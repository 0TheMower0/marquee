import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server-client";

import { mapListError } from "./errors";
import type {
  ListDetail,
  ListItemEntry,
  ListMember,
  ListSummary,
  MemberStatus,
  PendingInvite,
} from "./types";
import {
  buildListDetail,
  computeAgreementItems,
  rowToCollaborator,
  rowToListItem,
  rowToListSummary,
  type ListCollaboratorRow,
  type ListItemRow,
  type ListRow,
} from "./wire";

/**
 * Server-only reads. `import "server-only"` matches `lib/comments/queries.ts`
 * and every other server-side data layer in this app — an accidental Client
 * Component import becomes a build error here, not a runtime question of
 * whether the anon key happens to be enough.
 *
 * Every function degrades to `null`/`[]` on failure rather than throwing —
 * the caller (a Server Component) is expected to wrap the call in its own
 * try/catch and render a degraded state, the exact lesson Phase 6 Step 6a's
 * `CommentSection` learned the hard way: a missing try/catch there took down
 * an entire title page on a transient failure. See `components/lists/`.
 */

const SUMMARY_COLUMNS = `
  id, owner_id, name, description, visibility, created_at, updated_at, deleted_at,
  owner:profiles!lists_owner_id_fkey ( username, display_name ),
  list_items ( count )
`;

const ITEM_COLUMNS = `
  list_id, media_type, title_id, summary, added_by, added_at,
  adder:profiles!list_items_added_by_fkey ( username, display_name )
`;

const COLLABORATOR_COLUMNS = `
  list_id, user_id, invited_by, status, invited_at, responded_at,
  member:profiles!list_collaborators_user_id_fkey ( username, display_name ),
  inviter:profiles!list_collaborators_invited_by_fkey ( username, display_name )
`;

/** PostgREST's embedded-count shape: `list_items(count)` comes back as
 *  `[{count: N}]`, not a bare number. */
type WithItemCount = ListRow & { list_items: { count: number }[] };

async function attachFollowerCounts(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  rows: WithItemCount[],
  viewerId: string,
): Promise<ListSummary[]> {
  if (rows.length === 0) return [];

  // Batched into ONE call rather than one per list — same N+1 avoidance as
  // lib/comments/queries.ts's comment_like_counts usage, and for the same
  // reason: list_followers' own RLS is own-rows-only (see the migration), so
  // an embedded `list_followers(count)` would silently count only the
  // VIEWER's own follow row, not the true total.
  const { data: counts, error } = await supabase.rpc("list_follower_counts", {
    p_list_ids: rows.map((row) => row.id),
  });
  if (error) throw mapListError(error);

  const followerCounts = new Map<string, number>();
  for (const row of (counts ?? []) as { list_id: string; followers: number }[]) {
    followerCounts.set(row.list_id, row.followers);
  }

  return rows.map((row) =>
    rowToListSummary(
      row,
      viewerId,
      row.list_items[0]?.count ?? 0,
      followerCounts.get(row.id) ?? 0,
    ),
  );
}

async function requireViewer(): Promise<{
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  viewerId: string;
} | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { supabase, viewerId: data.user.id };
}

/** Lists the viewer owns, in one call — RLS (`lists_select_visible`) already
 *  restricts this to what the viewer can see, but the explicit `.eq` keeps
 *  the QUERY'S intent readable rather than relying on the policy alone to
 *  convey "mine". */
export async function getMyLists(): Promise<ListSummary[]> {
  const viewer = await requireViewer();
  if (!viewer) return [];
  const { supabase, viewerId } = viewer;

  const { data, error } = await supabase
    .from("lists")
    .select(SUMMARY_COLUMNS)
    .eq("owner_id", viewerId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  if (error) throw mapListError(error);
  return attachFollowerCounts(supabase, (data ?? []) as unknown as WithItemCount[], viewerId);
}

/** Lists the viewer collaborates on (accepted only — a pending invite shows
 *  up via `getPendingInvites` instead, not here). */
export async function getCollaboratingLists(): Promise<ListSummary[]> {
  const viewer = await requireViewer();
  if (!viewer) return [];
  const { supabase, viewerId } = viewer;

  const { data: memberships, error: membershipError } = await supabase
    .from("list_collaborators")
    .select("list_id")
    .eq("user_id", viewerId)
    .eq("status", "accepted");
  if (membershipError) throw mapListError(membershipError);

  const listIds = (memberships ?? []).map((row) => row.list_id as string);
  if (listIds.length === 0) return [];

  const { data, error } = await supabase
    .from("lists")
    .select(SUMMARY_COLUMNS)
    .in("id", listIds)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false });

  if (error) throw mapListError(error);
  return attachFollowerCounts(supabase, (data ?? []) as unknown as WithItemCount[], viewerId);
}

