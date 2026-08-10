/**
 * Quiet hours — pure, no I/O, no React.
 *
 * ============================================================================
 * ⚠️ THE FREEZE RUNS THE OPPOSITE WAY FROM lib/watchlog. READ THIS FIRST.
 * ============================================================================
 * `lib/watchlog/types.ts` freezes a day key at write time because it records
 * HISTORY: the day you watched something is a fact about where you *were*,
 * and re-deriving it after you travel would rewrite your streaks.
 *
 * Quiet hours are the mirror image. They are a LIVE PREFERENCE about where
 * you *are*: "do not wake me at 3am" means 3am wherever the phone currently
 * is. So the zone is deliberately NOT frozen — it is refreshed by the client
 * whenever `Intl.DateTimeFormat().resolvedOptions().timeZone` changes, and
 * every evaluation here uses the current stored value.
 *
 * Freezing it would wake someone at 3am after they moved country. That is the
 * same class of bug `localDayKey` exists to prevent, arriving through the
 * opposite door.
 *
 * The rule BOTH cases obey, and the one worth remembering: **never derive a
 * user's local time by assuming the server's zone.** The direction of the
 * freeze differs; that does not.
 *
 * A fixed UTC offset ("+03:00") would be wrong for a third reason: it breaks
 * across DST twice a year. An IANA zone name survives both transitions
 * because `Intl` carries the whole rule set, not a single number.
 */

/** Minutes since local midnight, 0–1439. */
export type MinuteOfDay = number;

export interface QuietHours {
  /** Inclusive start, minutes since local midnight. */
  start: MinuteOfDay;
  /** Exclusive end, minutes since local midnight. */
  end: MinuteOfDay;
  /** IANA zone name, e.g. "Europe/Istanbul". Never a fixed offset. */
  timeZone: string;
}

export const DEFAULT_QUIET_START: MinuteOfDay = 22 * 60; // 22:00
export const DEFAULT_QUIET_END: MinuteOfDay = 8 * 60; // 08:00

export function isMinuteOfDay(value: unknown): value is MinuteOfDay {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439;
}

/**
 * Local wall-clock minutes for an instant in a given IANA zone.
 *
 * `hourCycle: "h23"` rather than `hour12: false` on purpose: the latter has a
 * long-standing quirk where midnight formats as hour "24" rather than "00" in
 * some engines, which would compute 1440 and fall outside every window.
 *
 * An unknown or malformed zone makes `Intl` throw. Rather than propagate that
 * into the sender — where it would fail one user's delivery forever, silently,
 * because their stored zone was retired from the tz database — it falls back
 * to UTC. Being an hour or two wrong about someone's quiet hours is a far
 * smaller failure than never notifying them again.
 */
export function localMinuteOfDayIn(instant: Date, timeZone: string): MinuteOfDay {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return (hour % 24) * 60 + minute;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  }

  // Cached because the sender evaluates this once per pending notification and
  // constructing an Intl.DateTimeFormat is comparatively expensive. Keyed by
  // the zone string, including the invalid ones that fell back to UTC — a bad
  // zone should not re-throw and re-catch on every single evaluation.
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Whether `instant` falls inside the user's quiet window.
 *
 * Three cases, and the wrapping one is the normal one:
 *
 *   22:00 → 08:00   start > end, wraps midnight. Inside if at-or-after start
 *                   OR before end. This is what almost every real setting
 *                   looks like, so it is the case to get right.
 *   01:00 → 05:00   start < end, ordinary interval.
 *   equal           NO quiet hours at all. Deliberately not "always quiet":
 *                   a user who sets both ends the same has expressed an empty
 *                   window, and reading that as a permanent block would
 *                   silence them forever with no error.
 */
export function isWithinQuietHours(instant: Date, quiet: QuietHours): boolean {
  if (quiet.start === quiet.end) return false;

  const minute = localMinuteOfDayIn(instant, quiet.timeZone);

  return quiet.start > quiet.end
    ? minute >= quiet.start || minute < quiet.end
    : minute >= quiet.start && minute < quiet.end;
}

/** "22:00" for display and for an `<input type="time">` value. */
export function formatMinuteOfDay(minute: MinuteOfDay): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, "0");
  const minutes = String(minute % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Parses an `<input type="time">` value. Returns null on anything malformed
 *  rather than coercing — a silently-wrong quiet window is worse than a
 *  rejected edit. */
export function parseMinuteOfDay(value: string): MinuteOfDay | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * The browser's current zone, for the client to store and refresh.
 *
 * Falls back to UTC where `Intl` is unavailable or returns nothing — the same
 * degradation as `localMinuteOfDayIn`, and for the same reason.
 */
export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
