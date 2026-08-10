import { describe, expect, it } from "vitest";

import { decideDelivery, eligibleFollowers, type DeliveryPrefsLike } from "./deliver";

const ISTANBUL = "Europe/Istanbul"; // UTC+3

function prefs(overrides: Partial<DeliveryPrefsLike> = {}): DeliveryPrefsLike {
  return {
    quietStart: 22 * 60,
    quietEnd: 8 * 60,
    timeZone: ISTANBUL,
    episodeAired: true,
    seasonAnnounced: true,
    ...overrides,
  };
}

const DAYTIME = new Date("2026-08-10T12:00:00Z"); // 15:00 Istanbul
const NIGHT = new Date("2026-08-10T00:00:00Z"); // 03:00 Istanbul

describe("decideDelivery", () => {
  it("sends during waking hours", () => {
    expect(
      decideDelivery({ kind: "episode_aired", prefs: prefs(), deviceCount: 1, now: DAYTIME }),
    ).toEqual({ action: "send" });
  });

  it("DEFERS during quiet hours — never discards", () => {
    // The queue row IS the deferral mechanism. Discarding here would drop the
    // notification permanently rather than delaying it.
    expect(
      decideDelivery({ kind: "episode_aired", prefs: prefs(), deviceCount: 1, now: NIGHT }),
    ).toEqual({ action: "defer", reason: "quiet-hours" });
  });

  it("discards a kind the user switched off", () => {
    expect(
      decideDelivery({
        kind: "season_announced",
        prefs: prefs({ seasonAnnounced: false }),
        deviceCount: 1,
        now: DAYTIME,
      }),
    ).toEqual({ action: "discard", reason: "kind-disabled" });
  });

  it("still sends the OTHER kind when one is switched off", () => {
    expect(
      decideDelivery({
        kind: "episode_aired",
        prefs: prefs({ seasonAnnounced: false }),
        deviceCount: 1,
        now: DAYTIME,
      }),
    ).toEqual({ action: "send" });
  });

  it("discards rather than defers when there are no devices, even in quiet hours", () => {
    // Deferring something undeliverable would keep the row forever, growing
    // the queue on every run for an account that removed its last device.
    expect(
      decideDelivery({ kind: "episode_aired", prefs: prefs(), deviceCount: 0, now: NIGHT }),
    ).toEqual({ action: "discard", reason: "no-devices" });
  });

  it("treats a MISSING prefs row as defaults, not as a reason to withhold", () => {
    // The row is created lazily on first save, so anyone who followed a show
    // without opening settings has none. Withholding here would silently
    // never notify exactly the users who did the simplest possible thing.
    expect(
      decideDelivery({ kind: "episode_aired", prefs: undefined, deviceCount: 1, now: DAYTIME }),
    ).toEqual({ action: "send" });
  });

  it("respects an empty quiet window as 'no quiet hours'", () => {
    const always = prefs({ quietStart: 0, quietEnd: 0 });
    expect(
      decideDelivery({ kind: "episode_aired", prefs: always, deviceCount: 1, now: NIGHT }),
    ).toEqual({ action: "send" });
  });

  it("decides per user's own zone at the same instant", () => {
    // Two users, same moment, opposite answers — the reason a single daily
    // cron run cannot serve everyone (design doc §3.1).
    const istanbul = decideDelivery({
      kind: "episode_aired",
      prefs: prefs({ timeZone: ISTANBUL }),
      deviceCount: 1,
      now: NIGHT,
    });
    const tokyo = decideDelivery({
      kind: "episode_aired",
      prefs: prefs({ timeZone: "Asia/Tokyo" }),
      deviceCount: 1,
      now: NIGHT,
    });
    expect(istanbul.action).toBe("defer");
    expect(tokyo.action).toBe("send"); // 09:00 Tokyo
  });
});

describe("eligibleFollowers — the no-backfill gate", () => {
  const detectedAt = new Date("2026-08-10T12:00:00Z");

  it("excludes someone who followed AFTER the event was detected", () => {
    // Design doc §2.1 rule 2: enabling notifications for a show that aired
    // yesterday must be silent.
    const followers = [
      { userId: "early", followedAt: new Date("2026-08-01T00:00:00Z") },
      { userId: "late", followedAt: new Date("2026-08-10T18:00:00Z") },
    ];
    expect(eligibleFollowers(followers, detectedAt).map((f) => f.userId)).toEqual(["early"]);
  });

  it("excludes a follow created in the same instant", () => {
    const followers = [{ userId: "exact", followedAt: detectedAt }];
    expect(eligibleFollowers(followers, detectedAt)).toEqual([]);
  });

  it("returns everyone when all predate the event", () => {
    const followers = [
      { userId: "a", followedAt: new Date("2026-01-01T00:00:00Z") },
      { userId: "b", followedAt: new Date("2026-02-01T00:00:00Z") },
    ];
    expect(eligibleFollowers(followers, detectedAt)).toHaveLength(2);
  });
});