/** The "Discover" feed — recent PUBLIC lists. Deliberately does not include
 *  unlisted lists: discoverability is exactly the property that
 *  distinguishes them from public ones (see the migration's header comment),
 *  and this is the one query where that distinction is actually enforced —
 *  RLS treats the two identically, so a query that forgot this `.eq` would
 *  silently turn "unlisted" into "public" for anyone who called it. */
export async function getPublicLists(limit = 30): Promise<ListSummary[]> {
  const viewer = await requireViewer();
  if (!viewer) return [];
  const { supabase, viewerId } = viewer;

  const { data, error } = await supabase
    .from("lists")
    .select(SUMMARY_COLUMNS)
    .eq("visibility", "public")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw mapListError(error);
  return attachFollowerCounts(supabase, (data ?? []) as unknown as WithItemCount[], viewerId);
}

export async function getFollowedLists(): Promise<ListSummary[]> {
  const viewer = await requireViewer();
  if (!viewer) return [];
  const { supabase, viewerId } = viewer;

  const { data: follows, error: followError } = await supabase
    .from("list_followers")
    .select("list_id")
    .eq("user_id", viewerId);
  if (followError) throw mapListError(followError);

  const listIds = (follows ?? []).map((row) => row.list_id as string);
  if (listIds.length === 0) return [];

  const { data, error } = await supabase
    .from("lists")
    .select(SUMMARY_COLUMNS)
    .in("id", listIds)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) throw mapListError(error);
  return attachFollowerCounts(supabase, (data ?? []) as unknown as WithItemCount[], viewerId);
}

/** Pending invites addressed to the viewer — surfaced somewhere the viewer
 *  will actually see them (Profile), since an invite that only appears on
 *  the list's own page is an invite nobody without the link will ever
 *  respond to. */
export async function getPendingInvites(): Promise<PendingInvite[]> {
  const viewer = await requireViewer();
  if (!viewer) return [];
  const { supabase, viewerId } = viewer;

  const { data, error } = await supabase
    .from("list_collaborators")
    .select(
      `list_id, invited_by, invited_at,
       inviter:profiles!list_collaborators_invited_by_fkey ( username, display_name ),
       list:lists!inner ( ${SUMMARY_COLUMNS} )`,
    )
    .eq("user_id", viewerId)
    .eq("status", "invited");

  if (error) throw mapListError(error);

  const rows = (data ?? []) as unknown as Array<{
    invited_by: string | null;
    invited_at: string;
    inviter: { username: string; display_name: string | null } | null;
    list: WithItemCount;
  }>;

  const summaries = await attachFollowerCounts(
    supabase,
    rows.map((row) => row.list),
    viewerId,
  );

  return rows.map((row, index) => ({
    list: summaries[index],
    invitedBy: row.invited_by
      ? {
          id: row.invited_by,
          username: row.inviter?.username ?? "deleted-user",
          displayName: row.inviter?.display_name ?? null,
        }
      : null,
    invitedAt: new Date(row.invited_at),
  }));
}

/**
 * The full detail page for one list, or `null` if it does not exist or the
 * viewer cannot see it — RLS makes those two cases indistinguishable at the
 * database level (a row that fails the SELECT policy is simply absent from
 * the result, identical to a row that was never there), and that ambiguity
 * is deliberately preserved here rather than papered over: telling a visitor
 * "this list is private" instead of a plain 404 would confirm a list with
 * that id EXISTS, which is itself a small information leak for a private
 * list whose id someone is guessing at or was shown out of context.
 */
