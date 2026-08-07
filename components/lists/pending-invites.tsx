import { Skeleton } from "@/components/ui/skeleton";
import { getAccount } from "@/lib/auth";
import { getPendingInvites } from "@/lib/lists/queries";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

import { PendingInvitesClient } from "./pending-invites-client";

/**
 * Surfaced on Profile — the one place a signed-in user reliably looks — so a
 * collaborator invite isn't something you can only discover by already
 * having the list's link. Renders nothing at all when there's nothing to
 * show: no account, no config, zero invites, or a failed fetch all collapse
 * to the same "don't take up space" outcome, since none of them are actions
 * for the viewer to take.
 *
 * Same try/catch discipline `CommentSection` uses and Phase 6 Step 6b's brief
 * calls out explicitly: a transient failure here must never take down the
 * rest of Profile (XP, streaks, badges), so it degrades to nothing rather
 * than throwing into `app/error.tsx`.
 */
export async function PendingInvites() {
  if (!isSupabaseConfigured()) return null;

  const account = await getAccount();
  if (!account) return null;

  let invites;
  try {
    invites = await getPendingInvites();
  } catch (error) {
    console.error("[lists] pending invites failed to load", error);
    return null;
  }

  if (invites.length === 0) return null;

  return <PendingInvitesClient initialInvites={invites} viewerId={account.user.id} />;
}

/**
 * Accepted tradeoff: most visits have zero pending invites, so this fallback
 * flashes briefly then collapses to nothing on the common path — the same
 * cost every Suspense boundary in this app pays for streaming instead of
 * blocking, just more visible here because the "resolves to null" outcome is
 * the majority case rather than the exception. Kept deliberately short (two
 * small bars) so that flash is as unobtrusive as it can be.
 */
export function PendingInvitesSkeleton() {
  return (
    <div className="space-y-3" aria-label="Loading list invites">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-14 w-full rounded-md" />
    </div>
  );
}
