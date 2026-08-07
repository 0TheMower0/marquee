-- ===========================================================================
-- Marquee — Phase 6 Step 6b: lists, attacked rather than asserted
--
-- Same discipline as every adversarial test in this directory: this does not
-- check that policies EXIST, it tries to defeat them and fails loudly if any
-- attempt succeeds. Runs in a transaction and rolls back.
--
-- Two claims matter more than the rest and get the most scrutiny:
--
--   1. A private list is provably unreadable by anyone but its owner and
--      ACCEPTED collaborators — an invited-but-not-yet-accepted "member" gets
--      nothing (checks 1-4).
--   2. The cross-user tracked_titles carve-out is scoped EXACTLY to "you are
--      both editing members of a list containing this exact title" — not
--      "you're both on some list together" (checks 12-13), and NOT "you can
--      both view a public list" (check 14, the one most likely to get wrong
--      if this carve-out were ever loosened).
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

set local role postgres;

do $$
declare
  alice uuid := '11111111-1111-1111-1111-111111111111'; -- owns list L (private then public)
  bob   uuid := '22222222-2222-2222-2222-222222222222'; -- invited collaborator on L
  carol uuid := '33333333-3333-3333-3333-333333333333'; -- outsider, no relationship to L
  dave  uuid := '44444444-4444-4444-4444-444444444444'; -- owns unrelated list M
  failures text[] := '{}';

  list_l uuid;
  list_m uuid;
  row_count int;
  got_visibility text;
  got_status text;
  got_bool boolean;
