-- ===========================================================================
-- Marquee — Phase 7 Step 5: new-episode push notifications
--
-- Design: ../../docs/phase-7-notifications-design.md. Read §1 before touching
-- anything here.
--
-- Same "schema and RLS in one transaction" discipline as every migration in
-- this directory — see 20260801000001's header for why a public table must
-- never exist without RLS for even one instant.
--
-- ---------------------------------------------------------------------------
-- THE THING THAT SHAPES THIS ENTIRE SCHEMA: THE TRIGGER IS A WORLD FACT
-- ---------------------------------------------------------------------------
-- "Notify about the world changing, never about the user's behaviour" is not
-- only an ethical rule here, it is why this schema is as small as it is.
--
-- "You haven't watched S6E1" would require the notifier to read every user's
-- watch progress. "S6E1 aired" does not. So the notifier needs to know only
-- WHICH SHOWS A USER FOLLOWS — never what they have seen, never when they
-- last opened the app, never how far behind they are. There is deliberately
-- nowhere in these six tables to record any of that.
--
-- Watch state IS consulted at send time, but ONLY to SUPPRESS a redundant
-- notification (you already watched it), NEVER to create one. Design doc §1.1
-- gives the mechanical test: if deleting all watch data would remove a
-- notification, it was a behaviour ping. That test must be applied before any
-- new event kind is added to `notification_event_kind` below.
--
-- ---------------------------------------------------------------------------
-- TWO RLS SHAPES IN ONE MIGRATION — the second is new to this project
-- ---------------------------------------------------------------------------
-- Every table before this one has been own-rows: `auth.uid() = user_id`.
-- Three tables here follow that exactly. But `show_snapshots` is WORLD data
-- (what TMDB last said about a show) belonging to no user, written by a cron
-- with no `auth.uid()` at all. It gets `USING (false)` for every API role, so
-- PostgREST exposes literally nothing — the service role reaches it by
-- BYPASSRLS, and nothing else reaches it at all.
--
-- `USING (false)` is not a placeholder to be "fixed" later. It is the whole
-- policy: this table has no user-facing read that would ever be correct.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Event kinds
--
-- An enum rather than a free-text column ON PURPOSE. Adding a value requires
-- a migration, which is exactly the friction wanted: every new event kind must
-- pass design doc §1.1's world-vs-behaviour test, and a text column would let
-- someone add 'you_are_behind' with a one-line client change and no review.
-- ---------------------------------------------------------------------------
create type public.notification_event_kind as enum (
  -- A new episode of a followed show has aired. Air date in the past or today.
  'episode_aired',
  -- A season that did not previously exist now does, or is dated in the future.
  'season_announced'
);

