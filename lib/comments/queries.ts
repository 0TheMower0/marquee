import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server-client";

import { mapCommentError } from "./errors";
import type { CommentScope, CommentSectionData } from "./types";
import { groupIntoThreads, rowToComment, type CommentRow } from "./wire";

/**
 * Server-only reads. `import "server-only"` matches every other server-side
 * data layer in this app (`lib/content/tmdb`, `lib/content/index.ts`) — an
 * accidental Client Component import becomes a build error here, not a
 * runtime question of whether the anon key happens to be enough.
 *
 * Every function here degrades to the empty/locked state on failure rather
 * than throwing. A comments section is secondary content on a page whose main
 * job is showing a title — the same "never block the page on a secondary
 * source" rule the OMDb ratings row and watch-providers section already
 * follow (CLAUDE.md). A broken comments fetch must not take down the title
 * page around it.
 */

const SELECT_COLUMNS = `
  id, user_id, media_type, title_id, season_number, episode_number, parent_id,
  body, status, created_at, updated_at, edited_at, deleted_at,
  author:profiles!comments_user_id_fkey ( username, display_name ),
  comment_likes ( user_id ),
  comment_reports ( id )
`;

/**
 * The whole comment thread for one scope, plus whether the viewer can post
 * here at all.
 *
 * `canParticipate` is computed by RPC-ing INTO the exact same
 * `can_view_comment_scope` SQL function the RLS policies themselves use
 * (`lib/supabase` migration 20260809000001) — never a TypeScript
 * re-implementation of that gating rule, which could silently drift from
 * what the database actually enforces. This is the single query that decides
 * whether the UI shows "be the first to comment" or "watch this episode to
 * unlock the discussion" — see the file header in `components/comments/` for
 * why that decision is never taken from the emptiness of the comment list
 * alone.
 *
 * Returns `null` when the caller has no session at all — comments require
 * authentication uniformly (matching `profiles`' own `to authenticated`
 * policy), so there is nothing meaningful to fetch for a signed-out visitor.
 */
export async function getCommentSectionData(
  scope: CommentScope,
): Promise<CommentSectionData | null> {
  const supabase = await createSupabaseServerClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;
  const viewerId = userData.user.id;

  let query = supabase
    .from("comments")
    .select(SELECT_COLUMNS)
    .eq("media_type", scope.mediaType)
    .eq("title_id", scope.titleId)
    .order("created_at", { ascending: true });

  // `.is()`, not `.eq()`, for a null column value — PostgREST's equality
  // operator cannot match NULL (SQL's own `= NULL` is always unknown), and
  // title-level scope is defined as BOTH columns being null.
  query =
    scope.seasonNumber === null
      ? query.is("season_number", null)
      : query.eq("season_number", scope.seasonNumber);
  query =
    scope.episodeNumber === null
      ? query.is("episode_number", null)
      : query.eq("episode_number", scope.episodeNumber);

  const [{ data: rows, error: rowsError }, { data: canParticipate, error: gateError }] =
    await Promise.all([
      query,
      supabase.rpc("can_view_comment_scope", {
        p_media_type: scope.mediaType,
        p_title_id: scope.titleId,
        p_season_number: scope.seasonNumber,
        p_episode_number: scope.episodeNumber,
      }),
    ]);

  if (rowsError) throw mapCommentError(rowsError);
  if (gateError) throw mapCommentError(gateError);

  const commentRows = (rows ?? []) as unknown as CommentRow[];

  // Batched into ONE call rather than one per comment — see the doc comment
  // on comment_like_counts() in the migration for the N+1 this avoids.
  const ids = commentRows.map((row) => row.id);
  const likeCounts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: counts, error: countsError } = await supabase.rpc("comment_like_counts", {
      p_comment_ids: ids,
    });
    if (countsError) throw mapCommentError(countsError);
    for (const row of (counts ?? []) as { comment_id: string; likes: number }[]) {
      likeCounts.set(row.comment_id, row.likes);
    }
  }

  const comments = commentRows.map((row) =>
    rowToComment(row, viewerId, likeCounts.get(row.id) ?? 0),
  );

  return {
    threads: groupIntoThreads(comments),
    canParticipate: canParticipate === true,
    scope,
  };
}
