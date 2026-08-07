-- ===========================================================================
-- Marquee — Phase 6 Step 6: comments, attacked rather than asserted
--
-- Same discipline as 01_rls_adversarial.sql and 02_sync_conflict_rules.sql —
-- this does not check that policies EXIST, it tries to defeat them and fails
-- loudly if any attempt succeeds. Runs in a transaction and rolls back.
--
-- The single most important claim in this whole feature is check 1: a reader
-- who has NOT watched an episode receives ZERO rows for that episode's
-- comments — not a blurred row, not a "spoiler hidden" placeholder, nothing
-- at all. That is what "ours knows where you are" actually means, and it is
-- the one thing worth being paranoid about.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

set local role postgres;

do $$
declare
  alice uuid := '11111111-1111-1111-1111-111111111111'; -- watched S1E1, not S1E2
  bob   uuid := '22222222-2222-2222-2222-222222222222'; -- author of the spoiler comment
  carol uuid := '33333333-3333-3333-3333-333333333333'; -- has watched S1E2
  dave  uuid := '44444444-4444-4444-4444-444444444444';
  eve   uuid := '55555555-5555-5555-5555-555555555555';
  failures text[] := '{}';

  spoiler_comment_id uuid;
  reply_id uuid;
  hidden_comment_id uuid;
  row_count int;
  got_count bigint;
  got_status text;
  got_body text;
