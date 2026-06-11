-- ============================================================
--  Beveiligingslaag: login + per-gebruiker afgeschermde data.
--  Draai dit ná supabase/schema.sql in de SQL Editor.
--  Elke gebruiker ziet/bewerkt alleen zijn eigen rondes.
-- ============================================================

-- 1. Koppel elke ronde aan een gebruiker. Nieuwe rijen krijgen automatisch
--    de ingelogde gebruiker (auth.uid()); de scraper zet 'm expliciet.
alter table public.rounds
  add column if not exists user_id uuid references auth.users(id) default auth.uid();

create index if not exists rounds_user_idx on public.rounds (user_id);

-- 2. RLS: vervang de open policy door "alleen je eigen rondes".
alter table public.rounds enable row level security;
drop policy if exists "anon full access" on public.rounds;
drop policy if exists "eigen rondes" on public.rounds;

-- Separate policies for better control
create policy "read own rounds"
  on public.rounds
  for select
  using (
    auth.role() = 'authenticated'
    and auth.uid() = user_id
  );

create policy "insert own rounds"
  on public.rounds
  for insert
  with check (
    auth.role() = 'authenticated'
    and auth.uid() = user_id
  );

create policy "update own rounds"
  on public.rounds
  for update
  using (
    auth.role() = 'authenticated'
    and auth.uid() = user_id
  )
  with check (
    auth.role() = 'authenticated'
    and auth.uid() = user_id
  );

create policy "delete own rounds"
  on public.rounds
  for delete
  using (
    auth.role() = 'authenticated'
    and auth.uid() = user_id
  );

-- anon (de publieke pagina zónder login) krijgt geen enkele policy => geen toegang.
-- service_role (de scrapers, server-side) omzeilt RLS sowieso.

-- 3. Bestaande rondes (de startdata uit schema.sql) hebben nog geen user_id.
--    Maak na het aanmaken van je account je eigen account-id eigenaar:
--      a) Authentication -> Users -> klik je gebruiker -> kopieer "User UID"
--      b) zet 'm hieronder en draai deze regel (haal het commentaar weg):
-- update public.rounds set user_id = 'JOUW-USER-UID' where user_id is null;
--    (Of verwijder de startdata en laat de GOLF.NL-sync 'm opnieuw vullen.)

-- 4. Screenshots privé maken: bucket niet meer publiek, en per-gebruiker map.
update storage.buckets set public = false where id = 'round-screenshots';

drop policy if exists "anon upload screenshots" on storage.objects;
drop policy if exists "anon read screenshots" on storage.objects;
drop policy if exists "eigen screenshots upload" on storage.objects;
drop policy if exists "eigen screenshots lezen" on storage.objects;

create policy "eigen screenshots upload"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'round-screenshots'
              and (storage.foldername(name))[1] = auth.uid()::text);

create policy "eigen screenshots lezen"
  on storage.objects for select to authenticated
  using (bucket_id = 'round-screenshots'
         and (storage.foldername(name))[1] = auth.uid()::text);
