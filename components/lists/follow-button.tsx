"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { followListAction, unfollowListAction } from "@/lib/lists";

/**
 * Not rendered for the owner or a collaborator (see the call site in
 * `list-detail-client.tsx`) — following your own list, or a list you already
 * help maintain, isn't a state this app offers.
 */
export function FollowButton({
  listId,
  initialFollowing,
}: {
  listId: string;
  initialFollowing: boolean;
}) {
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (pending) return;
    const next = !following;
    // Optimistic, same discipline `lib/tracking/context.tsx` established:
    // flip immediately, roll back on failure with a visible error rather
    // than silently reverting.
    setFollowing(next);
    setPending(true);
    setError(null);
    try {
      const result = next ? await followListAction(listId) : await unfollowListAction(listId);
      if (!result.ok) {
        setFollowing(!next);
        setError(result.message);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant={following ? "secondary" : "outline"}
        size="sm"
        isLoading={pending}
        onClick={() => void toggle()}
      >
        {following ? "Following" : "Follow"}
      </Button>
      {error && (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
