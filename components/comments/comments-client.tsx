"use client";

import { useState } from "react";

import { EmptyState } from "@/components/ui/empty-state";
import { MessageIcon } from "@/components/ui/icons";
import { postCommentAction, type Comment, type CommentScope, type CommentThread } from "@/lib/comments";

import { CommentForm } from "./comment-form";
import { CommentItem } from "./comment-item";

/**
 * The interactive owner of one scope's comment thread.
 *
 * ============================================================================
 * WHY "canParticipate" DECIDES THE EMPTY STATE, NEVER "threads.length === 0"
 * ============================================================================
 * The brief: "an empty comment section should invite the first comment, not
 * advertise that nobody's here." That copy choice only makes sense once you
 * know WHY it's empty, and an empty array is ambiguous between two very
 * different situations:
 *
 *   - Nobody has said anything yet, and you CAN — invite the first comment.
 *   - You cannot see anything here because you haven't watched this episode
 *     yet — an empty array for a completely different reason, where an
 *     "invite the first comment" message would be actively wrong (it would
 *     either dishonestly imply there's nothing to unlock, or — worse — invite
 *     a comment the poster then can't even read back, since the INSERT policy
 *     gates on the exact same check the SELECT policy does).
 *
 * `canParticipate` is computed server-side by RPC-ing into the SAME
 * `can_view_comment_scope` function the database's own RLS policies use (see
 * `lib/comments/queries.ts`), so this is never a client-side guess — it is
 * the real answer, just fetched once rather than discovered by a failed post
 * attempt.
 */
export function CommentsClient({
  scope,
  initialThreads,
  canParticipate,
}: {
  scope: CommentScope;
  initialThreads: CommentThread[];
  canParticipate: boolean;
}) {
  const [threads, setThreads] = useState(initialThreads);

  function replaceComment(updated: Comment) {
    setThreads((prev) =>
      prev.map((thread) => {
        if (thread.comment.id === updated.id) {
          return { ...thread, comment: updated };
        }
        if (thread.replies.some((reply) => reply.id === updated.id)) {
          return {
            ...thread,
            replies: thread.replies.map((reply) =>
              reply.id === updated.id ? updated : reply,
            ),
          };
        }
        return thread;
      }),
    );
  }

  function addTopLevel(comment: Comment) {
    setThreads((prev) => [...prev, { comment, replies: [] }]);
  }

  function addReply(parentId: string, reply: Comment) {
    setThreads((prev) =>
      prev.map((thread) =>
        thread.comment.id === parentId
          ? { ...thread, replies: [...thread.replies, reply] }
          : thread,
      ),
    );
  }

  async function handlePostTopLevel(body: string) {
    const result = await postCommentAction(scope, body, null);
    if (!result.ok) throw result.message;
    addTopLevel(result.data);
  }

  if (!canParticipate) {
    return (
      <EmptyState
        icon={<MessageIcon />}
        title="Locked for now"
        body="Watch this episode to unlock the discussion — comments here are hidden from anyone who hasn't seen it yet, including you."
        className="py-10"
      />
    );
  }

  return (
    <div className="space-y-6">
      <CommentForm
        placeholder="Share your thoughts…"
        submitLabel="Post"
        onSubmit={handlePostTopLevel}
      />

      {threads.length === 0 ? (
        <EmptyState
          icon={<MessageIcon />}
          title="Be the first to say something"
          body="Nobody's commented here yet — your reaction could start the conversation."
          className="py-8"
        />
      ) : (
        <ul className="divide-line-subtle divide-y">
          {threads.map((thread) => (
            <li key={thread.comment.id} className="space-y-3 py-4 first:pt-0 last:pb-0">
              <CommentItem
                comment={thread.comment}
                scope={scope}
                isReply={false}
                onChanged={replaceComment}
                onReplyPosted={(reply) => addReply(thread.comment.id, reply)}
              />
              {thread.replies.map((reply) => (
                <CommentItem
                  key={reply.id}
                  comment={reply}
                  scope={scope}
                  isReply
                  onChanged={replaceComment}
                />
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
