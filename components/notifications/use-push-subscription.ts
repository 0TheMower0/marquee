"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  deletePushSubscriptionAction,
  savePushSubscriptionAction,
} from "@/lib/notifications/actions";
import { detectPushCapability, type PushCapability } from "@/lib/notifications/capability";

/**
 * Owns the browser side of a push subscription: capability, permission, and
 * the PushManager handshake.
 *
 * The permission prompt is fired ONLY from an explicit user action (see
 * `subscribe`), never on mount. A denied permission cannot be re-requested
 * from script — only the user can undo it, buried in browser settings — so a
 * prompt fired cold is the fastest possible way to lose the feature
 * permanently for that person.
 */

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

/**
 * VAPID keys travel as base64url; PushManager wants raw bytes.
 *
 * Annotated `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`: current
 * lib.dom types require `applicationServerKey` to be backed by a real
 * `ArrayBuffer`, and the default generic parameter is the wider
 * `ArrayBufferLike` (which admits `SharedArrayBuffer`).
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

function encodeKey(subscription: PushSubscription, name: "p256dh" | "auth"): string {
  const key = subscription.getKey(name);
  if (!key) return "";
  // btoa over a binary string, then base64url — the shape `web-push` expects.
  return window
    .btoa(String.fromCharCode(...new Uint8Array(key)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface PushSubscriptionState {
  capability: PushCapability;
  /** True when THIS browser has a live subscription. Per-device, not
   *  per-account: the same account on a laptop is a separate subscription. */
  subscribed: boolean;
  busy: boolean;
  error: string | null;
  /** Absent VAPID config makes the whole feature inert rather than broken,
   *  matching a blank OMDB_API_KEY or unconfigured Supabase. */
  configured: boolean;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
}

/**
 * Capability is EXTERNAL state (the browser's own feature set and permission),
 * so it is read with `useSyncExternalStore` rather than set into React state
 * from an effect.
 *
 * That is not a style preference — `react-hooks/set-state-in-effect` rejects
 * the effect version outright, and this is the fourth time this codebase has
 * hit that rule (Search, badges, sync, storage-status). The storage-status
 * hook in Phase 6 Step 5b landed on exactly this answer for exactly this
 * shape of problem, and it buys the SSR snapshot for free: the server sees
 * `unknown` by construction, so the setup card cannot flash a wrong state
 * into the server HTML and then correct it on hydration.
 *
 * Permission can change from browser UI without any event we can subscribe
 * to, so the "subscribe" side is a no-op and the value is re-read whenever
 * React re-renders for another reason. `subscribe()`/`unsubscribe()` below
 * force that re-read via `bumpCapability` after any action that could change
 * the answer.
 */
const capabilityListeners = new Set<() => void>();
let capabilitySnapshot: PushCapability | null = null;

function subscribeCapability(onChange: () => void): () => void {
  capabilityListeners.add(onChange);
  return () => capabilityListeners.delete(onChange);
}

function capabilityClientSnapshot(): PushCapability {
  // Cached because useSyncExternalStore requires a STABLE reference between
  // renders — returning a fresh object each call is an infinite render loop.
  capabilitySnapshot ??= detectPushCapability();
  return capabilitySnapshot;
}

const CAPABILITY_SERVER_SNAPSHOT: PushCapability = { kind: "unknown" };

function bumpCapability(): void {
  capabilitySnapshot = detectPushCapability();
  for (const listener of capabilityListeners) listener();
}

export function usePushSubscription(): PushSubscriptionState {
  const capability = useSyncExternalStore(
    subscribeCapability,
    capabilityClientSnapshot,
    () => CAPABILITY_SERVER_SNAPSHOT,
  );
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((existing) => {
        if (!cancelled) setSubscribed(existing !== null);
      })
      .catch(() => {
        /* no worker yet — `subscribed` stays false, which is correct */
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Called from a click handler, so this is a user-gesture-initiated
      // prompt — the only kind that should ever appear.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        // Re-read: a denial has just changed the answer, and there is no
        // event to tell us otherwise.
        bumpCapability();
        setError(
          permission === "denied"
            ? "Notifications are blocked for this site. You can re-enable them in your browser settings."
            : "Notifications weren't enabled.",
        );
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        // Required to be true by every browser that implements Web Push: a
        // push must result in a visible notification. There is no silent-push
        // mode to opt into even if we wanted one.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });

      const result = await savePushSubscriptionAction({
        endpoint: subscription.endpoint,
        p256dh: encodeKey(subscription, "p256dh"),
        auth: encodeKey(subscription, "auth"),
        userAgent: navigator.userAgent,
      });

      if (!result.ok) {
        // Roll the browser-side subscription back rather than leaving a live
        // endpoint the server has no record of: it would receive nothing, and
        // the UI would say "subscribed" forever.
        await subscription.unsubscribe().catch(() => {});
        setError(result.message);
        return;
      }

      setSubscribed(true);
    } catch (cause) {
      console.warn("[marquee] push subscribe failed", cause);
      setError("Couldn't turn on notifications on this device.");
    } finally {
      setBusy(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        // Server first: if the browser-side unsubscribe succeeded but the row
        // survived, the sender would keep pushing to a dead endpoint until it
        // 410'd. Removing the row first makes the worst case a subscription
        // the user can simply turn off again.
        await deletePushSubscriptionAction(existing.endpoint);
        await existing.unsubscribe();
      }
      setSubscribed(false);
    } catch (cause) {
      console.warn("[marquee] push unsubscribe failed", cause);
      setError("Couldn't turn notifications off. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    capability,
    subscribed,
    busy,
    error,
    configured: VAPID_PUBLIC_KEY.length > 0,
    subscribe,
    unsubscribe,
  };
}
