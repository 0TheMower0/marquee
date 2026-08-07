"use client";

import { useState } from "react";

import { FlagIcon, HeartIcon, ReplyIcon } from "@/components/ui/icons";
import {
  deleteCommentAction,
  editCommentAction,
  postCommentAction,
  reportCommentAction,
  toggleLikeAction,
  type Comment,
  type CommentScope,
  type ReportReason,
} from "@/lib/comments";
import { cn } from "@/lib/utils/cn";

import { CommentAvatar } from "./comment-avatar";
import { CommentForm } from "./comment-form";
import { ReportPanel } from "./report-panel";

/** "just now" / "5 min ago" / "3 hr ago" / a real date past a week — same
 *  local, non-exported pattern `components/sync/sync-status.tsx` uses for the
 *  identical shape of problem. Not extracted into a shared utility: two
 *  ~10-line callers doing the same simple thing is the "three similar lines"
 *  case CLAUDE.md says is fine to leave alone, not a case for a premature
 *  shared abstraction. */
function formatRelativeTime(when: Date): string {
  const seconds = Math.round((Date.now() - when.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function CommentItem({
  comment,
  scope,
  isReply,
  onChanged,
  onReplyPosted,
}: {
  comment: Comment;
  scope: CommentScope;
  /** Hides the Reply affordance — replies never get their own Reply button,
   *  since the schema allows exactly one level of nesting
   *  (`comments_enforce_nesting` in the migration rejects the rest). */
  isReply: boolean;
  /** Fired after an edit, delete, or like toggle succeeds, with the fresh
   *  server-authoritative Comment to splice into place. */
  onChanged: (updated: Comment) => void;
  /** Fired after a reply is successfully posted under THIS comment. Absent
   *  (never called) for a reply itself, since isReply hides the control that
   *  would trigger it. */
  onReplyPosted?: (reply: Comment) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isReplying, setIsReplying] = useState(false);
  const [isReporting, setIsReporting] = useState(false);
  const [reportedLocally, setReportedLocally] = useState(false);
  const [likePending, setLikePending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const isDeleted = comment.deletedAt !== null;
  const reported = comment.reportedByViewer || reportedLocally;

  async function handleEdit(body: string) {
    const result = await editCommentAction(comment.id, body);
    if (!result.ok) throw result.message;
    onChanged(result.data);
    setIsEditing(false);
  }

  async function handleDelete() {
    setActionError(null);
    const result = await deleteCommentAction(comment.id);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    onChanged(result.data);
  }

  async function handleReply(body: string) {
    const result = await postCommentAction(scope, body, comment.id);
    if (!result.ok) throw result.message;
    onReplyPosted?.(result.data);
    setIsReplying(false);
  }

  async function handleLike() {
    if (likePending) return;
    setLikePending(true);
    setActionError(null);
    const nextLiked = !comment.likedByViewer;
    const result = await toggleLikeAction(comment.id, nextLiked);
    setLikePending(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    onChanged({
      ...comment,
      likedByViewer: result.data.liked,
      likeCount: result.data.likeCount,
    });
  }

  async function handleReport(reason: ReportReason, note: string) {
    const result = await reportCommentAction(comment.id, reason, note);
    if (!result.ok) throw result.message;
    setReportedLocally(true);
    setIsReporting(false);
  }

  return (
    <div className={cn("flex gap-3", isReply && "ml-8 sm:ml-11")}>
      <CommentAvatar username={comment.author.username} size={isReply ? "sm" : "md"} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-body-sm text-fg font-medium">
            {comment.author.displayName || comment.author.username}
          </span>
          <span className="text-meta-sm text-fg-subtle">
            {formatRelativeTime(comment.createdAt)}
            {comment.editedAt && !isDeleted && " · edited"}
          </span>
        </div>

        {isEditing ? (
          <div className="mt-1.5">
            <CommentForm
              initialValue={comment.body}
              placeholder="Edit your comment"
              submitLabel="Save"
              autoFocus
              onSubmit={handleEdit}
              onCancel={() => setIsEditing(false)}
            />
          </div>
        ) : (
          <p
            className={cn(
              "text-body-sm mt-0.5 whitespace-pre-wrap",
              isDeleted ? "text-fg-subtle italic" : "text-fg-muted",
            )}
          >
            {isDeleted ? "[deleted]" : comment.body}
          </p>
        )}

        {!isEditing && !isDeleted && (
          <div className="text-meta-sm mt-1.5 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => void handleLike()}
              disabled={likePending}
              aria-pressed={comment.likedByViewer}
              className={cn(
                "flex items-center gap-1 disabled:opacity-50",
                comment.likedByViewer ? "text-accent" : "text-fg-subtle hover:text-fg",
              )}
            >
              <HeartIcon
                className={cn("size-4", comment.likedByViewer && "fill-current")}
              />
              {comment.likeCount > 0 && comment.likeCount}
              <span className="sr-only">
                {comment.likedByViewer ? "Unlike" : "Like"} this comment
              </span>
            </button>

            {!isReply && (
              <button
                type="button"
                onClick={() => setIsReplying((prev) => !prev)}
                className="text-fg-subtle hover:text-fg flex items-center gap-1"
              >
                <ReplyIcon className="size-4" />
                Reply
              </button>
            )}

            {comment.isOwn ? (
              <>
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className="text-fg-subtle hover:text-fg"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete()}
                  className="text-fg-subtle hover:text-danger"
                >
                  Delete
                </button>
              </>
            ) : (
              !reported && (
                <button
                  type="button"
                  onClick={() => setIsReporting((prev) => !prev)}
                  className="text-fg-subtle hover:text-danger flex items-center gap-1"
                >
                  <FlagIcon className="size-4" />
                  Report
                </button>
              )
            )}
            {reported && !comment.isOwn && (
              <span className="text-fg-subtle">Reported</span>
            )}
          </div>
        )}

        {actionError && (
          <p role="alert" className="text-meta text-danger mt-1">
            {actionError}
          </p>
        )}

        {isReporting && (
          <ReportPanel onSubmit={handleReport} onCancel={() => setIsReporting(false)} />
        )}

        {isReplying && (
          <div className="mt-2">
            <CommentForm
              placeholder={`Reply to ${comment.author.username}`}
              submitLabel="Reply"
              autoFocus
              onSubmit={handleReply}
              onCancel={() => setIsReplying(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
