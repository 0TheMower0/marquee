-- ===========================================================================
-- Marquee — Phase 6 Step 3: initial schema + Row Level Security
--
-- Implements docs/phase-6-sync-design.md §2 (schema) and §3 (RLS).
-- Read that document before changing anything here; several choices below
-- look arbitrary without it.
--
-- ---------------------------------------------------------------------------
-- WHY SCHEMA AND RLS ARE IN ONE MIGRATION, NOT TWO
-- ---------------------------------------------------------------------------
-- The tempting split is "0001 tables, 0002 policies". It is wrong here.
-- Postgres DDL is transactional, so this file applies completely or not at
-- all — which means there is no instant, and no intermediate migration state,
-- in which a table exists without RLS. Split across two migrations, anyone who
-- applies only the first (a partial deploy, an interrupted CI run, a manual
-- `psql -f`) has published every user's data through PostgREST to anyone
-- holding the anon key, which ships in the client bundle by design.
--
-- Corollary for whoever adds the next table: add it, enable RLS on it, and
-- write its policies in the SAME migration file. Never in a follow-up.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Shared triggers
-- ---------------------------------------------------------------------------

-- `updated_at` is the PULL CURSOR (design doc §4.3). It must be server-set:
-- if a client could write it, a client could write it *backwards* and make its
-- own rows invisible to every other device's `where updated_at > :cursor`
-- query. That is silent, permanent data divergence, so this is an integrity
-- control and not merely a convenience default.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- `client_updated_at` is the CONFLICT CLOCK (design doc §4.3) and is genuinely
-- client-supplied, because last-write-wins must reflect when the USER acted,
-- not when their device happened to reconnect.
--
-- The clamp bounds the one pathological case: a device whose clock reads 2030
-- would otherwise win every conflict forever, unrecoverably. Clamping a
-- fast clock is *more* correct rather than a trade-off — the clamped value is
-- still later than any prior write, so it still wins what it should. A SLOW
-- clock remains a known, accepted limitation; no trigger can distinguish "an
-- hour slow" from "a legitimate offline write made an hour ago".
create or replace function public.clamp_client_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.client_updated_at is null or new.client_updated_at > now() then
    new.client_updated_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles
--
-- Minimal on purpose. This is the ONLY table whose SELECT policy is not
-- "your own rows", because Phase 6's comments and shared lists must render
-- other people's display names. That makes it the one table where a careless
-- column addition becomes a data leak — see the policy comment below.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- tracked_titles
-- ---------------------------------------------------------------------------
create table public.tracked_titles (
  user_id             uuid        not null references auth.users (id) on delete cascade,
  media_type          text        not null check (media_type in ('movie', 'tv')),
  title_id            text        not null,
  status              text        not null check (status in ('watchlist', 'watching', 'watched')),
  -- TitleSummary snapshot: read as a unit, never queried by field. It is
  -- denormalized provider data by design (see the snapshot note in
  -- lib/tracking/types.ts), so jsonb is correct rather than lazy.
  summary             jsonb       not null,
  -- Phase 5 Step 2 XP-only fallbacks. Nullable = an honest gap, never a
  -- fabricated number.
  runtime_minutes     integer,
  known_episode_count integer,
  added_at            timestamptz not null default now(),
  client_updated_at   timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  primary key (user_id, media_type, title_id)
);

create index tracked_titles_pull_cursor
  on public.tracked_titles (user_id, updated_at);

create trigger tracked_titles_clamp
  before insert or update on public.tracked_titles
  for each row execute function public.clamp_client_updated_at();

-- ---------------------------------------------------------------------------
-- watched_episodes
--
-- ONE ROW PER WATCHED EPISODE. The client-side `EpisodeRange` encoding is
-- deliberately NOT preserved here — design doc §2.1. As rows, two devices
-- marking different episodes are two independent inserts into two distinct
-- primary keys, so the canonical "phone marks S3E4, laptop marks S3E5" case
-- has no conflict at all. As a JSON blob it would be a whole-blob conflict
-- where last-write-wins silently destroys one device's episode.
-- ---------------------------------------------------------------------------
create table public.watched_episodes (
  user_id           uuid        not null references auth.users (id) on delete cascade,
  -- Redundant by one column, and worth it: carrying media_type lets the FK
  -- below reference tracked_titles' natural key directly, so every write is a
  -- pure function of data the client already holds with no id-resolution step.
  media_type        text        not null default 'tv' check (media_type = 'tv'),
  title_id          text        not null,
  season_number     integer     not null check (season_number >= 0), -- 0 = Specials
  episode_number    integer     not null check (episode_number >= 1),
  client_updated_at timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Tombstone, not a hard delete. A DELETE does not commute with a concurrent
  -- INSERT: an offline device re-marking the episode would resurrect or lose
  -- it purely on sync order. With a tombstone the outcome is a function of
  -- when the user acted. This makes the table a LWW-Element-Set CRDT, which is
  -- how the highest-risk data gets convergence with no CRDT machinery.
  deleted_at        timestamptz,
  primary key (user_id, media_type, title_id, season_number, episode_number),
  foreign key (user_id, media_type, title_id)
    references public.tracked_titles (user_id, media_type, title_id)
    on delete cascade
);

