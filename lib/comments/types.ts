import type { MediaType } from "@/lib/content/types";

/**
 * Domain types for comments — OUR shapes, not PostgREST's row shapes. Same
 * split `lib/sync/wire.ts` draws for a different reason: there, local and
 * server representations genuinely differ (ranges vs. rows). Here they don't
 * — a comment IS a comment either way — but keeping row shapes (snake_case,
 * in `wire.ts`) separate from these (camelCase, what components render
 * against) still matters, for the same reason `lib/content/tmdb/normalize.ts`
 * normalizes TMDB's wire format instead of handing components raw JSON: a
 * schema column rename should not become a find-and-replace across every
 * component.
 */

/**
 * Where a comment lives. Exactly two granularities — matches the brief
 * verbatim ("comment on a title, or on a specific episode"). There is no
 * season-level bucket; see the migration's header comment for the reasoning
 * behind the gating asymmetry this scope shape encodes.
 */
export interface CommentScope {
  mediaType: MediaType;
  titleId: string;
  /** Both present (episode-level) or both absent (title-level) — never one
   *  without the other. `isEpisodeScope`/`isTitleScope` are the narrowing
   *  helpers; do not check `seasonNumber` alone. */
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export function isEpisodeScope(
  scope: CommentScope,
): scope is CommentScope & { seasonNumber: number; episodeNumber: number } {
  return scope.seasonNumber !== null && scope.episodeNumber !== null;
}

export function titleScope(mediaType: MediaType, titleId: string): CommentScope {
  return { mediaType, titleId, seasonNumber: null, episodeNumber: null };
}

export function episodeScope(
  mediaType: MediaType,
  titleId: string,
  seasonNumber: number,
  episodeNumber: number,
): CommentScope {
  return { mediaType, titleId, seasonNumber, episodeNumber };
}

/**
 * Whether a scope is gated at all — i.e. whether `can_view_comment_scope` in
 * the migration can ever return `false` for it. A TV title-level scope is the
 * one ungated case; every episode scope and every movie title scope is gated.
 * Pure mirror of the SQL function's `case` branches, kept here so the CLIENT
 * can decide up front whether to even attempt a fetch/render a locked state,
 * without duplicating the actual security decision — the server's function
 * remains the only thing that decides who sees what; this only decides which
 * COPY to show.
 */
export function isGatedScope(scope: CommentScope): boolean {
  if (isEpisodeScope(scope)) return true;
  return scope.mediaType === "movie";
}

export type ReportReason = "spam" | "harassment" | "spoiler" | "other";

export const REPORT_REASONS: readonly { value: ReportReason; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "harassment", label: "Harassment or abuse" },
  { value: "spoiler", label: "Spoiler outside its episode" },
  { value: "other", label: "Something else" },
];

export interface CommentAuthor {
  id: string;
  username: string;
  displayName: string | null;
}

export interface Comment {
  id: string;
  scope: CommentScope;
  parentId: string | null;
  author: CommentAuthor;
  /** Empty string on a deleted comment — the server clears it, never the
   *  client (see `comments_lock_immutable_fields` in the migration). Render
   *  a "[deleted]" placeholder whenever `deletedAt` is non-null rather than
   *  trusting an empty body alone to mean that, since a comment could in
   *  principle be blank for another reason if validation ever loosens. */
  body: string;
  status: "visible" | "hidden";
  createdAt: Date;
  updatedAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  likeCount: number;
  likedByViewer: boolean;
  reportedByViewer: boolean;
  /** True only for the signed-in viewer's own comment. Drives whether edit/
   *  delete controls render — never trust this alone for anything that
   *  matters; it is UI-only, RLS is the actual enforcement. */
  isOwn: boolean;
}

/** A top-level comment plus its (at most one level of) replies, already
 *  ordered oldest-first — chronological, matching how a real conversation
 *  reads. */
export interface CommentThread {
  comment: Comment;
  replies: Comment[];
}

export interface CommentSectionData {
  threads: CommentThread[];
  /** Whether the VIEWER could post here at all — computed server-side from
   *  the same tracking data the RLS policy itself checks (see
   *  `lib/comments/queries.ts`), so the UI never has to guess "is this scope
   *  empty because nobody's said anything, or because I can't see it" from
   *  emptiness alone. Always `true` for an ungated scope. */
  canParticipate: boolean;
  scope: CommentScope;
}
