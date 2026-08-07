"use client";

import { AlertIcon } from "@/components/ui/icons";

import { useStorageStatus } from "./use-storage-status";

/**
 * The warning shown when this browser will not persist anything.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Without it, blocked storage is **indistinguishable from having no data**.
 * A live two-device test hit exactly that: tracking controls disabled, My
 * Library empty, and nothing anywhere saying why. Someone signed in would
 * reasonably conclude their account had failed to sync and that their library
 * was gone — which is a far more alarming reading than the truth.
 *
 * Two audiences hit this for real, neither of them edge cases:
 *
 *   - **Private / incognito browsing.** Several browsers allow `localStorage`
 *     to be read and written and then discard it, or block it outright.
 *   - **A non-HTTPS deployment**, or a dev server reached over the LAN from a
 *     phone. Storage itself is not secure-context gated, but everything around
 *     it behaves differently enough that this is where people land.
 *
 * ============================================================================
 * WHY IT RENDERS ONLY FOR "memory"
 * ============================================================================
 * The client can only ever resolve to `persistent` or `memory` — `unavailable`
 * is the SSR driver, which exists because the server genuinely has no access
 * to this user's storage. Rendering on `unavailable` would put the banner in
 * the server HTML for every visitor and then remove it on hydration, which is
 * a flash of a false alarm on every page load.
 *
 * `memory` is not a broken app: everything works for this tab, and that is
 * what the copy says. It is broken *persistence*, and the difference is
 * exactly what the user needs to know before they spend an evening tracking a
 * season.
 */
export function StorageBanner() {
  const status = useStorageStatus();

  if (status !== "memory") return null;

  return (
    <div
      role="alert"
      className="border-warning/40 bg-warning/10 mx-6 mt-6 rounded-md border px-4 py-3 sm:mx-8"
    >
      <div className="flex items-start gap-3">
        <AlertIcon className="text-warning mt-0.5 size-5 shrink-0" />
        <div className="space-y-1">
          <p className="text-body-sm text-fg font-medium">
            This browser isn&rsquo;t saving your data
          </p>
          <p className="text-meta text-fg-muted">
            Marquee can&rsquo;t write to storage here, so anything you track will
            be lost when you close this tab. Your existing library hasn&rsquo;t
            been deleted &mdash; it just can&rsquo;t be read on this device.
          </p>
          <p className="text-meta text-fg-subtle">
            This is usually private browsing, or a browser setting that blocks
            site data. Try a normal window, or allow site data for this address.
          </p>
        </div>
      </div>
    </div>
  );
}
