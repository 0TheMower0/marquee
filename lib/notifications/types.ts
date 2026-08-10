import type { NotificationEventKind } from "./detect";
import type { MinuteOfDay } from "./quiet-hours";

/**
 * Shared shapes for the notifications feature.
 *
 * ============================================================================
 * WHY NONE OF THIS JOINS `SYNC_TABLES` — a correction to the design doc
 * ============================================================================
 * `docs/phase-7-notifications-design.md` §7 said follows and prefs would join
 * `SYNC_TABLES` "so preferences sync like everything else". **They do not, and
 * should not.** Realised while building step 3.
 *
 * `lib/sync` exists to reconcile a LOCAL-FIRST replica with the server:
 * tracking, ratings, and the watch log are all fully usable offline and only
 * later converge. Notification follows have no offline story at all — the
 * thing that acts on them is a server-side cron, so a local replica could
 * never be authoritative and could never be acted upon while offline.
 *
 * They are the same class as comments (Phase 6 Step 6a) and lists (6b): both
 * are account-gated, server-authoritative, and deliberately outside
 * `SYNC_TABLES`. Adding these would mean an outbox, a reconcile rule, and a
 * local mirror for data whose only consumer runs on the server.
 *
 * Cross-device consistency is not lost by this — it is *stronger*. A
 * server-authoritative row is identical on every device by construction,
 * with no convergence window at all.
 */

export interface NotificationPrefs {
  quietStart: MinuteOfDay;
  quietEnd: MinuteOfDay;
  /** IANA zone name. Refreshed by the client, never frozen — see quiet-hours.ts. */
  timeZone: string;
  episodeAired: boolean;
  seasonAnnounced: boolean;
}

/** A show the user has asked to be notified about. */
export interface ShowFollow {
  showId: string;
  followedAt: Date;
}

export interface NotificationSettings {
  prefs: NotificationPrefs;
  follows: ShowFollow[];
  /** How many browsers currently have a live push subscription for this
   *  account. Zero means notifications are enabled in principle but nothing
   *  can receive them — a state the UI must call out rather than imply
   *  everything is fine. */
  deviceCount: number;
}

export interface SentNotification {
  showId: string;
  kind: NotificationEventKind;
  eventKey: string;
  sentAt: Date;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  quietStart: 22 * 60,
  quietEnd: 8 * 60,
  timeZone: "UTC",
  episodeAired: true,
  seasonAnnounced: true,
};

/** The payload the service worker receives. Kept minimal and deliberately
 *  free of anything personal: a push payload is encrypted in transit but is
 *  handed to the OS, which may log or display it on a lock screen. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Collapses same-show notifications in the OS tray rather than stacking. */
  tag: string;
}
