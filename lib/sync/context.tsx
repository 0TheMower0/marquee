"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getSupabaseBrowserClient } from "@/lib/supabase/browser-client";

import { getSyncBackend } from "./backend";
import {
  inspectBeforeMerge,
  runFirstLoginMerge,
  subscribeToOtherTabs,
  syncOnce,
  type MergeDecision,
} from "./engine";
import type { MergeSummary } from "./merge";
import { STUCK_AFTER_ATTEMPTS, allEntries } from "./outbox";
import { setSyncUser } from "./record";
import { acknowledgeMerge, getMergeRecord } from "./state";
import type { SyncState } from "./types";

/**
 * The sync runtime.
 *
 * Mounted inside `<main>` alongside TrackingProvider and RatingsProvider, and
 * OUTSIDE them in the tree so it can start before they read. It owns three
 * things: knowing who is signed in, running the first-login merge exactly
 * once per (device, account), and keeping a periodic push/pull going.
 *
 * ============================================================================
 * WHY THE SESSION IS READ CLIENT-SIDE HERE
 * ============================================================================
 * Step 4 deliberately kept `getAccount()` out of the root layout, because
 * `cookies()` is request-time and one call there makes every route dynamic.
 * That decision still stands, so this provider cannot be handed a user id from
 * a Server Component without undoing it.
 *
 * It reads the session from the browser client instead — the same cookie the
 * server wrote, so the two never disagree about identity. The session is
 * re-read on three triggers, which between them cover every way it can change:
 * mount, `onAuthStateChange`, and pathname change (sign-in and sign-out are
 * Server Actions that redirect, and a server-set cookie fires no client-side
 * auth event).
 */

const IDLE: SyncState = {
  phase: "disabled",
  pending: 0,
  stuck: 0,
  lastSyncedAt: null,
  message: null,
};

