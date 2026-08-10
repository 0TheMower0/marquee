import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { isSupabaseConfigured, SUPABASE_URL } from "@/lib/supabase/public-env";
import { hasServiceRoleKey, serviceRoleKey } from "@/lib/supabase/server-env";

import type { DetectedEvent, NotificationEventKind, ShowSnapshot } from "../detect";
import type { NotificationPayload } from "../detect";

/**
 * ███████████████████████████████████████████████████████████████████████████
 * THE ONLY MODULE IN THIS PROJECT THAT HOLDS A SERVICE-ROLE CLIENT.
 * ███████████████████████████████████████████████████████████████████████████
 *
 * That client carries **BYPASSRLS**. Every policy in every migration under
 * `supabase/` is simply not applied to it. A mistake here is not "this query
 * returned too much" — it is unmediated read/write access to every user's
 * library, ratings, private notes, watch history and comments, with nothing in
 * the database able to stop it.
 *
 * So this module is built to be OBVIOUSLY scoped rather than carefully used.
 * Three properties do that, and all three are structural:
 *
 * 1. **The client never escapes.** `client()` is module-private and is not
 *    exported. There is no `getServiceRoleClient()` anywhere in the codebase.
 *    The only way to reach the database with these privileges is through one
 *    of the named operations at the bottom of this file, and that list IS the
 *    complete inventory of what the notifier can touch.
 *
 * 2. **The reachable tables are an allowlist, enforced by the type checker.**
 *    `readTable()` and `writeTable()` accept only the unions below. Writing
 *    `writeTable("comments")` does not compile. Neither does
 *    `writeTable("watched_episodes")` — that table is deliberately
 *    read-only-reachable, because the ONLY legitimate reason to consult watch
 *    state here is to SUPPRESS a redundant notification (design doc §1.1),
 *    never to modify anything.
 *
 * 3. **No caller-supplied value chooses a table or a user.** Every operation
 *    below takes concrete, typed arguments and hard-codes its own table. There
 *    is no generic `query(table, filter)` seam for a future caller to widen.
 *
 * If a new operation is needed, add a named function here rather than
 * exporting the client. The extra friction is the point.
 *
 * The guard test (`lib/notifications/service-role-guard.test.ts`) asserts that
 * this remains the ONLY importer of `@/lib/supabase/server-env`. That test is
 * the only mechanical thing standing between this project and a second
 * service-role code path.
 */

/* ---------------------------------------------------------------------------
 * The allowlist — the complete set of tables the notifier may reach
 * ------------------------------------------------------------------------ */

/**
 * Writable. Every one of these exists solely for notifications; none is user
 * content, and losing all of them would cost a user nothing but a re-opt-in.
 */
type WritableTable =
  | "show_snapshots"
  | "pending_notifications"
  | "notification_log"
  | "push_subscriptions";

/**
 * Readable but NOT writable.
 *
 * `show_follows` and `notification_prefs` are the user's own settings: the
 * notifier reads them to decide what to send, and has no business editing
 * them — that is what the Server Actions in `../actions.ts` are for, running
 * as the user under RLS.
 *
 * `tracked_titles` and `watched_episodes` are the suppression inputs, and are
 * the sharpest reason this split is typed rather than documented. Watch state
 * may only ever REMOVE a notification the world already justified. Making
 * these unreachable to `writeTable` means the notifier structurally cannot
 * modify a user's watch history — the worst imaginable bug in this feature.
 */
type ReadableTable =
  | WritableTable
  | "show_follows"
  | "notification_prefs"
  | "tracked_titles"
  | "watched_episodes";

let cached: SupabaseClient | null = null;

/**
 * Module-private, deliberately never exported.
 *
 * `persistSession: false` because this client has no session to persist and
 * must never pick one up from anywhere; `autoRefreshToken: false` for the same
 * reason. Both would be harmless in a cron but are set explicitly so this can
 * never behave like a user-facing client if it were ever moved.
 */
