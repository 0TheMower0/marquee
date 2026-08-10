import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server-client";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";

import { DEFAULT_PREFS, type NotificationSettings, type ShowFollow } from "./types";
import { detectTimeZone } from "./quiet-hours";

/**
 * The read path — `server-only`, so a Client Component importing it is a
 * BUILD error rather than a runtime leak. Deliberately not re-exported from
 * an `index.ts` barrel, for the same reason `lib/lists` withholds its
 * queries: a barrel would let a client import drag this into the browser
 * graph.
 *
 * Every read here runs AS THE USER through the ordinary anon-key client and
 * is subject to the same RLS every other table in this app relies on. Nothing
 * in this file touches the service role — that is confined entirely to
 * `./server/store.ts`, which the cron alone uses.
 */

interface FollowRow {
  show_id: string;
  followed_at: string;
}

interface PrefsRow {
  quiet_start: number;
  quiet_end: number;
  timezone: string;
  episode_aired: boolean;
  season_announced: boolean;
}

/**
 * Everything the settings page needs, in one round trip per table.
 *
 * Returns `null` when notifications are unavailable — unconfigured Supabase,
 * or signed out. That is the same "inert, not broken" shape
 * `getAuthProvider()` established: callers render an explanation, not an
 * error.
 *
 * A missing prefs row is NOT an error either. The row is created lazily on
 * first save, so a user who has never opened the settings page has none —
 * defaults stand in until they change something.
 */
export async function getNotificationSettings(): Promise<NotificationSettings | null> {
  if (!isSupabaseConfigured()) return null;

  const supabase = await createSupabaseServerClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return null;

  const userId = userData.user.id;

  const [followsResult, prefsResult, devicesResult] = await Promise.all([
    supabase
      .from("show_follows")
      .select("show_id, followed_at")
      .eq("user_id", userId)
      .order("followed_at", { ascending: false }),
    supabase
      .from("notification_prefs")
      .select("quiet_start, quiet_end, timezone, episode_aired, season_announced")
      .eq("user_id", userId)
      .maybeSingle(),
    // head+count: the endpoint itself is a capability URL and there is no
    // reason to pull the rows just to say "2 devices".
    supabase
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
  ]);

  const follows: ShowFollow[] = ((followsResult.data ?? []) as FollowRow[]).map((row) => ({
    showId: row.show_id,
    followedAt: new Date(row.followed_at),
  }));

  const prefsRow = prefsResult.data as PrefsRow | null;

  return {
    follows,
    deviceCount: devicesResult.count ?? 0,
    prefs: prefsRow
      ? {
          quietStart: prefsRow.quiet_start,
          quietEnd: prefsRow.quiet_end,
          timeZone: prefsRow.timezone,
          episodeAired: prefsRow.episode_aired,
          seasonAnnounced: prefsRow.season_announced,
        }
      : // `detectTimeZone()` returns UTC on the server (no Intl locale zone),
        // which is the honest default: the real zone arrives from the client
        // on first mount via `syncTimeZoneAction`.
        { ...DEFAULT_PREFS, timeZone: detectTimeZone() },
  };
}

/**
 * Whether the signed-in user follows this specific show.
 *
 * Its own query rather than a slice of `getNotificationSettings` because the
 * per-show bell renders on every TV title page, where pulling the entire
 * follow list and every device row to answer one boolean would be waste that
 * scales with how many shows the user follows.
 *
 * Returns `false` — never throws — when signed out or unconfigured. The bell
 * then renders as an invitation to sign in rather than an error.
 */
export async function isFollowingShow(showId: string): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;

  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return false;

  const { data } = await supabase
    .from("show_follows")
    .select("show_id")
    .eq("user_id", userData.user.id)
    .eq("show_id", showId)
    .maybeSingle();

  return data !== null;
}
