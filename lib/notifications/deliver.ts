import type { NotificationEventKind } from "./detect";
import { isWithinQuietHours } from "./quiet-hours";
import { DEFAULT_PREFS } from "./types";

/**
 * Whether a queued notification may be sent RIGHT NOW — pure, no I/O.
 *
 * Split out of the route so the one decision that can silently withhold
 * someone's notifications forever is testable against plain objects, rather
 * than only observable by watching a cron not send something.
 */

export interface DeliveryPrefsLike {
  quietStart: number;
  quietEnd: number;
  timeZone: string;
  episodeAired: boolean;
  seasonAnnounced: boolean;
}

export type DeliveryDecision =
  /** Send now. */
  | { action: "send" }
  /** Hold in the queue and reconsider on a later run. */
  | { action: "defer"; reason: "quiet-hours" }
  /** Drop the queue row without sending — the user does not want this kind,
   *  or has nowhere to receive it. */
  | { action: "discard"; reason: "kind-disabled" | "no-devices" };

export function decideDelivery(input: {
  kind: NotificationEventKind;
  prefs: DeliveryPrefsLike | undefined;
  deviceCount: number;
  now: Date;
}): DeliveryDecision {
  // A missing prefs row is NOT an error and NOT a reason to withhold: the row
  // is created lazily on first save, so anyone who followed a show without
  // opening the settings page has none. Defaults stand in — which is why
  // DEFAULT_PREFS enables both kinds.
  const prefs = input.prefs ?? DEFAULT_PREFS_LIKE;

  const enabled = input.kind === "episode_aired" ? prefs.episodeAired : prefs.seasonAnnounced;
  if (!enabled) return { action: "discard", reason: "kind-disabled" };

  // Checked BEFORE quiet hours on purpose. Deferring something that can never
  // be delivered would keep the row in the queue forever, re-evaluated on
  // every run, growing without bound for any account that enabled
  // notifications and then removed its last device.
  if (input.deviceCount === 0) return { action: "discard", reason: "no-devices" };

  if (
    isWithinQuietHours(input.now, {
      start: prefs.quietStart,
      end: prefs.quietEnd,
      timeZone: prefs.timeZone,
    })
  ) {
    // DEFER, never discard. The queue row is the deferral mechanism — see
    // design doc §2.2. It stays put and a later run picks it up once the
    // window closes, which is why the ledger is written on send rather than
    // on detection.
    return { action: "defer", reason: "quiet-hours" };
  }

  return { action: "send" };
}

const DEFAULT_PREFS_LIKE: DeliveryPrefsLike = {
  quietStart: DEFAULT_PREFS.quietStart,
  quietEnd: DEFAULT_PREFS.quietEnd,
  timeZone: DEFAULT_PREFS.timeZone,
  episodeAired: DEFAULT_PREFS.episodeAired,
  seasonAnnounced: DEFAULT_PREFS.seasonAnnounced,
};

/**
 * Which followers are eligible for an event, given when each opted in.
 *
 * Pure so design doc §2.1 rule 2 — "enabling notifications for a show that
 * aired an episode yesterday must be silent" — is pinned by a test rather
 * than by the cron's behaviour being observed after the fact.
 *
 * Strictly `<`: a follow created in the same instant as detection is not
 * retroactively owed the event.
 */
export function eligibleFollowers<T extends { userId: string; followedAt: Date }>(
  followers: readonly T[],
  detectedAt: Date,
): T[] {
  return followers.filter((follower) => follower.followedAt < detectedAt);
}