function client(): SupabaseClient {
  cached ??= createClient(SUPABASE_URL, serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return cached;
}

/**
 * Whether the notifier can operate at all.
 *
 * Lives HERE rather than in the route so the route never imports
 * `@/lib/supabase/server-env` itself — the containment claim is "exactly one
 * file imports the service-role module", and a route reaching for it even
 * just to ask "is it set?" would make that claim false and the guard test
 * would (correctly) fail. The route asks the store instead, which is also
 * simply the better shape: the store is what knows whether it can work.
 */
export function isNotifierConfigured(): boolean {
  return isSupabaseConfigured() && hasServiceRoleKey();
}

function readTable(table: ReadableTable) {
  return client().from(table);
}

function writeTable(table: WritableTable) {
  return client().from(table);
}

/* ---------------------------------------------------------------------------
 * Operations. This list is the notifier's complete surface area.
 * ------------------------------------------------------------------------ */

/** Every distinct show at least one person follows. The detector's driving
 *  query, and the reason detection costs one upstream call per SHOW rather
 *  than per follower. */
export async function listFollowedShowIds(): Promise<string[]> {
  const { data, error } = await readTable("show_follows").select("show_id");
  if (error) throw error;
  return [...new Set((data ?? []).map((row) => row.show_id as string))];
}

export async function readSnapshots(showIds: string[]): Promise<Map<string, ShowSnapshot>> {
  if (showIds.length === 0) return new Map();

  const { data, error } = await readTable("show_snapshots")
    .select("show_id, last_episode_key, latest_season, seasons_count")
    .in("show_id", showIds);
  if (error) throw error;

  return new Map(
    (data ?? []).map((row) => [
      row.show_id as string,
      {
        showId: row.show_id as string,
        lastEpisodeKey: row.last_episode_key as string | null,
        latestSeason: row.latest_season as number | null,
        seasonsCount: row.seasons_count as number | null,
      },
    ]),
  );
}

export async function writeSnapshot(snapshot: ShowSnapshot): Promise<void> {
  const { error } = await writeTable("show_snapshots").upsert(
    {
      show_id: snapshot.showId,
      last_episode_key: snapshot.lastEpisodeKey,
      latest_season: snapshot.latestSeason,
      seasons_count: snapshot.seasonsCount,
      checked_at: new Date().toISOString(),
    },
    { onConflict: "show_id" },
  );
  if (error) throw error;
}

export interface Follower {
  userId: string;
  followedAt: Date;
}

/** Who follows this show, and since when. `followedAt` is what enforces
 *  design doc §2.1 rule 2: an event detected before you opted in is not
 *  yours. */
export async function listFollowers(showId: string): Promise<Follower[]> {
  const { data, error } = await readTable("show_follows")
    .select("user_id, followed_at")
    .eq("show_id", showId);
  if (error) throw error;

  return (data ?? []).map((row) => ({
    userId: row.user_id as string,
    followedAt: new Date(row.followed_at as string),
  }));
}

/**
 * Which of these users have ALREADY watched this episode.
 *
 * ============================================================================
 * SUPPRESSION ONLY. THIS RESULT MAY NEVER CAUSE A NOTIFICATION.
 * ============================================================================
 * The caller subtracts this set from the followers who would otherwise be
 * notified. It must never be used the other way around — "notify the users who
 * have NOT watched it" is a behaviour ping wearing this function's clothes,
 * and is precisely what design doc §1.1 forbids.
 *
 * The mechanical test, if this is ever refactored: deleting this function
 * entirely must still leave every notification being sent. It removes
 * recipients; it never adds one.
 *
 * Reads `watched_episodes`, which `writeTable` cannot reach by construction.
 */
export async function listUsersWhoWatched(
  showId: string,
  seasonNumber: number,
  episodeNumber: number,
  candidateUserIds: string[],
): Promise<Set<string>> {
  if (candidateUserIds.length === 0) return new Set();

  const { data, error } = await readTable("watched_episodes")
    .select("user_id")
    .eq("title_id", showId)
    .eq("season_number", seasonNumber)
    .eq("episode_number", episodeNumber)
    // `watched_episodes` is TOMBSTONED, not hard-deleted — un-marking an
    // episode sets `deleted_at` rather than removing the row (it is a
    // LWW-Element-Set, see the migration). Omitting this filter would treat a
    // deliberately UN-marked episode as watched and silently suppress a
    // notification the user should have received, which is the quiet kind of
    // wrong: nothing fails, the push simply never arrives.
    .is("deleted_at", null)
    .in("user_id", candidateUserIds);
  if (error) throw error;

  return new Set((data ?? []).map((row) => row.user_id as string));
}

export interface PendingRow {
  id: string;
  userId: string;
  showId: string;
  kind: NotificationEventKind;
  eventKey: string;
  payload: NotificationPayload;
}

/**
 * Queues events for delivery.
 *
 * `ignoreDuplicates` rather than an upsert: the unique constraint on
 * (user, show, event_key) is the idempotency mechanism, and a repeated
 * detection must be a silent no-op rather than overwriting a row that may
 * already be mid-delivery.
 */
export async function enqueue(
  event: DetectedEvent,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;

  const { error } = await writeTable("pending_notifications").upsert(
    userIds.map((userId) => ({
      user_id: userId,
      show_id: event.showId,
      event_kind: event.kind,
      event_key: event.eventKey,
      payload: event.payload,
    })),
    { onConflict: "user_id,show_id,event_key", ignoreDuplicates: true },
  );
  if (error) throw error;
}

export async function listPending(limit: number): Promise<PendingRow[]> {
  const { data, error } = await readTable("pending_notifications")
    .select("id, user_id, show_id, event_kind, event_key, payload")
    .order("detected_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id as string,
    userId: row.user_id as string,
    showId: row.show_id as string,
    kind: row.event_kind as NotificationEventKind,
    eventKey: row.event_key as string,
    payload: row.payload as NotificationPayload,
  }));
}

