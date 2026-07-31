-- ===========================================================================
-- ADVERSARIAL RLS TEST
--
-- This does not assert that RLS "is enabled". It signs in as one user and
-- actively attacks another user's rows — reading, updating, deleting, forging
-- inserts, and attempting the user_id-reassignment hijack — then fails loudly
-- if any attack succeeds.
--
-- It ends with a NEGATIVE CONTROL: a deliberately broken table whose UPDATE
-- policy carries `with check (true)`. The hijack SUCCEEDS there. That is the
-- point — it demonstrates the test can distinguish a correct policy from a
-- broken one, so a passing run means something. A security test that passes
-- against a broken policy is worthless.
--
-- Check 11 then corrects a claim that an earlier draft of the design doc got
-- wrong: a USING-only UPDATE policy is NOT the vulnerable shape, because
-- Postgres defaults WITH CHECK to the USING expression. The vulnerable shape
-- is a WITH CHECK BROADER than USING.
--
-- Runs entirely inside a transaction and ROLLS BACK: nothing is persisted, so
-- it is safe against a real project. Run it in the Supabase SQL editor, or
-- locally per supabase/README.md.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- Seed. Runs as the connection's own role, which bypasses RLS (a superuser
-- locally, `service_role` in Supabase) — this is setup, not part of the test.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.test');

insert into public.profiles (id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'Alice'),
  ('22222222-2222-2222-2222-222222222222', 'Bob');

insert into public.tracked_titles (user_id, media_type, title_id, status, summary) values
  ('11111111-1111-1111-1111-111111111111', 'movie', 'alice-movie', 'watched',  '{"name":"Alice Movie"}'),
  ('22222222-2222-2222-2222-222222222222', 'movie', 'bob-movie',   'watchlist','{"name":"Bob Movie"}');

insert into public.rating_notes (user_id, media_type, title_id, note) values
  ('22222222-2222-2222-2222-222222222222', 'movie', 'bob-movie', 'BOB PRIVATE NOTE');

insert into public.watch_events (id, user_id, day_key, kind, media_type, title_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
   date '2026-07-30', 'movie', 'movie', 'bob-movie');

-- The negative control: identical to `tracked_titles` except its UPDATE policy
-- carries a PERMISSIVE `with check (true)`.
--
-- NOTE, and this corrects an earlier claim in the design doc: the dangerous
-- shape is NOT "USING with WITH CHECK omitted". Postgres defaults WITH CHECK
-- to the USING expression when it is omitted, so a USING-only UPDATE policy
-- blocks the hijack perfectly well — check 11 below proves that empirically.
-- The real hole is a WITH CHECK that is BROADER than the USING clause, of
-- which `true` is the maximal case and by far the most common in the wild
-- (usually written to "just let updates through").
create table public._rls_negative_control (
  user_id uuid not null,
  note    text not null
);
alter table public._rls_negative_control enable row level security;
alter table public._rls_negative_control force  row level security;

create policy "nc_select" on public._rls_negative_control
  for select to authenticated using ((select auth.uid()) = user_id);

-- ⚠ THE BUG, DELIBERATELY: a WITH CHECK broader than the USING clause.
create policy "nc_update_broken" on public._rls_negative_control
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (true);

-- And the shape that is often ASSUMED broken but is not — see check 11.
create table public._rls_using_only (
  user_id uuid not null,
  note    text not null
);
alter table public._rls_using_only enable row level security;
alter table public._rls_using_only force  row level security;

create policy "uo_select" on public._rls_using_only
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "uo_update_using_only" on public._rls_using_only
  for update to authenticated using ((select auth.uid()) = user_id);

insert into public._rls_negative_control (user_id, note) values
  ('11111111-1111-1111-1111-111111111111', 'alice row');
insert into public._rls_using_only (user_id, note) values
  ('11111111-1111-1111-1111-111111111111', 'alice row');

-- ---------------------------------------------------------------------------
-- Become Alice. From here on, every statement runs exactly as a request
-- arriving with Alice's JWT would.
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';

do $$
declare
  bob   constant uuid := '22222222-2222-2222-2222-222222222222';
  alice constant uuid := '11111111-1111-1111-1111-111111111111';
  n           integer;
  txt         text;
  failures    text[] := '{}';
  hijacked    boolean;
