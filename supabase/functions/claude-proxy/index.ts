// supabase/functions/claude-proxy/index.ts
// Supabase Edge Function — authenticates Google users, gates on tier/usage, calls Claude API

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const FREE_MONTHLY_LIMIT = 5;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// ─── CORS headers (Chrome extension origin) ──────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-google-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ─── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Handle /status sub-path
  const url = new URL(req.url);
  if (url.pathname.endsWith('/status')) {
    return handleStatus(req);
  }

  return handleProxy(req);
});

async function handleProxy(req: Request): Promise<Response> {
  try {
    const googleToken = req.headers.get('x-google-token');
    if (!googleToken) {
      return jsonResponse({ error: 'missing_token' }, 401);
    }

    // Verify Google token and get user info
    const userInfo = await getGoogleUserInfo(googleToken);
    if (!userInfo?.sub) {
      return jsonResponse({ error: 'invalid_token' }, 401);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Upsert user record
    const user = await upsertUser(supabase, userInfo);

    // Check usage vs tier limit
    const monthlyUsage = await getMonthlyUsage(supabase, user.id);
    const limit = user.tier === 'paid' ? Infinity : FREE_MONTHLY_LIMIT;

    if (monthlyUsage >= limit) {
      return jsonResponse({ error: 'usage_limit_exceeded', usage: monthlyUsage, limit }, 429);
    }

    // Parse request body
    const { prompt, type } = await req.json();
    if (!prompt) {
      return jsonResponse({ error: 'missing_prompt' }, 400);
    }

    // Call Claude API with server-side key
    const claudeResponse = await callClaude(prompt, type);

    // Record usage
    await recordUsage(supabase, user.id);

    return jsonResponse(claudeResponse);
  } catch (err) {
    console.error('claude-proxy error:', err);
    return jsonResponse({ error: 'internal_error', message: err.message }, 500);
  }
}

async function handleStatus(req: Request): Promise<Response> {
  try {
    const googleToken = req.headers.get('x-google-token');
    if (!googleToken) return jsonResponse({ error: 'missing_token' }, 401);

    const userInfo = await getGoogleUserInfo(googleToken);
    if (!userInfo?.sub) return jsonResponse({ error: 'invalid_token' }, 401);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const user = await upsertUser(supabase, userInfo);
    const usage = await getMonthlyUsage(supabase, user.id);
    const limit = user.tier === 'paid' ? null : FREE_MONTHLY_LIMIT;

    return jsonResponse({ tier: user.tier, usage, limit });
  } catch (err) {
    return jsonResponse({ error: 'internal_error', message: err.message }, 500);
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
    .select('id, tier')
    .single();

  if (error) throw new Error(`DB upsert error: ${error.message}`);
  return data;
}

async function getMonthlyUsage(supabase: SupabaseClient, userId: string): Promise<number> {
  const month = currentMonth();
  const { count, error } = await supabase
    .from('usage')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('month', month);

  if (error) throw new Error(`DB usage query error: ${error.message}`);
  return count ?? 0;
}

async function recordUsage(supabase: SupabaseClient, userId: string) {
  const { error } = await supabase
    .from('usage')
    .insert({ user_id: userId, month: currentMonth() });

  if (error) throw new Error(`DB usage insert error: ${error.message}`);
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
