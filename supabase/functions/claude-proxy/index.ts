// supabase/functions/claude-proxy/index.ts
// Supabase Edge Function — authenticates Google users, gates on tier/usage, calls Claude API

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const FREE_MONTHLY_LIMIT = 5;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

// Set ALLOWED_ORIGIN to your extension's chrome-extension://EXTENSION_ID origin.
// Falls back to '*' only if the env var is not configured (e.g. during local dev).
const ALLOWED_ORIGIN = Deno.env.get('ALLOWED_ORIGIN') ?? '*';

// Maximum characters accepted in a prompt — prevents token-exhaustion abuse.
const MAX_PROMPT_CHARS = 6000;

// Only these call types are accepted from the extension.
const ALLOWED_TYPES = new Set(['check_email', 'draft_reply']);

// ─── CORS headers (Chrome extension origin) ──────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
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

    // Parse and validate request body before spending the usage slot
    const { prompt, type } = await req.json();
    if (!prompt || typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) {
      return jsonResponse({ error: 'invalid_prompt' }, 400);
    }
    if (type !== undefined && !ALLOWED_TYPES.has(type)) {
      return jsonResponse({ error: 'invalid_type' }, 400);
    }

    // Atomically increment usage and check limit in one DB operation.
    // This eliminates the race condition where two concurrent requests both
    // pass a separate check-then-insert sequence.
    if (user.tier !== 'paid') {
      const newCount = await incrementUsage(supabase, user.id);
      if (newCount > FREE_MONTHLY_LIMIT) {
        return jsonResponse({ error: 'usage_limit_exceeded', usage: newCount - 1, limit: FREE_MONTHLY_LIMIT }, 429);
      }
    }

    // Call Claude API with server-side key
    const claudeResponse = await callClaude(prompt, type);

    return jsonResponse(claudeResponse);
  } catch (err) {
    // Log full error server-side; return generic message to client.
    console.error('claude-proxy error:', err);
    return jsonResponse({ error: 'internal_error' }, 500);
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
    console.error('claude-proxy status error:', err);
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
    .select('id, tier')
    .single();

  if (error) throw new Error(`DB upsert error: ${error.code}`);
  return data;
}

// Atomically increments the monthly usage counter and returns the new count.
// Uses the increment_usage Postgres function (migration 002) so the check and
// write happen in a single atomic statement, preventing race conditions.
async function incrementUsage(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .rpc('increment_usage', { p_user_id: userId, p_month: currentMonth() });

  if (error) throw new Error(`DB usage increment error: ${error.code}`);
  return data as number;
}

// Read-only usage count for the /status endpoint.
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
