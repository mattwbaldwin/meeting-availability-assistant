-- Meeting Availability Assistant — initial DB schema

-- Users table: one row per Google account
create table if not exists public.users (
  id         uuid primary key default gen_random_uuid(),
  google_sub text unique not null,         -- Google user ID (stable)
  email      text,
  tier       text not null default 'free', -- 'free' | 'paid'
  created_at timestamptz not null default now()
);

-- Usage table: one row per AI reply, per month
create table if not exists public.usage (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  month      text not null,               -- YYYY-MM
  created_at timestamptz not null default now()
);

create index if not exists usage_user_month_idx on public.usage(user_id, month);

-- Row-level security: service role has full access (edge function uses service key)
alter table public.users enable row level security;
alter table public.usage enable row level security;