begin
  insert into auth.users (id) values (alice), (bob), (carol), (dave)
    on conflict do nothing;
  insert into public.profiles (id, username) values
    (alice, 'alice'), (bob, 'bob'), (carol, 'carol'), (dave, 'dave')
  on conflict do nothing;

  -- =======================================================================
  -- Setup: alice creates a PRIVATE list L containing 'show1'; dave creates an
  -- UNRELATED list M containing 'show2'. Both are done as postgres (bypassing
  -- RLS) purely to seed fixture data quickly, matching the prior tests' style.
  -- =======================================================================
  insert into public.lists (owner_id, name, visibility)
    values (alice, 'Alice''s watchlist', 'private')
    returning id into list_l;
  insert into public.lists (owner_id, name, visibility)
    values (dave, 'Dave''s watchlist', 'private')
    returning id into list_m;

  insert into public.list_items (list_id, media_type, title_id, summary, added_by)
    values (list_l, 'tv', 'show1', '{}'::jsonb, alice);
  insert into public.list_items (list_id, media_type, title_id, summary, added_by)
    values (list_m, 'tv', 'show2', '{}'::jsonb, dave);

  -- =======================================================================
  -- 1. CAROL — a total outsider — sees NOTHING of list L: not the list row,
  --    not its items, via list or direct lookup.
  -- =======================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  select count(*) into row_count from public.lists where id = list_l;
  if row_count <> 0 then
    failures := array_append(failures, '1a. carol (outsider) can see a private list by id');
  end if;

  select count(*) into row_count from public.list_items where list_id = list_l;
  if row_count <> 0 then
    failures := array_append(failures, '1b. carol (outsider) can see a private list''s items');
  end if;

  -- =======================================================================
  -- 2. ALICE (owner) sees her own private list fine.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  select count(*) into row_count from public.lists where id = list_l;
  if row_count <> 1 then
    failures := array_append(failures, '2. alice (owner) cannot see her own private list');
  end if;

  -- =======================================================================
  -- 3. Alice invites bob. BEFORE accepting, bob has NO access — invited is
  --    not membership.
  -- =======================================================================
  insert into public.list_collaborators (list_id, user_id, invited_by)
    values (list_l, bob, alice);

  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  select count(*) into row_count from public.lists where id = list_l;
  if row_count <> 0 then
    failures := array_append(failures, '3a. bob (invited, not yet accepted) can already see the private list');
  end if;

  begin
    insert into public.list_items (list_id, media_type, title_id, summary, added_by)
    values (list_l, 'movie', 'movie1', '{}'::jsonb, bob);
    failures := array_append(failures, '3b. bob (invited, not yet accepted) was able to add an item');
  exception when others then
    raise notice 'PASS 3. an invited-but-not-accepted collaborator has no access at all';
  end;

  -- Bob CAN see his own pending invite row, though — he needs to, to respond
  -- to it.
  select count(*) into row_count from public.list_collaborators
   where list_id = list_l and user_id = bob;
  if row_count <> 1 then
    failures := array_append(failures, '3c. bob cannot see his own pending invite');
  end if;

  -- =======================================================================
  -- 4. Bob accepts. NOW he has full member access.
  -- =======================================================================
  update public.list_collaborators set status = 'accepted'
   where list_id = list_l and user_id = bob;

  select count(*) into row_count from public.lists where id = list_l;
  if row_count <> 1 then
    failures := array_append(failures, '4a. bob, after accepting, still cannot see the private list');
  end if;

  insert into public.list_items (list_id, media_type, title_id, summary, added_by)
    values (list_l, 'movie', 'movie1', '{}'::jsonb, bob);

  select count(*) into row_count from public.list_items where list_id = list_l and title_id = 'movie1';
  if row_count <> 1 then
    failures := array_append(failures, '4b. bob, after accepting, still cannot add an item');
  end if;
  if row_count = 1 then
    raise notice 'PASS 4. accepting an invite grants full member access';
  end if;

  -- =======================================================================
  -- 5. Bob (a collaborator, not the owner) CANNOT rename, re-describe,
  --    re-visibility, or delete the list — collaborators may add items, not
  --    edit list metadata.
  -- =======================================================================
  update public.lists set name = 'hijacked by bob' where id = list_l;
  get diagnostics row_count = row_count;
  if row_count <> 0 then
    failures := array_append(failures, '5a. bob (collaborator) renamed alice''s list');
  end if;

  update public.lists set visibility = 'public' where id = list_l;
  get diagnostics row_count = row_count;
  if row_count <> 0 then
    failures := array_append(failures, '5b. bob (collaborator) changed alice''s list''s visibility');
  end if;

  -- =======================================================================
  -- 6. Bob (collaborator) CANNOT invite further collaborators — only the
  --    owner may invite.
  -- =======================================================================
  begin
    insert into public.list_collaborators (list_id, user_id, invited_by)
    values (list_l, carol, bob);
    failures := array_append(failures, '6. bob (collaborator, not owner) was able to invite carol');
  exception when others then
    raise notice 'PASS 6. only the list owner may invite collaborators';
  end;

  -- =======================================================================
  -- 7. Bob cannot accept an invite on someone ELSE's behalf, and cannot
  --    forge a brand-new 'accepted' row for himself bypassing the invite
  --    step entirely.
  -- =======================================================================
  begin
    insert into public.list_collaborators (list_id, user_id, invited_by, status)
    values (list_m, bob, bob, 'accepted');
    failures := array_append(failures, '7. bob inserted himself directly as an accepted collaborator on dave''s list, skipping the invite');
  exception when others then
    raise notice 'PASS 7. a collaborator row cannot be inserted pre-accepted, and only the owner may invite';
  end;

  -- =======================================================================
  -- 8. Un-accepting: once accepted, cannot revert to 'invited' via UPDATE —
  --    not even by the collaborator themselves.
  -- =======================================================================
  begin
    update public.list_collaborators set status = 'invited'
     where list_id = list_l and user_id = bob;
    failures := array_append(failures, '8. bob reverted his own accepted status back to invited');
  exception when others then
    raise notice 'PASS 8. reverting accepted -> invited is rejected';
  end;

  -- =======================================================================
  -- 9. Item removal: bob (collaborator) cannot remove an item ALICE added,
  --    only his own or the owner can remove any.
  -- =======================================================================
  delete from public.list_items where list_id = list_l and title_id = 'show1'; -- alice's item
  get diagnostics row_count = row_count;
  if row_count <> 0 then
    failures := array_append(failures, '9. bob (collaborator) deleted an item alice added');
  end if;

  -- Bob CAN remove his own item.
  delete from public.list_items where list_id = list_l and title_id = 'movie1'; -- bob's own item
  get diagnostics row_count = row_count;
  if row_count <> 1 then
    failures := array_append(failures, '9b. bob could not delete his own item');
  end if;

  -- =======================================================================
  -- 10. THE CROSS-USER CARVE-OUT — the most important cluster of checks.
  --     Ground truth: alice and bob both watchlist 'show1' (they share list
  --     L, which contains it). Carol has NO relationship to alice or list L
  --     at all.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;

  insert into public.tracked_titles (user_id, media_type, title_id, status, summary, added_at, client_updated_at)
  values
    (alice, 'tv', 'show1', 'watchlist', '{}'::jsonb, now(), now()),
    (bob,   'tv', 'show1', 'watchlist', '{}'::jsonb, now(), now()),
    (carol, 'tv', 'show1', 'watched',   '{}'::jsonb, now(), now()),
    (dave,  'tv', 'show2', 'watchlist', '{}'::jsonb, now(), now());
  insert into public.list_items (list_id, media_type, title_id, summary, added_by)
    values (list_l, 'tv', 'show1', '{}'::jsonb, alice)
    on conflict do nothing;

  -- 10a. Bob CAN see alice's status for 'show1' — they share list L, which
  --      contains it, and both are accepted members.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  select status into got_status from public.tracked_titles where user_id = alice and title_id = 'show1';
  if got_status is distinct from 'watchlist' then
    failures := array_append(failures, format('10a. bob could NOT see alice''s shared-list status (got %s)', coalesce(got_status, 'NULL')));
  end if;

  -- 10b. Bob CANNOT see dave's status for 'show2' — no shared list at all.
  select count(*) into row_count from public.tracked_titles where user_id = dave and title_id = 'show2';
  if row_count <> 0 then
    failures := array_append(failures, '10b. bob can see dave''s tracked_titles row despite sharing NO list with him');
  end if;

  -- 10c. Carol, an outsider with NO relationship to list L, cannot see
  --      alice's status for 'show1' either — being on some OTHER list, or no
  --      list, must not leak this.
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  select count(*) into row_count from public.tracked_titles where user_id = alice and title_id = 'show1';
  if row_count <> 0 then
    failures := array_append(failures, '10c. carol (no shared list with alice) can see alice''s tracked_titles row');
  end if;

  -- =======================================================================
  -- 11. TITLE-SCOPED, NOT MEMBER-SCOPED: alice adds a SECOND title,
  --     'show3', to a list bob is NOT part of. Bob must not gain visibility
  --     into alice's status for THAT title just because he can see her
  --     status for 'show1'.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;

  insert into public.tracked_titles (user_id, media_type, title_id, status, summary, added_at, client_updated_at)
  values (alice, 'tv', 'show3', 'watchlist', '{}'::jsonb, now(), now());
  -- 'show3' deliberately NOT added to list_l — it belongs nowhere alice and
  -- bob share.

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  select count(*) into row_count from public.tracked_titles where user_id = alice and title_id = 'show3';
  if row_count <> 0 then
    failures := array_append(failures, '11. bob can see alice''s status for a title NOT on any list they share — the carve-out is leaking beyond its title scope');
  end if;

  -- =======================================================================
  -- 12. VIEWING A PUBLIC LIST DOES NOT GRANT THE CARVE-OUT. Alice's list L
  --     becomes public. Carol, a random authenticated user with no
  --     collaborator invite, CAN now view the list and its items — but must
  --     NOT gain visibility into alice's or bob's tracked_titles just from
  --     being able to view it. This is the check most likely to catch a
  --     future accidental widening of shares_editable_list_with().
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  update public.lists set visibility = 'public' where id = list_l;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  -- Carol can now view the (now-public) list and its items...
  select count(*) into row_count from public.lists where id = list_l;
  if row_count <> 1 then
    failures := array_append(failures, '12a. carol cannot view alice''s now-PUBLIC list at all');
  end if;
  select count(*) into row_count from public.list_items where list_id = list_l;
  if row_count = 0 then
    failures := array_append(failures, '12b. carol cannot see the public list''s items');
  end if;

  -- ...but STILL cannot see alice's tracked_titles row for a title on it.
  select count(*) into row_count from public.tracked_titles where user_id = alice and title_id = 'show1';
  if row_count <> 0 then
    failures := array_append(failures,
      '12c. CAROL CAN SEE ALICE''S TRACKING STATUS JUST BY VIEWING HER PUBLIC LIST — the carve-out must require editing membership, not mere visibility');
  else
    raise notice 'PASS 12. viewing a public list does not, by itself, expose members'' tracking status';
  end if;

  -- And carol still cannot ADD an item to it — public means readable, not
  -- writable, by a non-member.
  begin
    insert into public.list_items (list_id, media_type, title_id, summary, added_by)
    values (list_l, 'movie', 'movie2', '{}'::jsonb, carol);
    failures := array_append(failures, '12d. carol added an item to a public list she does not own or collaborate on');
  exception when others then
    raise notice 'PASS 12d. a public list is readable but not writable by a non-member';
  end;

  -- =======================================================================
  -- 13. UNLISTED behaves exactly like PUBLIC for read access (any
  --     authenticated user, given the id) — the only difference is
  --     discoverability, which is a query-level concern this test cannot
  --     exercise directly, but read access should be identical.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  update public.lists set visibility = 'unlisted' where id = list_l;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  select count(*) into row_count from public.lists where id = list_l;
  if row_count <> 1 then
    failures := array_append(failures, '13. carol cannot view an UNLISTED list by id, despite unlisted being readable-by-link');
  end if;

  -- =======================================================================
  -- 14. Owner identity cannot be reassigned via UPDATE (the §3.2 shape,
  --     applied to lists), and list_items has no UPDATE policy at all —
  --     confirm that is authorized-for-zero-rows, not an exception, same
  --     Postgres RLS semantics the comments suite already documented.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  begin
    update public.lists set owner_id = bob where id = list_l;
    failures := array_append(failures, '14a. alice reassigned her own list''s owner_id to bob via UPDATE');
  exception when others then
    raise notice 'PASS 14a. reassigning owner_id on UPDATE is rejected';
  end;

  update public.list_items set added_by = alice where list_id = list_l and title_id = 'show1';
  get diagnostics row_count = row_count;
  if row_count <> 0 then
    failures := array_append(failures, '14b. an UPDATE on list_items succeeded despite no UPDATE policy existing for that table');
  else
    raise notice 'PASS 14b. list_items has no UPDATE policy; a plain UPDATE authorizes zero rows';
  end if;

  -- =======================================================================
  -- 15. Following: only someone who can VIEW a list may follow it. Make L
  --     private again and confirm carol (no longer able to view it) cannot
  --     follow it either.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  update public.lists set visibility = 'private' where id = list_l;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  begin
    insert into public.list_followers (list_id, user_id) values (list_l, carol);
    failures := array_append(failures, '15. carol followed a private list she cannot view');
  exception when others then
    raise notice 'PASS 15. following a list you cannot view is rejected';
  end;

  -- Bob (an actual member) CAN follow it.
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);
  insert into public.list_followers (list_id, user_id) values (list_l, bob);

  -- =======================================================================
  -- 16. Follower privacy: alice (the list owner) cannot see BOB's follow row
  --     directly — list_followers is own-rows-only, same as comment_likes.
  --     She CAN learn the count via the batched RPC, never the identity.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  select count(*) into row_count from public.list_followers where list_id = list_l;
  if row_count <> 0 then
    failures := array_append(failures, '16a. alice can see bob''s individual follow row — list_followers is leaking other users'' rows');
  end if;

  select followers into row_count from public.list_follower_counts(array[list_l]);
  if row_count <> 1 then
    failures := array_append(failures, format('16b. list_follower_counts returned %s, expected 1', coalesce(row_count::text, 'NULL')));
  end if;

  -- =======================================================================
  -- 17. NEGATIVE CONTROL — proves the harness can tell protected from
  --     unprotected. A deliberately wide-open mirror table must leak.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;

  create table public.private_list_control (
    owner_id uuid not null,
    name     text not null
  );
  alter table public.private_list_control enable row level security;
  create policy "wide_open" on public.private_list_control for select to authenticated using (true);
  insert into public.private_list_control values (alice, 'a private-in-name-only list');

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', carol)::text, true);

  select count(*) into row_count from public.private_list_control;
  if row_count <> 1 then
    failures := array_append(failures,
      '17. NEGATIVE CONTROL FAILED: an intentionally wide-open table did not leak, so this test cannot distinguish protected from unprotected');
  else
    raise notice 'PASS 17. negative control: an unprotected table DOES leak, confirming the harness detects a missing gate';
  end if;

  set local role postgres;
  reset request.jwt.claims;
  drop table public.private_list_control;

  -- =======================================================================
  if array_length(failures, 1) > 0 then
    raise exception E'\n=== LISTS ADVERSARIAL FAILURES ===\n%', array_to_string(failures, E'\n');
  end if;

  raise notice '=== ALL LISTS CHECKS PASSED ===';
end;
$$;

rollback;
