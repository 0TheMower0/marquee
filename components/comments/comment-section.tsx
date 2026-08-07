import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { MessageIcon } from "@/components/ui/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { getAccount } from "@/lib/auth";
import type { CommentScope } from "@/lib/comments";
import { getCommentSectionData } from "@/lib/comments/queries";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

import { CommentsClient } from "./comments-client";

/**
 * The server-rendered entry point into one scope's discussion — mounted for
 * a TV show's title-level Discussion tab and a movie's Discussion section
 * (`app/title/[mediaType]/[id]/page.tsx`). Episode-level discussion has its
 * own, separately lazy-loaded entry point:
 * `components/comments/episode-discussion.tsx`, mounted inline in
 * `season-list.tsx` next to the episode it belongs to.
 *
 * Fetches server-side so the very first paint shows real comments — no
 * client-side "loading comments…" flash for a feature whose whole pitch is
 * about what a reader can and can't see. `lib/comments/queries.ts` is
 * `server-only`; this is exactly the kind of Server Component that layer
 * exists for.
 *
 * Comments require an account uniformly — same reasoning `profiles`' own
 * `to authenticated` RLS policy already establishes (a comment needs a
 * username to render, and profiles are only readable signed in). This is
 * NOT "signing in is a gate" in the sense CLAUDE.md warns against for
 * tracking — nothing else on this page is affected, and the invite here says
 * so plainly rather than pretending comments are broken.
 */
export async function CommentSection({ scope }: { scope: CommentScope }) {
  if (!isSupabaseConfigured()) {
    return (
      <EmptyState
        icon={<MessageIcon />}
        title="Comments aren't available here"
        body="This build has no account service configured, so there's nowhere for a discussion to live."
        className="py-10"
      />
    );
  }

  const account = await getAccount();
  if (!account) {
    return (
      <EmptyState
        icon={<MessageIcon />}
        title="Sign in to join the discussion"
        body="Reading and posting comments needs an account — everything else on this page works exactly the same either way."
        action={
          <Button href={`/signin?next=${encodeURIComponent(scopePath(scope))}`} size="sm">
            Sign in
          </Button>
        }
        className="py-10"
      />
    );
  }

  // ==========================================================================
  // NEVER LET A COMMENTS FAILURE TAKE DOWN THE PAGE AROUND IT
  // ==========================================================================
  // A live check against a real (mid-deploy) Supabase project caught this the
  // hard way, not a code review: before this try/catch existed, a schema-cache
  // miss (PGRST205 — the comments migration not yet applied) threw straight
  // through this Server Component with nothing catching it, and the ENTIRE
  // title page — poster, cast, tracking controls, everything — was replaced by
  // the generic `app/error.tsx` boundary. Comments are secondary content on a
  // page whose main job is showing a title; CLAUDE.md already states this rule
  // for the OMDb ratings row and watch-providers section, and this component
  // simply hadn't been brought into line with it yet. `ContentError`-style
  // failures degrade to a plain message instead — see the two-layer error
  // handling note in CLAUDE.md ("Only the await goes inside the try").
  let data;
  try {
    data = await getCommentSectionData(scope);
  } catch (error) {
    console.error("[comments] section failed to load", error);
    return (
      <EmptyState
        icon={<MessageIcon />}
        title="Comments couldn't load"
        body="Something went wrong loading the discussion. The rest of this page is unaffected."
        className="py-10"
      />
    );
  }

  if (!data) {
    // Reachable only if the session expired between the check above and this
    // fetch — a narrow race, not a real empty state. Same copy as the
    // signed-out case, since from the reader's side the fix is identical.
    return (
      <EmptyState
        icon={<MessageIcon />}
        title="Sign in to join the discussion"
        action={
          <Button href={`/signin?next=${encodeURIComponent(scopePath(scope))}`} size="sm">
            Sign in
          </Button>
        }
        className="py-10"
      />
    );
  }

  return (
    <CommentsClient
      scope={scope}
      initialThreads={data.threads}
      canParticipate={data.canParticipate}
    />
  );
}

function scopePath(scope: CommentScope): string {
  return `/title/${scope.mediaType}/${scope.titleId}`;
}

/** Placed in the `<Suspense>` boundary each `<CommentSection>` call site
 *  wraps it in, same "streamed independently" treatment `RatingsRowSkeleton`
 *  gets — a comments fetch (auth check, RLS-filtered query, a batched like-
 *  count RPC) must never sit in the page's own time-to-first-byte. */
export function CommentSectionSkeleton() {
  return (
    <div className="space-y-3 py-4" aria-label="Loading discussion">
      <Skeleton className="h-20 w-full rounded-md" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
