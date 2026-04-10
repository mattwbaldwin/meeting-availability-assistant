// supabase/functions/claude-proxy/index.ts
// Supabase Edge Function — authenticates Google users, gates on tier/usage, calls Claude API

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const FREE_MONTHLY_LIMIT = 5;
const REFERRAL_CREDITS = 5; // credits awarded to both parties on a successful referral

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// Set ALLOWED_ORIGIN to your extension's chrome-extension://EXTENSION_ID origin.
// Fails closed if not configured — requests from unknown origins will be rejected.
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN');
if (!ALLOWED_ORIGIN) {
  console.warn('claude-proxy: ALLOWED_ORIGIN env var not set — CORS will reject all browser requests');
}

// Maximum characters accepted in a prompt — prevents token-exhaustion abuse.
const MAX_PROMPT_CHARS = 6000;

// Only these call types are accepted from the extension.
const ALLOWED_TYPES = new Set(['check_email', 'draft_reply']);

// ─── CORS headers (Chrome extension origin) ──────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  ...(ALLOWED_ORIGIN ? { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN } : {}),
  'Access-Control-Allow-Headers': 'content-type, x-google-token',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  if (url.pathname.endsWith('/status'))   return handleStatus(req);
  if (url.pathname.endsWith('/feedback')) return handleFeedback(req);
  if (url.pathname.endsWith('/referral')) return handleReferral(req);

  return handleProxy(req);
});

// ─── Claude proxy ─────────────────────────────────────────────────────────────