create index watched_episodes_pull_cursor
  on public.watched_episodes (user_id, updated_at);

create trigger watched_episodes_clamp
  before insert or update on public.watched_episodes
  for each row execute function public.clamp_client_updated_at();

-- ---------------------------------------------------------------------------
-- ratings  (score only — notes live in their own table, see below)
-- ---------------------------------------------------------------------------
create table public.ratings (
  user_id           uuid        not null references auth.users (id) on delete cascade,
  media_type        text        not null check (media_type in ('movie', 'tv')),
  title_id          text        not null,
  score             integer     check (score between 0 and 100),
  client_updated_at timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  primary key (user_id, media_type, title_id)
);

create index ratings_pull_cursor on public.ratings (user_id, updated_at);

create trigger ratings_clamp
  before insert or update on public.ratings
  for each row execute function public.clamp_client_updated_at();

-- ---------------------------------------------------------------------------
-- rating_notes
--
-- A SEPARATE TABLE from `ratings`, deliberately (design doc §7). A score may
-- one day be shared; a private note never will be. Table-level separation is a
-- structural guarantee — a careless `select *` on `ratings` physically cannot
-- reach a note — where column-level omission relies on remembering. Its RLS
-- policy is own-rows-only and must NEVER be relaxed, even if `ratings` later
-- gains a "visible to people I share a list with" policy.
-- ---------------------------------------------------------------------------
create table public.rating_notes (
  user_id           uuid        not null references auth.users (id) on delete cascade,
  media_type        text        not null check (media_type in ('movie', 'tv')),
  title_id          text        not null,
  note              text        not null,
  client_updated_at timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  primary key (user_id, media_type, title_id)
);

create index rating_notes_pull_cursor on public.rating_notes (user_id, updated_at);

create trigger rating_notes_clamp
  before insert or update on public.rating_notes
  for each row execute function public.clamp_client_updated_at();

-- ---------------------------------------------------------------------------
-- watch_events  (append-only history)
-- ---------------------------------------------------------------------------
create table public.watch_events (
  -- Client-generated. The log is append-only and genuine duplicates are
  -- MEANINGFUL (the "Second Helping" badge detects an unmark-then-remark), so
  -- a content-derived natural key would collapse real data. A client UUID
  -- makes replay idempotent without deduplicating anything real.
  id             uuid        primary key,
  user_id        uuid        not null references auth.users (id) on delete cascade,
  -- =====================================================================
  -- ⚠ THE LOCAL CALENDAR DAY, FROZEN AT WRITE TIME. NEVER DERIVE THIS.
  -- =====================================================================
  -- `date`, deliberately, because `date` carries no timezone and undergoes no
  -- conversion. Recomputing this from a timestamp — e.g.
  --     day_key := (created_at at time zone 'UTC')::date
  -- is FORBIDDEN. Watch something at 8am in Tokyo, fly to Los Angeles, and
  -- that instant re-derives as the previous day: the user's streak history
  -- rewrites itself because they travelled. See lib/watchlog/types.ts.
  -- `created_at` below is recording metadata only; nothing may do day
  -- arithmetic with it.
  day_key        date        not null,
  kind           text        not null check (kind in ('episode', 'movie', 'title')),
  media_type     text        not null check (media_type in ('movie', 'tv')),
  title_id       text        not null,
  season_number  integer,
  episode_number integer,
  minute_of_day  integer     check (minute_of_day between 0 and 1439),
  bulk           boolean     not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- An episode event without its coordinates cannot be attributed to
  -- anything; a non-episode event must not carry them.
  constraint watch_events_episode_coords
    check ((kind = 'episode') = (season_number is not null and episode_number is not null))
);