export interface DeliveryPrefs {
  quietStart: number;
  quietEnd: number;
  timeZone: string;
  episodeAired: boolean;
  seasonAnnounced: boolean;
}

export async function readPrefs(userIds: string[]): Promise<Map<string, DeliveryPrefs>> {
  if (userIds.length === 0) return new Map();

  const { data, error } = await readTable("notification_prefs")
    .select("user_id, quiet_start, quiet_end, timezone, episode_aired, season_announced")
    .in("user_id", userIds);
  if (error) throw error;

  return new Map(
    (data ?? []).map((row) => [
      row.user_id as string,
      {
        quietStart: row.quiet_start as number,
        quietEnd: row.quiet_end as number,
        timeZone: row.timezone as string,
        episodeAired: row.episode_aired as boolean,
        seasonAnnounced: row.season_announced as boolean,
      },
    ]),
  );
}

export interface DeviceSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function readSubscriptions(
  userIds: string[],
): Promise<Map<string, DeviceSubscription[]>> {
  if (userIds.length === 0) return new Map();

  const { data, error } = await readTable("push_subscriptions")
    .select("user_id, endpoint, p256dh, auth")
    .in("user_id", userIds);
  if (error) throw error;

  const byUser = new Map<string, DeviceSubscription[]>();
  for (const row of data ?? []) {
    const list = byUser.get(row.user_id as string) ?? [];
    list.push({
      endpoint: row.endpoint as string,
      p256dh: row.p256dh as string,
      auth: row.auth as string,
    });
    byUser.set(row.user_id as string, list);
  }
  return byUser;
}

/**
 * Marks a pending row delivered: writes the permanent ledger, then removes
 * the queue row.
 *
 * In that ORDER, deliberately. If the log write succeeds and the delete fails,
 * the next run finds the pending row again, tries to log it, and the unique
 * constraint rejects it — so the row is dropped without a second push. The
 * reverse order would delete the queue row and then, on a failed log write,
 * leave no record at all, which re-opens the door to sending the same
 * notification again later.
 */
export async function recordSent(pending: PendingRow): Promise<void> {
  const { error: logError } = await writeTable("notification_log").upsert(
    {
      user_id: pending.userId,
      show_id: pending.showId,
      event_kind: pending.kind,
      event_key: pending.eventKey,
    },
    { onConflict: "user_id,show_id,event_key", ignoreDuplicates: true },
  );
  if (logError) throw logError;

  const { error: deleteError } = await writeTable("pending_notifications")
    .delete()
    .eq("id", pending.id);
  if (deleteError) throw deleteError;
}

/** Drops a queue row without logging a send — used when there is nothing to
 *  deliver to (no devices) or the user has that event kind switched off. */
export async function discardPending(id: string): Promise<void> {
  const { error } = await writeTable("pending_notifications").delete().eq("id", id);
  if (error) throw error;
}

/**
 * Removes a dead push endpoint.
 *
 * A push service returns 410 Gone (or 404) once a subscription is permanently
 * invalid — the browser was uninstalled, the user cleared site data, the
 * endpoint rotated. Without pruning, the table fills with endpoints that fail
 * on every run forever.
 */
export async function pruneSubscription(endpoint: string): Promise<void> {
  const { error } = await writeTable("push_subscriptions").delete().eq("endpoint", endpoint);
  if (error) throw error;
}
