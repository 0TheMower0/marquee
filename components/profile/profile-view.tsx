"use client";

import { BadgeCase } from "@/components/badges/badge-case";
import { DiagnosticsPanel } from "@/components/storage/diagnostics-panel";
import { XpSummary } from "@/components/profile/xp-summary";
import { StreakSummary } from "@/components/streak/streak-summary";
import { Button } from "@/components/ui/button";

/**
 * Client-rendered for the same reason `LibraryView` is: XP is derived from
 * tracking state that lives only in this browser's storage, so there is
 * nothing for a server render to fetch.
 */
export function ProfileView() {
  return (
    <div className="space-y-8 pb-6 sm:pb-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-display-lg text-fg uppercase">Profile</h1>
          <p className="text-body-sm text-fg-subtle mt-1 max-w-prose">
            Everything below is computed from this device&rsquo;s own data —
            signed in or not.
          </p>
        </div>
        <Button href="/profile/stats" variant="outline" size="sm">
          Full stats
        </Button>
      </div>

      <XpSummary />
      <StreakSummary />
      <BadgeCase />

      {/* On Profile rather than /account on purpose: this is for diagnosing a
          device where something is wrong, and /account needs a working session
          — which is one of the things that might be wrong. */}
      <DiagnosticsPanel />
    </div>
  );
}