interface SyncContextValue extends SyncState {
  userId: string | null;
  /** Set when two non-empty datasets met and §6.6 requires confirmation. */
  pendingMerge: MergeDecision | null;
  /** The last merge's summary, until the user acknowledges it. */
  mergeSummary: MergeSummary | null;
  confirmMerge: () => Promise<void>;
  cancelMerge: () => void;
  dismissSummary: () => Promise<void>;
  /** Manual "try now", for the error state. */
  syncNow: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

/** Periodic cycle. Two minutes is frequent enough that a second device feels
 *  current within a reasonable window, and infrequent enough that an idle tab
 *  is not a background traffic generator. Reconnect and tab-focus both trigger
 *  an immediate cycle, so this interval is the floor, not the latency. */
const SYNC_INTERVAL_MS = 120_000;

export function SyncProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null);
  const [state, setState] = useState<SyncState>(IDLE);
  const [pendingMerge, setPendingMerge] = useState<MergeDecision | null>(null);
  const [mergeSummary, setMergeSummary] = useState<MergeSummary | null>(null);

  const pathname = usePathname();
  /** Guards against two overlapping cycles in this tab. Cross-tab exclusion is
   *  handled by the Web Lock inside `flushOutbox`. */
  const running = useRef(false);

  /* ----- who is signed in ------------------------------------------------ */

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();
    if (!supabase) return;

    let cancelled = false;

    // Not `getSession()`: it decodes the cookie without verifying it. On the
    // client that is far less serious than on the server (RLS is what actually
    // protects the data) but `getUser()` also confirms the session is still
    // live, which is what decides whether we start syncing at all.
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setUserId(data.user?.id ?? null);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
    // Re-runs on navigation: a Server Action that signs in or out sets the
    // cookie server-side, which fires no client-side auth event, so a redirect
    // is the only signal this tab gets.
  }, [pathname]);

  useEffect(() => {
    // The module-level user for `lib/sync/record.ts`. Everything that queues a
    // write reads it, so it must be set before any mutation can happen.
    //
    // No setState here. Resetting the status on sign-out is a DERIVED fact —
    // "signed out" and "disabled" are the same state — so it is computed in
    // the render body below instead. eslint's react-hooks/set-state-in-effect
    // rejects a synchronous setState in an effect body outright, and it is
    // right to: this was state that did not need to exist.
    setSyncUser(userId);
  }, [userId]);

  /* ----- status ---------------------------------------------------------- */

  const refreshCounts = useCallback(async (patch: Partial<SyncState> = {}) => {
    const entries = await allEntries();
    setState((previous) => ({
      ...previous,
      ...patch,
      pending: entries.length,
      stuck: entries.filter((entry) => entry.attempts >= STUCK_AFTER_ATTEMPTS).length,
    }));
  }, []);

  /* ----- one cycle ------------------------------------------------------- */

  const runCycle = useCallback(async () => {
    if (!userId || running.current) return;
    running.current = true;
    setState((previous) => ({ ...previous, phase: "syncing" }));

    try {
      const backend = getSyncBackend(userId);
      const result = await syncOnce(userId, backend);

      if (result.permanentError) {
        // The state the brief insists must be visible. A permanent failure
        // will not resolve by waiting, so showing "offline" here would be a
        // lie that ends in someone believing they are synced when they are not.
        await refreshCounts({
          phase: "error",
          message: result.permanentError,
        });
      } else if (result.offline) {
        await refreshCounts({
          phase: "offline",
          message: null,
        });
      } else {
        await refreshCounts({
          phase: "idle",
          message: null,
          lastSyncedAt: new Date(),
        });
      }
    } catch (error) {
      console.error("[sync] cycle failed", error);
      await refreshCounts({
        phase: "error",
        message: "Sync failed unexpectedly. Your data is safe on this device.",
      });
    } finally {
      running.current = false;
    }
  }, [userId, refreshCounts]);

  /* ----- first-login merge ----------------------------------------------- */

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    (async () => {
      const existing = await getMergeRecord(userId);
      if (cancelled) return;

      if (existing) {
        // Already merged on this device for this account. Surface the summary
        // again if it was never acknowledged — §6.4 asks for it to stay
        // re-openable, because the merge lands while the user is busy signing
        // in and least likely to read carefully.
        if (!existing.acknowledged) setMergeSummary(existing.summary);
        void runCycle();
        return;
      }

      const backend = getSyncBackend(userId);
      const decision = await inspectBeforeMerge(backend);
      if (cancelled) return;

      if (decision.needsConfirmation) {
        // Two non-empty datasets met. The prompt exists to guard the one
        // irreversible outcome in this design — signing into the WRONG account
        // and uploading your library into someone else's.
        setPendingMerge(decision);
        return;
      }

      const summary = await runFirstLoginMerge(userId, backend);
      if (cancelled) return;
      setMergeSummary(summary);
      void runCycle();
    })().catch((error) => {
      console.error("[sync] first-login merge failed", error);
      setState((previous) => ({
        ...previous,
        phase: "error",
        message:
          "Couldn't merge this device's data with your account. Nothing was lost — a backup was taken first.",
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [userId, runCycle]);

  const confirmMerge = useCallback(async () => {
    if (!userId) return;
    setPendingMerge(null);
    try {
      const summary = await runFirstLoginMerge(userId, getSyncBackend(userId));
      setMergeSummary(summary);
      void runCycle();
    } catch (error) {
      console.error("[sync] merge failed", error);
      setState((previous) => ({
        ...previous,
        phase: "error",
        message: "The merge didn't complete. A backup was taken before it started.",
      }));
    }
  }, [userId, runCycle]);

  const cancelMerge = useCallback(() => {
    setPendingMerge(null);
    // Deliberately does NOT record a merge. Declining leaves the device
    // unmerged, so the prompt returns next time — which is right: the reason
    // to decline is "wrong account", and that should not be silently
    // remembered as "this device is done".
    setState((previous) => ({
      ...previous,
      phase: "error",
      message: "Not synced — this device's data hasn't been merged with the account yet.",
    }));
  }, []);

  const dismissSummary = useCallback(async () => {
    setMergeSummary(null);
    if (userId) await acknowledgeMerge(userId);
  }, [userId]);

  /* ----- keep it going --------------------------------------------------- */

  useEffect(() => {
    if (!userId || pendingMerge) return;

    const interval = setInterval(() => void runCycle(), SYNC_INTERVAL_MS);

    // Reconnect is the moment an offline queue must flush — the third
    // requirement in the brief. `online` fires when connectivity returns;
    // `visibilitychange` covers the far more common case of a laptop waking
    // from sleep with the tab already open, where no `online` event fires.
    const onOnline = () => void runCycle();
    const onVisible = () => {
      if (document.visibilityState === "visible") void runCycle();
    };

    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);

    // Another tab wrote to local storage. Re-reading is not enough on its own
    // — the stores are read into React state at mount — so this at least keeps
    // the outbox counts honest and picks up work the other tab queued.
    const unsubscribe = subscribeToOtherTabs(() => void refreshCounts());

    return () => {
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, [userId, pendingMerge, runCycle, refreshCounts]);

  // Signed out is exactly the disabled state, derived rather than stored — see
  // the effect above. This also means a stale error from a previous session
  // cannot survive a sign-out.
  const value: SyncContextValue = {
    ...(userId ? state : IDLE),
    userId,
    pendingMerge,
    mergeSummary,
    confirmMerge,
    cancelMerge,
    dismissSummary,
    syncNow: runCycle,
  };

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

/**
 * Returns null rather than throwing when there is no provider.
 *
 * Every other context in this app throws, and the difference is deliberate:
 * those are required for the feature to work at all, whereas sync is optional
 * by design. A component that wants to show a sync indicator must be able to
 * render in a build with no Supabase configured, where mounting the provider
 * would be pointless.
 */
export function useSync(): SyncContextValue | null {
  return useContext(SyncContext);
}
