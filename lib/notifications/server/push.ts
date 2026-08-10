import "server-only";

import webpush from "web-push";

import type { PushPayload } from "../types";
import type { DeviceSubscription } from "./store";

/**
 * The Web Push transport. The one place `web-push` is used.
 *
 * ============================================================================
 * WHY A DEPENDENCY HERE, WHEN THIS PROJECT AVOIDS THEM
 * ============================================================================
 * Icons and charts are hand-rolled in this codebase, and the arguments there
 * (`components/ui/icons.tsx`, `components/stats/`) are about bundle weight and
 * API surface for simple things. Neither transfers.
 *
 * Web Push requires VAPID JWT signing (ES256 over the push service origin)
 * and RFC 8291 payload encryption (ECDH on P-256, HKDF, AES128GCM). That is
 * real cryptography where a subtle mistake is silent — the notification
 * simply never arrives, or arrives unencrypted — and hand-rolling it would be
 * a bad idea for reasons that have nothing to do with effort.
 *
 * Server-side only. `web-push` must never reach the browser: `server-only`
 * above makes an accidental client import a build error rather than a
 * bundle-size surprise carrying our private key's usage patterns.
 */

export type PushResult =
  | { ok: true }
  /** The subscription is permanently dead — prune it. */
  | { ok: false; gone: true }
  /** Transient. Leave the subscription alone and let a later run retry. */
  | { ok: false; gone: false; status: number | null };

let configured = false;

/** VAPID identifies US to the push service; the contact is required to be a
 *  mailto: or https: URL by spec, and is what a push provider uses to reach an
 *  operator whose traffic is misbehaving. */
function configure(): boolean {
  if (configured) return true;

  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return false;

  webpush.setVapidDetails(
    process.env.VAPID_CONTACT ?? "mailto:notifications@marquee.invalid",
    publicKey,
    privateKey,
  );
  configured = true;
  return true;
}

export function isPushConfigured(): boolean {
  return configure();
}

export async function sendPush(
  subscription: DeviceSubscription,
  payload: PushPayload,
): Promise<PushResult> {
  if (!configure()) return { ok: false, gone: false, status: null };

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      // TTL: how long the push service should hold this if the device is
      // offline. A day — a "new episode aired" notice delivered three days
      // late is worse than not delivered, and the queue would have moved on.
      { TTL: 60 * 60 * 24 },
    );
    return { ok: true };
  } catch (error) {
    const status = statusOf(error);

    // 404 and 410 are the spec's "this subscription is permanently invalid":
    // the browser was uninstalled, site data was cleared, or the endpoint
    // rotated. Anything else — including 429 and 5xx — is transient and must
    // NOT prune, or a push service having a bad hour would silently
    // unsubscribe every user we tried to reach during it.
    if (status === 404 || status === 410) return { ok: false, gone: true };

    return { ok: false, gone: false, status };
  }
}

function statusOf(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const status = (error as { statusCode: unknown }).statusCode;
    if (typeof status === "number") return status;
  }
  return null;
}
