-- ===========================================================================
-- Marquee — Phase 8 Step 2: home_config, attacked rather than asserted
--
-- Same discipline as every adversarial test in this directory: this does not
-- check that policies EXIST, it tries to defeat them and fails loudly if any
-- attempt succeeds. Runs in a transaction and rolls back.
--
-- Smaller than the suites before it because the table itself is small — one
-- jsonb blob per user — but the two things worth attacking are the same two
-- that matter everywhere in this schema: can another user read or write my
-- row, and does the conflict rule actually reject a stale write. Checks 6-7
-- exist specifically because "home_config reuses generic triggers, so it
-- must be fine" is an assumption, not a fact, until it is attacked the same
-- way the original four LWW tables were in 20260807000001.
-- ===========================================================================

\set ON_ERROR_STOP on

begin;

set local role postgres;

do $$
declare
  alice uuid := '11111111-1111-1111-1111-111111111111';
  bob   uuid := '22222222-2222-2222-2222-222222222222';
  failures text[] := '{}';

  row_count int;
  got_config jsonb;
  got_ts timestamptz;
begin
  insert into auth.users (id) values (alice), (bob) on conflict do nothing;

  insert into public.home_config (user_id, config, client_updated_at)
    values (alice, '{"firstPage":"library"}'::jsonb, now() - interval '1 hour');

  -- =======================================================================
  -- BOB ATTACKS ALICE'S ROW
  -- =======================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  -- 1. Bob cannot read Alice's settings.
  select count(*) into row_count from public.home_config where user_id = alice;
  if row_count <> 0 then
    failures := array_append(failures, format('1. Bob read %s of Alice''s home_config rows', row_count));
  end if;

  -- 2. Bob cannot overwrite Alice's settings via an unqualified update — the
  --    Phase 6 Step 3 lesson: the hole is a WITH CHECK broader than USING,
  --    and an unqualified statement is the form that finds it.
  update public.home_config set config = '{"firstPage":"search"}'::jsonb where user_id = alice;
  get diagnostics row_count = row_count;
  if row_count <> 0 then
    failures := array_append(failures, '2. Bob updated Alice''s row directly');
  end if;

  -- 3. Bob cannot reassign his own (nonexistent) row's identity to Alice by
  --    inserting one attributed to her.
  begin
    insert into public.home_config (user_id, config) values (alice, '{}'::jsonb);
    failures := array_append(failures, '3. Bob inserted a home_config row owned by Alice');
  exception when others then
    null;
  end;

  -- 4. Bob cannot delete Alice's settings.
  delete from public.home_config where user_id = alice;
  get diagnostics row_count = row_count;
  if row_count <> 0 then
    failures := array_append(failures, '4. Bob deleted Alice''s home_config row');
  end if;

  -- 5. Confirm Alice's row is genuinely untouched by any of the above, not
  --     merely "the statement reported zero rows".
  set local role postgres;
  reset request.jwt.claims;
  select config into got_config from public.home_config where user_id = alice;
  if got_config <> '{"firstPage":"library"}'::jsonb then
    failures := array_append(failures, format('5. Alice''s config changed to %s', got_config));
  end if;

  -- =======================================================================
  -- THE CONFLICT RULE, ATTACKED — not assumed safe because it reuses
  -- existing triggers.
  -- =======================================================================

  -- 6. A STALE write (older client_updated_at than what is stored) is
  --    silently rejected — the row keeps its current value.
  update public.home_config
     set config = '{"firstPage":"stale-attempt"}'::jsonb,
         client_updated_at = now() - interval '2 hours'
   where user_id = alice;
  select config into got_config from public.home_config where user_id = alice;
  if got_config = '{"firstPage":"stale-attempt"}'::jsonb then
    failures := array_append(failures, '6. A stale write overwrote a newer home_config row');
  end if;

  -- 7. A FUTURE-dated client_updated_at is clamped to now(), not trusted —
  --    otherwise a fast client clock would win every future comparison
  --    forever. This is check 6's mirror: the clamp trigger, not the LWW one.
  update public.home_config
     set config = '{"firstPage":"schedule"}'::jsonb,
         client_updated_at = now() + interval '10 years'
   where user_id = alice;
  select client_updated_at into got_ts from public.home_config where user_id = alice;
  if got_ts > now() + interval '1 minute' then
    failures := array_append(failures,
      format('7. A future-dated client_updated_at was NOT clamped: %s', got_ts));
  end if;

  -- =======================================================================
  -- 8. POSITIVE CONTROL — Alice can read and legitimately update her own
  --    settings. If this fails, checks 1-4 above would be passing for the
  --    wrong reason (nobody can write ANYTHING, not just nobody but Alice).
  -- =======================================================================
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', alice)::text, true);

  update public.home_config set config = '{"firstPage":"home"}'::jsonb where user_id = alice;
  select count(*) into row_count from public.home_config
   where user_id = alice and config = '{"firstPage":"home"}'::jsonb;
  if row_count <> 1 then
    failures := array_append(failures, '8. POSITIVE CONTROL FAILED: Alice could not update her own settings');
  else
    raise notice 'PASS 8. positive control: Alice CAN read and update her own home_config';
  end if;

  -- =======================================================================
  -- 9. NEGATIVE CONTROL — proves the harness can tell protected from
  --    unprotected, the same discipline as every prior suite.
  -- =======================================================================
  set local role postgres;
  reset request.jwt.claims;

  create table public.home_config_control (
    user_id uuid not null,
    config  jsonb not null
  );
  alter table public.home_config_control enable row level security;
  create policy "wide_open" on public.home_config_control for select to authenticated using (true);
  insert into public.home_config_control values (alice, '{"firstPage":"library"}'::jsonb);

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', bob)::text, true);

  select count(*) into row_count from public.home_config_control;
  if row_count <> 1 then
    failures := array_append(failures,
      '9. NEGATIVE CONTROL FAILED: an intentionally wide-open table did not leak, so this test cannot distinguish protected from unprotected');
  else
    raise notice 'PASS 9. negative control: an unprotected table DOES leak, confirming the harness detects a missing gate';
  end if;

  set local role postgres;
  reset request.jwt.claims;
  drop table public.home_config_control;

  -- =======================================================================
  if array_length(failures, 1) > 0 then
    raise exception E'\n=== HOME_CONFIG ADVERSARIAL FAILURES ===\n%', array_to_string(failures, E'\n');
  end if;

  raise notice '=== ALL HOME_CONFIG CHECKS PASSED ===';
end;
$$;

rollback;
