"use server";

import { headers } from "next/headers";

import { RATE_LIMITS, checkRateLimit } from "@/lib/ratelimit";
import { isSupabaseConfigured } from "@/lib/supabase/public-env";
import { createSupabaseServerClient } from "@/lib/supabase/server-client";

import { isMinuteOfDay } from "./quiet-hours";
import type { NotificationPrefs } from "./types";

/**
 * Server Actions — the client seam for notifications. Same shape as
 * `lib/comments/actions.ts` and `lib/lists/actions.ts`: plain async functions
 * returning a discriminated result, called from client event handlers.
 *
 * ============================================================================
 * EVERY INSERT BELOW SETS ITS OWN user_id EXPLICITLY
 * ============================================================================
 * Phase 6 Step 6a lost real time to this: `postCommentAction` and
 * `reportCommentAction` both omitted their owner-id column, and it did NOT
 * surface as a missing-field error. `user_id = (select auth.uid())` in the
 * INSERT policy's WITH CHECK compares NULL against a UUID, which is never
 * TRUE, so Postgres rejected the row as an ordinary-looking 42501 "row-level
 * security policy" violation — reading exactly like a gating bug and sending
 * debugging in entirely the wrong direction.
 *
 * So: every insert here names `user_id`, and none of them relies on a default
 * or a trigger to supply it.
 *
 * ============================================================================
 * NOTHING HERE READS OR WRITES WATCH STATE
 * ============================================================================
 * Following a show is an explicit, standalone opt-in. It is deliberately NOT
 * derived from tracking status — "all shows is noise, and noise gets
 * notifications disabled entirely" — and marking something watched must never
 * change what you are subscribed to.
 */

export type NotificationActionResult =
  | { ok: true }
  | { ok: false; message: string };

const UNAVAILABLE: NotificationActionResult = {
  ok: false,
  message: "Notifications aren't available right now.",
};

const SIGNED_OUT: NotificationActionResult = {
  ok: false,
  message: "Sign in to manage notifications.",
};

const RATE_LIMITED: NotificationActionResult = {
  ok: false,
  message: "That's a lot of changes at once — try again in a moment.",
};

/**
 * Logged server-side only, never returned. Mirrors `lib/comments/actions.ts`'s
 * `failure()`: these are outcomes the UI should not be able to provoke through
 * normal use, unlike a rate limit, so a log line is the only trail worth
 * having when one appears.
 */
function unexpected(operation: string, error: unknown): NotificationActionResult {
  console.error(`[marquee] notifications.${operation} failed`, error);
  return { ok: false, message: "Couldn't save that. Try again." };
}

async function guard(
  rule: (typeof RATE_LIMITS)[keyof typeof RATE_LIMITS],
): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>; userId: string }
  | { ok: false; result: NotificationActionResult }
> {
  if (!isSupabaseConfigured()) return { ok: false, result: UNAVAILABLE };

  // Same synthetic-Request wrapper `lib/lists/actions.ts` uses: a Server
  // Action has no Request object, but `checkRateLimit` reads only headers, and
  // handing it the real ones preserves the right-to-left `x-forwarded-for`
  // parsing that is the limiter's actual security property.
  const requestHeaders = await headers();
  const decision = await checkRateLimit(
    new Request("http://server-action.local", { headers: requestHeaders }),
    rule,
  );
  if (!decision.allowed) return { ok: false, result: RATE_LIMITED };

  const supabase = await createSupabaseServerClient();
  // getUser(), never getSession(): the latter returns whatever the cookie
  // decodes to WITHOUT verifying the signature, which server-side is a
  // user-supplied claim rather than a fact.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { ok: false, result: SIGNED_OUT };

  return { ok: true, supabase, userId: data.user.id };
}

/* ---------------------------------------------------------------------------
 * Push subscriptions
 * ------------------------------------------------------------------------ */

