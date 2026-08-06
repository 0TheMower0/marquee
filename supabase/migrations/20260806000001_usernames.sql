-- ===========================================================================
-- Marquee — Phase 6 Step 4: usernames
--
-- Adds the one column auth needs that the Step 3 schema did not have, plus
-- the format constraint, the uniqueness index, and the single RPC the
-- signed-OUT sign-up form needs.
--
-- No new TABLE is created here, so the "tables and their RLS ship together"
-- rule in 20260801000001 is not in play. The guard at the end still runs, for
-- the same reason it exists there: it costs nothing and catches the mistake
-- this project has decided it never wants to make silently.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- The column
--
-- Added nullable, backfilled, then set NOT NULL. Adding it NOT NULL in one
-- step would fail against any database that already has profile rows — there
-- are none today (Step 3 shipped schema only, and no app code wrote to it),
-- but a migration that only works on an empty table is a trap for whoever
-- re-runs this against a branch database later.
--
-- The backfill produces `user_<first 8 of the uuid>`, which satisfies the same
-- format rule as a generated placeholder from lib/auth/username.ts: a uuid's
-- first 8 characters are hex, so the result always starts with a letter or
-- digit and never ends in an underscore.
-- ---------------------------------------------------------------------------
alter table public.profiles add column username text;

update public.profiles
   set username = 'user_' || substring(replace(id::text, '-', '') from 1 for 8)
 where username is null;

alter table public.profiles alter column username set not null;

-- ---------------------------------------------------------------------------
-- Format: mirrors USERNAME_PATTERN in lib/auth/username.ts. The two must
-- change together.
--
-- The application validates first, so this constraint should never fire in
-- normal operation — which is exactly why it is here. It is the backstop for
-- a bug in that file, or for a direct PostgREST call made with a user's own
-- token that skips the app entirely. `~` is case-sensitive and the class
-- covers both cases explicitly, rather than using `~*`, so the pattern reads
-- identically to the JavaScript one.
--
-- NOT enforced here: the reserved-word list. That is deliberate and the
-- reasoning is in lib/auth/username.ts — it is product policy that changes,
-- and a CHECK constraint would demand a migration per edit, including one
-- that could fail because an existing row already holds a newly-reserved name.
-- ---------------------------------------------------------------------------
alter table public.profiles
  add constraint profiles_username_format
  check (username ~ '^[A-Za-z0-9][A-Za-z0-9_]{1,22}[A-Za-z0-9]$');

-- ---------------------------------------------------------------------------
-- Uniqueness — case-insensitive.
--
-- On `lower(username)`, not on `username`: `AliK` and `alik` must be one
-- person, not two, or the username stops identifying anybody in the Phase 6
-- Step 6 comments feature it exists to serve. The stored value keeps whatever
-- case the user typed, which is why this is an expression index rather than a
-- lowercase-only column.
--
-- THIS INDEX IS THE UNIQUENESS MECHANISM. `username_available()` below is a
-- courtesy for the form; between its answer and the eventual insert there is a
-- window in which someone else can take the name, and only the index closes
-- it. lib/auth/supabase/index.ts treats a 23505 as an ordinary outcome for
-- exactly this reason.
-- ---------------------------------------------------------------------------
create unique index profiles_username_lower_key
  on public.profiles (lower(username));

-- ---------------------------------------------------------------------------
-- Availability check for the sign-up form.
--
-- Needed because `profiles` is readable by `authenticated` only, and the
-- person filling in a sign-up form is by definition not authenticated yet.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DISCLOSES
-- ---------------------------------------------------------------------------
-- Whether a given username exists. That is inherent to any form that tells you
-- a name is taken, and it is why the function returns a bare boolean and
-- nothing else: no id, no count, no row. It cannot be used to page through the
-- user list, only to test one guess at a time — and the `auth` rate limit on
-- the Server Action that calls it (lib/ratelimit/rules.ts) is what stops that
-- being a practical enumeration channel.
--
-- Contrast with email: there is no equivalent function for addresses, and
-- deliberately so. A username is a public handle; an email address is not.
--
-- `security definer` with `set search_path = ''` and fully-qualified names:
-- without the empty search_path a caller could create their own `profiles`
-- table in a schema earlier on the path and have this privileged function read
-- that instead. Every object reference below is schema-qualified for the same
-- reason.
--
-- `stable` rather than `volatile` — it performs no writes, which lets the
-- planner avoid re-evaluating it needlessly and, more usefully, documents that
-- calling it has no side effects.
-- ---------------------------------------------------------------------------
create function public.username_available(candidate text)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    -- Reject anything malformed rather than reporting it "available" and
    -- letting the user discover at submit time that the name was never legal.
    -- Mirrors the app-side check; both exist so neither is load-bearing alone.
    candidate ~ '^[A-Za-z0-9][A-Za-z0-9_]{1,22}[A-Za-z0-9]$'
    and not exists (
      select 1 from public.profiles
       where lower(public.profiles.username) = lower(candidate)
    );
$$;

-- Callable by anyone, including the anon key, because sign-up happens before
-- authentication. `execute` is revoked from `public` first: Postgres grants
-- EXECUTE on new functions to PUBLIC by default, so relying on that default
-- would mean the grant is implicit and invisible to review.
revoke execute on function public.username_available(text) from public;
grant execute on function public.username_available(text) to anon, authenticated;

-- ===========================================================================
-- Same guard as the initial migration. No table was added here, so this must
-- pass trivially — but running it costs nothing and means every migration in
-- this directory ends by proving the invariant still holds, rather than only
-- the one that happened to introduce it.
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
