-- ===========================================================================
-- Marquee — Phase 7 Step 5: notifications, attacked rather than asserted
--
-- Same discipline as every adversarial test in this directory: this does not
-- check that policies EXIST, it tries to defeat them and fails loudly if any
-- attempt succeeds. Runs in a transaction and rolls back, so it is safe
-- against a live project.
--
-- Four claims matter more than the rest:
--
--   1. A push endpoint is a CAPABILITY URL — anyone holding it can send that
--      device a notification. Bob must not be able to read, guess-confirm, or
--      steal Alice's (checks 1-4).
--   2. `show_snapshots` is world data with NO API access at all. Neither an
--      authenticated user nor anon may read or write it (checks 8-9). This is
--      the first `USING (false)` table in the project and the one most likely
--      to be "fixed" into something readable by a later reader.
--   3. `pending_notifications` / `notification_log` are read-only to their
--      owner. A client that could delete a pending row could silently cancel
--      its own notifications (checks 10-13).
--   4. `followed_at` cannot be moved backwards, because doing so would unlock
--      exactly the backfill burst design doc §2.1 rule 2 exists to prevent
--      (check 6).
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

set local role postgres;

do $$
declare
  alice uuid := '11111111-1111-1111-1111-111111111111';
  bob   uuid := '22222222-2222-2222-2222-222222222222';
  failures text[] := '{}';

  row_count  int;
  got_text   text;
  got_ts     timestamptz;
  alice_pending uuid;
