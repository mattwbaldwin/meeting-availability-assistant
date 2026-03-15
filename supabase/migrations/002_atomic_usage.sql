-- Meeting Availability Assistant — atomic usage counting + security hardening
--
-- Replaces the append-only usage table with a summary table that can be
-- incremented atomically via INSERT ... ON CONFLICT DO UPDATE, eliminating
-- the check-then-insert race condition that allowed concurrent requests to
-- both pass the free-tier limit check.

-- ─── Replace append-only usage table with a summary table ────────────────────

drop table if exists public.usage;

create table if not exists public.monthly_usage (
  user_id    uuid not null references public.users(id) on delete cascade,
  month      text not null,               -- YYYY-MM
  count      integer not null default 0 check (count >= 0),
  primary key (user_id, month)
);

-- ─── Atomic increment RPC ────────────────────────────────────────────────────
-- Returns the NEW count after increment.  The Edge Function calls this and
-- compares the result against the tier limit: if new_count > limit the request
-- was already recorded, so the function should return 429 and not call Claude.
-- Using a DB function ensures the check and the write are one atomic operation.

create or replace function public.increment_usage(p_user_id uuid, p_month text)
returns integer
language sql
security definer          -- runs as postgres owner, bypasses RLS
set search_path = public
as $$
  insert into public.monthly_usage (user_id, month, count)
  values (p_user_id, p_month, 1)
  on conflict (user_id, month)
  do update set count = monthly_usage.count + 1
  returning count;
$$;

-- ─── RLS — block anonymous access (edge function uses service key) ────────────

alter table public.monthly_usage enable row level security;

-- Deny all access to the anon role as a safety net.  The Edge Function always
-- authenticates with the service role key, so it is unaffected by these policies.
create policy "deny_anon_users" on public.users
  as restrictive for all to anon using (false);

create policy "deny_anon_monthly_usage" on public.monthly_usage
  as restrictive for all to anon using (false);
