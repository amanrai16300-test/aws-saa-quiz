create table if not exists public.quiz_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.quiz_progress enable row level security;

drop policy if exists "Users can read their own quiz progress" on public.quiz_progress;
drop policy if exists "Users can insert their own quiz progress" on public.quiz_progress;
drop policy if exists "Users can update their own quiz progress" on public.quiz_progress;
drop policy if exists "Users can delete their own quiz progress" on public.quiz_progress;

create policy "Users can read their own quiz progress"
  on public.quiz_progress
  for select
  using (auth.uid() = user_id);

create policy "Users can insert their own quiz progress"
  on public.quiz_progress
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own quiz progress"
  on public.quiz_progress
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own quiz progress"
  on public.quiz_progress
  for delete
  using (auth.uid() = user_id);

create or replace function public.set_quiz_progress_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_quiz_progress_updated_at on public.quiz_progress;

create trigger set_quiz_progress_updated_at
before update on public.quiz_progress
for each row
execute function public.set_quiz_progress_updated_at();
