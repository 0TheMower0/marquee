import type { MediaType } from "@/lib/content/types";

import type {
  CollaboratorStatus,
  ListCollaborator,
  ListDetail,
  ListItemEntry,
  ListMember,
  ListSummary,
  ListVisibility,
  MemberStatus,
} from "./types";

/**
 * PostgREST row shapes <-> domain types. Pure — no I/O — same split
 * `lib/comments/wire.ts` draws.
 */

interface ProfileEmbed {
  username: string;
  display_name: string | null;
}

export interface ListRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  visibility: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  owner: ProfileEmbed | null;
}

export interface ListItemRow {
  list_id: string;
  media_type: string;
  title_id: string;
  summary: unknown;
  added_by: string | null;
  added_at: string;
  adder: ProfileEmbed | null;
}

export interface ListCollaboratorRow {
  list_id: string;
  user_id: string;
  invited_by: string | null;
  status: string;
  invited_at: string;
  responded_at: string | null;
  member: ProfileEmbed | null;
  inviter: ProfileEmbed | null;
}

/**
 * `owner`/`adder`/`member`/`inviter` can genuinely be `null` in one case: the
 * referenced account was deleted after the fact. For `lists.owner_id` this
 * should be unreachable (`on delete cascade` — the list itself is gone before
 * this could render), kept as a defensive fallback rather than an expected
 * path. For `list_items.added_by`/`list_collaborators.invited_by` (both
 * `on delete set null`) it is a REAL, reachable state — a collaborator who
 * added items and later deleted their account leaves those items behind with
 * no attribution.
 */
function toMember(embed: ProfileEmbed | null, id: string | null): ListMember | null {
  if (id === null) return null;
  return {
    id,
    username: embed?.username ?? "deleted-user",
    displayName: embed?.display_name ?? null,
  };
}

function toVisibility(value: string): ListVisibility {
  return value === "public" || value === "unlisted" ? value : "private";
}

export function rowToListSummary(
  row: ListRow,
  viewerId: string,
  itemCount: number,
  followerCount: number,
): ListSummary {
  const owner = toMember(row.owner, row.owner_id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: toVisibility(row.visibility),
    // toMember only returns null when its id argument is null, and
    // owner_id is NOT NULL — this cast documents that rather than
    // threading an unreachable null branch through every caller.
    owner: owner as ListMember,
    itemCount,
    followerCount,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    isOwn: row.owner_id === viewerId,
  };
}

export function rowToListItem(row: ListItemRow): ListItemEntry {
  return {
    mediaType: row.media_type === "movie" ? "movie" : "tv",
    titleId: row.title_id,
    summary: row.summary as ListItemEntry["summary"],
    addedBy: toMember(row.adder, row.added_by),
    addedAt: new Date(row.added_at),
  };
}

export function rowToCollaborator(
  row: ListCollaboratorRow,
  viewerId: string,
): ListCollaborator {
  const member = toMember(row.member, row.user_id);
  return {
    // Same reasoning as rowToListSummary's owner cast — user_id is NOT NULL.
    user: member as ListMember,
    status: row.status === "accepted" ? "accepted" : ("invited" as CollaboratorStatus),
    invitedBy: toMember(row.inviter, row.invited_by),
    invitedAt: new Date(row.invited_at),
    respondedAt: row.responded_at ? new Date(row.responded_at) : null,
    isSelf: row.user_id === viewerId,
  };
}

/** Assembles the pieces `queries.ts` fetches separately into one `ListDetail`.
 *  Kept here, pure, rather than inline in the async query function, so the
 *  assembly logic (which flags depend on which membership facts) is testable
 *  without a database. */
export function buildListDetail(
  summary: ListSummary,
  items: ListItemEntry[],
  collaborators: ListCollaborator[],
  membership: { isOwner: boolean; isAcceptedCollaborator: boolean; isFollowing: boolean },
): ListDetail {
  return {
    ...summary,
    items,
    collaborators,
    canEdit: membership.isOwner || membership.isAcceptedCollaborator,
    isOwner: membership.isOwner,
    isFollowedByViewer: membership.isFollowing,
  };
}

/* ---------------------------------------------------------------------------
 * "What can we all agree on" — the aggregation the whole feature is really
 * for. Pure, and the most carefully tested function in this package.
 * ------------------------------------------------------------------------ */

function memberStatusKey(mediaType: MediaType, titleId: string): string {
  return `${mediaType}:${titleId}`;
}

/**
 * Titles on the list where EVERY member has it on their own watchlist.
 *
 * "Watchlisted by everyone, watched by nobody" collapses to one condition,
 * not two: `TrackingStatus` is mutually exclusive by construction (CLAUDE.md,
 * "One status, not two flags") — a title cannot be simultaneously
 * 'watchlist' and 'watched' for the same person, so requiring status ===
 * 'watchlist' for every member ALREADY guarantees none of them has watched
 * it. There is no separate "and nobody watched" check to write.
 *
 * A member with NO tracked_titles row at all for a title (never personally
 * added it to their own library) does NOT count as having watchlisted it —
 * "everyone has watchlisted this" requires an explicit entry from everyone,
 * absence is not agreement.
 */
export function computeAgreementItems(
  items: readonly ListItemEntry[],
  memberIds: readonly string[],
  statuses: readonly MemberStatus[],
): ListItemEntry[] {
  if (memberIds.length === 0) return [];

  const watchlistedBy = new Map<string, Set<string>>();
  for (const status of statuses) {
    if (status.status !== "watchlist") continue;
    const key = memberStatusKey(status.mediaType, status.titleId);
    const set = watchlistedBy.get(key);
    if (set) set.add(status.userId);
    else watchlistedBy.set(key, new Set([status.userId]));
  }

  return items.filter((item) => {
    const key = memberStatusKey(item.mediaType, item.titleId);
    const watchlisters = watchlistedBy.get(key);
    if (!watchlisters) return false;
    return memberIds.every((id) => watchlisters.has(id));
  });
}
