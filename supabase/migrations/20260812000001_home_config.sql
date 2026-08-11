-- ===========================================================================
-- Marquee — Phase 8 Step 2: Home customization
--
-- Same "schema and RLS in one transaction" discipline as every migration in
-- this directory — see 20260801000001's header for why a public table must
-- never exist without RLS for even one instant.
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE, DESPITE CARRYING NO REAL DATA
-- ---------------------------------------------------------------------------
-- home_config is a UI preference — which sections show on Home, in what
-- order, and which route the app opens to. Losing it costs a user nothing
-- but a re-click; it is nothing like the tracking/ratings/watch-log tables
-- this schema otherwise protects. It still gets the same RLS discipline as
-- everything else, because "low stakes" is not an exemption from "a public
-- table without RLS is world-readable through PostgREST" — see the guard at
-- the bottom of this file.
--
-- ---------------------------------------------------------------------------
-- THE CONFLICT RULE IS THE SIMPLEST ONE IN THIS SCHEMA, ON PURPOSE
-- ---------------------------------------------------------------------------
-- Every other table with a `client_updated_at` column needs it because two
-- devices can make DIFFERENT KINDS of progress that both deserve to survive —
-- that is what `tracked_titles`/`watched_episodes` union rather than pick a
-- winner. A settings blob has no meaningful union: there is no honest way to
-- "merge" section order A with section order B. So this reuses the SAME
-- generic `clamp_client_updated_at()` / `reject_stale_write()` triggers
-- every LWW table already has (20260801000001, 20260807000001) with no new
-- trigger logic at all — whichever device touched settings more recently
-- wins, wholesale. That is the correct answer for arbitrary preference data,
-- and it is also exactly what `lib/sync/merge.ts`'s first-login rule for
-- this table does (see the comment there): pick the newer side, don't merge.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- home_config
--
-- One row per user, matching xp_state's shape (single settings record, no
-- soft-delete — there is no "deleted" state for a preference, only "reset to
-- default", which is an ordinary update).
--
-- `config` is a single jsonb column rather than a column per field
-- (first_page, sections, show_streak_badge, ...) DELIBERATELY. The shape of
-- this preference blob is expected to grow (a future step might add more
-- toggles), and a jsonb column means that growth is a client-side type change
-- plus a `lib/storage` migration — the SAME lazy, per-record migration
-- discipline every local store in this app already uses — rather than a new
-- SQL migration and a new column on every growth. The cost, accepted
-- deliberately: this column cannot be queried or indexed by field, which is
-- fine, because nothing server-side ever needs to filter by field — the
-- notifier reads other tables for its own purposes, and this table has
-- exactly one caller: the owning user's own settings page.
-- ---------------------------------------------------------------------------
create table public.home_config (
  user_id           uuid        primary key references auth.users (id) on delete cascade,
  config            jsonb       not null default '{}'::jsonb,
  client_updated_at timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Reused, not redefined — both functions already exist from
-- 20260801000001_initial_schema.sql and 20260807000001_sync_conflict_rules.sql
-- respectively. Trigger NAME ORDER matters: Postgres fires same-event
-- triggers alphabetically, and "home_config_clamp" must sort before
-- "home_config_lww" so the clamp (which pins a future-dated
-- client_updated_at to now()) runs before the comparison that would
-- otherwise let a fast client clock win using the very timestamp the clamp
-- exists to reject. It does, by construction, but is worth re-checking if
-- either name ever changes — see the identical note on the original four
-- LWW tables.
create trigger home_config_clamp
  before insert or update on public.home_config
  for each row execute function public.clamp_client_updated_at();

create trigger home_config_lww
  before update on public.home_config
  for each row execute function public.reject_stale_write();

-- ===========================================================================
-- ROW LEVEL SECURITY — own-rows, identical shape to every other user table.
-- ===========================================================================

alter table public.home_config enable row level security;
alter table public.home_config force  row level security;
revoke all on public.home_config from anon;

create policy "home_config_select_own" on public.home_config
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "home_config_insert_own" on public.home_config
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "home_config_update_own" on public.home_config
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "home_config_delete_own" on public.home_config
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ===========================================================================
-- GUARD: fail the migration if any public table escaped RLS.
--
-- Repeated verbatim from every prior migration rather than assumed
-- still-passing: "forgetting `enable row level security`" produces no
-- warning of any kind, on a table however low-stakes.
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
