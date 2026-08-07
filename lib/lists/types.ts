import type { MediaType, TitleSummary } from "@/lib/content/types";
import type { TrackingStatus } from "@/lib/tracking/types";

/**
 * Domain types for shared/public lists — OUR shapes, not PostgREST's row
 * shapes. Same split `lib/comments/types.ts` draws, for the same reason: a
 * schema column rename should never become a find-and-replace across every
 * component.
 */

export type ListVisibility = "private" | "unlisted" | "public";

export interface ListMember {
  id: string;
  username: string;
  displayName: string | null;
}

/** A list without its items or collaborator roster — what a card in a grid
 *  ("My Lists", "Discover") needs, and no more. */
export interface ListSummary {
  id: string;
  name: string;
  description: string | null;
  visibility: ListVisibility;
  owner: ListMember;
  itemCount: number;
  followerCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** True only for the signed-in viewer's own list. UI-only — never trust
   *  this for anything that matters; RLS is the actual enforcement. */
  isOwn: boolean;
}

export interface ListItemEntry {
  mediaType: MediaType;
  titleId: string;
  summary: TitleSummary;
  /** Null when the person who added it has since deleted their account —
   *  `list_items.added_by` is `on delete set null` specifically so the ITEM
   *  survives that; only the attribution is lost. */
  addedBy: ListMember | null;
  addedAt: Date;
}

export type CollaboratorStatus = "invited" | "accepted";

export interface ListCollaborator {
  user: ListMember;
  status: CollaboratorStatus;
  invitedBy: ListMember | null;
  invitedAt: Date;
  respondedAt: Date | null;
  /** True for the signed-in viewer's own row — drives whether "Accept" /
   *  "Decline" / "Leave" render instead of "Remove". */
  isSelf: boolean;
}

/** The full page for one list. `collaborators` is only ever populated for a
 *  viewer who can edit (owner or an accepted collaborator) — a list_items
 *  policy makes items visible to any viewer who can VIEW the list, but the
 *  membership roster is a level more private than that, and `queries.ts`
 *  simply omits fetching it rather than fetching-then-hiding. */
export interface ListDetail extends ListSummary {
  items: ListItemEntry[];
  collaborators: ListCollaborator[];
  canEdit: boolean;
  /** Owner only — collaborators can add items but never invite/remove people
   *  or edit the list's own metadata. */
  isOwner: boolean;
  isFollowedByViewer: boolean;
}

export interface PendingInvite {
  list: ListSummary;
  invitedBy: ListMember | null;
  invitedAt: Date;
}

/** One member's tracked status for one title — the raw material the
 *  "agree on" view is computed from. Pure data, no UI meaning of its own. */
export interface MemberStatus {
  userId: string;
  mediaType: MediaType;
  titleId: string;
  status: TrackingStatus;
}
