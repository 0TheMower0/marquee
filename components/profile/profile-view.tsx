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
        <div className="flex flex-wrap gap-2">
          {/* Phase 8 Step 1. Listed before "Full stats" because it is the
              narrative view and the one worth opening unprompted; stats is
              the reference view you go looking for. */}
          <Button href="/profile/year" variant="primary" size="sm">
            Last 12 months
          </Button>
          <Button href="/profile/stats" variant="outline" size="sm">
            Full stats
          </Button>
          {/* Phase 8 Step 2. Ghost, not outline — it's a lower-priority exit
              from this page rather than a third thing to look at, the same
              weighting the two stats buttons above already establish
              relative to each other. Not a 5th NAV_ITEMS entry; every other
              rarely-visited route in this app (/lists, /schedule,
              /notifications) is reached the same way, from the page it's
              most contextually relevant to. */}
          <Button href="/settings" variant="ghost" size="sm">
            Settings
          </Button>
        </div>
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
