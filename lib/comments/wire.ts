import type { Comment, CommentAuthor, CommentScope, CommentThread } from "./types";

/**
 * PostgREST row shape <-> domain `Comment`. Pure — no I/O — same split
 * `lib/sync/wire.ts` draws, and for a related reason: the raw response shape
 * (embedded relations, RLS-filtered arrays standing in for booleans) is a
 * transport detail that should never leak past this one file.
 */

/** What `lib/comments/queries.ts` actually selects. `author` is a to-one
 *  embed (many comments -> one profiles row via `comments_user_id_fkey`), so
 *  PostgREST returns an object, not an array. `comment_likes`/
 *  `comment_reports` are to-many embeds, but RLS on both tables is own-rows-
 *  only, so in practice the array PostgREST returns here holds AT MOST the
 *  viewer's own row — never another user's. Presence, not content, is what
 *  these two fields are used for. */
export interface CommentRow {
  id: string;
  user_id: string;
  media_type: string;
  title_id: string;
  season_number: number | null;
  episode_number: number | null;
  parent_id: string | null;
  body: string;
  status: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  author: { username: string; display_name: string | null } | null;
  comment_likes: { user_id: string }[] | null;
  comment_reports: { id: string }[] | null;
}

/**
 * `author` can genuinely be `null` in ONE case worth naming: a comment whose
 * author's account (and cascading profile row) was deleted after posting,
 * where `on delete cascade` should in practice have removed the comment too
 * — see the FK on `comments.user_id` in the migration. This branch exists as
 * a defensive fallback for a state the schema should make unreachable, not as
 * an expected path; if it is ever hit in production, that is itself a bug
 * worth investigating, not a normal empty state.
 */
function toAuthor(row: CommentRow): CommentAuthor {
  return {
    id: row.user_id,
    username: row.author?.username ?? "deleted-user",
    displayName: row.author?.display_name ?? null,
  };
}

export function rowToComment(
  row: CommentRow,
  viewerId: string,
  likeCount: number,
): Comment {
  const mediaType = row.media_type === "movie" ? "movie" : "tv";
  const scope: CommentScope = {
    mediaType,
    titleId: row.title_id,
    seasonNumber: row.season_number,
    episodeNumber: row.episode_number,
  };

  return {
    id: row.id,
    scope,
    parentId: row.parent_id,
    author: toAuthor(row),
    body: row.body,
    status: row.status === "hidden" ? "hidden" : "visible",
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    editedAt: row.edited_at ? new Date(row.edited_at) : null,
    deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
    likeCount,
    likedByViewer: (row.comment_likes?.length ?? 0) > 0,
    reportedByViewer: (row.comment_reports?.length ?? 0) > 0,
    isOwn: row.user_id === viewerId,
  };
}

/**
 * Groups a flat, RLS-already-filtered list of rows into top-level threads.
 * A plain `groupBy` suffices — never a recursive walk — because the schema
 * enforces exactly one level of nesting (`comments_enforce_nesting` in the
 * migration rejects a reply-to-a-reply at write time), so there is no deeper
 * structure to discover.
 *
 * A reply whose parent is NOT in `rows` (the parent is hidden and this isn't
 * its author, or was deleted before this fetch) is dropped rather than
 * promoted to top-level — an orphaned reply floating free of the comment it
 * was replying to would be confusing, and RLS already guarantees the reader
 * couldn't see the parent for a reason, so hiding the response to it too is
 * the consistent choice.
 *
 * Both threads and each thread's replies are ordered oldest-first —
 * chronological, matching how a real conversation reads. Requires `rows` to
 * already be sorted by `created_at` ascending (the query does this); this
 * function does not re-sort.
 */
export function groupIntoThreads(rows: readonly Comment[]): CommentThread[] {
  const byId = new Map(rows.map((comment) => [comment.id, comment]));
  const repliesByParent = new Map<string, Comment[]>();

  for (const comment of rows) {
    if (comment.parentId === null) continue;
    if (!byId.has(comment.parentId)) continue; // orphaned — see doc comment
    const list = repliesByParent.get(comment.parentId);
    if (list) list.push(comment);
    else repliesByParent.set(comment.parentId, [comment]);
  }

  return rows
    .filter((comment) => comment.parentId === null)
    .map((comment) => ({
      comment,
      replies: repliesByParent.get(comment.id) ?? [],
    }));
}
