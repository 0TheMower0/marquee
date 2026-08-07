import type { Metadata } from "next";
import { Suspense } from "react";

import { AccountCard } from "@/components/auth/account-card";
import { PendingInvites, PendingInvitesSkeleton } from "@/components/lists/pending-invites";
import { ProfileView } from "@/components/profile/profile-view";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Profile" };

export default function ProfilePage() {
  return (
    <div className="space-y-8 p-6 pb-0 sm:p-8 sm:pb-0">
      {/* Its own Suspense boundary for the same reason the OMDb ratings row
          has one: `AccountCard` reads the session, which is a network round
          trip to the auth server, and the rest of this page is local-storage
          data that needs nothing from the server at all. Blocking XP, streaks
          and badges on an auth call would make signing in *slow down* the
          part of the app that works without it. */}
      <Suspense fallback={<Skeleton className="h-40 w-full rounded-lg" />}>
        <AccountCard />
      </Suspense>

      {/* Own Suspense boundary, same reasoning as AccountCard above — a
          pending-invites fetch is a network round trip that must not block
          the local-storage-only XP/streak/badge cards beneath it. */}
      <Suspense fallback={<PendingInvitesSkeleton />}>
        <PendingInvites />
      </Suspense>

      <ProfileView />
    </div>
  );
}
