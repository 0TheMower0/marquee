"use server";

import { headers } from "next/headers";

import { RATE_LIMITS, checkRateLimit } from "@/lib/ratelimit";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

import { CommentError, commentErrorMessage, mapCommentError, type CommentErrorKind } from "./errors";
import { getCommentSectionData } from "./queries";
import type { Comment, CommentScope, CommentSectionData } from "./types";
import {
  MAX_COMMENT_LENGTH,
  validateCommentBody,
  validateReportNote,
  type ReportNoteValidation,
} from "./validate";
import { isReportReason } from "./validate";
import { rowToComment, type CommentRow } from "./wire";

/**
 * Server Actions — the client seam for comments, same reasoning
 * `lib/auth/actions.ts` gives for auth: this is the "Server Action per
 * mutation" pattern from that file, reused here because comments need the
 * identical properties — a real session (cookies, readable only server-side)
 * and per-caller rate limiting on a surface that is exactly as public as
 * `app/api/content/*`, callable by anyone who can read this page's JS.
 *
 * ============================================================================
 * NOTE ON RETURN SHAPE — DELIBERATELY NOT `useActionState`
 * ============================================================================
 * `lib/auth/actions.ts` binds its actions directly to `<form action={...}>`
 * via `useActionState`, because an auth form's whole job IS its own state
 * (idle/error/success) and nothing outside the form needs to react to it.
 * Comments are different: posting/editing/deleting/liking all need to update
 * a LIST the form does not own — append a new comment, replace an edited one
 * in place, toggle one row's like state. That is the same shape
 * `lib/tracking/context.tsx`'s optimistic mutators already use (a plain async
 * function returning/throwing, called directly from a client event handler,
 * with the CALLER owning where the result goes) — so these functions follow
 * that precedent instead of `useActionState`'s form-scoped contract.
 *
 * Every mutating action still degrades safely and NEVER exports a bare
 * constant — see the comment in `lib/auth/form-state.ts` for why a `"use
 * server"` module may only export async functions: a plain value export
 * arrives on the client as `undefined`, a bug that cost a full build to find
 * in Phase 6 Step 4. Every export below is a function.
 */

const TOO_MANY = "Slow down a little — try again in a minute.";

async function rateLimitCheck(rule: (typeof RATE_LIMITS)[keyof typeof RATE_LIMITS]) {
  const requestHeaders = await headers();
  const decision = await checkRateLimit(
    new Request("http://server-action.local", { headers: requestHeaders }),
    rule,
  );
  return decision.allowed;
}

function configuredOrThrow(): void {
  if (!isSupabaseConfigured()) {
    throw new CommentError("not_configured", "Supabase is not configured.");
  }
}

const SELECT_COLUMNS = `
  id, user_id, media_type, title_id, season_number, episode_number, parent_id,
  body, status, created_at, updated_at, edited_at, deleted_at,
  author:profiles!comments_user_id_fkey ( username, display_name ),
  comment_likes ( user_id ),
  comment_reports ( id )
`;

/** Re-selects one comment by id, in the exact shape `rowToComment` expects,
 *  and re-derives its like count via the SAME batched RPC the initial fetch
 *  uses. Used after every mutation so the client always renders what the
 *  server actually persisted — never an assumed/optimistic shape for the
 *  authoritative fields (id, timestamps, edited_at). */
async function reselectComment(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  id: string,
  viewerId: string,
): Promise<Comment> {
  const { data, error } = await supabase
    .from("comments")
    .select(SELECT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw mapCommentError(error);
  if (!data) throw new CommentError("not_found", "comment vanished after write");

  const { data: counts, error: countsError } = await supabase.rpc("comment_like_counts", {
    p_comment_ids: [id],
  });
  if (countsError) throw mapCommentError(countsError);
  const likeCount = ((counts ?? []) as { comment_id: string; likes: number }[])[0]?.likes ?? 0;

  return rowToComment(data as unknown as CommentRow, viewerId, likeCount);
}

async function requireViewerId(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new CommentError("not_authenticated", "no session");
  }
  return data.user.id;
}

export type CommentActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

/** Kinds a well-behaved client should never actually trigger — the UI already
 *  gates the paths that would produce `invalid_input`/`rate_limited`/
 *  `not_authenticated`/`not_configured` locally, so seeing one of THOSE here
 *  is an ordinary user hitting an ordinary edge (ratelimit, a stale form). A
 *  `forbidden`/`unknown`/`network` result reaching here means something is
 *  wrong that the UI did not anticipate — worth a server log to catch, the
 *  way a live test against a real Supabase project caught the missing
 *  `user_id` bug in postCommentAction: it surfaced as an ordinary-looking
 *  `forbidden`, and only a log of the RAW error (never sent to the client)
 *  revealed the actual 42501 detail. */
