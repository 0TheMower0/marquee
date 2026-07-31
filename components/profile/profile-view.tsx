"use client";

import { XpSummary } from "@/components/profile/xp-summary";

/**
 * Client-rendered for the same reason `LibraryView` is: XP is derived from
 * tracking state that lives only in this browser's storage, so there is
 * nothing for a server render to fetch.
 */
export function ProfileView() {
  return (
    <div className="space-y-8 p-6 sm:p-8">
      <div>
        <h1 className="font-display text-display-lg text-fg uppercase">Profile</h1>
        <p className="text-body-sm text-fg-subtle mt-1 max-w-prose">
          Accounts, streaks, and badges arrive in later phases. For now Marquee
          runs entirely on this device — nothing is synced anywhere.
        </p>
      </div>

      <XpSummary />
    </div>
  );
}
