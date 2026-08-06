-- ===========================================================================
-- Marquee — Phase 6 Step 5: the conflict rules, attacked rather than asserted
--
-- Same discipline as 01_rls_adversarial.sql: this does not check that triggers
-- EXIST, it tries to make them lose data and fails loudly if any attempt
-- succeeds. Runs in a transaction and rolls back, so it is safe against a live
-- project.
--
-- Every check below corresponds to a rule in docs/phase-6-sync-design.md §4.2.
-- These are the rules that decide whether a user's edit survives a conflict,
-- so "it looked right in review" is not a standard worth relying on.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

set local role postgres;

do $$
declare
  alice uuid := '11111111-1111-1111-1111-111111111111';
  failures text[] := '{}';
  got_status text;
  got_score int;
  got_note text;
  got_deleted timestamptz;
  got_earned timestamptz;
  got_level int;
  row_count int;
begin
  insert into auth.users (id) values (alice) on conflict do nothing;

  -- =======================================================================
  -- 1. LWW: a NEWER client_updated_at wins
  -- =======================================================================
  insert into public.tracked_titles
    (user_id, media_type, title_id, status, summary, added_at, client_updated_at)
  values (alice, 'tv', 'lww', 'watchlist', '{}'::jsonb, now(), '2026-01-01T00:00:00Z');

  insert into public.tracked_titles
    (user_id, media_type, title_id, status, summary, added_at, client_updated_at)
  values (alice, 'tv', 'lww', 'watched', '{}'::jsonb, now(), '2026-06-01T00:00:00Z')
  on conflict (user_id, media_type, title_id) do update
    set status = excluded.status,
        client_updated_at = excluded.client_updated_at;

  select status into got_status from public.tracked_titles
   where user_id = alice and title_id = 'lww';
  if got_status is distinct from 'watched' then
    failures := array_append(failures,
      format('1. a NEWER write did not win (status=%s)', got_status));
  end if;

  -- =======================================================================
  -- 2. LWW: an OLDER client_updated_at is silently ignored
  --
  -- This is the one that matters. Without the trigger, a device that has been
  -- offline for a week reconnects and its stale state overwrites everything
  -- newer — the exact "last to sync wins" failure the design rejects.
  -- =======================================================================
  insert into public.tracked_titles
    (user_id, media_type, title_id, status, summary, added_at, client_updated_at)
  values (alice, 'tv', 'lww', 'watchlist', '{}'::jsonb, now(), '2026-02-01T00:00:00Z')
  on conflict (user_id, media_type, title_id) do update
    set status = excluded.status,
        client_updated_at = excluded.client_updated_at;

  select status into got_status from public.tracked_titles
   where user_id = alice and title_id = 'lww';
  if got_status is distinct from 'watched' then
    failures := array_append(failures,
      format('2. AN OLDER WRITE OVERWROTE A NEWER ONE (status=%s) — LWW is not enforced', got_status));
  end if;

  -- =======================================================================
  -- 3. A stale write does not RAISE — it is a no-op
  --
  -- If it errored, the outbox would retry forever a write that is correctly
  -- being ignored, and the user would see a permanent sync failure.
  -- =======================================================================
  begin
    insert into public.tracked_titles
      (user_id, media_type, title_id, status, summary, added_at, client_updated_at)
    values (alice, 'tv', 'lww', 'watchlist', '{}'::jsonb, now(), '2020-01-01T00:00:00Z')
    on conflict (user_id, media_type, title_id) do update
      set status = excluded.status, client_updated_at = excluded.client_updated_at;
  exception when others then
    failures := array_append(failures, '3. a stale write RAISED instead of being ignored');
  end;

  -- =======================================================================
  -- 4. Episodes: two devices, two different episodes, no conflict at all
  --    (design doc §4.1 — the whole return on exploding the range encoding)
  -- =======================================================================
  insert into public.watched_episodes
    (user_id, media_type, title_id, season_number, episode_number, client_updated_at)
  values (alice, 'tv', 'lww', 3, 4, '2026-05-01T00:00:00Z'),
         (alice, 'tv', 'lww', 3, 5, '2026-05-02T00:00:00Z')
  on conflict do nothing;

  select count(*) into row_count from public.watched_episodes
   where user_id = alice and title_id = 'lww' and deleted_at is null;
  if row_count <> 2 then
    failures := array_append(failures,
      format('4. two devices marking different episodes did not both land (rows=%s)', row_count));
  end if;

  -- =======================================================================
  -- 5. Un-marking writes a TOMBSTONE and a later re-mark resurrects it
  -- =======================================================================
  insert into public.watched_episodes
    (user_id, media_type, title_id, season_number, episode_number, client_updated_at, deleted_at)
  values (alice, 'tv', 'lww', 3, 4, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')
  on conflict (user_id, media_type, title_id, season_number, episode_number) do update
    set client_updated_at = excluded.client_updated_at, deleted_at = excluded.deleted_at;

  select deleted_at into got_deleted from public.watched_episodes
   where user_id = alice and title_id = 'lww' and season_number = 3 and episode_number = 4;
  if got_deleted is null then
    failures := array_append(failures, '5a. the un-mark did not tombstone the episode');
  end if;

  -- An OLDER re-mark must NOT resurrect it.
  insert into public.watched_episodes
    (user_id, media_type, title_id, season_number, episode_number, client_updated_at, deleted_at)
  values (alice, 'tv', 'lww', 3, 4, '2026-05-15T00:00:00Z', null)
  on conflict (user_id, media_type, title_id, season_number, episode_number) do update
    set client_updated_at = excluded.client_updated_at, deleted_at = excluded.deleted_at;

  select deleted_at into got_deleted from public.watched_episodes
   where user_id = alice and title_id = 'lww' and season_number = 3 and episode_number = 4;
  if got_deleted is null then
    failures := array_append(failures,
      '5b. an OLDER re-mark resurrected a tombstoned episode — sync order, not user intent, decided');
  end if;

  -- A NEWER re-mark must resurrect it.
  insert into public.watched_episodes
    (user_id, media_type, title_id, season_number, episode_number, client_updated_at, deleted_at)
  values (alice, 'tv', 'lww', 3, 4, '2026-07-01T00:00:00Z', null)
  on conflict (user_id, media_type, title_id, season_number, episode_number) do update
    set client_updated_at = excluded.client_updated_at, deleted_at = excluded.deleted_at;

  select deleted_at into got_deleted from public.watched_episodes
   where user_id = alice and title_id = 'lww' and season_number = 3 and episode_number = 4;
  if got_deleted is not null then
    failures := array_append(failures, '5c. a NEWER re-mark did not resurrect the episode');
  end if;

  -- =======================================================================
  -- 6. Ratings and notes take LWW independently, per table
  -- =======================================================================
  insert into public.ratings (user_id, media_type, title_id, score, client_updated_at)
  values (alice, 'tv', 'lww', 90, '2026-06-01T00:00:00Z');
  insert into public.rating_notes (user_id, media_type, title_id, note, client_updated_at)
  values (alice, 'tv', 'lww', 'kept', '2026-06-01T00:00:00Z');

  -- An older score arrives; the note must be untouched by it.
  insert into public.ratings (user_id, media_type, title_id, score, client_updated_at)
  values (alice, 'tv', 'lww', 10, '2026-01-01T00:00:00Z')
  on conflict (user_id, media_type, title_id) do update
    set score = excluded.score, client_updated_at = excluded.client_updated_at;

  select score into got_score from public.ratings
   where user_id = alice and title_id = 'lww';
  select note into got_note from public.rating_notes
   where user_id = alice and title_id = 'lww';

  if got_score is distinct from 90 then
    failures := array_append(failures, format('6a. an older score overwrote a newer one (%s)', got_score));
  end if;
  if got_note is distinct from 'kept' then
    failures := array_append(failures, format('6b. a score write disturbed the note (%s)', got_note));
  end if;

  -- =======================================================================
  -- 7. watch_events: re-inserting the same id is a no-op, not a duplicate
  --
  -- This is the server half of the "just run the merge again" guarantee. The
  -- client half (deterministic v5 ids) is covered in lib/sync/merge.test.ts.
  -- =======================================================================
  insert into public.watch_events (id, user_id, day_key, kind, media_type, title_id, season_number, episode_number)
  values ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', alice, '2026-07-01', 'episode', 'tv', 'lww', 1, 1)
  on conflict (id) do nothing;
  insert into public.watch_events (id, user_id, day_key, kind, media_type, title_id, season_number, episode_number)
  values ('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', alice, '2026-07-01', 'episode', 'tv', 'lww', 1, 1)
  on conflict (id) do nothing;

  select count(*) into row_count from public.watch_events where user_id = alice;
  if row_count <> 1 then
    failures := array_append(failures,
      format('7. replaying a watch event duplicated it (rows=%s) — the merge is not idempotent', row_count));
  end if;

  -- =======================================================================
  -- 8. day_key survives verbatim. §2.3: deriving it from a timestamp rewrites
  --    a user's streak history when they travel.
  -- =======================================================================
  if (select day_key from public.watch_events where user_id = alice) <> date '2026-07-01' then
    failures := array_append(failures, '8. day_key was altered on write');
  end if;

  -- =======================================================================
  -- 9. badges_earned takes LEAST(earned_at)
  -- =======================================================================
  insert into public.badges_earned (user_id, badge_id, earned_at)
  values (alice, 'marathoner', '2026-03-01T00:00:00Z');
  insert into public.badges_earned (user_id, badge_id, earned_at)
  values (alice, 'marathoner', '2026-09-01T00:00:00Z')
  on conflict (user_id, badge_id) do update set earned_at = excluded.earned_at;

  select earned_at into got_earned from public.badges_earned
   where user_id = alice and badge_id = 'marathoner';
  if got_earned <> '2026-03-01T00:00:00Z'::timestamptz then
    failures := array_append(failures,
      format('9. a later badge date moved the earned_at forward (%s)', got_earned));
  end if;

  -- =======================================================================
  -- 10. xp_state takes GREATEST(highest_level_seen)
  -- =======================================================================
  insert into public.xp_state (user_id, highest_level_seen) values (alice, 30);
  insert into public.xp_state (user_id, highest_level_seen) values (alice, 4)
  on conflict (user_id) do update set highest_level_seen = excluded.highest_level_seen;

  select highest_level_seen into got_level from public.xp_state where user_id = alice;
  if got_level <> 30 then
    failures := array_append(failures,
      format('10. a stale device rolled highest_level_seen backwards (%s)', got_level));
  end if;

  -- =======================================================================
  -- 11. NEGATIVE CONTROL — the test must be able to detect a missing rule.
  --
  -- Without this, checks 1-10 would pass just as happily against a database
  -- where none of the triggers exist. A table with the same shape and NO
  -- trigger must show the older write winning.
  -- =======================================================================
  create table public.lww_control (
    user_id uuid not null,
    title_id text not null,
    status text not null,
    client_updated_at timestamptz not null,
    primary key (user_id, title_id)
  );

  insert into public.lww_control values (alice, 'x', 'watched', '2026-06-01T00:00:00Z');
  insert into public.lww_control values (alice, 'x', 'watchlist', '2026-01-01T00:00:00Z')
  on conflict (user_id, title_id) do update
    set status = excluded.status, client_updated_at = excluded.client_updated_at;

  select status into got_status from public.lww_control where user_id = alice;
  if got_status is distinct from 'watchlist' then
    failures := array_append(failures,
      '11. NEGATIVE CONTROL FAILED: an unprotected table did not lose the newer write, so this test cannot tell protected from unprotected');
  else
    raise notice 'PASS 11. negative control: without the trigger the older write DID win (status=%)', got_status;
  end if;

  drop table public.lww_control;

  -- =======================================================================
  if array_length(failures, 1) > 0 then
    raise exception E'\n=== SYNC CONFLICT RULE FAILURES ===\n%', array_to_string(failures, E'\n');
  end if;

  raise notice '=== ALL SYNC CONFLICT CHECKS PASSED ===';
end;
$$;

rollback;
