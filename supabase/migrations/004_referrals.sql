-- Meeting Availability Assistant — referral credits

-- Add bonus credits column to users
alter table public.users
  add column if not exists bonus_credits integer not null default 0 check (bonus_credits >= 0);

-- Referral tracking: one row per referred user (unique on referee_id)
create table public.referrals (
  id          uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references public.users(id),
  referee_id  uuid not null references public.users(id),
  created_at  timestamptz not null default now(),
  unique (referee_id)   -- each user can only be referred once
);

alter table public.referrals enable row level security;

create policy "deny_anon_referrals" on public.referrals
  as restrictive for all to anon using (false);

-- Atomically add bonus credits to a user
create or replace function public.add_bonus_credits(p_user_id uuid, p_credits integer)
returns void
language sql
security definer
set search_path = public
as $$
  update public.users
  set bonus_credits = bonus_credits + p_credits
  where id = p_user_id;
$$;