async function handleProxy(req: Request): Promise<Response> {
  try {
    const googleToken = req.headers.get('x-google-token');
    if (!googleToken) {
      return jsonResponse({ error: 'missing_token' }, 401);
    }

    const userInfo = await getGoogleUserInfo(googleToken);
    if (!userInfo?.sub) {
      return jsonResponse({ error: 'invalid_token' }, 401);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const user = await upsertUser(supabase, userInfo);

    const { prompt, type } = await req.json();
    if (!prompt || typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) {
      return jsonResponse({ error: 'invalid_prompt' }, 400);
    }
    if (type !== undefined && !ALLOWED_TYPES.has(type)) {
      return jsonResponse({ error: 'invalid_type' }, 400);
    }

    // Effective limit = base free limit + any bonus credits earned via referrals
    if (user.tier !== 'paid') {
      const effectiveLimit = FREE_MONTHLY_LIMIT + (user.bonus_credits ?? 0);
      const currentUsage = await getMonthlyUsage(supabase, user.id);
      if (currentUsage >= effectiveLimit) {
        return jsonResponse({ error: 'usage_limit_exceeded', usage: currentUsage, limit: effectiveLimit }, 429);
      }
    }

    const claudeResponse = await callClaude(prompt, type);

    if (user.tier !== 'paid') {
      await incrementUsage(supabase, user.id);
    }

    return jsonResponse(claudeResponse);
  } catch (err) {
    console.error('claude-proxy error:', err);
    if ((err as Error).message === 'service_temporarily_unavailable') {
      return jsonResponse({ error: 'service_temporarily_unavailable' }, 503);
    }
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

// ─── Account status ───────────────────────────────────────────────────────────

async function handleStatus(req: Request): Promise<Response> {
  try {
    const googleToken = req.headers.get('x-google-token');
    if (!googleToken) return jsonResponse({ error: 'missing_token' }, 401);

    const userInfo = await getGoogleUserInfo(googleToken);
    if (!userInfo?.sub) return jsonResponse({ error: 'invalid_token' }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const user = await upsertUser(supabase, userInfo);
    const usage = await getMonthlyUsage(supabase, user.id);
    const bonusCredits = user.bonus_credits ?? 0;
    const effectiveLimit = user.tier === 'paid' ? null : FREE_MONTHLY_LIMIT + bonusCredits;

    return jsonResponse({ tier: user.tier, usage, limit: effectiveLimit, bonus_credits: bonusCredits });
  } catch (err) {
    console.error('claude-proxy status error:', err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

// ─── Reply quality feedback ───────────────────────────────────────────────────

async function handleFeedback(req: Request): Promise<Response> {
  try {
    const googleToken = req.headers.get('x-google-token');
    if (!googleToken) return jsonResponse({ error: 'missing_token' }, 401);

    const userInfo = await getGoogleUserInfo(googleToken);
    if (!userInfo?.sub) return jsonResponse({ error: 'invalid_token' }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const user = await upsertUser(supabase, userInfo);

    const { rating } = await req.json();
    if (rating !== 1 && rating !== -1) return jsonResponse({ error: 'invalid_rating' }, 400);

    const { error } = await supabase.from('feedback').insert({ user_id: user.id, rating });
    if (error) throw new Error(`DB feedback error: ${error.code}`);

    return jsonResponse({ success: true });
  } catch (err) {
    console.error('feedback error:', err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

// ─── Referral credits ─────────────────────────────────────────────────────────

async function handleReferral(req: Request): Promise<Response> {
  try {
    const googleToken = req.headers.get('x-google-token');
    if (!googleToken) return jsonResponse({ error: 'missing_token' }, 401);

    const userInfo = await getGoogleUserInfo(googleToken);
    if (!userInfo?.sub) return jsonResponse({ error: 'invalid_token' }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const user = await upsertUser(supabase, userInfo);

    if (req.method === 'GET') {
      const { count } = await supabase
        .from('referrals').select('*', { count: 'exact', head: true })
        .eq('referrer_id', user.id);
      const { data: usedReferral } = await supabase
        .from('referrals').select('id').eq('referee_id', user.id).maybeSingle();
      return jsonResponse({
        code: user.id.slice(0, 8).toUpperCase(),
        referrals_made: count ?? 0,
        already_referred: !!usedReferral,
      });
    }

    if (req.method === 'POST') {
      const { code } = await req.json();
      if (!code || typeof code !== 'string' || code.length !== 8) {
        return jsonResponse({ error: 'invalid_code' }, 400);
      }

      // Can't refer yourself
      if (user.id.toUpperCase().startsWith(code.toUpperCase())) {
        return jsonResponse({ error: 'cannot_refer_self' }, 400);
      }

      // Each user can only redeem one referral code
      const { data: existingRef } = await supabase
        .from('referrals').select('id').eq('referee_id', user.id).maybeSingle();
      if (existingRef) return jsonResponse({ error: 'already_referred' }, 409);

      // Find referrer by their 8-char code prefix
      const { data: referrer } = await supabase
        .from('users').select('id')
        .ilike('id', `${code}%`)
        .maybeSingle();
      if (!referrer) return jsonResponse({ error: 'code_not_found' }, 404);

      // Record the referral
      const { error: refError } = await supabase
        .from('referrals').insert({ referrer_id: referrer.id, referee_id: user.id });
      if (refError) return jsonResponse({ error: 'referral_failed' }, 500);

      // Credit both parties
      await supabase.rpc('add_bonus_credits', { p_user_id: referrer.id, p_credits: REFERRAL_CREDITS });
      await supabase.rpc('add_bonus_credits', { p_user_id: user.id, p_credits: REFERRAL_CREDITS });

      return jsonResponse({ success: true, credits_added: REFERRAL_CREDITS });
    }

    return jsonResponse({ error: 'method_not_allowed' }, 405);
  } catch (err) {
    console.error('referral error:', err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}

// ─── Google token verification ────────────────────────────────────────────────

async function getGoogleUserInfo(token: string) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function upsertUser(supabase: SupabaseClient, userInfo: Record<string, string>) {
  const { data, error } = await supabase
    .from('users')
    .upsert(
      { google_sub: userInfo.sub, email: userInfo.email },
      { onConflict: 'google_sub', ignoreDuplicates: false }
    )
    .select('id, tier, bonus_credits')
    .single();

  if (error) throw new Error(`DB upsert error: ${error.code}`);
  return data;
}

async function incrementUsage(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .rpc('increment_usage', { p_user_id: userId, p_month: currentMonth() });

  if (error) throw new Error(`DB usage increment error: ${error.code}`);
  return data as number;
}

async function getMonthlyUsage(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('monthly_usage')
    .select('count')
    .eq('user_id', userId)
    .eq('month', currentMonth())
    .maybeSingle();

  if (error) throw new Error(`DB usage query error: ${error.code}`);
  return (data as { count: number } | null)?.count ?? 0;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Claude API ───────────────────────────────────────────────────────────────

async function callClaude(prompt: string, _type: string) {
  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 429 || err.error?.type === 'insufficient_quota') {
      throw new Error('service_temporarily_unavailable');
    }
    throw new Error(err.error?.message ?? `Claude API error: ${res.status}`);
  }
  return res.json();
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
  });
}
