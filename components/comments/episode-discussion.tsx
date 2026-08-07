"use client";

import { useState } from "react";

import { ChevronDownIcon, MessageIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchCommentThreadAction,
  type CommentScope,
  type CommentThread,
} from "@/lib/comments";
import { useSync } from "@/lib/sync";
import { cn } from "@/lib/utils/cn";

import { CommentsClient } from "./comments-client";

type LoadState =
  | { status: "collapsed" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; threads: CommentThread[]; canParticipate: boolean };

/**
 * The per-episode "Discussion" disclosure mounted inline in
 * `components/tracking/season-list.tsx`, right next to the episode it
 * belongs to — the exact spot where the spoiler-gating story is most vivid:
 * the watched-checkbox and the thing it unlocks, side by side.
 *
 * Fetches NOTHING until opened, via the `fetchCommentThreadAction` Server
 * Action (`lib/comments/queries.ts` is `server-only` and unreachable directly
 * from this Client Component). That matches `season-list.tsx`'s own existing
 * discipline verbatim — its header comment already documents "at most one
 * season's episode list is in the DOM," fetched lazily on expand; this adds
 * one more layer of the same idea, one level deeper: a season's episodes are
 * cheap until opened, and now one episode's discussion is cheap until THAT is
 * opened. A show with 200 episodes never fetches 200 comment threads for one
 * page view.
 *
 * Gated on `useSync()?.userId` client-side purely as a UX nicety — so a
 * signed-out visitor sees no toggle promising a feature that would just
 * reject when clicked, rather than a real security boundary. The Server
 * Action itself re-checks the session regardless (never trust the client).
 */
export function EpisodeDiscussion({ scope }: { scope: CommentScope }) {
  const sync = useSync();
  const [state, setState] = useState<LoadState>({ status: "collapsed" });

  // No account, no Supabase, or sync hasn't resolved who's signed in yet —
  // render nothing rather than a toggle that can't do anything useful.
  if (!sync?.userId) return null;

  const isOpen = state.status !== "collapsed";

  async function toggle() {
    if (isOpen) {
      setState({ status: "collapsed" });
      return;
    }

    setState({ status: "loading" });
    const result = await fetchCommentThreadAction(scope);
    if (!result.ok || !result.data) {
      setState({ status: "error" });
      return;
    }
    setState({
      status: "ready",
      threads: result.data.threads,
      canParticipate: result.data.canParticipate,
    });
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={isOpen}
        className="text-fg-subtle hover:text-fg flex items-center gap-1.5 text-meta-sm"
      >
        <MessageIcon className="size-4" />
        Discussion
        <ChevronDownIcon
          className={cn(
            "size-3.5 transition-transform motion-safe:duration-[--dur-fast]",
            isOpen && "rotate-180",
          )}
        />
      </button>

      {state.status === "loading" && (
        <div className="mt-2 space-y-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}

      {state.status === "error" && (
        <p role="alert" className="text-danger text-meta-sm mt-2">
          Couldn&rsquo;t load the discussion for this episode.
        </p>
      )}

      {state.status === "ready" && (
        <div className="mt-3">
          <CommentsClient
            scope={scope}
            initialThreads={state.threads}
            canParticipate={state.canParticipate}
          />
        </div>
      )}
    </div>
  );
}
