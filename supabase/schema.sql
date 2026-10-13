-- HabitNow schema. Paste this into the Supabase SQL editor and run it once.
--
-- Every table is scoped to auth.uid() through row-level security, so the public
-- anon key can only ever read or write the signed-in person's own rows.

create table if not exists public.areas (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users on delete cascade,
  name      text not null,
  position  int  not null default 0
);

create table if not exists public.habits (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  name         text not null,
  icon         text not null default '🎯',
  color        text not null default 'indigo',
  target       int  not null default 1 check (target > 0),
  unit         text not null default 'times',
  time_of_day  text not null default 'anytime'
                 check (time_of_day in ('morning', 'afternoon', 'evening', 'anytime')),
  area_id      uuid references public.areas on delete set null,
  days         int[] not null default '{0,1,2,3,4,5,6}',
  reminder     text,
  github       text,
  archived     boolean not null default false,
  position     int  not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists public.entries (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references auth.users on delete cascade,
  habit_id  uuid not null references public.habits on delete cascade,
  date      date not null,
  value     int  not null default 0 check (value >= 0),
  skipped   boolean not null default false,
  note      text not null default '',
  -- One row per habit per day; the app upserts on this pair.
  unique (habit_id, date)
);

-- Added after the first release; harmless to re-run on a fresh project.
alter table public.habits add column if not exists github text;

create index if not exists habits_user_idx  on public.habits (user_id, position);
create index if not exists entries_user_idx on public.entries (user_id, date);
create index if not exists areas_user_idx   on public.areas (user_id, position);

alter table public.areas   enable row level security;
alter table public.habits  enable row level security;
alter table public.entries enable row level security;

-- "for all" covers select, insert, update and delete in one policy. `using`
-- gates the rows you can see or change; `with check` gates what you may write,
-- which is what stops anyone inserting a row under someone else's user_id.
drop policy if exists "own areas" on public.areas;
create policy "own areas" on public.areas
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own habits" on public.habits;
create policy "own habits" on public.habits
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own entries" on public.entries;
create policy "own entries" on public.entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