create index watch_events_pull_cursor on public.watch_events (user_id, updated_at);
-- Year in Review and streak queries filter by day, per user.
create index watch_events_by_day on public.watch_events (user_id, day_key);

create trigger watch_events_set_updated_at
  before update on public.watch_events
  for each row execute function public.set_updated_at();

-- NOTE: deliberately NO foreign key to tracked_titles. The log is an immutable
-- record of what happened; tracked_titles is current state. Removing a show
-- from your library must not erase the fact that you watched it in June.

-- ---------------------------------------------------------------------------
-- badges_earned
-- ---------------------------------------------------------------------------
create table public.badges_earned (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  badge_id   text        not null,
  earned_at  timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);

create index badges_earned_pull_cursor on public.badges_earned (user_id, updated_at);

create trigger badges_earned_set_updated_at
  before update on public.badges_earned
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- xp_state
-- ---------------------------------------------------------------------------
create table public.xp_state (
  user_id            uuid        primary key references auth.users (id) on delete cascade,
  highest_level_seen integer     not null default 1,
  updated_at         timestamptz not null default now()
);

create trigger xp_state_set_updated_at
  before update on public.xp_state
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- ROW LEVEL SECURITY
--
-- Read this before editing any policy below.
--
-- RLS here is NOT hardening applied on top of a safe default. It IS the
-- access control. Supabase grants the `anon` and `authenticated` roles table
-- privileges in the `public` schema and exposes every table through
-- PostgREST, so a table in this schema with RLS *not enabled* is readable and
-- writable by anyone holding the anon key — which is published in the client
-- bundle on purpose. There is no second line of defence.
--
-- Four rules applied uniformly below:
--
--   1. ENABLE, then FORCE. `enable` subjects normal roles to policies;
--      `force` additionally subjects the TABLE OWNER, so a migration or admin
--      session connected as the owner cannot quietly read everything. Neither
--      affects a role holding BYPASSRLS (Supabase's `service_role`) — which is
--      exactly why that key must never reach a browser.
--
--   2. Four explicit per-operation policies, never one `for all`. Postgres
--      does fall back to the USING expression for WITH CHECK when the latter
--      is omitted, so `for all` is not *broken* — but relying on that means
--      every reviewer has to re-derive it. These are auditable at a glance.
--
--   3. EVERY UPDATE POLICY CARRIES BOTH `using` AND `with check`. `using`
--      decides which rows you may update; `with check` decides what the row
--      may look like AFTERWARDS, and it is what stops a user reassigning their
--      own row's `user_id` into someone else's account.
--
--      ⚠ CORRECTION TO A WIDELY-REPEATED CLAIM (including in an earlier draft
--      of our own design doc): omitting `with check` is NOT the vulnerable
--      shape. Postgres defaults `with check` to the `using` expression when it
--      is omitted, so a USING-only UPDATE policy blocks the hijack fine. This
--      was verified empirically, not assumed — see checks 10-12 in
--      supabase/tests/01_rls_adversarial.sql.
--
--      The ACTUAL hole is a `with check` BROADER than `using`, of which
--      `with check (true)` is the maximal case and by far the most common in
--      the wild (written to "just let updates through"). Writing both clauses
--      explicitly is still right — it makes the intent reviewable and stops
--      someone widening it later by accident — just not for the usually-cited
--      reason.
--
--   4. `revoke all ... from anon`. Nothing here is public data. Belt and
--      braces alongside having no `anon` policies at all.
-- ===========================================================================

-- --------------------------- profiles --------------------------------------
alter table public.profiles enable row level security;
alter table public.profiles force  row level security;
revoke all on public.profiles from anon;

-- The ONE intentional exception to own-rows-only: any signed-in user may read
-- any profile, because Phase 6 comments and shared lists must show authors'
-- display names.
--
-- ⚠ CONSEQUENCE: never add an email, a real name, or any private preference
-- column to this table. Email lives in `auth.users`, which PostgREST does not
-- expose. If a profile ever needs private fields they go in a separate
-- `profile_private` table with the standard own-rows-only policy — NOT as
-- extra columns here.
create policy "profiles_select_any_authenticated" on public.profiles
  for select to authenticated
  using (true);

-- Prevents: creating a profile row that claims to be another user.
create policy "profiles_insert_self" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

-- USING prevents editing someone else's profile.
-- WITH CHECK prevents re-pointing your own row's `id` at another user.
create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using      ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- Prevents: deleting another user's profile.
create policy "profiles_delete_self" on public.profiles
  for delete to authenticated
  using ((select auth.uid()) = id);

-- ----------------------- the uniform own-rows set --------------------------
-- Identical shape for every remaining table. `(select auth.uid())` rather than
-- a bare `auth.uid()` is deliberate: the scalar subquery is evaluated once per
-- query instead of once per row, which matters on a table scan.
--
-- auth.uid() returns NULL for an unauthenticated caller, and `null = user_id`
-- evaluates to NULL, which is not TRUE, so every policy denies by default.

-- tracked_titles
alter table public.tracked_titles enable row level security;
alter table public.tracked_titles force  row level security;
revoke all on public.tracked_titles from anon;

-- Prevents: reading another user's library.
create policy "tracked_titles_select_own" on public.tracked_titles
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Prevents: inserting a row attributed to another user.
create policy "tracked_titles_insert_own" on public.tracked_titles
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- USING prevents: editing another user's row.
-- WITH CHECK prevents: reassigning your own row's user_id into another
-- account (the §3.2 hijack).
create policy "tracked_titles_update_own" on public.tracked_titles
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Prevents: deleting another user's row.
create policy "tracked_titles_delete_own" on public.tracked_titles
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- watched_episodes
alter table public.watched_episodes enable row level security;
alter table public.watched_episodes force  row level security;
revoke all on public.watched_episodes from anon;

create policy "watched_episodes_select_own" on public.watched_episodes
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "watched_episodes_insert_own" on public.watched_episodes
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "watched_episodes_update_own" on public.watched_episodes
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "watched_episodes_delete_own" on public.watched_episodes
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ratings
alter table public.ratings enable row level security;
alter table public.ratings force  row level security;
revoke all on public.ratings from anon;

create policy "ratings_select_own" on public.ratings
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "ratings_insert_own" on public.ratings
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "ratings_update_own" on public.ratings
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "ratings_delete_own" on public.ratings
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- rating_notes — the strictest table in the schema. See the table comment:
-- this policy set must never be relaxed for sharing.
alter table public.rating_notes enable row level security;
alter table public.rating_notes force  row level security;
revoke all on public.rating_notes from anon;

create policy "rating_notes_select_own" on public.rating_notes
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "rating_notes_insert_own" on public.rating_notes
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "rating_notes_update_own" on public.rating_notes
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "rating_notes_delete_own" on public.rating_notes
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- watch_events
alter table public.watch_events enable row level security;
alter table public.watch_events force  row level security;
revoke all on public.watch_events from anon;

create policy "watch_events_select_own" on public.watch_events
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "watch_events_insert_own" on public.watch_events
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- The log is append-only in the application, but an UPDATE policy is still
-- required rather than omitted: with no policy at all an UPDATE is denied,
-- which is what we want, but a future correction path would otherwise have to
-- be added under time pressure. Kept explicit and own-rows-only.
create policy "watch_events_update_own" on public.watch_events
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "watch_events_delete_own" on public.watch_events
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- badges_earned
alter table public.badges_earned enable row level security;
alter table public.badges_earned force  row level security;
revoke all on public.badges_earned from anon;

create policy "badges_earned_select_own" on public.badges_earned
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "badges_earned_insert_own" on public.badges_earned
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "badges_earned_update_own" on public.badges_earned
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "badges_earned_delete_own" on public.badges_earned
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- xp_state
alter table public.xp_state enable row level security;
alter table public.xp_state force  row level security;
revoke all on public.xp_state from anon;

create policy "xp_state_select_own" on public.xp_state
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "xp_state_insert_own" on public.xp_state
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "xp_state_update_own" on public.xp_state
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "xp_state_delete_own" on public.xp_state
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ===========================================================================
-- GUARD: fail the migration if any public table escaped RLS.
--
-- "Forgetting `enable row level security` on a new table" produces no warning
-- of any kind — the table simply works, for everyone. This turns that silent
-- failure into a loud one at migration time, so the mistake cannot reach a
-- deployed database.
-- ===========================================================================
do $$
declare
  unprotected text;
begin
  select string_agg(tablename, ', ')
    into unprotected
    from pg_tables
   where schemaname = 'public'
     and rowsecurity = false;

  if unprotected is not null then
    raise exception
      'RLS is not enabled on: %. Every public table must enable AND force RLS in the same migration that creates it.',
      unprotected;
  end if;
end;
$$;

commit;
