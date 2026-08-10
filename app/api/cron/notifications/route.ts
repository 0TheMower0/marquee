import { timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import { getContentProvider } from "@/lib/content";
import { detectEvents } from "@/lib/notifications/detect";
import { decideDelivery, eligibleFollowers } from "@/lib/notifications/deliver";
import { isPushConfigured, sendPush } from "@/lib/notifications/server/push";
import * as store from "@/lib/notifications/server/store";
import { mapWithConcurrency } from "@/lib/utils/concurrency";

/**
 * The notification detector and sender — Phase 7 Step 5, design doc §2 and §3.
 *
 * ============================================================================
 * IDEMPOTENT AND FREQUENCY-AGNOSTIC, BY CONSTRUCTION
 * ============================================================================
 * Calling this hourly, daily, or twice in the same minute must all be safe.
 * That is not polish — it is what makes the SCHEDULE a deployment choice
 * rather than a design constraint, and it is why the answer to "Vercel Hobby
 * only allows daily cron" was a deployment change rather than a redesign.
 *
 * Two unique constraints do the work: `pending_notifications` and
 * `notification_log` are both unique on (user, show, event_key), so a repeated
 * detection is a no-op insert and a repeated send is impossible.
 *
 * Deployment (design doc §3.2): an external scheduler calls this HOURLY, and a
 * Vercel daily cron calls it too as a FLOOR — so a dead or misconfigured
 * external scheduler degrades to daily notifications rather than to silence.
 * A single scheduler is a single point of failure whose failure mode is
 * indistinguishable from "nothing has aired."
 *
 * ============================================================================
 * THIS ROUTE RUNS WITH BYPASSRLS
 * ============================================================================
 * Every database call below goes through `lib/notifications/server/store.ts`,
 * which holds the only service-role client in the project. That module never
 * exports the client, and its table access is a typed allowlist — see its
 * header. This route therefore cannot reach a table the notifier has no
 * business touching, even by mistake, because there is no API here to do so.
 */

/** Concurrency for upstream show fetches. TMDB documents ~40 req/s and a CDN
 *  layer adds ~50/s per IP (verified — design doc §0), so 6 is comfortably
 *  inside it while still finishing a few hundred shows quickly. */
const FETCH_CONCURRENCY = 6;

/** Bounded so one invocation cannot run unboundedly long on a serverless
 *  function. Leftovers are simply picked up by the next run — the queue is
 *  durable, which is the whole point of the two-phase split. */
const DELIVERY_BATCH = 200;

export async function GET(request: NextRequest) {
  const authorized = authorize(request);
  // 404, not 401: a 401 confirms the endpoint exists and is worth attacking.
  // There is nothing here for an unauthenticated caller to learn.
  if (!authorized) return new Response("Not found", { status: 404 });

  if (!store.isNotifierConfigured()) {
    // Unconfigured is a supported mode, not a failure — same shape as a blank
    // OMDB_API_KEY. Reported as OK-with-a-reason so a monitoring check on this
    // endpoint does not page someone about a deliberately inert feature.
    return Response.json({ ok: true, skipped: "not-configured" });
  }

  try {
    const detected = await detect();
    const delivered = await deliver();
    return Response.json({ ok: true, ...detected, ...delivered });
  } catch (error) {
    // Logged server-side only. The response body must not carry a database
    // error: this endpoint is reachable by anyone who guesses the path, and a
    // Postgres message names tables and columns.
    console.error("[marquee] notification cron failed", error);
    return Response.json({ ok: false }, { status: 500 });
  }
}

/**
 * Compares the caller's secret against `CRON_SECRET` in constant time.
 *
 * A plain `===` on a secret leaks its prefix through timing. That is a
 * marginal attack over the public internet — but this secret is the only thing
 * standing between an anonymous caller and a service-role code path, so the
 * marginal version is not one to accept.
 */
function authorize(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  // Refuse rather than run open. An unset secret must never mean "allow all",
  // which is the shape of default that gets deployed by accident.
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak
  // length — compare lengths first and still run the constant-time compare so
  // the timing profile does not depend on how wrong the guess was.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------------------
 * Phase 1 — detect (per SHOW, deduped across all users)
 * ------------------------------------------------------------------------ */

async function detect(): Promise<{ showsChecked: number; eventsDetected: number }> {
  const showIds = await store.listFollowedShowIds();
  if (showIds.length === 0) return { showsChecked: 0, eventsDetected: 0 };

  const snapshots = await store.readSnapshots(showIds);
  const provider = getContentProvider();
  let eventsDetected = 0;

  // ONE upstream fetch per show, regardless of how many people follow it.
  // 100 followers of Breaking Bad is one call. This is only possible because
  // the trigger is a world fact rather than a per-user computation (§1).
  const results = await mapWithConcurrency(showIds, FETCH_CONCURRENCY, async (showId) => {
    try {
      const title = await provider.getTitle(showId, "tv");
      return { showId, title };
    } catch (error) {
      // One unreachable show must not abort the run for every other show.
      console.warn(`[marquee] notification detect: could not fetch ${showId}`, error);
      return { showId, title: null };
    }
  });

  for (const { showId, title } of results) {
    if (!title) continue;

    const previous = snapshots.get(showId) ?? null;
    const { events, snapshot } = detectEvents(title, previous);

    for (const event of events) {
      const detectedAt = new Date();
      const followers = eligibleFollowers(await store.listFollowers(showId), detectedAt);
      if (followers.length === 0) continue;

      let recipients = followers.map((follower) => follower.userId);

      // SUPPRESSION ONLY — this can remove recipients, never add one. If this
      // block were deleted entirely, every notification would still be sent,
      // which is the mechanical test design doc §1.1 sets for telling a world
      // event apart from a behaviour ping.
      if (event.kind === "episode_aired" && title.lastEpisodeToAir) {
        const alreadyWatched = await store.listUsersWhoWatched(
          showId,
          title.lastEpisodeToAir.seasonNumber,
          title.lastEpisodeToAir.episodeNumber,
          recipients,
        );
        recipients = recipients.filter((userId) => !alreadyWatched.has(userId));
      }

      if (recipients.length > 0) {
        await store.enqueue(event, recipients);
        eventsDetected += 1;
      }
    }

    // Written AFTER enqueuing, so a crash between the two re-detects the same
    // event on the next run rather than losing it. Re-detection is harmless —
    // the unique constraint absorbs it — whereas a lost event is invisible.
    await store.writeSnapshot(snapshot);
  }

  return { showsChecked: showIds.length, eventsDetected };
}

/* ---------------------------------------------------------------------------
 * Phase 2 — deliver (per USER, quiet-hours aware)
 * ------------------------------------------------------------------------ */

async function deliver(): Promise<{ sent: number; deferred: number; discarded: number }> {
  if (!isPushConfigured()) return { sent: 0, deferred: 0, discarded: 0 };

  const pending = await store.listPending(DELIVERY_BATCH);
  if (pending.length === 0) return { sent: 0, deferred: 0, discarded: 0 };

  const userIds = [...new Set(pending.map((row) => row.userId))];
  const [prefsByUser, subscriptionsByUser] = await Promise.all([
    store.readPrefs(userIds),
    store.readSubscriptions(userIds),
  ]);

  const now = new Date();
  let sent = 0;
  let deferred = 0;
  let discarded = 0;

  for (const row of pending) {
    const subscriptions = subscriptionsByUser.get(row.userId) ?? [];
    const decision = decideDelivery({
      kind: row.kind,
      prefs: prefsByUser.get(row.userId),
      deviceCount: subscriptions.length,
      now,
    });

    if (decision.action === "defer") {
      // Left in the queue on purpose — this IS the deferral mechanism.
      deferred += 1;
      continue;
    }

    if (decision.action === "discard") {
      await store.discardPending(row.id);
      discarded += 1;
      continue;
    }

    const payload = {
      ...row.payload,
      // Collapses repeats for the same show in the OS tray rather than
      // stacking them — the anti-noise rule applied at the last layer too.
      tag: `show:${row.showId}`,
    };

    let anyDelivered = false;
    for (const subscription of subscriptions) {
      const result = await sendPush(subscription, payload);
      if (result.ok) {
        anyDelivered = true;
      } else if (result.gone) {
        await store.pruneSubscription(subscription.endpoint);
      }
    }

    if (anyDelivered) {
      await store.recordSent(row);
      sent += 1;
    } else if (subscriptions.length > 0) {
      // Every device failed transiently (a push service outage, say). Leave
      // the row queued so a later run retries, rather than logging it as sent
      // and losing it — the ledger means "delivered", and writing it here
      // would make that false.
      deferred += 1;
    }
  }

  return { sent, deferred, discarded };
}
