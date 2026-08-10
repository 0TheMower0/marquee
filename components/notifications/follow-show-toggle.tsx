"use client";

import { useState } from "react";

import { BellIcon, BellOffIcon } from "@/components/ui/icons";
import { followShowAction, unfollowShowAction } from "@/lib/notifications/actions";
import { cn } from "@/lib/utils/cn";

/**
 * The per-show notification opt-in, on a TV title page.
 *
 * ============================================================================
 * PER-SHOW AND OPT-IN, WITH NO "ALL SHOWS" ANYWHERE
 * ============================================================================
 * There is deliberately no global "notify me about everything" switch, and
 * this is deliberately NOT derived from tracking status. Following every show
 * you have ever marked "watching" is exactly the noise that gets notifications
 * switched off wholesale, and once someone denies the browser permission it
 * cannot be asked for again from script.
 *
 * Marking an episode watched must therefore never change what you are
 * subscribed to, and vice versa. They are independent on purpose.
 *
 * Optimistic with rollback, matching `TrackingBadge`: the button flips
 * immediately and reverts visibly if the write fails, rather than showing a
 * spinner for a round trip on what should feel like a switch.
 */
export function FollowShowToggle({
  showId,
  initialFollowing,
  signedIn,
}: {
  showId: string;
  initialFollowing: boolean;
  /** Rendered as a prompt rather than a control when false — push needs a
   *  server-side row to exist before the device is asleep, so this is one of
   *  the few genuinely account-gated things in the app. */
  signedIn: boolean;
}) {
  const [following, setFollowing] = useState(initialFollowing);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!signedIn) {
    return (
      <a
        href="/signin?next=/notifications"
        className="text-meta text-fg-subtle hover:text-fg inline-flex items-center gap-1.5 underline underline-offset-4"
      >
        <BellIcon className="size-4" />
        Sign in to get new-episode alerts
      </a>
    );
  }

  async function toggle() {
    const next = !following;
    setFollowing(next);
    setPending(true);
    setError(null);

    const result = next ? await followShowAction(showId) : await unfollowShowAction(showId);

    setPending(false);
    if (!result.ok) {
      setFollowing(!next);
      setError(result.message);
      window.setTimeout(() => setError(null), 4000);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={pending}
        aria-pressed={following}
        className={cn(
          "text-meta inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 uppercase transition-colors",
          following
            ? "bg-accent/15 text-accent border-accent/40"
            : "text-fg-muted border-line hover:bg-overlay hover:text-fg border",
          pending && "opacity-60",
        )}
      >
        {following ? <BellIcon className="size-4" /> : <BellOffIcon className="size-4" />}
        {following ? "Notifying" : "Notify me"}
      </button>

      {error && (
        <p role="alert" className="text-danger text-meta-sm">
          {error}
        </p>
      )}
    </div>
  );
}
