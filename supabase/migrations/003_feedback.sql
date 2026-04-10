-- Meeting Availability Assistant — reply quality feedback

create table public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  rating     smallint not null check (rating in (1, -1)),  -- 1 = thumbs up, -1 = thumbs down
  created_at timestamptz not null default now()
);

create index feedback_user_idx on public.feedback(user_id);

alter table public.feedback enable row level security;

create policy "deny_anon_feedback" on public.feedback
  as restrictive for all to anon using (false);