export async function getListDetail(listId: string): Promise<ListDetail | null> {
  const viewer = await requireViewer();
  if (!viewer) return null;
  const { supabase, viewerId } = viewer;

  const { data: listRow, error: listError } = await supabase
    .from("lists")
    .select(SUMMARY_COLUMNS)
    .eq("id", listId)
    .is("deleted_at", null)
    .maybeSingle();
  if (listError) throw mapListError(listError);
  if (!listRow) return null;

  const [itemsResult, collaboratorsResult, membershipResult, followResult] = await Promise.all([
    supabase
      .from("list_items")
      .select(ITEM_COLUMNS)
      .eq("list_id", listId)
      .order("added_at", { ascending: true }),
    supabase.from("list_collaborators").select(COLLABORATOR_COLUMNS).eq("list_id", listId),
    supabase
      .from("list_collaborators")
      .select("status")
      .eq("list_id", listId)
      .eq("user_id", viewerId)
      .maybeSingle(),
    supabase
      .from("list_followers")
      .select("user_id")
      .eq("list_id", listId)
      .eq("user_id", viewerId)
      .maybeSingle(),
  ]);

  if (itemsResult.error) throw mapListError(itemsResult.error);
  if (collaboratorsResult.error) throw mapListError(collaboratorsResult.error);
  // membershipResult/followResult intentionally not treated as fatal — see
  // below; a viewer who is neither owner nor collaborator gets zero rows for
  // list_collaborators' own-row check, which is success, not an error.

  const [summary] = await attachFollowerCounts(
    supabase,
    [listRow as unknown as WithItemCount],
    viewerId,
  );

  const items: ListItemEntry[] = ((itemsResult.data ?? []) as unknown as ListItemRow[]).map(
    rowToListItem,
  );

  const isOwner = summary.owner.id === viewerId;
  const isAcceptedCollaborator = membershipResult.data?.status === "accepted";

  // The collaborator roster is only meaningful to actual members — RLS
  // (`list_collaborators_select_member`) already restricts what a non-member
  // gets back to nothing, but the UI treats "canEdit" as the signal for
  // whether to render it at all, rather than rendering an empty roster and
  // implying there ARE no collaborators when the truth is simply "you can't
  // see them."
  const collaborators = (isOwner || isAcceptedCollaborator)
    ? ((collaboratorsResult.data ?? []) as unknown as ListCollaboratorRow[]).map((row) =>
        rowToCollaborator(row, viewerId),
      )
    : [];

  return buildListDetail(summary, items, collaborators, {
    isOwner,
    isAcceptedCollaborator,
    isFollowing: followResult.data !== null,
  });
}

/**
 * "What can we all agree on" — titles on the list every member has
 * watchlisted. `list` must already be a `ListDetail` the caller fetched
 * (so this never re-fetches items/membership); this function only adds the
 * cross-user tracking data and hands off to the pure `computeAgreementItems`
 * for the actual decision.
 *
 * Reads OTHER members' `tracked_titles` rows — possible ONLY because of the
 * `tracked_titles_select_shared_list_member` policy the lists migration
 * adds, scoped exactly to "you share an editable membership on a list
 * containing this title." A list with zero OTHER members (nobody has
 * accepted a collaboration yet) still works: the aggregate degenerates to
 * "does the sole member — you — have it watchlisted," which is a correct,
 * if unexciting, answer rather than a special case to guard against.
 */
export async function getAgreementItems(list: ListDetail): Promise<ListItemEntry[]> {
  const viewer = await requireViewer();
  if (!viewer || list.items.length === 0) return [];
  const { supabase } = viewer;

  const memberIds = [
    list.owner.id,
    ...list.collaborators.filter((c) => c.status === "accepted").map((c) => c.user.id),
  ];

  const orFilters = list.items
    .map((item) => `and(media_type.eq.${item.mediaType},title_id.eq.${item.titleId})`)
    .join(",");

  const { data, error } = await supabase
    .from("tracked_titles")
    .select("user_id, media_type, title_id, status")
    .in("user_id", memberIds)
    .or(orFilters);

  if (error) throw mapListError(error);

  const statuses: MemberStatus[] = ((data ?? []) as Array<{
    user_id: string;
    media_type: string;
    title_id: string;
    status: string;
  }>).map((row) => ({
    userId: row.user_id,
    mediaType: row.media_type === "movie" ? "movie" : "tv",
    titleId: row.title_id,
    status:
      row.status === "watching" || row.status === "watched" ? row.status : "watchlist",
  }));

  return computeAgreementItems(list.items, memberIds, statuses);
}

export type { ListMember };
