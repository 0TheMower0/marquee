-- ===========================================================================
-- Marquee — Phase 6 Step 5: conflict rules, enforced in the database
--
-- Implements docs/phase-6-sync-design.md §4.2 (last-write-wins on
-- `client_updated_at`) and the two monotonic rules from §4.2's table
-- (`LEAST(earned_at)` for badges, `GREATEST(highest_level_seen)` for XP).
--
-- ---------------------------------------------------------------------------
-- WHY THESE ARE TRIGGERS AND NOT CLIENT LOGIC
-- ---------------------------------------------------------------------------
-- The obvious implementation is "read the row, compare, decide, write" in the
-- sync client. That is wrong for three separate reasons:
--
--   1. It is a race. Between the read and the write another device can commit,
--      and the loser silently overwrites the winner. The whole point of LWW is
--      that the outcome is a function of when the USER acted, not of who
--      happened to write last.
--   2. It costs a round trip per record, turning a batched upsert of 300
--      episodes into 300 reads.
--   3. It can be bypassed. PostgREST is a public API: anything holding a valid
--      session token can write these tables directly, and a rule that lives
--      only in our client is not a rule.
--
-- As BEFORE triggers the comparison happens inside the same statement that
-- writes, under the row lock, and applies to every writer without exception.
--
-- A stale write is skipped SILENTLY (`return null`), not rejected with an
-- error. It is not a failure — it is LWW working. Raising would make the
-- outbox retry a write that is correctly being ignored, forever.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Last-write-wins on client_updated_at
--
-- `return null` in a BEFORE trigger cancels the operation for that row,
-- leaving the existing row untouched. The statement still succeeds, which is
-- what lets a batch upsert contain a mix of newer and older rows and apply
-- exactly the newer ones.
--
-- Trigger NAMING matters here. Postgres fires triggers for the same event in
-- alphabetical order, and `<table>_clamp` (which pins a future-dated
-- client_updated_at to now(), from the initial migration) must run BEFORE this
-- comparison — otherwise a device with a fast clock would win the comparison
-- using the very timestamp the clamp exists to reject. "clamp" sorts before
-- "lww", so the required order is the one we get. Do not rename either
-- trigger without re-checking that.
-- ---------------------------------------------------------------------------
create or replace function public.reject_stale_write()
returns trigger
language plpgsql
as $$
begin
  if new.client_updated_at < old.client_updated_at then
    return null;
  end if;
  return new;
end;
$$;

create trigger tracked_titles_lww
  before update on public.tracked_titles
  for each row execute function public.reject_stale_write();

create trigger watched_episodes_lww
  before update on public.watched_episodes
  for each row execute function public.reject_stale_write();

create trigger ratings_lww
  before update on public.ratings
  for each row execute function public.reject_stale_write();

create trigger rating_notes_lww
  before update on public.rating_notes
  for each row execute function public.reject_stale_write();

-- ---------------------------------------------------------------------------
-- badges_earned: LEAST(earned_at)
--
-- A badge is earned exactly once. Whichever device saw it first holds the true
-- moment, and a later device re-uploading its own (later) timestamp must not
-- move the date forward. Monotonic and lossless — there is no case where the
-- later value is the correct one.
--
-- Note this table has no `client_updated_at` and therefore no LWW trigger:
-- the value itself carries the ordering, so a separate conflict clock would be
-- a second, redundant source of truth.
-- ---------------------------------------------------------------------------
create or replace function public.keep_earliest_earned_at()
returns trigger
language plpgsql
as $$
begin
  new.earned_at := least(new.earned_at, old.earned_at);
  new.updated_at := now();
  return new;
end;
$$;

create trigger badges_earned_least
  before update on public.badges_earned
  for each row execute function public.keep_earliest_earned_at();

-- ---------------------------------------------------------------------------
-- xp_state: GREATEST(highest_level_seen)
--
-- "Highest level the celebration has already been shown for" only ever
-- increases. Taking the greater value means a device that has been offline
-- through several level-ups cannot roll the marker backwards and re-fire
-- celebrations the user already saw.
-- ---------------------------------------------------------------------------
create or replace function public.keep_highest_level()
returns trigger
language plpgsql
as $$
begin
  new.highest_level_seen := greatest(new.highest_level_seen, old.highest_level_seen);
  new.updated_at := now();
  return new;
end;
$$;

create trigger xp_state_greatest
  before update on public.xp_state
  for each row execute function public.keep_highest_level();

-- ---------------------------------------------------------------------------
-- The one missing pull-cursor index.
--
-- Every sync pull is `where user_id = auth.uid() and updated_at > :cursor`,
-- per table (design doc §5). The initial migration already created that index
-- on six of the seven tables; `xp_state` was the omission.
--
-- ⚠ A NOTE FOR WHOEVER ADDS THE NEXT ONE. An earlier draft of this migration
-- tried to add `watch_events (user_id, created_at)` — on the assumption that
-- an append-only table has no `updated_at` — using `if not exists`. It has
-- one, and the index name was already taken, so the statement was silently
-- SKIPPED and no index on `created_at` was ever created. The sync client was
-- meanwhile querying by `created_at`, so the "indexed" pull would have been a
-- sequential scan of every event the user has ever logged. Caught by applying
-- this migration to a real database and reading the NOTICEs, not by review.
--
-- Two lessons worth keeping: `if not exists` matches on the NAME, not on the
-- definition, so it silently accepts a different index wearing the same name;
-- and the cursor column in `lib/sync/backend.ts` must match the indexed column
-- exactly. Every table now uses `updated_at`, including `watch_events`.
-- ---------------------------------------------------------------------------
create index if not exists xp_state_pull_cursor
  on public.xp_state (user_id, updated_at);

-- ===========================================================================
-- Same guard every migration in this directory ends with.
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
