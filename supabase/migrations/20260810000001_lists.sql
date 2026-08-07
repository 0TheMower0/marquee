-- ===========================================================================
-- Marquee — Phase 6 Step 6b: shared and public lists
--
-- Same "schema and RLS in one transaction" discipline as every migration in
-- this directory — see the header comment in 20260801000001 for why a table
-- must never exist without RLS for even one instant.
--
-- ---------------------------------------------------------------------------
-- THE ONE THING WORTH READING BEFORE ANYTHING ELSE: THE RECURSION TRAP
-- ---------------------------------------------------------------------------
-- 20260809000001's `can_view_comment_scope()` is `security invoker`, and its
-- own doc comment argues that's the SAFER default — it needs no elevated
-- privilege because it only ever reads rows the caller could already read
-- directly. That reasoning does NOT carry over here, and getting this wrong
-- doesn't just leak data, it hangs the query.
--
-- `can_view_comment_scope()` is called from a policy ON `comments`, but it
-- queries `watched_episodes`/`tracked_titles` — a DIFFERENT table. No
-- recursion risk.
--
-- `can_view_list()` below is called from a policy ON `lists`, and it queries
-- `lists` — the SAME table. Under `security invoker`, that inner query would
-- itself be subject to `lists`' own SELECT policy — which calls
-- `can_view_list()` again, on the same row, forever. This is a well-known RLS
-- pitfall, not a hypothetical: self-referencing helper functions on the table
-- they protect MUST be `security definer`, which bypasses RLS for the
-- function's own internal query and breaks the cycle cleanly. Every helper
-- function in this migration is `security definer` for exactly this reason —
-- even the ones that don't obviously self-reference, because they call each
-- other and the shortest path to "definitely safe" was "always definer here."
-- Each still discloses only a narrow computed boolean or count, never a raw
-- row — the same restraint `username_available`/`comment_like_counts` already
-- established, just applied more broadly because the recursion risk demanded
-- it.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- lists
--
-- The list's own `id` (a v4 UUID, unguessable) IS the shareable link —
-- `/lists/{id}`, no separate slug column. A UUID already has as much entropy
-- as a purpose-built random token would, so a second column would be pure
-- duplication.
--
-- PUBLIC vs UNLISTED is a narrower distinction than it sounds, and it matters
-- for how the RLS below reads: **the two are identical at the RLS layer.**
-- Both mean "any authenticated user may view this, given its id." The ONLY
-- difference is DISCOVERABILITY — whether a title shows up in a "browse
-- public lists" query — and that is enforced entirely at the query level (the
-- browse query filters `where visibility = 'public'`), never by hiding row
-- access. An unlisted list is exactly as readable as a public one to anyone
-- who has the link; it just never appears anywhere unprompted.
--
-- Confirmed with the user before writing any of this: a shareable link
-- requires being SIGNED IN, matching comments' precedent exactly (`profiles`
-- is already `to authenticated` only). "Shareable" here means "anyone with an
-- account and the link," not literally anyone on the internet — extending
-- that would additionally require relaxing `profiles`' own SELECT policy,
-- which is a separate, larger decision this step deliberately does not make.
create table public.lists (
  id           uuid        primary key default gen_random_uuid(),
  -- References PROFILES, not auth.users — same deliberate exception
  -- `comments.user_id` makes, for the same two reasons: it lets PostgREST
  -- embed the owner's username directly, and it guarantees a list can never
  -- exist without a real profile row to attribute it to.
  owner_id     uuid        not null
    constraint lists_owner_id_fkey references public.profiles (id) on delete cascade,
  name         text        not null check (char_length(name) between 1 and 100),
  description  text        check (description is null or char_length(description) <= 500),
  visibility   text        not null default 'private'
    check (visibility in ('private', 'unlisted', 'public')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- Tombstone, matching every other table in this schema. The owner CAN
  -- restore their own list by clearing this later (no lock trigger forbids
  -- it) — unlike a hidden COMMENT, there is no third party's moderation
  -- decision to protect here, only the owner's own content.
  deleted_at   timestamptz
);

create index lists_owner_idx on public.lists (owner_id);
-- Serves the "browse public lists" query specifically — partial, since only
-- public+live rows are ever scanned by it.
create index lists_public_idx on public.lists (created_at desc)
  where visibility = 'public' and deleted_at is null;

create trigger lists_set_updated_at
  before update on public.lists
  for each row execute function public.set_updated_at();

-- Identity-field lock, same §3.2-lesson shape as comments: an owner may
-- rename/describe/re-visibility/delete their own list, but never reassign it
-- to someone else or rewrite when it was created.
create function public.lists_lock_immutable_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.owner_id <> old.owner_id or new.created_at <> old.created_at then
    raise exception 'cannot change a list''s identity fields';
  end if;
  return new;
end;
$$;

create trigger lists_lock_immutable_fields
  before update on public.lists
  for each row execute function public.lists_lock_immutable_fields();

-- ---------------------------------------------------------------------------
-- list_collaborators
--
-- Invites require acceptance — an owner cannot silently add someone as a
-- collaborator on a list they never agreed to help curate. `status` starts at
-- 'invited' and can only move to 'accepted', never back — a lock trigger
-- enforces the one-way transition, the same shape
-- `comments_lock_immutable_fields()` uses for 'hidden' never returning to
-- 'visible'. DECLINING an invite is a DELETE, not a third status — there is
-- no reason to keep a permanent record of a declined invite the way a
-- moderation report needs to be permanent.
--
-- `invited_by` is `on delete set null`, deliberately DIFFERENT from
-- `owner_id`'s `on delete cascade` above: if the person who sent an invite
-- later deletes their account, the INVITEE's membership must not evaporate
-- with them — only the "who invited you" attribution becomes unknown. The
-- collaboration itself outlives the inviter.
--
-- Both FK constraints to `profiles` below are named EXPLICITLY, not just for
-- consistency with the rest of this schema — it is load-bearing here. This
-- table has TWO separate FKs into `profiles` (`user_id` and `invited_by`), so
-- PostgREST cannot infer which one an embed like `profiles(username)` means;
-- the query layer must disambiguate with
-- `member:profiles!list_collaborators_user_id_fkey(...)` and
-- `inviter:profiles!list_collaborators_invited_by_fkey(...)`, and both names
-- have to actually exist to reference.
-- ---------------------------------------------------------------------------
create table public.list_collaborators (
  list_id      uuid        not null references public.lists (id) on delete cascade,
  user_id      uuid        not null
    constraint list_collaborators_user_id_fkey references public.profiles (id) on delete cascade,
  invited_by   uuid
    constraint list_collaborators_invited_by_fkey references public.profiles (id) on delete set null,
  status       text        not null default 'invited' check (status in ('invited', 'accepted')),
  invited_at   timestamptz not null default now(),
  responded_at timestamptz,
  primary key (list_id, user_id)
);

create index list_collaborators_user_idx on public.list_collaborators (user_id, status);

create function public.list_collaborators_lock_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.list_id <> old.list_id
     or new.user_id <> old.user_id
     or new.invited_at <> old.invited_at
  then
    raise exception 'cannot change a collaborator row''s identity fields';
  end if;

  if old.status = 'accepted' and new.status = 'invited' then
    raise exception 'cannot revert an accepted invite back to invited';
  end if;

  -- Server-stamped the moment status genuinely changes to accepted — never
  -- client-supplied, same reasoning comments' edited_at gets auto-stamped.
  if old.status <> 'accepted' and new.status = 'accepted' then
    new.responded_at := now();
  end if;

  return new;
end;
$$;

create trigger list_collaborators_lock_fields
  before update on public.list_collaborators
  for each row execute function public.list_collaborators_lock_fields();

-- ---------------------------------------------------------------------------
-- list_items
--
-- `summary` is a TitleSummary snapshot, same "denormalized provider data,
-- read as a unit, never queried by field" reasoning as
-- `tracked_titles.summary` — rendering a list must not cost a provider fetch
-- per item.
--
-- `added_by` is `on delete set null` for the SAME reason as
-- `list_collaborators.invited_by`: if a collaborator adds three titles and
-- later deletes their account, those three items must survive — only the
-- attribution is lost. Losing someone's account should never mean losing
-- content THEY contributed to something you own.
-- ---------------------------------------------------------------------------
create table public.list_items (
  list_id        uuid        not null references public.lists (id) on delete cascade,
  media_type     text        not null check (media_type in ('movie', 'tv')),
  title_id       text        not null,
  summary        jsonb       not null,
  added_by       uuid
    constraint list_items_added_by_fkey references public.profiles (id) on delete set null,
  added_at       timestamptz not null default now(),
  primary key (list_id, media_type, title_id)
);

-- Serves shares_editable_list_with() below: "which lists contain title X" is
-- its central join, and without this index that's a sequential scan of every
-- item on every list in the database for every tracked_titles row a
-- collaborator's view has to check.
create index list_items_title_idx on public.list_items (media_type, title_id);

-- ---------------------------------------------------------------------------
-- list_followers
--
-- A plain toggle, the identical shape `comment_likes` already established:
-- own-rows SELECT/INSERT/DELETE, and a count is disclosed only through a
-- batched, count-only `security definer` RPC — never the list of who
-- follows, for the same privacy reasoning `comment_like_counts` documents.
-- ---------------------------------------------------------------------------
create table public.list_followers (
  list_id     uuid        not null references public.lists (id) on delete cascade,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  followed_at timestamptz not null default now(),
  primary key (list_id, user_id)
);

create index list_followers_user_idx on public.list_followers (user_id);

-- ===========================================================================
-- Helper functions — see the file header for why these are ALL
-- `security definer`.
-- ===========================================================================

-- Can the CURRENT user view this list at all? True for: the owner, an
-- accepted collaborator, or ANY authenticated user when the list is public or
-- unlisted (see the file header on why those two are identical here). False
-- for a soft-deleted list, unconditionally — checked here, in exactly one
-- place, rather than duplicated in every policy that calls this.
create function public.can_view_list(p_list_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.lists l
     where l.id = p_list_id
       and l.deleted_at is null
       and (
         l.visibility in ('public', 'unlisted')
         or l.owner_id = auth.uid()
         or exists (
           select 1 from public.list_collaborators lc
            where lc.list_id = l.id
              and lc.user_id = auth.uid()
              and lc.status = 'accepted'
         )
       )
  );
$$;

revoke execute on function public.can_view_list(uuid) from public;
grant execute on function public.can_view_list(uuid) to authenticated;

-- Can the CURRENT user ADD/curate items on this list? Deliberately NARROWER
-- than can_view_list: "public" describes READ access, never write access — a
-- random authenticated user browsing someone's public list must not be able
-- to add items to it just because they can see it. Only the owner and
-- accepted collaborators may edit, regardless of visibility.
create function public.can_edit_list(p_list_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.lists l
     where l.id = p_list_id
       and l.deleted_at is null
       and (
         l.owner_id = auth.uid()
         or exists (
           select 1 from public.list_collaborators lc
            where lc.list_id = l.id
              and lc.user_id = auth.uid()
              and lc.status = 'accepted'
         )
       )
  );
$$;

revoke execute on function public.can_edit_list(uuid) from public;
grant execute on function public.can_edit_list(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The cross-user tracked_titles carve-out — the single most sensitive
-- function in this migration, because it is the ONE thing in this entire
-- schema that lets one user read a fact about another user's PERSONAL
-- tracking data. Confirmed explicitly with the user before writing this: the
-- exception is scoped to EXACTLY "you share a list containing this title, and
-- you are both actual members (owner or accepted collaborator) of it" —
-- nothing broader. Viewing a PUBLIC list does not, by itself, expose a
-- fellow viewer's tracking status to you; only being an editing MEMBER of a
-- shared list does, and only for titles that list actually contains.
--
-- `security definer` here is not just about the general recursion caution
-- from the file header — it is load-bearing for correctness. Without it, the
-- function's own reads of `lists`/`list_collaborators` would be filtered by
-- THE CALLING USER's own RLS on those tables, which could silently produce
-- the wrong answer (e.g. failing to see a collaborator row on a list the
-- caller can view but isn't themselves a privileged reader of, for some
-- future policy shape). Definer makes this function self-contained and its
-- answer independent of the caller's own unrelated read permissions.
-- ---------------------------------------------------------------------------
create function public.shares_editable_list_with(
  p_other_user uuid,
  p_media_type text,
  p_title_id text
)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.list_items li
      join public.lists l on l.id = li.list_id and l.deleted_at is null
     where li.media_type = p_media_type
       and li.title_id = p_title_id
       and (
         l.owner_id = auth.uid()
         or exists (
           select 1 from public.list_collaborators lc
            where lc.list_id = l.id and lc.user_id = auth.uid() and lc.status = 'accepted'
         )
       )
       and (
         l.owner_id = p_other_user
         or exists (
           select 1 from public.list_collaborators lc2
            where lc2.list_id = l.id and lc2.user_id = p_other_user and lc2.status = 'accepted'
         )
       )
  );
$$;

revoke execute on function public.shares_editable_list_with(uuid, text, text) from public;
grant execute on function public.shares_editable_list_with(uuid, text, text) to authenticated;

-- Batched, count-only disclosure — same shape as comment_like_counts(), same
-- reasoning: a NUMBER per list id, never a row, never a follower's identity.
create function public.list_follower_counts(p_list_ids uuid[])
returns table (list_id uuid, followers bigint)
language sql
security definer
stable
set search_path = ''
as $$
  select lf.list_id, count(*) as followers
    from public.list_followers lf
   where lf.list_id = any(p_list_ids)
   group by lf.list_id;
$$;

revoke execute on function public.list_follower_counts(uuid[]) from public;
grant execute on function public.list_follower_counts(uuid[]) to authenticated;

-- ===========================================================================
-- RLS
-- ===========================================================================

-- --------------------------------- lists ------------------------------------
alter table public.lists enable row level security;
alter table public.lists force  row level security;
revoke all on public.lists from anon;

create policy "lists_select_visible" on public.lists
  for select to authenticated
  using (public.can_view_list(id));

create policy "lists_insert_own" on public.lists
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

-- USING restricts which rows an UPDATE can target (only the owner's own);
-- WITH CHECK restricts what the row may become (still owned by the same
-- person) — the §3.2 shape. Collaborators get NO update policy at all: they
-- may add items (list_items, below) but never rename/re-describe/re-
-- visibility/delete the list itself.
create policy "lists_update_own" on public.lists
  for update to authenticated
  using      (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Deliberately no delete policy — soft-delete via UPDATE (deleted_at), the
-- same tombstone discipline as tracked_titles/ratings/comments.

-- ----------------------------- list_items -----------------------------------
alter table public.list_items enable row level security;
alter table public.list_items force  row level security;
revoke all on public.list_items from anon;

create policy "list_items_select_visible" on public.list_items
  for select to authenticated
  using (public.can_view_list(list_id));

create policy "list_items_insert_editor" on public.list_items
  for insert to authenticated
  with check (added_by = (select auth.uid()) and public.can_edit_list(list_id));

-- Whoever added an item may remove it; the LIST OWNER may remove any item
-- regardless of who added it (ordinary curation power over their own list).
-- A collaborator may NOT remove another collaborator's addition — avoids one
-- collaborator unilaterally editing another's contribution out of a shared
-- list.
create policy "list_items_delete_adder_or_owner" on public.list_items
  for delete to authenticated
  using (
    added_by = (select auth.uid())
    or exists (
      select 1 from public.lists l
       where l.id = list_items.list_id and l.owner_id = (select auth.uid())
    )
  );

-- ------------------------- list_collaborators -------------------------------
alter table public.list_collaborators enable row level security;
alter table public.list_collaborators force  row level security;
revoke all on public.list_collaborators from anon;

-- You can always see your own membership/invite row (so a pending invite is
-- visible to the person it's FOR); an owner or accepted collaborator can see
-- the full roster (so a shared list's members know who else is on it).
create policy "list_collaborators_select_member" on public.list_collaborators
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.can_edit_list(list_id)
  );

-- Only the OWNER may invite — a collaborator cannot invite further
-- collaborators, which keeps control of who joins with the person who
-- created the list. Must be inserted as 'invited', never directly as
-- 'accepted' — there is no path that skips the acceptance step.
create policy "list_collaborators_insert_owner" on public.list_collaborators
  for insert to authenticated
  with check (
    invited_by = (select auth.uid())
    and status = 'invited'
    and exists (
      select 1 from public.lists l
       where l.id = list_id and l.owner_id = (select auth.uid())
    )
  );

-- Only the INVITEE may update their own row — this is the accept action.
-- list_collaborators_lock_fields() above does the rest: no reverting
-- 'accepted' back to 'invited', identity fields immutable.
create policy "list_collaborators_update_self" on public.list_collaborators
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- The invitee may remove themselves (decline, or leave later); the owner may
-- remove anyone (revoke access).
create policy "list_collaborators_delete_self_or_owner" on public.list_collaborators
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.lists l
       where l.id = list_id and l.owner_id = (select auth.uid())
    )
  );

-- -------------------------- list_followers ----------------------------------
alter table public.list_followers enable row level security;
alter table public.list_followers force  row level security;
revoke all on public.list_followers from anon;

create policy "list_followers_select_own" on public.list_followers
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Anyone who can VIEW a list may follow it — including a private list's own
-- owner/collaborators, which is harmless (mildly redundant, not worth a
-- special case) rather than something requiring active prevention.
create policy "list_followers_insert_own" on public.list_followers
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.can_view_list(list_id));

create policy "list_followers_delete_own" on public.list_followers
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- --------------------- tracked_titles: the new carve-out ---------------------
-- ADDS to, does not replace, `tracked_titles_select_own` from 20260801000001.
-- Postgres OR's multiple permissive policies for the same command together,
-- so a user's own rows remain visible via the original policy exactly as
-- before; this one ADDITIONALLY exposes another member's row for a title you
-- both share on an editable list. Every other table's rows (ratings,
-- rating_notes, watch_events, badges_earned, xp_state) remain exactly as
-- private as they always were — this carve-out touches tracked_titles alone.
create policy "tracked_titles_select_shared_list_member" on public.tracked_titles
  for select to authenticated
  using (public.shares_editable_list_with(user_id, media_type, title_id));

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