begin
  raise notice '';
  raise notice '=== running as role=% , auth.uid()=% ===', current_user, auth.uid();
  raise notice '';

  -- 1 -----------------------------------------------------------------------
  select count(*) into n from public.tracked_titles;
  if n = 1 then
    raise notice 'PASS  1. Unqualified SELECT over tracked_titles returns % row (Alice''s only).', n;
  else
    failures := array_append(failures, format('1. Unqualified SELECT returned %s rows, expected 1', n));
    raise notice 'FAIL  1. Unqualified SELECT returned % rows.', n;
  end if;

  -- 2 -----------------------------------------------------------------------
  -- The query the brief asked for: Alice asks for Bob's row BY EXACT PRIMARY
  -- KEY. She knows it exists. RLS must still return nothing.
  select count(*) into n
    from public.tracked_titles
   where user_id = bob and media_type = 'movie' and title_id = 'bob-movie';
  if n = 0 then
    raise notice 'PASS  2. SELECT of Bob''s row by exact PK returns 0 rows (not an error - it does not exist, as far as Alice is concerned).';
  else
    failures := array_append(failures, '2. Alice READ Bob''s row');
    raise notice 'FAIL  2. Alice read Bob''s row!';
  end if;

  -- 3 -----------------------------------------------------------------------
  select count(*) into n from public.tracked_titles where user_id <> alice;
  if n = 0 then
    raise notice 'PASS  3. "WHERE user_id <> me" - the obvious probe - returns 0 rows.';
  else
    failures := array_append(failures, format('3. Probe for other users returned %s rows', n));
    raise notice 'FAIL  3. Probe returned % rows.', n;
  end if;

  -- 4 -----------------------------------------------------------------------
  txt := null;
  select note into txt from public.rating_notes where user_id = bob;
  if txt is null then
    raise notice 'PASS  4. Bob''s PRIVATE NOTE is invisible (rating_notes, the strictest table).';
  else
    failures := array_append(failures, '4. Alice read Bob''s private note');
    raise notice 'FAIL  4. Alice read Bob''s note: %', txt;
  end if;

  -- 5 -----------------------------------------------------------------------
  select count(*) into n from public.watch_events where user_id = bob;
  if n = 0 then
    raise notice 'PASS  5. Bob''s watch history is invisible.';
  else
    failures := array_append(failures, '5. Alice read Bob''s watch history');
    raise notice 'FAIL  5. Alice read Bob''s watch history.';
  end if;

  -- 6 -----------------------------------------------------------------------
  -- A silent no-op is the correct outcome: USING filters the row out before
  -- the UPDATE can match it, so this reports 0 rows rather than raising.
  update public.tracked_titles set status = 'watched'
   where user_id = bob and title_id = 'bob-movie';
  get diagnostics n = row_count;
  if n = 0 then
    raise notice 'PASS  6. UPDATE of Bob''s row affected 0 rows.';
  else
    failures := array_append(failures, '6. Alice UPDATED Bob''s row');
    raise notice 'FAIL  6. Alice updated % of Bob''s rows.', n;
  end if;

  -- 7 -----------------------------------------------------------------------
  delete from public.tracked_titles where user_id = bob;
  get diagnostics n = row_count;
  if n = 0 then
    raise notice 'PASS  7. DELETE of Bob''s rows affected 0 rows.';
  else
    failures := array_append(failures, '7. Alice DELETED Bob''s rows');
    raise notice 'FAIL  7. Alice deleted % of Bob''s rows.', n;
  end if;

  -- 8 -----------------------------------------------------------------------
  -- Forging an INSERT attributed to Bob. WITH CHECK must reject it outright.
  begin
    insert into public.tracked_titles (user_id, media_type, title_id, status, summary)
    values (bob, 'movie', 'forged', 'watched', '{"name":"forged"}');
    failures := array_append(failures, '8. Alice INSERTED a row owned by Bob');
    raise notice 'FAIL  8. Alice inserted a row attributed to Bob!';
  exception when insufficient_privilege then
    raise notice 'PASS  8. INSERT attributed to Bob was REJECTED (%).', sqlerrm;
  end;

  -- 9 -----------------------------------------------------------------------
  -- THE §3.2 HIJACK. Alice owns this row, so USING permits the update. Only
  -- WITH CHECK stops the new row from landing in Bob's account. This is the
  -- test that a USING-only policy fails.
  begin
    update public.tracked_titles set user_id = bob
     where user_id = alice and title_id = 'alice-movie';
    failures := array_append(failures, '9. HIJACK SUCCEEDED - Alice moved her row into Bob''s account');
    raise notice 'FAIL  9. HIJACK SUCCEEDED - user_id reassigned into Bob''s account!';
  exception when insufficient_privilege then
    raise notice 'PASS  9. user_id-reassignment hijack was REJECTED by WITH CHECK (%).', sqlerrm;
  end;

  -- 10 ----------------------------------------------------------------------
  -- Same hijack against the deliberately broken table. It MUST succeed, or
  -- this whole test proves nothing.
  -- NOTE the absent WHERE clause — it is load-bearing. See check 12.
  hijacked := false;
  begin
    update public._rls_negative_control set user_id = bob;
    get diagnostics n = row_count;
    hijacked := n > 0;
  exception when insufficient_privilege then
    hijacked := false;
  end;

  if hijacked then
    raise notice '';
    raise notice 'PASS 10. NEGATIVE CONTROL: against WITH CHECK (true) the SAME hijack SUCCEEDED.';
    raise notice '         The test distinguishes a correct policy from a broken one, so check 9 means something.';
  else
    failures := array_append(failures,
      '10. Negative control did NOT reproduce the hijack - the test is not sensitive');
    raise notice 'FAIL 10. Negative control failed to reproduce the hijack; check 9 proves nothing.';
  end if;

  -- 11 ----------------------------------------------------------------------
  -- Empirical correction to a widely-repeated claim (including in an earlier
  -- draft of our own design doc): "USING without WITH CHECK lets a user
  -- reassign user_id". It does not. Postgres defaults WITH CHECK to the USING
  -- expression when omitted, so this shape is safe. Asserted here so the claim
  -- stays tested rather than remembered.
  hijacked := false;
  begin
    update public._rls_using_only set user_id = bob where user_id = alice;
    get diagnostics n = row_count;
    hijacked := n > 0;
  exception when insufficient_privilege then
    hijacked := false;
  end;

  if not hijacked then
    raise notice '';
    raise notice 'PASS 11. USING-only UPDATE policy ALSO blocked the hijack - Postgres defaults';
    raise notice '         WITH CHECK to the USING expression. The danger is a BROADER with-check,';
    raise notice '         not an absent one.';
  else
    failures := array_append(failures,
      '11. USING-only policy permitted the hijack - Postgres defaulting assumption is wrong');
    raise notice 'FAIL 11. USING-only policy permitted the hijack.';
  end if;

  -- 12 ----------------------------------------------------------------------
  -- The subtlety that makes RLS testing treacherous, found while building this
  -- file: the SAME broken table, attacked with a WHERE clause, is BLOCKED.
  --
  -- When an UPDATE references the table's columns, SELECT policies are applied
  -- to the row as well, and this table's restrictive SELECT policy rejects a
  -- post-update row owned by Bob. So a restrictive SELECT policy is genuine
  -- defence in depth against ownership transfer.
  --
  -- The trap: it also MASKS a broken WITH CHECK. An engineer probing a real
  -- hole with the natural `... where user_id = me` form would see it blocked
  -- and conclude the policy was sound. Only the unqualified form exposes it —
  -- which is why check 10 has no WHERE clause.
  hijacked := false;
  begin
    update public._rls_negative_control set user_id = bob where user_id = alice;
    get diagnostics n = row_count;
    hijacked := n > 0;
  exception when insufficient_privilege then
    hijacked := false;
  end;

  if not hijacked then
    raise notice '';
    raise notice 'PASS 12. Same broken table + a WHERE clause -> BLOCKED, because SELECT policies';
    raise notice '         also apply to the post-update row. Defence in depth, but it MASKS a';
    raise notice '         broken WITH CHECK - probe without a WHERE clause or you will miss it.';
  else
    failures := array_append(failures,
      '12. WHERE-clause form unexpectedly hijacked - SELECT policy is not constraining the new row');
    raise notice 'FAIL 12. WHERE-clause form also hijacked.';
  end if;

  -- Verdict ----------------------------------------------------------------
  raise notice '';
  if array_length(failures, 1) is null then
    raise notice '=== ALL CHECKS PASSED ===';
  else
    raise exception E'RLS ADVERSARIAL TEST FAILED:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
end;
$$;

reset role;
rollback;
