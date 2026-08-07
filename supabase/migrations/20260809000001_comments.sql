-- ===========================================================================
-- Marquee — Phase 6 Step 6: spoiler-safe comments
--
-- The differentiator this step ships: episode comments are invisible to a
-- reader who has not watched that episode — not blurred, not client-side
-- hidden-then-revealed, ABSENT from the query result entirely. A reader
-- inspecting network traffic in devtools sees nothing, because the row never
-- left the database. That property is enforced by the RLS SELECT policy
-- below, not by app code, which is the whole point: app code can have bugs,
-- and a client-side blur can always be un-blurred.
--
-- Same "schema and RLS in one transaction" discipline as every migration in
-- this directory — see the header comment in 20260801000001 for why a table
-- must never exist without RLS for even one instant.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- comments
--
-- Two granularities only, matching the brief exactly: a TITLE (general
-- discussion) or a specific EPISODE (season_number + episode_number both
-- set). There is no season-level granularity — CLAUDE.md's own precedent
-- (tracking status vs. per-episode progress) is "only build the granularities
-- actually asked for," and a season bucket was not.
--
-- ---------------------------------------------------------------------------
-- GATING ASYMMETRY, STATED PLAINLY — A JUDGMENT CALL, NOT IN THE BRIEF VERBATIM
-- ---------------------------------------------------------------------------
-- The brief says "episode comments hidden until watched" and leaves title-
-- level ungated. Applied literally, that would leave a MOVIE's only comment
-- bucket (there is no episode to move spoilers to) completely open the
-- instant you land on its page — which undermines the feature's whole pitch
-- for exactly half the catalog. So:
--
--   - TV title-level comments: OPEN. No episode exists to carry a spoiler
--     into instead, and general "I love the theme song" chatter about a show
--     is exactly what an ungated bucket is for.
--   - MOVIE title-level comments: GATED on `tracked_titles.status = 'watched'`
--     for that user. A movie's only page is its whole story.
--   - TV episode comments: GATED on a `watched_episodes` row for that exact
--     episode.
--
-- This reuses Phase 6 Step 5's SYNCED tracking tables as the source of truth
-- for "has this reader watched this" — see `can_view_comment_scope` below.
-- Consequence, stated honestly: a reader's watch state is only as current as
-- their last sync. Marked an episode watched five seconds ago on a device
-- that has not yet flushed its outbox? The comment for it stays gated until
-- the sync cycle catches up. That is the same eventual-consistency the sync
-- design already accepts everywhere else (design doc §5); it is not a new
-- weakness introduced here.
create table public.comments (
  id           uuid        primary key default gen_random_uuid(),
  -- References PROFILES, not auth.users — the ONE deviation from this
  -- schema's uniform "-> auth.users(id)" convention, and deliberate on two
  -- counts: (1) it lets PostgREST embed the author's username/display_name
  -- directly (`select=*, author:profiles(username,display_name)`) with no
  -- extra round trip, which every comment render needs; (2) it guarantees a
  -- comment can never exist without a real profile row to attribute it to, so
  -- the UI never needs a null-author fallback branch. Cascades identically to
  -- referencing auth.users(id) directly, since profiles.id IS auth.users.id
  -- and profiles already cascades from auth.users (migration 20260801000001).
  user_id      uuid        not null
    constraint comments_user_id_fkey references public.profiles (id) on delete cascade,
  media_type      text     not null check (media_type in ('movie', 'tv')),
  title_id        text     not null,
  season_number   int      check (season_number is null or season_number >= 0),
  episode_number  int      check (episode_number is null or episode_number >= 1),
  -- One level of nesting only. A reply's parent must itself be a top-level
  -- comment — enforced in comments_enforce_nesting() below, because "does my
  -- parent have a parent" needs a lookup a CHECK constraint cannot perform.
  parent_id    uuid        references public.comments (id) on delete cascade,
  -- Length capped at the SAME 2000 characters lib/ratings/types.ts already
  -- uses for MAX_NOTE_LENGTH — reusing a number this app has already picked
  -- for "a real block of prose about a title," not a fresh arbitrary pick.
  -- The lower bound is relaxed to zero once a comment is deleted — see the
  -- deleted_at clause below; comments_lock_immutable_fields() forces body to
  -- '' at the moment deleted_at is set, so this constraint and that trigger
  -- must be read together.
  body         text        not null check (deleted_at is not null or char_length(body) between 1 and 2000),
  -- 'hidden' is reachable ONLY via the report auto-hide trigger (security
  -- definer) or direct database access — never via a plain client UPDATE.
  -- See comments_lock_immutable_fields().
  status       text        not null default 'visible' check (status in ('visible', 'hidden')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Set automatically by comments_lock_immutable_fields() the moment body
  -- changes — never client-supplied, so a client cannot hide the fact that a
  -- comment was edited.
  edited_at    timestamptz,
  -- A tombstone, not a DELETE — same reasoning CLAUDE.md gives everywhere
  -- else in this schema: a hard delete would orphan replies with a dangling
  -- reference, and this schema's whole discipline is "no DELETE policy for
  -- regular users, ever." There genuinely is no DELETE policy below.
  deleted_at   timestamptz,
  check ((season_number is null) = (episode_number is null)),
  check (not (media_type = 'movie' and season_number is not null))
);

create index comments_scope_idx
  on public.comments (media_type, title_id, season_number, episode_number, created_at);
create index comments_parent_idx
  on public.comments (parent_id) where parent_id is not null;

create trigger comments_set_updated_at
  before update on public.comments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- The visibility check — ONE function, used by both the SELECT policy (can
-- you see comments here) and the INSERT policy (can you post here), so the
-- two can never silently drift apart. If they diverged, the app could show a
-- reader a "write a comment" box for a scope whose OWN comments they can't
-- read back — a confusing, security-adjacent bug this design structurally
-- rules out by construction.
--
-- `security invoker` (the default, written explicitly to document the
-- decision rather than rely on it being remembered): this runs as the CALLING
-- user and its internal SELECTs are themselves subject to that user's own RLS
-- on watched_episodes/tracked_titles. It needs no elevated privilege at all —
-- it only ever reads rows the caller could already read directly, just
-- packaged as one boolean. Contrast with comment_like_counts and the report
-- auto-hide trigger below, which genuinely DO need security definer because
-- they touch other users' rows.
-- ---------------------------------------------------------------------------
create function public.can_view_comment_scope(
  p_media_type text,
  p_title_id text,
  p_season_number int,
  p_episode_number int
)
returns boolean
language sql
security invoker
stable
set search_path = ''
as $$
  select case
    when p_episode_number is not null then
      exists (
        select 1 from public.watched_episodes we
         where we.user_id = auth.uid()
           and we.media_type = p_media_type
           and we.title_id = p_title_id
           and we.season_number = p_season_number
           and we.episode_number = p_episode_number
           and we.deleted_at is null
      )
    when p_media_type = 'movie' then
      exists (
        select 1 from public.tracked_titles tt
         where tt.user_id = auth.uid()
           and tt.media_type = 'movie'
           and tt.title_id = p_title_id
           and tt.status = 'watched'
           and tt.deleted_at is null
      )
    else true -- tv title-level: open discussion, no gate
  end;
$$;

-- Callable directly (not just used inside policies): the app's server-side
-- query layer RPCs into this SAME function to compute "can this viewer post
-- here" for the UI (lib/comments/queries.ts), rather than re-implementing the
-- gating logic a second time in TypeScript, where it could silently drift
-- from what the RLS policies actually enforce. Postgres grants EXECUTE on a
-- new function to PUBLIC by default; revoking first makes the grant explicit
-- and reviewable rather than implicit, the same discipline every other
-- function in this schema follows (see `username_available` in
-- 20260806000001_usernames.sql).
revoke execute on function public.can_view_comment_scope(text, text, int, int) from public;
grant execute on function public.can_view_comment_scope(text, text, int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Reply nesting + scope inheritance.
--
-- A reply's scope (media_type/title_id/season/episode) is NEVER taken from
-- client input — it is OVERWRITTEN here from the parent's actual row. Two
-- reasons this is not optional:
--
--   1. Never trust the client (the brief says so outright). A client claiming
--      a reply belongs to one scope while attaching it under a comment from
--      another would let a reply "launder" itself into a spoiler-gated
--      thread it was never actually posted through the gate for.
--   2. It is what lets can_view_comment_scope() run correctly and identically
--      for both a top-level comment and a reply — the WITH CHECK on the
--      INSERT policy evaluates against the FINAL row, i.e. AFTER this BEFORE
--      trigger has run (Postgres evaluates constraints/RLS on the post-
--      trigger row), so a reply is gated on its PARENT's real scope
--      regardless of what the client sent.
--
-- Also blocks replying to an already-hidden comment unless you are its
-- author — belt and braces alongside the fact that a non-author generally
-- cannot even SELECT a hidden row to discover its id in the first place.
-- ---------------------------------------------------------------------------
create function public.comments_enforce_nesting()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  parent public.comments;
begin
  if new.parent_id is null then
    return new;
  end if;

  select * into parent from public.comments where id = new.parent_id;

  if not found then
    raise exception 'parent comment does not exist';
  end if;

  if parent.parent_id is not null then
    raise exception 'replies cannot be nested more than one level deep';
  end if;

  if parent.status = 'hidden' and parent.user_id <> new.user_id then
    raise exception 'cannot reply to a hidden comment';
  end if;

  new.media_type     := parent.media_type;
  new.title_id       := parent.title_id;
  new.season_number  := parent.season_number;
  new.episode_number := parent.episode_number;

  return new;
end;
$$;

create trigger comments_enforce_nesting
  before insert on public.comments
  for each row execute function public.comments_enforce_nesting();

-- ---------------------------------------------------------------------------
-- Field-level locking on UPDATE.
--
-- RLS's own-rows UPDATE policy (below) only answers "is this your row" — it
-- says nothing about WHICH columns a client may change once it is. Without
-- this trigger, an owner could rewrite their comment's title_id, parent_id,
-- or user_id via a raw PATCH and relocate it into a different thread, or
-- silently un-edit the edited_at marker.
--
-- status is allowed to move 'visible' -> 'hidden' by ANYONE hitting this
-- trigger (including a plain owner UPDATE) because RLS already restricts a
-- normal UPDATE to the caller's OWN rows — so the only thing an owner
-- self-hiding achieves is hiding their own comment, which they could already
-- do via deleted_at. The one thing this trigger forbids outright is the
-- REVERSE direction, 'hidden' -> 'visible': there is no un-hide path in this
-- "basic" moderation system (see comment_reports_auto_hide below) — a site
-- operator can flip it back directly via the Supabase SQL editor with the
-- service role until an admin UI exists in a later phase. Stated here rather
-- than silently implied.
-- ---------------------------------------------------------------------------
create function public.comments_lock_immutable_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id <> old.user_id
     or new.media_type <> old.media_type
     or new.title_id <> old.title_id
     or new.parent_id is distinct from old.parent_id
     or new.season_number is distinct from old.season_number
     or new.episode_number is distinct from old.episode_number
     or new.created_at <> old.created_at
  then
    raise exception 'cannot change a comment''s identity fields';
  end if;

  if old.status = 'hidden' and new.status = 'visible' then
    raise exception 'un-hiding a comment is not available yet';
  end if;

  if old.deleted_at is not null and new.body <> old.body then
    raise exception 'cannot edit a deleted comment';
  end if;

  -- Deleting clears the text server-side, unconditionally — even if the
  -- caller forgot to (or a future bug forgets to). A tombstoned comment must
  -- never retain its content.
  if new.deleted_at is not null then
    new.body := '';
  end if;

  -- Auto-stamped, never client-supplied — a client cannot post an edit while
  -- claiming it was never edited.
  if new.body <> old.body then
    new.edited_at := now();
  end if;

  return new;
end;
$$;

create trigger comments_lock_immutable_fields
  before update on public.comments
  for each row execute function public.comments_lock_immutable_fields();

-- ===========================================================================
-- comments RLS
--
-- ⚠ THE SECOND INTENTIONAL EXCEPTION TO OWN-ROWS-ONLY, after `profiles`
-- (20260801000001 §3.3). Comments are a broadcast table by nature — every
-- authenticated user must be able to read comments authored by every OTHER
-- user, which is the entire feature. What keeps this from being "just turn
-- RLS off": the SELECT policy still actively filters on TWO axes every read,
-- not merely on ownership — moderation status and spoiler gating — so
-- "broadcast" here means "broadcast to whoever the two filters allow," never
-- "broadcast to everyone."
-- ===========================================================================
alter table public.comments enable row level security;
alter table public.comments force  row level security;
revoke all on public.comments from anon;

-- Visible if: (not hidden, OR you are the author) AND (you can view this
-- scope, OR you are the author). The author clause exists twice because the
-- two conditions are independent — an author must see their own hidden
-- comment (so they know it happened) AND their own comment even if they
-- later un-mark the episode it was posted under (see the file header comment
-- for why losing your own comment that way would be a confusing regression).
create policy "comments_select_visible" on public.comments
  for select to authenticated
  using (
    (status <> 'hidden' or user_id = (select auth.uid()))
    and (
      user_id = (select auth.uid())
      or public.can_view_comment_scope(media_type, title_id, season_number, episode_number)
    )
  );

-- You may only post as yourself, into a scope you could also read comments
-- in (see the file header — this is the identical function the SELECT policy
-- uses, so the two can never drift), and never insert a pre-hidden or
-- pre-deleted row.
create policy "comments_insert_own" on public.comments
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'visible'
    and deleted_at is null
    and public.can_view_comment_scope(media_type, title_id, season_number, episode_number)
  );

-- USING restricts which rows an UPDATE can target (your own); WITH CHECK
-- restricts what the row may become (still your own — prevents reassigning
-- user_id to someone else, the exact §3.2 lesson from Phase 6 Step 3).
-- comments_lock_immutable_fields() above does everything else RLS cannot
-- express: which COLUMNS may change and in which direction.
create policy "comments_update_own" on public.comments
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Deliberately NO delete policy. "Delete your own" is served by an UPDATE
-- setting deleted_at — see the tombstone note on the column above. A real
-- DELETE would either orphan replies (if cascaded to nothing) or need to
-- reject deletion whenever replies exist (an awkward, hard-to-express-in-RLS
-- asymmetric rule) — the tombstone sidesteps both problems for free, and
-- matches every other table in this schema.

-- ---------------------------------------------------------------------------
-- comment_likes
--
-- A plain own-rows table — the uniform pattern every OTHER table in this
-- schema uses (20260801000001 §3.1) — deliberately NOT a "profiles-style"
-- broadcast table. The total like count is disclosed only through
-- comment_like_counts() below, which reveals a NUMBER and nothing else —
-- never the list of who liked what. That is a real privacy choice, not an
-- oversight: "did I like this" is answerable from a user's own row under
-- this ordinary policy; "how many people liked this" does not require
-- knowing WHICH people, so it is never exposed that way.
-- ---------------------------------------------------------------------------
create table public.comment_likes (
  user_id    uuid        not null references auth.users (id) on delete cascade,
  comment_id uuid        not null references public.comments (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, comment_id)
);

create index comment_likes_comment_idx on public.comment_likes (comment_id);

alter table public.comment_likes enable row level security;
alter table public.comment_likes force  row level security;
revoke all on public.comment_likes from anon;

create policy "comment_likes_select_own" on public.comment_likes
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Re-derives the SAME visibility check the comments table itself uses — you
-- cannot like a comment you are not allowed to see. Without this, "like"
-- becomes a scope-existence oracle: probing random comment ids and watching
-- insert succeed/fail would let a client detect hidden episode discussion it
-- otherwise cannot read at all.
create policy "comment_likes_insert_own" on public.comment_likes
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.comments c
       where c.id = comment_id
         and c.status <> 'hidden'
         and (
           c.user_id = (select auth.uid())
           or public.can_view_comment_scope(c.media_type, c.title_id, c.season_number, c.episode_number)
         )
    )
  );

