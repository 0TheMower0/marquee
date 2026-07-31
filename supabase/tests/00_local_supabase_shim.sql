-- ===========================================================================
-- LOCAL TEST HARNESS ONLY — never applied to a real Supabase project.
--
-- Supabase provides all of this: the `auth` schema, `auth.users`, `auth.uid()`,
-- and the `anon` / `authenticated` / `service_role` roles. Reproducing them
-- here is what lets the adversarial test in 01_rls_adversarial.sql run against
-- a plain PostgreSQL instance.
--
-- `auth.uid()` below is Supabase's real definition: it reads the JWT claims
-- that PostgREST sets as a per-transaction GUC. That is what makes
-- `set local request.jwt.claims = '{"sub":"<uuid>"}'` a faithful simulation of
-- "a request arrived bearing this user's token".
-- ===========================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text unique
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

-- Supabase's three API roles. All NOLOGIN — PostgREST connects as an
-- authenticator and switches into them per request, which is exactly what
-- `set local role` does below.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- BYPASSRLS is the whole reason this key must never reach a browser: no
    -- policy in the schema applies to it.
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;

-- Supabase grants table privileges to the API roles by default, which is
-- precisely why RLS — not the grant — is the access control. Default
-- privileges apply to tables created *after* this runs, i.e. the migration.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
