"use client";

import { useSyncExternalStore } from "react";

import { getStorageStatus, type StorageStatus } from "@/lib/storage";

/**
 * The storage driver actually in use, as a React value.
 *
 * ============================================================================
 * WHY useSyncExternalStore AND NOT useState + useEffect
 * ============================================================================
 * Two reasons, and the second is the real one:
 *
 *   1. `getStorageStatus()` is a synchronous read of an external system, which
 *      is precisely what this hook is for. The `useState` + `useEffect`
 *      version would be a synchronous `setState` in an effect body, which
 *      eslint's `react-hooks/set-state-in-effect` rejects outright — the same
 *      rule that has now bitten this codebase in Phase 5 Step 4, Phase 6 Step
 *      5, and would have here.
 *   2. It handles the server/client split correctly by construction. During
 *      SSR there is no `window`, so the driver is the null one and the status
 *      is `"unavailable"`; `getServerSnapshot` returns exactly that, so the
 *      HTML and the first client render agree and there is no hydration
 *      mismatch.
 *
 * `subscribe` is a no-op returning a no-op: the driver is detected once and
 * cached for the life of the page, so there is genuinely nothing to subscribe
 * to. Defined at module scope rather than inline so its identity is stable —
 * a new function per render would make React re-subscribe on every render.
 */
const subscribe = () => () => {};

const serverSnapshot = (): StorageStatus => "unavailable";

export function useStorageStatus(): StorageStatus {
  return useSyncExternalStore(subscribe, getStorageStatus, serverSnapshot);
}

/**
 * Whether this page is in a secure context.
 *
 * Not a storage property, but it belongs next to one: it is the single most
 * useful thing to know when diagnosing a device where things "just don't
 * work", and it is invisible to the user otherwise. `http://<lan-ip>:3000` is
 * NOT secure; `https://` and `http://localhost` are.
 */
export function useSecureContext(): boolean | null {
  return useSyncExternalStore(
    subscribe,
    () => (typeof window === "undefined" ? null : window.isSecureContext),
    () => null,
  );
}