begin
  insert into auth.users (id) values (alice), (bob), (carol), (dave), (eve)
    on conflict do nothing;

  insert into public.profiles (id, username) values
    (alice, 'alice'), (bob, 'bob'), (carol, 'carol'), (dave, 'dave'), (eve, 'eve')
  on conflict do nothing;

  -- Ground truth: alice has watched S1E1 only. Carol, dave and eve have
  -- watched S1E2 (needed later so eve can legitimately report bob's comment).
  insert into public.tracked_titles (user_id, media_type, title_id, status, summary, added_at, client_updated_at)
  values
    (alice, 'tv', 'show1', 'watching', '{}'::jsonb, now(), now()),
    (bob,   'tv', 'show1', 'watching', '{}'::jsonb, now(), now()),
    (carol, 'tv', 'show1', 'watching', '{}'::jsonb, now(), now()),
    (dave,  'tv', 'show1', 'watching', '{}'::jsonb, now(), now()),
    (eve,   'tv', 'show1', 'watching', '{}'::jsonb, now(), now());

  insert into public.watched_episodes (user_id, media_type, title_id, season_number, episode_number, client_updated_at)
  values
    (alice, 'tv', 'show1', 1, 1, now()),
    (bob,   'tv', 'show1', 1, 2, now()),
    (carol, 'tv', 'show1', 1, 2, now()),
    (dave,  'tv', 'show1', 1, 2, now()),
    (eve,   'tv', 'show1', 1, 2, now());

  -- =======================================================================
  -- 1. THE CORE CLAIM: bob posts a spoiler comment on S1E2. Alice — who has
  --    only watched S1E1 — must receive ZERO rows querying that scope. Not a
  --    hidden-but-present row: zero.
  -- =======================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  insert into public.comments (user_id, media_type, title_id, season_number, episode_number, body)
  values (bob, 'tv', 'show1', 1, 2, 'I cannot believe the season finale twist!')
  returning id into spoiler_comment_id;

  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  select count(*) into row_count from public.comments
   where media_type = 'tv' and title_id = 'show1' and season_number = 1 and episode_number = 2;

  if row_count <> 0 then
    failures := array_append(failures,
      format('1. ALICE SAW THE SPOILER: %s row(s) returned for an episode she has not watched', row_count));
  else
    raise notice 'PASS 1. reader who has not watched the episode gets zero rows, not a hidden one';
  end if;

  -- Direct lookup by id must ALSO fail — not just the list query.
  select count(*) into row_count from public.comments where id = spoiler_comment_id;
  if row_count <> 0 then
    failures := array_append(failures, '1b. direct SELECT by id leaked the spoiler comment to alice');
  end if;

  -- =======================================================================
  -- 2. Carol HAS watched S1E2 — she must see it.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  select count(*) into row_count from public.comments where id = spoiler_comment_id;
  if row_count <> 1 then
    failures := array_append(failures, '2. carol, who HAS watched the episode, could not see the comment');
  end if;

  -- =======================================================================
  -- 3. ALICE CANNOT POST THERE EITHER. The insert gate mirrors the select
  --    gate exactly — she should not be able to write into a scope she can't
  --    read back.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  begin
    insert into public.comments (user_id, media_type, title_id, season_number, episode_number, body)
    values (alice, 'tv', 'show1', 1, 2, 'trying to post where I cannot read');
    failures := array_append(failures, '3. alice was able to POST into an episode scope she cannot see');
  exception when others then
    raise notice 'PASS 3. posting into an unwatched episode scope is rejected';
  end;

  -- =======================================================================
  -- 4. Alice CAN post/read a TV title-level comment (open, ungated) even
  --    though she has not finished the show.
  -- =======================================================================
  insert into public.comments (user_id, media_type, title_id, body)
  values (alice, 'tv', 'show1', 'loving this show so far, no spoilers pls');

  select count(*) into row_count from public.comments
   where media_type = 'tv' and title_id = 'show1' and season_number is null;
  if row_count <> 1 then
    failures := array_append(failures, format('4. tv title-level comment was not visible/postable (rows=%s)', row_count));
  end if;

  -- =======================================================================
  -- 5. A MOVIE title-level comment IS gated — dave has not watched movie1.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;

  insert into public.tracked_titles (user_id, media_type, title_id, status, summary, added_at, client_updated_at)
  values (bob, 'movie', 'movie1', 'watched', '{}'::jsonb, now(), now());

  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  insert into public.comments (user_id, media_type, title_id, body)
  values (bob, 'movie', 'movie1', 'the ending got me');

  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', dave)::text, true);

  select count(*) into row_count from public.comments where media_type = 'movie' and title_id = 'movie1';
  if row_count <> 0 then
    failures := array_append(failures, '5. dave (has not watched the movie) saw the movie title-level comment');
  end if;

  begin
    insert into public.comments (user_id, media_type, title_id, body)
    values (dave, 'movie', 'movie1', 'trying to post on an unwatched movie');
    failures := array_append(failures, '5b. dave was able to post on a movie title he has not watched');
  exception when others then
    raise notice 'PASS 5. movie title-level comments are gated on watched status';
  end;

  -- =======================================================================
  -- 6. Replies: one level of nesting only, and scope is INHERITED from the
  --    parent regardless of what the client claims.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  -- Carol tries to attach a reply to bob's spoiler comment while CLAIMING a
  -- different, ungated scope (title-level, season/episode null) — the
  -- trigger must overwrite this back to the parent's real scope.
  insert into public.comments (user_id, media_type, title_id, season_number, episode_number, parent_id, body)
  values (carol, 'tv', 'show1', null, null, spoiler_comment_id, 'agreed, huge twist')
  returning id into reply_id;

  perform 1 from public.comments
   where id = reply_id and season_number = 1 and episode_number = 2;
  if not found then
    failures := array_append(failures, '6. reply scope was NOT overwritten from the client-claimed (wrong) scope to the parent''s real scope');
  else
    raise notice 'PASS 6. reply scope is inherited from the parent, never trusted from the client';
  end if;

  -- A reply-to-a-reply must be rejected (one level of nesting only).
  begin
    insert into public.comments (user_id, media_type, title_id, parent_id, body)
    values (carol, 'tv', 'show1', reply_id, 'nested reply attempt');
    failures := array_append(failures, '6b. a reply-to-a-reply was accepted; nesting is not limited to one level');
  exception when others then
    raise notice 'PASS 6b. replying to a reply is rejected';
  end;

  -- A reply attached to a parent from a DIFFERENT title is still forced onto
  -- the real parent's scope (not left as an inconsistent cross-title row) —
  -- proven by 6 above already using the general mechanism; nothing further
  -- needed here.

  -- =======================================================================
  -- 7. Alice — who cannot even see the spoiler comment — must not be able to
  --    like it (an insert-success/failure oracle for hidden content).
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  begin
    insert into public.comment_likes (user_id, comment_id) values (alice, spoiler_comment_id);
    failures := array_append(failures, '7. alice liked a comment in a scope she cannot see');
  exception when others then
    raise notice 'PASS 7. liking a comment you cannot see is rejected';
  end;

  -- Carol, who CAN see it, can like it.
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  insert into public.comment_likes (user_id, comment_id) values (carol, spoiler_comment_id);

  -- =======================================================================
  -- 8. Like counts: batched RPC discloses a NUMBER, and comment_likes itself
  --    (own-rows only) must NOT reveal who else liked something.
  -- =======================================================================
  select likes into got_count from public.comment_like_counts(array[spoiler_comment_id]);
  if got_count <> 1 then
    failures := array_append(failures, format('8a. comment_like_counts returned %s, expected 1', got_count));
  end if;

  -- Carol querying comment_likes directly must see only HER OWN like row —
  -- never dave's or anyone else's, even for a comment dave also liked.
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', dave)::text, true);
  insert into public.comment_likes (user_id, comment_id) values (dave, spoiler_comment_id);

  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  select count(*) into row_count from public.comment_likes where comment_id = spoiler_comment_id;
  if row_count <> 1 then
    failures := array_append(failures,
      format('8b. carol saw %s like row(s) for a comment two people liked — comment_likes is leaking other users'' rows', row_count));
  end if;

  -- =======================================================================
  -- 9. Reports: no self-reports, cannot report what you cannot see, cannot
  --    read other people's reports.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  begin
    insert into public.comment_reports (comment_id, reporter_id, reason)
    values (spoiler_comment_id, bob, 'spam');
    failures := array_append(failures, '9a. bob reported his own comment');
  exception when others then
    raise notice 'PASS 9a. self-reports are rejected';
  end;

  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  begin
    insert into public.comment_reports (comment_id, reporter_id, reason)
    values (spoiler_comment_id, alice, 'spoiler');
    failures := array_append(failures, '9b. alice reported a comment she cannot even see');
  exception when others then
    raise notice 'PASS 9b. reporting a comment you cannot see is rejected';
  end;

  -- =======================================================================
  -- 10. AUTO-HIDE: 3 distinct reporters (carol, dave, eve — all of whom CAN
  --     see the comment, having watched S1E2) hides it. Alice's failed
  --     attempt above must not have contributed to the count.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);
  insert into public.comment_reports (comment_id, reporter_id, reason) values (spoiler_comment_id, carol, 'harassment');

  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', dave)::text, true);
  insert into public.comment_reports (comment_id, reporter_id, reason) values (spoiler_comment_id, dave, 'harassment');

  select status into got_status from public.comments where id = spoiler_comment_id;
  if got_status <> 'visible' then
    failures := array_append(failures, format('10a. comment hidden after only 2 distinct reports (status=%s), threshold should be 3', got_status));
  end if;

  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', eve)::text, true);
  insert into public.comment_reports (comment_id, reporter_id, reason) values (spoiler_comment_id, eve, 'harassment');

  select status into got_status from public.comments where id = spoiler_comment_id;
  if got_status <> 'hidden' then
    failures := array_append(failures, format('10b. comment NOT auto-hidden after 3 distinct reports (status=%s)', got_status));
  else
    raise notice 'PASS 10. auto-hide fires at exactly 3 distinct reporters, not before';
  end if;

  -- Duplicate report from the SAME reporter must be rejected outright
  -- (unique constraint), so a single account cannot inflate the count.
  begin
    insert into public.comment_reports (comment_id, reporter_id, reason) values (spoiler_comment_id, carol, 'spam');
    failures := array_append(failures, '10c. the same reporter was able to report the same comment twice');
  exception when others then
    raise notice 'PASS 10c. duplicate reports from one account are rejected';
  end;

  -- =======================================================================
  -- 11. Now hidden: only bob (the author) can still see it. Carol — who
  --     COULD see it before — now cannot, because it is hidden and she is
  --     not the author.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  select count(*) into row_count from public.comments where id = spoiler_comment_id;
  if row_count <> 0 then
    failures := array_append(failures, '11a. carol (not the author) can still see a hidden comment');
  end if;

  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  select count(*) into row_count from public.comments where id = spoiler_comment_id;
  if row_count <> 1 then
    failures := array_append(failures, '11b. bob, the author, cannot see his own hidden comment');
  end if;

  -- The reply carol posted earlier is UNAFFECTED by the parent being hidden —
  -- replies are not cascade-hidden (see the migration's design note).
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  select count(*) into row_count from public.comments where id = reply_id;
  if row_count <> 1 then
    failures := array_append(failures, '11c. the reply was hidden along with its now-hidden parent; replies should not cascade-hide');
  end if;

  -- =======================================================================
  -- 12. Un-hiding is rejected — no path back from 'hidden' to 'visible' via
  --     a plain UPDATE, not even by the comment's own author.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  begin
    update public.comments set status = 'visible' where id = spoiler_comment_id;
    failures := array_append(failures, '12. bob was able to un-hide his own comment via a plain UPDATE');
  exception when others then
    raise notice 'PASS 12. un-hiding via a plain UPDATE is rejected, even for the author';
  end;

  -- =======================================================================
  -- 13. Editing: body changes are allowed for the owner and edited_at is
  --     stamped SERVER-SIDE regardless of what the client sends.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  update public.comments
     set body = 'loving this show so far, EDITED', edited_at = '1999-01-01'::timestamptz
   where user_id = alice and season_number is null and title_id = 'show1';

  select edited_at::date into got_status from public.comments
   where user_id = alice and season_number is null and title_id = 'show1';
  if got_status = '1999-01-01' then
    failures := array_append(failures, '13. client-supplied edited_at was honoured instead of being server-stamped');
  end if;

  -- =======================================================================
  -- 14. Deleting: soft-delete clears body server-side even if the client
  --     tries to keep the text, and a deleted comment cannot be re-edited.
  -- =======================================================================
  update public.comments
     set deleted_at = now(), body = 'i am trying to keep my text after deleting'
   where user_id = alice and season_number is null and title_id = 'show1';

  select body into got_body from public.comments
   where user_id = alice and season_number is null and title_id = 'show1';
  if got_body <> '' then
    failures := array_append(failures, format('14a. body was NOT cleared on delete (got "%s")', got_body));
  end if;

  begin
    update public.comments set body = 'trying to resurrect a deleted comment'
     where user_id = alice and season_number is null and title_id = 'show1';
    failures := array_append(failures, '14b. a deleted comment was successfully re-edited');
  exception when others then
    raise notice 'PASS 14. deleting clears the body server-side and blocks further edits';
  end;

  -- =======================================================================
  -- 15. Identity-field tampering on UPDATE is rejected (§3.2-style check,
  --     applied to comments): an owner cannot relocate their own comment
  --     into someone else's row, or into a different title/scope. Posted on
  --     the open tv title-level scope so this check is decoupled from the
  --     movie-gating logic checks 5/5b already cover.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', dave)::text, true);

  insert into public.comments (user_id, media_type, title_id, body)
  values (dave, 'tv', 'show1', 'a comment dave owns');

  begin
    update public.comments set title_id = 'a-different-show'
     where user_id = dave and title_id = 'show1' and season_number is null;
    failures := array_append(failures, '15a. dave relocated his own comment to a different title via UPDATE');
  exception when others then
    raise notice 'PASS 15a. changing title_id on UPDATE is rejected';
  end;

  begin
    update public.comments set user_id = alice
     where user_id = dave and title_id = 'show1' and season_number is null;
    failures := array_append(failures, '15b. dave reassigned his own comment to another user via UPDATE');
  exception when others then
    raise notice 'PASS 15b. changing user_id on UPDATE is rejected';
  end;

  -- =======================================================================
  -- 16. Cross-user UPDATE/DELETE is rejected outright (the row is simply not
  --     targetable — the baseline every table in this schema gets).
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  update public.comments set body = 'hijacked' where user_id = alice;
  get diagnostics row_count = row_count;
  if row_count <> 0 then
    failures := array_append(failures, '16a. carol updated a row she does not own');
  end if;

  -- No DELETE policy exists at all for comments. RLS's behaviour when NO
  -- policy grants a command is to authorize ZERO rows for it — the DELETE
  -- statement itself does not raise, it just matches and removes nothing, the
  -- same shape as the UPDATE check just above. So the real proof is TWO
  -- things: zero rows reported affected, AND (checked as an unrestricted role
  -- afterward) alice's row is still actually there.
  delete from public.comments where user_id = alice;
  get diagnostics row_count = row_count;
  if row_count <> 0 then
    failures := array_append(failures, format('16b. carol''s DELETE reported %s row(s) affected against a comment she does not own', row_count));
  end if;

  set local role postgres;
  reset request.jwt.claims;
  select count(*) into row_count from public.comments where user_id = alice;
  if row_count = 0 then
    failures := array_append(failures, '16b. alice''s comment(s) are actually GONE after carol''s DELETE — RLS did not protect it');
  else
    raise notice 'PASS 16b. DELETE on comments is authorized for zero rows (no policy grants it), and the row survives';
  end if;

  -- =======================================================================
  -- 17. NEGATIVE CONTROL — an unprotected scope check must let the spoiler
  --     through, proving checks 1-16 are actually testing something and not
  --     vacuously passing against an over-permissive setup.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;

  create table public.spoiler_control (
    user_id uuid not null,
    body    text not null
  );
  alter table public.spoiler_control enable row level security;
  create policy "wide_open" on public.spoiler_control for select to authenticated using (true);

  insert into public.spoiler_control values (bob, 'an unprotected spoiler');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  select count(*) into row_count from public.spoiler_control;
  if row_count <> 1 then
    failures := array_append(failures,
      '17. NEGATIVE CONTROL FAILED: an intentionally wide-open table did not leak, so this test cannot distinguish protected from unprotected');
  else
    raise notice 'PASS 17. negative control: an unprotected table DOES leak, confirming the harness can detect a missing gate';
  end if;

  set local role postgres;
  reset request.jwt.claims;
  drop table public.spoiler_control;

  -- =======================================================================
  if array_length(failures, 1) > 0 then
    raise exception E'\n=== COMMENTS ADVERSARIAL FAILURES ===\n%', array_to_string(failures, E'\n');
  end if;

  raise notice '=== ALL COMMENTS CHECKS PASSED ===';
end;
$$;

rollback;