begin
  insert into auth.users (id) values (alice), (bob) on conflict do nothing;

  -- =======================================================================
  -- Setup, as postgres (bypassing RLS) purely to seed fixtures quickly —
  -- matching the prior suites' style.
  -- =======================================================================
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
    values (alice, 'https://push.example/alice-secret-endpoint', 'alice-p256', 'alice-auth');
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
    values (bob, 'https://push.example/bob-endpoint', 'bob-p256', 'bob-auth');

  insert into public.show_follows (user_id, show_id) values (alice, 'breaking-bad');
  insert into public.notification_prefs (user_id, timezone) values (alice, 'Europe/Istanbul');

  insert into public.show_snapshots (show_id, last_episode_key, latest_season, seasons_count)
    values ('breaking-bad', 's5e16', 5, 5);

  insert into public.pending_notifications (user_id, show_id, event_kind, event_key, payload)
    values (alice, 'breaking-bad', 'episode_aired', 's6e1', '{"title":"New episode"}'::jsonb)
    returning id into alice_pending;

  insert into public.notification_log (user_id, show_id, event_kind, event_key)
    values (alice, 'breaking-bad', 'episode_aired', 's5e16');

  -- =======================================================================
  -- BOB ATTACKS
  -- =======================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  -- 1. Bob cannot read Alice's push subscription (the endpoint is a secret).
  select count(*) into row_count from public.push_subscriptions where user_id = alice;
  if row_count <> 0 then
    failures := array_append(failures, format('1. Bob read %s of Alice''s push subscriptions', row_count));
  end if;

  -- 2. Nor by guessing the endpoint directly — a targeted lookup must also
  --    return nothing, not merely be filtered from a list.
  select count(*) into row_count
    from public.push_subscriptions
   where endpoint = 'https://push.example/alice-secret-endpoint';
  if row_count <> 0 then
    failures := array_append(failures, '2. Bob confirmed Alice''s endpoint by direct lookup');
  end if;

  -- 3. Bob cannot forge a subscription attributed to Alice — this would
  --    redirect her notifications to a device he controls.
  begin
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
      values (alice, 'https://push.example/attacker-device', 'x', 'y');
    failures := array_append(failures, '3. Bob inserted a push subscription owned by Alice');
  exception when others then
    null;
  end;

  -- 4. Bob cannot hijack his OWN row into Alice's account either. This is the
  --    Phase 6 Step 3 lesson: the hole is a WITH CHECK broader than USING, and
  --    an unqualified UPDATE is the form that finds it.
  begin
    update public.push_subscriptions set user_id = alice;
    -- Blocked-by-zero-rows is a pass; blocked-by-raise is a pass. Only an
    -- actual reassignment is a failure, so re-read out of band.
    null;
  exception when others then
    null;
  end;
  set local role postgres;
  reset request.jwt.claims;
  select count(*) into row_count
    from public.push_subscriptions where user_id = alice and p256dh = 'bob-p256';
  if row_count <> 0 then
    failures := array_append(failures, '4. Bob reassigned his own subscription to Alice');
  end if;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  -- 5. Bob cannot see which shows Alice follows. A follow list is a taste
  --    profile, not public information.
  select count(*) into row_count from public.show_follows where user_id = alice;
  if row_count <> 0 then
    failures := array_append(failures, '5. Bob read Alice''s show follows');
  end if;

  -- 6. followed_at cannot move BACKWARDS, even by its own owner. Moving it
  --    back would unlock a burst of notifications about already-past events.
  set local role postgres;
  reset request.jwt.claims;
  update public.show_follows
     set followed_at = now() - interval '10 years'
   where user_id = alice and show_id = 'breaking-bad';
  select followed_at into got_ts
    from public.show_follows where user_id = alice and show_id = 'breaking-bad';
  if got_ts < now() - interval '1 day' then
    failures := array_append(failures,
      format('6. followed_at was moved backwards to %s — the backfill gate is defeatable', got_ts));
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  -- 7. Bob cannot read Alice's prefs (her timezone is location data).
  select count(*) into row_count from public.notification_prefs where user_id = alice;
  if row_count <> 0 then
    failures := array_append(failures, '7. Bob read Alice''s notification prefs, including her timezone');
  end if;

  -- =======================================================================
  -- show_snapshots — world data, NO API access for ANY role
  -- =======================================================================

  -- 8. An authenticated user reads nothing.
  select count(*) into row_count from public.show_snapshots;
  if row_count <> 0 then
    failures := array_append(failures, format('8. authenticated read %s show_snapshots rows; expected 0', row_count));
  end if;

  -- 9. And cannot write one either — a forged snapshot would let an attacker
  --    suppress everyone's notifications for a show by pre-declaring its
  --    latest episode.
  begin
    insert into public.show_snapshots (show_id, last_episode_key) values ('forged', 's9e9');
    failures := array_append(failures, '9. authenticated inserted a show_snapshots row');
  exception when others then
    null;
  end;

  -- 9b. anon likewise sees nothing.
  set local role anon;
  reset request.jwt.claims;
  select count(*) into row_count from public.show_snapshots;
  if row_count <> 0 then
    failures := array_append(failures, format('9b. anon read %s show_snapshots rows; expected 0', row_count));
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  -- =======================================================================
  -- pending_notifications / notification_log — own-row READ ONLY
  -- =======================================================================

  -- 10. Bob cannot read Alice's pending notifications.
  select count(*) into row_count from public.pending_notifications where user_id = alice;
  if row_count <> 0 then
    failures := array_append(failures, '10. Bob read Alice''s pending notifications');
  end if;

  -- 11. Bob cannot forge one for himself. Forging a pending row is forging a
  --     push payload — the sender renders `payload` verbatim.
  begin
    insert into public.pending_notifications (user_id, show_id, event_kind, event_key, payload)
      values (bob, 'breaking-bad', 'episode_aired', 'forged', '{"title":"click here"}'::jsonb);
    failures := array_append(failures, '11. Bob forged a pending notification for himself');
  exception when others then
    null;
  end;

  -- 12. Alice cannot DELETE her own pending row. Deliberate: a client able to
  --     delete pending rows can silently cancel its own notifications, which
  --     presents as "the system is broken" with no trace of why.
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);
  delete from public.pending_notifications where id = alice_pending;
  get diagnostics row_count = row_count;
  if row_count <> 0 then
    failures := array_append(failures, '12. Alice deleted her own pending notification');
  end if;

  -- 12b. ...and it is genuinely still there, not merely un-deleted-looking.
  set local role postgres;
  reset request.jwt.claims;
  select count(*) into row_count from public.pending_notifications where id = alice_pending;
  if row_count <> 1 then
    failures := array_append(failures, '12b. the pending row Alice tried to delete is gone');
  end if;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  -- 13. Alice cannot forge a notification_log entry. Doing so would let a
  --     client permanently suppress a real future notification by pre-claiming
  --     its (user, show, event_key) — the unique constraint would then reject
  --     the genuine send.
  begin
    insert into public.notification_log (user_id, show_id, event_kind, event_key)
      values (alice, 'breaking-bad', 'episode_aired', 's7e1');
    failures := array_append(failures, '13. Alice forged a notification_log entry, suppressing a future real send');
  exception when others then
    null;
  end;

  -- 14. Alice CAN read her own log — this is her data and a history surface is
  --     a reasonable feature. A positive control: if this returns 0, the
  --     policies above are too tight rather than too loose, and checks 10-13
  --     would pass vacuously.
  select count(*) into row_count from public.notification_log where user_id = alice;
  if row_count <> 1 then
    failures := array_append(failures,
      format('14. POSITIVE CONTROL FAILED: Alice read %s of her own log rows, expected 1', row_count));
  else
    raise notice 'PASS 14. positive control: Alice CAN read her own notification log';
  end if;

  -- 15. The dedup constraint actually holds — two sends of the same event for
  --     the same user are impossible, which is what makes overlapping cron
  --     runs safe.
  set local role postgres;
  reset request.jwt.claims;
  begin
    insert into public.notification_log (user_id, show_id, event_kind, event_key)
      values (alice, 'breaking-bad', 'episode_aired', 's5e16');
    failures := array_append(failures, '15. a duplicate notification_log row was accepted — overlapping runs can double-send');
  exception when unique_violation then
    raise notice 'PASS 15. duplicate sends are rejected by the unique constraint';
  end;

  -- 16. The event-kind enum rejects a behaviour-shaped event. Not security —
  --     this pins design doc §1.1 as a SCHEMA-level constraint, so adding
  --     "you haven't watched this" requires a migration and therefore review.
  begin
    execute $q$insert into public.pending_notifications (user_id, show_id, event_kind, event_key, payload)
              values ($1, 'breaking-bad', 'you_are_behind', 'x', '{}'::jsonb)$q$
      using alice;
    failures := array_append(failures, '16. a behaviour-shaped event kind was accepted by the enum');
  exception when others then
    raise notice 'PASS 16. event kinds are constrained by an enum, so a behaviour ping needs a migration';
  end;

  -- =======================================================================
  -- 17. NEGATIVE CONTROL — proves the harness can tell protected from
  --     unprotected. Without this, checks 1-13 would all pass against a
  --     database with no policies at all if the role switching were broken.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;

  create table public.push_control (
    user_id  uuid not null,
    endpoint text not null
  );
  alter table public.push_control enable row level security;
  create policy "wide_open" on public.push_control for select to authenticated using (true);
  insert into public.push_control values (alice, 'https://push.example/alice-secret-endpoint');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  select count(*) into row_count from public.push_control;
  if row_count <> 1 then
    failures := array_append(failures,
      '17. NEGATIVE CONTROL FAILED: an intentionally wide-open table did not leak, so this test cannot distinguish protected from unprotected');
  else
    raise notice 'PASS 17. negative control: an unprotected table DOES leak, confirming the harness detects a missing gate';
  end if;

  set local role postgres;
  reset request.jwt.claims;
  drop table public.push_control;

  -- =======================================================================
  if array_length(failures, 1) > 0 then
    raise exception E'\n=== NOTIFICATIONS ADVERSARIAL FAILURES ===\n%', array_to_string(failures, E'\n');
  end if;

  raise notice '=== ALL NOTIFICATION CHECKS PASSED ===';
end;
$$;

rollback;