-- A like is a toggle, not an edited fact — deleting your own row (un-liking)
-- is safe and orphans nothing, unlike a comment. This is the one table in
-- the whole schema that DOES get a real DELETE policy.
create policy "comment_likes_delete_own" on public.comment_likes
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- comment_reports
--
-- Append-only, same discipline as watch_events: no UPDATE, no DELETE. A
-- report, once filed, is a permanent fact — there is no "un-report."
-- ---------------------------------------------------------------------------
create table public.comment_reports (
  id          uuid        primary key default gen_random_uuid(),
  comment_id  uuid        not null references public.comments (id) on delete cascade,
  reporter_id uuid        not null references auth.users (id) on delete cascade,
  reason      text        not null check (reason in ('spam', 'harassment', 'spoiler', 'other')),
  note        text        check (note is null or char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  -- One report per (comment, reporter) — the report count driving auto-hide
  -- below counts ROWS, so without this a single account could inflate the
  -- count by reporting the same comment repeatedly.
  unique (comment_id, reporter_id)
);

create index comment_reports_comment_idx on public.comment_reports (comment_id);

alter table public.comment_reports enable row level security;
alter table public.comment_reports force  row level security;
revoke all on public.comment_reports from anon;

-- A reporter may see reports THEY filed (so the UI can show "you reported
-- this") — never reports filed by anyone else, which would let a reporter be
-- identified or retaliated against by the person they reported.
create policy "comment_reports_select_own" on public.comment_reports
  for select to authenticated
  using (reporter_id = (select auth.uid()));

-- No self-reports, and — same visibility re-derivation as comment_likes —
-- you cannot report a comment you are not allowed to see.
create policy "comment_reports_insert_own" on public.comment_reports
  for insert to authenticated
  with check (
    reporter_id = (select auth.uid())
    and exists (
      select 1 from public.comments c
       where c.id = comment_id
         and c.user_id <> (select auth.uid())
         and public.can_view_comment_scope(c.media_type, c.title_id, c.season_number, c.episode_number)
    )
  );

-- ---------------------------------------------------------------------------
-- The "basic moderation path": auto-hide after enough distinct reports.
--
-- SECURITY DEFINER, and worth being precise about why this one genuinely
-- needs it where can_view_comment_scope() and comments_enforce_nesting() do
-- not: this function writes to a comments ROW OWNED BY SOMEONE ELSE (the
-- reported comment's author, who is essentially never the reporter — self-
-- reports are blocked above). The reporter's own RLS grants them no UPDATE
-- rights on that row at all, so reaching it requires the function's elevated,
-- narrowly-scoped privilege — the same class of exception as
-- `username_available` in the Phase 6 Step 4 migration, held to the same
-- rules: `set search_path = ''`, every reference schema-qualified, and it
-- does exactly one thing.
--
-- Threshold is 3 DISTINCT reporters (guaranteed distinct by the unique
-- constraint above) — small and deliberate, matching this project's existing
-- honesty about limits it is not solving: three coordinated bad-faith
-- accounts CAN trigger this, and there is no appeal path in this "basic"
-- system (see comments_lock_immutable_fields's note on un-hiding). Documented
-- as an accepted limitation, the same tone as the rate limiter's own
-- "not a strict distributed limiter" admission.
-- ---------------------------------------------------------------------------
create function public.comment_reports_auto_hide()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  report_count int;
begin
  select count(*) into report_count
    from public.comment_reports
   where comment_id = new.comment_id;

  if report_count >= 3 then
    update public.comments
       set status = 'hidden'
     where id = new.comment_id
       and status = 'visible';
  end if;

  return new;
end;
$$;

create trigger comment_reports_auto_hide
  after insert on public.comment_reports
  for each row execute function public.comment_reports_auto_hide();

-- ---------------------------------------------------------------------------
-- comment_like_counts — batched, count-only disclosure.
--
-- SECURITY DEFINER to bypass comment_likes' own-rows RLS — but note precisely
-- what it discloses: a NUMBER per comment id, never a row, never a liker's
-- identity. Same "disclose existence/count only" shape as
-- `username_available` from Phase 6 Step 4.
--
-- Batched over an array rather than one id at a time: a comment thread with
-- 40 comments would otherwise cost 40 round trips to render like counts,
-- exactly the N+1 pattern CLAUDE.md already flags as a bug class elsewhere
-- (Phase 4 Step 4's getTitle/getExternalRatings sharing one fetch).
-- ---------------------------------------------------------------------------
create function public.comment_like_counts(p_comment_ids uuid[])
returns table (comment_id uuid, likes bigint)
language sql
security definer
stable
set search_path = ''
as $$
  select cl.comment_id, count(*) as likes
    from public.comment_likes cl
   where cl.comment_id = any(p_comment_ids)
   group by cl.comment_id;
$$;

revoke execute on function public.comment_like_counts(uuid[]) from public;
grant execute on function public.comment_like_counts(uuid[]) to authenticated;

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
