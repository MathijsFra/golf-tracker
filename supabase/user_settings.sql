-- ============================================================
--  user_settings: per-gebruiker instellingen (GOLF.NL-credentials, etc.)
--  Draai dit in de Supabase SQL Editor.
-- ============================================================

create table if not exists public.user_settings (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  golfnl_username text,
  golfnl_password text,
  updated_at    timestamptz default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "eigen instellingen lezen"    on public.user_settings;
drop policy if exists "eigen instellingen schrijven" on public.user_settings;
drop policy if exists "eigen instellingen bijwerken" on public.user_settings;

create policy "eigen instellingen lezen"
  on public.user_settings for select
  using (auth.uid() = user_id);

create policy "eigen instellingen schrijven"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

create policy "eigen instellingen bijwerken"
  on public.user_settings for update
  using (auth.uid() = user_id);