const UNEXPECTED_KINDS: ReadonlySet<CommentErrorKind> = new Set([
  "forbidden",
  "unknown",
  "network",
]);

function failure<T>(error: unknown): CommentActionResult<T> {
  const mapped = mapCommentError(error);
  if (UNEXPECTED_KINDS.has(mapped.kind)) {
    console.error("[comments] unexpected action failure:", mapped.message);
  }
  return { ok: false, message: commentErrorMessage(mapped) };
}

/* ---------------------------------------------------------------------------
 * Post (top-level or a reply)
 * ------------------------------------------------------------------------ */

export async function postCommentAction(
  scope: CommentScope,
  body: string,
  parentId: string | null,
): Promise<CommentActionResult<Comment>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.comments))) {
      return { ok: false, message: TOO_MANY };
    }

    const checked = validateCommentBody(body);
    if (!checked.ok) {
      const message =
        checked.reason === "too_long"
          ? `Comments can be at most ${MAX_COMMENT_LENGTH} characters.`
          : "Write something first.";
      return { ok: false, message };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    // Sent as the CURRENT scope regardless of whether this is a reply — if it
    // is, comments_enforce_nesting() in the migration overwrites these four
    // columns from the parent's real row before the INSERT's WITH CHECK is
    // evaluated. Never trust the client, but also no reason not to send its
    // best understanding of where it is.
    //
    // user_id MUST be sent explicitly — there is no column default, and a
    // missing value here is NOT caught as a NOT NULL violation before RLS
    // gets a look at it. `user_id = (select auth.uid())` in the INSERT
    // policy's WITH CHECK compares NULL against a UUID, which is never TRUE,
    // so the row is silently rejected as 42501 ("row-level security policy"),
    // reading exactly like a gating failure. A live test against a real
    // Supabase project chased that red herring for a while — the RPC
    // `can_view_comment_scope` and the raw `tracked_titles` row both checked
    // out fine, because the actual bug had nothing to do with gating at all.
    const { data: inserted, error } = await supabase
      .from("comments")
      .insert({
        user_id: viewerId,
        media_type: scope.mediaType,
        title_id: scope.titleId,
        season_number: scope.seasonNumber,
        episode_number: scope.episodeNumber,
        parent_id: parentId,
        body: checked.value,
      })
      .select("id")
      .single();

    if (error) throw mapCommentError(error);

    const comment = await reselectComment(supabase, inserted.id, viewerId);
    return { ok: true, data: comment };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------------------
 * Edit
 * ------------------------------------------------------------------------ */

export async function editCommentAction(
  commentId: string,
  body: string,
): Promise<CommentActionResult<Comment>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.comments))) {
      return { ok: false, message: TOO_MANY };
    }

    const checked = validateCommentBody(body);
    if (!checked.ok) {
      const message =
        checked.reason === "too_long"
          ? `Comments can be at most ${MAX_COMMENT_LENGTH} characters.`
          : "Write something first.";
      return { ok: false, message };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    // The UPDATE policy's own-rows check means this simply matches zero rows
    // for a comment that isn't the caller's — reported honestly as "not
    // found" rather than "forbidden", since from the caller's side there is
    // no way to distinguish "doesn't exist" from "not yours", and the vaguer
    // answer leaks less about what other ids might exist.
    const { data, error } = await supabase
      .from("comments")
      .update({ body: checked.value })
      .eq("id", commentId)
      .select("id")
      .maybeSingle();

    if (error) throw mapCommentError(error);
    if (!data) throw new CommentError("not_found", "comment not found or not yours");

    const comment = await reselectComment(supabase, commentId, viewerId);
    return { ok: true, data: comment };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------------------
 * Delete (soft — see the tombstone note in the migration)
 * ------------------------------------------------------------------------ */

export async function deleteCommentAction(
  commentId: string,
): Promise<CommentActionResult<Comment>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.comments))) {
      return { ok: false, message: TOO_MANY };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    // Body is sent as empty text here for clarity at the call site, but the
    // AUTHORITATIVE clearing happens server-side regardless — see
    // comments_lock_immutable_fields() in the migration, which forces body to
    // '' the instant deleted_at is set even if this client forgot to.
    const { data, error } = await supabase
      .from("comments")
      .update({ deleted_at: new Date().toISOString(), body: "" })
      .eq("id", commentId)
      .select("id")
      .maybeSingle();

    if (error) throw mapCommentError(error);
    if (!data) throw new CommentError("not_found", "comment not found or not yours");

    const comment = await reselectComment(supabase, commentId, viewerId);
    return { ok: true, data: comment };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------------------
 * Likes — a toggle, so the action takes the INTENDED next state rather than
 * inferring it, the same "explicit, not inferred" discipline CLAUDE.md
 * documents for the `bulk` flag on watch events: inference is fragile the
 * moment two tabs or a slow double-click are involved.
 * ------------------------------------------------------------------------ */

export interface LikeResult {
  liked: boolean;
  likeCount: number;
}

export async function toggleLikeAction(
  commentId: string,
  like: boolean,
): Promise<CommentActionResult<LikeResult>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.commentLikes))) {
      return { ok: false, message: TOO_MANY };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    if (like) {
      // Upsert rather than a plain insert: a double-click racing itself (two
      // requests in flight) must not surface a duplicate-key error to the
      // user for an action that is, from their perspective, idempotent —
      // "make sure this is liked" either way.
      const { error } = await supabase
        .from("comment_likes")
        .upsert({ user_id: viewerId, comment_id: commentId }, { onConflict: "user_id,comment_id" });
      if (error) throw mapCommentError(error);
    } else {
      const { error } = await supabase
        .from("comment_likes")
        .delete()
        .eq("user_id", viewerId)
        .eq("comment_id", commentId);
      if (error) throw mapCommentError(error);
    }

    const { data: counts, error: countsError } = await supabase.rpc("comment_like_counts", {
      p_comment_ids: [commentId],
    });
    if (countsError) throw mapCommentError(countsError);
    const likeCount =
      ((counts ?? []) as { comment_id: string; likes: number }[])[0]?.likes ?? 0;

    return { ok: true, data: { liked: like, likeCount } };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------------------
 * Report
 * ------------------------------------------------------------------------ */

export async function reportCommentAction(
  commentId: string,
  reason: string,
  note: string,
): Promise<CommentActionResult<{ reported: true }>> {
  try {
    configuredOrThrow();
    if (!(await rateLimitCheck(RATE_LIMITS.commentReports))) {
      return { ok: false, message: TOO_MANY };
    }

    if (!isReportReason(reason)) {
      return { ok: false, message: "Choose a reason." };
    }

    const checkedNote: ReportNoteValidation = validateReportNote(note);
    if (!checkedNote.ok) {
      return { ok: false, message: "That note is too long." };
    }

    const supabase = await createSupabaseServerClient();
    const viewerId = await requireViewerId(supabase);

    // reporter_id must be sent explicitly — same bug class as postCommentAction
    // above, and the same reason: with no column default, an omitted value
    // makes `reporter_id = (select auth.uid())` compare NULL against a UUID in
    // the INSERT policy's WITH CHECK, which reads as an ordinary 42501 gating
    // rejection rather than the missing-field bug it actually is.
    const { error } = await supabase
      .from("comment_reports")
      .insert({ comment_id: commentId, reporter_id: viewerId, reason, note: checkedNote.value });

    if (error) {
      const mapped = mapCommentError(error);
      // A duplicate report (already filed by this account) is an ordinary
      // outcome, not a failure — matches how a taken username is handled in
      // lib/auth/supabase/index.ts: the unique constraint is the real gate,
      // this is decoration over it.
      if ((error as { code?: string }).code === "23505") {
        return { ok: true, data: { reported: true } };
      }
      throw mapped;
    }

    return { ok: true, data: { reported: true } };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------------------
 * On-demand fetch — the client seam into `lib/comments/queries.ts`
 * ------------------------------------------------------------------------ */

/**
 * A thin, callable wrapper around `getCommentSectionData` (which is
 * `server-only` and therefore unreachable directly from a Client Component).
 *
 * Two callers use this: the episode-level "Discussion" disclosure in
 * `components/tracking/season-list.tsx`, which fetches lazily only when a
 * reader actually opens it (matching that file's existing discipline of
 * fetching nothing until asked — see its own header comment on why only one
 * season's episodes are ever mounted), and any client-side refresh a comments
 * component wants after a mutation instead of trusting purely local state.
 */
export async function fetchCommentThreadAction(
  scope: CommentScope,
): Promise<CommentActionResult<CommentSectionData | null>> {
  try {
    configuredOrThrow();
    const data = await getCommentSectionData(scope);
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}