-- ---------------------------------------------------------------------------
-- push_subscriptions
--
-- One row per BROWSER, not per user — the same account on a phone and a
-- laptop is two endpoints and must be two rows, or enabling notifications on
-- one device would silently unsubscribe the other.
--
-- `endpoint` is globally unique and is itself an unguessable capability URL:
-- anyone holding it can send this device a push. It is therefore treated as a
-- secret in transit and in logs, and never returned to any client but its
-- owner.
-- ---------------------------------------------------------------------------
create table public.push_subscriptions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  endpoint   text        not null unique,
  -- The two halves of the client's ECDH keypair material, base64url. Required
  -- by RFC 8291 payload encryption; useless without the endpoint.
  p256dh     text        not null,
  auth       text        not null,
  -- Purely so a user can tell two devices apart in the UI ("Chrome on
  -- Windows"). Truncated by the client; never parsed or matched on.
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

create trigger push_subscriptions_set_updated_at
  before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- show_follows
--
-- Per-show opt-in. "All shows is noise, and noise gets notifications disabled
-- entirely" — so there is no global "notify me about everything" flag anywhere
-- in this schema, and no default that enables anything.
--
-- `followed_at` is load-bearing, not bookkeeping: design doc §2.1 rule 2 uses
-- it to guarantee that enabling notifications for a show that aired an episode
-- yesterday is SILENT. Only events detected after this instant may notify.
-- Without it, every opt-in produces an immediate burst about the past — the
-- same failure the watch log's no-backfill rule and the badge ledger's silent
-- first evaluation both exist to prevent.
--
-- `show_id` is our own provider id (TMDB's, in practice), not a UUID — it
-- matches `tracked_titles.title_id` so a follow can be joined against tracking
-- state for the suppression check in design doc §1.1.
-- ---------------------------------------------------------------------------
create table public.show_follows (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  show_id     text        not null check (char_length(show_id) between 1 and 64),
  followed_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, show_id)
);

-- The detector's driving query is "every distinct show anyone follows", so
-- this index is the one that keeps that from being a sequential scan as the
-- follow table grows.
create index show_follows_show_idx on public.show_follows (show_id);

create trigger show_follows_set_updated_at
  before update on public.show_follows
  for each row execute function public.set_updated_at();

-- `followed_at` must never move backwards, or a client could rewrite it to an
-- old instant and unlock exactly the backfill burst rule 2 exists to prevent.
-- Forward moves are allowed (re-following after unfollowing is a fresh opt-in).
create function public.show_follows_lock_followed_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.followed_at < old.followed_at then
    new.followed_at := old.followed_at;
  end if;
  return new;
end;
$$;

create trigger show_follows_lock_followed_at
  before update on public.show_follows
  for each row execute function public.show_follows_lock_followed_at();

-- ---------------------------------------------------------------------------
-- notification_prefs
--
-- One row per user. Quiet hours are stored as LOCAL WALL-CLOCK minutes since
-- midnight plus an IANA zone name — never a UTC instant, and never a fixed
-- offset.
--
-- ⚠️ THE FREEZE RUNS THE OPPOSITE WAY FROM lib/watchlog. Read design doc §5.
-- `localDayKey` freezes the day a thing was watched because that is HISTORY —
-- a fact about where the user WAS, which must not rewrite itself when they
-- travel. Quiet hours are a LIVE PREFERENCE about where the user IS. Freezing
-- a zone captured at subscribe time would wake someone at 3am after they move
-- to another country. So `timezone` is refreshed by the client whenever it
-- changes, and is deliberately mutable.
--
-- A fixed offset ('+03:00') would be wrong for a different reason: it breaks
-- across DST twice a year. The IANA name survives both.
-- ---------------------------------------------------------------------------
create table public.notification_prefs (
  user_id          uuid        primary key references auth.users (id) on delete cascade,
  -- Minutes since local midnight, 0-1439. Equal values mean "no quiet hours".
  -- start > end is legitimate and normal: 22:00-08:00 wraps midnight.
  quiet_start      smallint    not null default 1320 check (quiet_start between 0 and 1439),
  quiet_end        smallint    not null default 480  check (quiet_end   between 0 and 1439),
  -- IANA zone name, e.g. 'Europe/Istanbul'. Validated by the app, not by a
  -- CHECK: the tz database changes several times a year and a constraint would
  -- need a migration each time, rejecting names that became valid after this
  -- migration ran. Same app-layer-only reasoning as the reserved-username list.
  timezone         text        not null default 'UTC'
    check (char_length(timezone) between 1 and 64),
  -- Per-kind toggles. Both default TRUE because reaching this table at all
  -- already required an explicit per-show opt-in — a user who has followed a
  -- show has asked for its events. The opt-in that matters is `show_follows`.
  episode_aired    boolean     not null default true,
  season_announced boolean     not null default true,
  updated_at       timestamptz not null default now()
);

create trigger notification_prefs_set_updated_at
  before update on public.notification_prefs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- show_snapshots
--
-- WORLD DATA. What TMDB last told us about a show. Belongs to no user, is
-- written only by the cron, and is read by nobody through the API.
--
-- This is what makes "new season announced" detectable at all: "announced" is
-- inherently a CHANGE, with no timestamp on it anywhere in TMDB's response.
-- `number_of_seasons` going 2 -> 3 is only visible by comparison against what
-- we saw last time.
--
-- The first snapshot of a show emits NO events (design doc §2.1 rule 1). A
-- baseline is not a change.
-- ---------------------------------------------------------------------------
create table public.show_snapshots (
  show_id           text        primary key check (char_length(show_id) between 1 and 64),
  -- "s{season}e{episode}" of the most recent AIRED episode, or null if none.
  -- A stable string rather than two integers so it can be compared with one
  -- `is distinct from` and stored in `pending_notifications.event_key` as-is.
  last_episode_key  text,
  -- Highest season number TMDB lists, aired or not.
  latest_season     integer,
  -- TMDB's own `number_of_seasons`. Kept alongside `latest_season` because the
  -- two genuinely disagree for shows with specials (season 0), and disagreeing
  -- is not an error.
  seasons_count     integer,
  checked_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- pending_notifications
--
-- Detected but not yet sent. This table is the reason quiet hours cost
-- nothing: a notification that is due but currently silenced simply STAYS
-- HERE and is picked up by a later run once the window opens. No scheduler,
-- no retry queue, no timer — deferral falls out of the detect/deliver split
-- rather than being built (design doc §2.2).
--
-- The unique constraint is what makes overlapping or retried runs safe. Same
-- reasoning as the deterministic watch-event UUIDs in Phase 6 Step 5:
-- idempotency belongs in a KEY, not in careful sequencing.
-- ---------------------------------------------------------------------------
create table public.pending_notifications (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users (id) on delete cascade,
  show_id     text        not null check (char_length(show_id) between 1 and 64),
  event_kind  public.notification_event_kind not null,
  -- Identifies the specific world event: "s6e1", or "season:6". Combined with
  -- user+show this is the dedup identity.
  event_key   text        not null check (char_length(event_key) between 1 and 64),
  -- Title/body/deep link, resolved at DETECTION time so the sender never needs
  -- another TMDB call. jsonb rather than columns because this is a rendering
  -- payload, not queryable data — nothing ever filters on its contents.
  payload     jsonb       not null,
  detected_at timestamptz not null default now(),
  unique (user_id, show_id, event_key)
);

create index pending_notifications_user_idx on public.pending_notifications (user_id);

-- ---------------------------------------------------------------------------
-- notification_log
--
-- Written on SEND, never on detection. That ordering is the whole quiet-hours
-- mechanism (above) and must not be "tidied" into a single write at detection
-- time — doing so would mark silenced notifications as delivered and they
-- would never arrive.
--
-- Also the permanent dedup ledger: a row here means this user has been told
-- about this event, forever, even after the pending row is deleted.
-- ---------------------------------------------------------------------------
create table public.notification_log (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users (id) on delete cascade,
  show_id    text        not null check (char_length(show_id) between 1 and 64),
  event_kind public.notification_event_kind not null,
  event_key  text        not null check (char_length(event_key) between 1 and 64),
  sent_at    timestamptz not null default now(),
  unique (user_id, show_id, event_key)
);

create index notification_log_user_sent_idx on public.notification_log (user_id, sent_at desc);

-- ===========================================================================
-- RLS
-- ===========================================================================

alter table public.push_subscriptions    enable row level security;
alter table public.push_subscriptions    force  row level security;
alter table public.show_follows          enable row level security;
alter table public.show_follows          force  row level security;
alter table public.notification_prefs    enable row level security;
alter table public.notification_prefs    force  row level security;
alter table public.show_snapshots        enable row level security;
alter table public.show_snapshots        force  row level security;
alter table public.pending_notifications enable row level security;
alter table public.pending_notifications force  row level security;
alter table public.notification_log      enable row level security;
alter table public.notification_log      force  row level security;

-- ---------------------------------------------------------------------------
-- Own-rows tables.
--
-- Every WITH CHECK is written explicitly even though Postgres defaults it to
-- the USING expression — Phase 6 Step 3 corrected the belief that omitting it
-- is the vulnerability (it is not; a BROADER one is), and writing both keeps
-- intent reviewable and prevents a later accidental widening.
-- ---------------------------------------------------------------------------

create policy "push_subscriptions_select_own" on public.push_subscriptions
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "push_subscriptions_insert_own" on public.push_subscriptions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "push_subscriptions_update_own" on public.push_subscriptions
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "push_subscriptions_delete_own" on public.push_subscriptions
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "show_follows_select_own" on public.show_follows
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "show_follows_insert_own" on public.show_follows
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "show_follows_update_own" on public.show_follows
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "show_follows_delete_own" on public.show_follows
  for delete to authenticated
  using ((select auth.uid()) = user_id);

create policy "notification_prefs_select_own" on public.notification_prefs
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "notification_prefs_insert_own" on public.notification_prefs
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "notification_prefs_update_own" on public.notification_prefs
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "notification_prefs_delete_own" on public.notification_prefs
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- show_snapshots — world data, NO API access at all.
--
-- `USING (false)` is the entire policy and is deliberate, not a stub. There is
-- no user-facing read of this table that would ever be correct: it is the
-- notifier's private memory of what TMDB last said, and a client that wants
-- show data should call the content layer like everything else in this app.
--
-- The cron reaches it via the service role, which BYPASSRLS makes exempt from
-- every policy here. Nothing else reaches it.
--
-- A policy that denies everything is still required — with RLS forced and NO
-- policy at all, Postgres authorizes zero rows for every command, which is the
-- same outcome but says nothing about intent to the next reader.
-- ---------------------------------------------------------------------------
create policy "show_snapshots_no_api_access" on public.show_snapshots
  for all to authenticated, anon
  using (false)
  with check (false);

-- ---------------------------------------------------------------------------
-- pending_notifications / notification_log — server-written, user-readable.
--
-- SELECT only. A user may see what they are about to be told and what they
-- have been told (both are genuinely their data, and a "notification history"
-- surface is a reasonable later feature), but may not forge, edit, or replay
-- either. DELETE on `pending_notifications` is deliberately withheld too:
-- letting a client delete a pending row would let it silently cancel its own
-- notifications, which looks like a feature and is actually an untraceable
-- way for the system to appear broken.
-- ---------------------------------------------------------------------------
create policy "pending_notifications_select_own" on public.pending_notifications
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "notification_log_select_own" on public.notification_log
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ===========================================================================
-- GUARD: fail the migration if any public table escaped RLS.
--
-- Repeated verbatim from 20260801000001 rather than assumed still-passing:
-- this migration adds six tables, and "forgetting `enable row level security`"
-- produces no warning of any kind.
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
