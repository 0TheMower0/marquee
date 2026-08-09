"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Detects a waiting service worker and offers to apply it. Step 3 of
 * docs/phase-5-pwa-design.md §10 — see §4 for the reasoning this implements.
 *
 * Split from `ServiceWorkerRegistration` deliberately: that component's only
 * job is getting a worker installed at all, and update detection needs its
 * own lifecycle (an existing registration, `updatefound`, `visibilitychange`)
 * that has nothing to do with the initial `register()` call. Mixing the two
 * would make either change risk breaking the other.
 */

const ENABLED =
  process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_SW_IN_DEV === "1";

export interface ServiceWorkerUpdate {
  /**
   * True whenever a waiting worker exists AND the caller hasn't dismissed
   * THIS surfacing of it. Not persisted anywhere — see `dismiss` below.
   */
  show: boolean;
  applyUpdate: () => void;
  dismiss: () => void;
}

export function useServiceWorkerUpdate(): ServiceWorkerUpdate {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reloadingRef = useRef(false);

  useEffect(() => {
    if (!ENABLED) return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;

    /**
     * Re-surfaces the prompt every time a waiting worker is freshly
     * CONFIRMED present — on initial load, after an `updatefound` install
     * completes, and after every `visibilitychange` recheck. This is what
     * makes dismissal genuinely per-visit rather than permanent: `dismissed`
     * is reset here, not just left alone, so tapping X hides the prompt now
     * without hiding it forever. See the doc comment on `UpdatePrompt` for
     * why storing the dismissal instead would be the bug, not the fix.
     */
    function surface(reg: ServiceWorkerRegistration) {
      if (cancelled || !reg.waiting) return;
      setAvailable(true);
      setDismissed(false);
    }

    function watch(reg: ServiceWorkerRegistration) {
      registrationRef.current = reg;
      surface(reg);

      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          // "installed" with an existing controller means this install is an
          // UPDATE waiting behind the active worker, not the page's first
          // ever registration — the latter activates immediately with
          // nothing to wait behind. reg.waiting is authoritative either way;
          // this just decides when it is worth re-checking.
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            surface(reg);
          }
        });
      });
    }

    // `ready` resolves once a worker is actively controlling the page —
    // reliable regardless of whether ServiceWorkerRegistration's own
    // register() call (deferred to the `load` event) has run yet.
    navigator.serviceWorker.ready.then((reg) => {
      if (!cancelled) watch(reg);
    });

    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const reg = registrationRef.current;
      if (!reg) return;
      // A long-lived tab would otherwise never notice a deploy that happened
      // while it sat in the background — this is the mechanism that catches it.
      reg.update().then(() => surface(reg)).catch(() => {});
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Fires once, exactly when the new worker takes control — NOT
    // immediately on postMessage, since activation is asynchronous and
    // reloading before it completes would just reload onto the old worker.
    function onControllerChange() {
      if (reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    }
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return {
    show: available && !dismissed,
    applyUpdate() {
      registrationRef.current?.waiting?.postMessage({ type: "SKIP_WAITING" });
    },
    dismiss() {
      setDismissed(true);
    },
  };
}
