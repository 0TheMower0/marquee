-- Phase 6 Step 6b follow-up — found live, not in review.
--
-- can_view_list() only counted an ACCEPTED collaborator as able to view a
-- list, never an INVITED one. That meant a pending invitee could see their
-- own row in list_collaborators (user_id = auth.uid() satisfies that
-- table's own SELECT policy) but could not see the LIST itself — so
-- getPendingInvites()'s `list:lists!inner(...)` embed silently dropped the
-- row, because PostgREST/Postgres only returns an inner-joined row when the
-- embedded table's own RLS also permits it. The practical symptom: account A
-- invited account B, the invite existed and account A could see it as
-- "Invited", and account B's Profile page showed nothing at all — no error,
-- no row, nothing to accept.
--
-- Confirmed directly against the live database before this fix, impersonating
-- the actual invited user: their own list_collaborators row was visible
-- (own_rows_visible = 1) while can_view_list() on the list itself returned
-- false. This migration is the fix, not a guess.
--
-- The fix is narrow and deliberate: 'invited' joins 'accepted' in the SAME
-- branch can_view_list already had for collaborators — a pending invitee can
-- now VIEW the list (and, as a consequence, its items — see the header
-- comment on list_items_select_visible in the base migration, which reuses
-- this same function) so they can decide whether to accept. It does NOT
-- touch can_edit_list, which is untouched below it and still requires
-- 'accepted' — an invitee gains read access only, never the ability to add
-- items, edit the list, or touch the collaborator roster. That boundary is
-- the whole point of the acceptance step and this migration does not move it.
create or replace function public.can_view_list(p_list_id uuid)
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
              and lc.status in ('accepted', 'invited')
         )
       )
  );
$$;

-- CREATE OR REPLACE does not carry security/volatility attributes forward
-- implicitly — they are restated above in full. Omitting `security definer`
-- here would silently revert this function to SECURITY INVOKER, which is
-- exactly the self-reference recursion trap the base migration's header
-- comment exists to warn about. Do not "simplify" this to a bare ALTER.
revoke execute on function public.can_view_list(uuid) from public;
grant execute on function public.can_view_list(uuid) to authenticated;