export async function savePushSubscriptionAction(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string;
}): Promise<NotificationActionResult> {
  const context = await guard(RATE_LIMITS.notifications);
  if (!context.ok) return context.result;

  if (!input.endpoint || !input.p256dh || !input.auth) {
    return { ok: false, message: "That subscription looks incomplete." };
  }

  try {
    const { error } = await context.supabase.from("push_subscriptions").upsert(
      {
        user_id: context.userId,
        endpoint: input.endpoint,
        p256dh: input.p256dh,
        auth: input.auth,
        // Truncated hard: this is only ever shown back to the user so they can
        // tell two devices apart, and a full UA string is a fingerprint we
        // have no reason to retain in full.
        user_agent: input.userAgent?.slice(0, 120) ?? null,
      },
      // The browser may re-issue the SAME endpoint after a permission cycle.
      // Upserting on it keeps one row per device instead of accumulating dead
      // duplicates that the sender would then push to and prune.
      { onConflict: "endpoint" },
    );
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return unexpected("savePushSubscription", error);
  }
}

export async function deletePushSubscriptionAction(
  endpoint: string,
): Promise<NotificationActionResult> {
  const context = await guard(RATE_LIMITS.notifications);
  if (!context.ok) return context.result;

  try {
    // Scoped by user_id as well as endpoint. RLS already enforces it, but a
    // delete that relies solely on a policy reads as though the endpoint alone
    // were authorization — and the endpoint is a value the client supplies.
    const { error } = await context.supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", context.userId)
      .eq("endpoint", endpoint);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return unexpected("deletePushSubscription", error);
  }
}

/* ---------------------------------------------------------------------------
 * Per-show follows
 * ------------------------------------------------------------------------ */

export async function followShowAction(showId: string): Promise<NotificationActionResult> {
  const context = await guard(RATE_LIMITS.notificationFollows);
  if (!context.ok) return context.result;

  if (!showId || showId.length > 64) {
    return { ok: false, message: "That show can't be followed." };
  }

  try {
    const { error } = await context.supabase.from("show_follows").upsert(
      { user_id: context.userId, show_id: showId },
      // ignoreDuplicates so re-following an already-followed show is a no-op
      // rather than resetting followed_at. The DB trigger refuses backwards
      // moves anyway; this avoids the pointless write entirely.
      { onConflict: "user_id,show_id", ignoreDuplicates: true },
    );
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return unexpected("followShow", error);
  }
}

export async function unfollowShowAction(showId: string): Promise<NotificationActionResult> {
  const context = await guard(RATE_LIMITS.notificationFollows);
  if (!context.ok) return context.result;

  try {
    const { error } = await context.supabase
      .from("show_follows")
      .delete()
      .eq("user_id", context.userId)
      .eq("show_id", showId);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return unexpected("unfollowShow", error);
  }
}

/* ---------------------------------------------------------------------------
 * Preferences
 * ------------------------------------------------------------------------ */

export async function savePrefsAction(
  prefs: NotificationPrefs,
): Promise<NotificationActionResult> {
  const context = await guard(RATE_LIMITS.notifications);
  if (!context.ok) return context.result;

  if (!isMinuteOfDay(prefs.quietStart) || !isMinuteOfDay(prefs.quietEnd)) {
    return { ok: false, message: "Those quiet hours don't look right." };
  }
  if (!prefs.timeZone || prefs.timeZone.length > 64) {
    return { ok: false, message: "That timezone isn't valid." };
  }

  try {
    const { error } = await context.supabase.from("notification_prefs").upsert(
      {
        user_id: context.userId,
        quiet_start: prefs.quietStart,
        quiet_end: prefs.quietEnd,
        timezone: prefs.timeZone,
        episode_aired: prefs.episodeAired,
        season_announced: prefs.seasonAnnounced,
      },
      { onConflict: "user_id" },
    );
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return unexpected("savePrefs", error);
  }
}

/**
 * Writes ONLY the timezone, called on mount whenever the browser's zone
 * differs from what is stored.
 *
 * Separate from `savePrefsAction` on purpose: this fires without the user
 * doing anything, and reusing the full save would mean a background action
 * silently rewriting quiet hours from whatever stale values the client
 * happened to be holding.
 */
export async function syncTimeZoneAction(timeZone: string): Promise<NotificationActionResult> {
  const context = await guard(RATE_LIMITS.notifications);
  if (!context.ok) return context.result;

  if (!timeZone || timeZone.length > 64) return { ok: false, message: "Invalid timezone." };

  try {
    const { error } = await context.supabase
      .from("notification_prefs")
      .update({ timezone: timeZone })
      .eq("user_id", context.userId);
    if (error) throw error;
    return { ok: true };
  } catch (error) {
    return unexpected("syncTimeZone", error);
  }
}
