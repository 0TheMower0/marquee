# Phase 7 Step 5 — New-episode push notifications: design

Status: **approved 2026-08-10, not built.** Nothing in this document exists in
the codebase yet.

Unblocked by Phase 5 Step 6 (PWA manifest + service worker), which shipped the
service worker this step needs to receive a push while the app is closed. Read
`docs/phase-5-pwa-design.md` first — this step adds a `push` handler to the
worker that file already owns, and the caching rules there are not affected by
anything here.

Also read, in CLAUDE.md: "Watch DATES are a separate store" (the frozen-local-
date discipline §5 inverts), "Accounts" (why this is account-gated), and the
`SUPABASE_SERVICE_ROLE_KEY` note in Phase 6 Step 3 — which currently says *no
code path needs it*, and which this step is the first to make false.

---

## 0. What was verified, and what was not

### Verified against official sources, 2026-08-10

| Claim | Source |
|---|---|
| **Vercel Hobby cron: once per day, ±59 min precision.** More frequent expressions *fail at deploy time*. | [Vercel cron usage & pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing) |
| Pro is once-per-minute with per-minute precision. | same |
| **TMDB: ~40 req/s**, "could change without notice". Legacy 40-per-10s limit disabled Dec 2019. No documented daily cap. | [TMDB rate limiting](https://developer.themoviedb.org/docs/rate-limiting) |
| A CDN layer adds ~50 req/s and 20 connections per IP. | TMDB support forum, corroborating the above |
| `web-push` is not currently a dependency; `SUPABASE_SERVICE_ROLE_KEY` is read only by `lib/supabase/server-env.ts` and used by nothing. | `package.json`, `grep` |

### NOT verified — asserted, flagged as such

- **iOS 16.4+ and home-screen install as the Web Push floor.** Consistent with
  the Next.js PWA guide and with `docs/phase-5-pwa-design.md` §5, but not
  re-confirmed against current WebKit here. The UI must *detect* capability at
  runtime rather than version-sniff, so being wrong about the exact floor
  costs nothing — but do not put "16.4" in user-facing copy without checking.
- Push endpoint expiry semantics (`410 Gone` / `404`) are standard across
  FCM/APNs/Mozilla but not individually re-verified.

---

## 1. THE REFRAME — read this before changing anything below

The brief's rule was **"notify about the world changing, never about the
user's behaviour."** That is not only an ethical constraint. It is the single
decision that makes this feature architecturally tractable, and every
simplification downstream depends on it.

> **"You haven't watched S6E1" requires the server to know your watch
> progress. "S6E1 aired" does not.**

The trigger is therefore a **per-show world fact**, not a per-user
computation. The server needs to know only *which shows you follow* — never
what you have seen, never when you last opened the app, never how far behind
you are. Whole categories of state, sync-freshness dependency, and
manipulation-by-accident disappear.

### 1.1 Watch state may only ever SUPPRESS. Never trigger.

⚠️ **This is the rule most likely to be "improved" into the exact thing the
brief forbids. It must not be.**

Suppression is legitimate and worth having: if synced `watched_episodes`
already shows you watched S6E1, sending "S6E1 aired!" is redundant noise, and
skipping it is respectful. So watch state is consulted — but **only ever to
remove a notification that the world already justified, never to create one.**

The asymmetry is the whole point:

| | allowed? | |
|---|---|---|
| "S6E1 aired" → send | ✅ | a world fact |
| "S6E1 aired, and you have already watched it" → skip | ✅ | suppression |
| "You have not watched S6E1 yet" → send | ❌ | **behaviour** |
| "You have not opened Marquee in 3 days" → send | ❌ | **behaviour** |
| "You are 4 episodes behind" → send | ❌ | **behaviour** |

The tell is mechanical, and it is worth stating as a test anyone can apply
without re-deriving the ethics: **if removing all watch data from the system
would remove the notification, it was a behaviour ping.** A world event
survives that deletion; a nag does not.

A consequence to accept rather than route around: because suppression depends
on sync, a device that has not synced recently may produce a redundant
notification. That is the correct failure direction. The alternative — making
delivery *wait* on watch state — would make watch data load-bearing for
whether a notification exists at all, which is precisely the dependency this
section exists to prevent.

---

## 2. What decides a notification is due

Two phases, deliberately separated. Same shape as `lib/sync`'s outbox: decide
and enqueue in one place, drain and perform I/O in another.

### 2.1 Phase 1 — Detect (per SHOW, deduped across all users)

Input: the distinct set of show ids that **at least one** user follows.

**One TMDB fetch per show, regardless of follower count.** 100 users following
Breaking Bad is one call, not 100. This is the property that keeps upstream
cost proportional to the catalogue rather than to the user base, and it is
only possible *because* of §1 — a per-user trigger could not be deduped.

Each show's fetched state is diffed against a stored `show_snapshots` row:

| Event | Signal |
|---|---|
| `episode_aired` | `last_episode_to_air` differs from the snapshot, **and** its air date is not in the future |
| `season_announced` | `number_of_seasons` increased, **or** a season appears whose air date is in the future |

Three rules govern what that diff is allowed to emit:

1. **No baseline, no events.** The first time a show is ever snapshotted, the
   snapshot is written and *nothing is emitted*. There is no "what did I
   miss" backfill. Identical discipline to the watch log's no-backfill rule
   (Phase 5 Step 1) and the badge ledger's silent first evaluation (Phase 5
   Step 4) — both of which exist because a feature's first run must not
   produce a burst of history.
2. **`followed_at` gates every event.** A user is notified only about events
   detected *after* they opted in for that show. Turning notifications on for
   a show that aired an episode yesterday must be silent.
3. **Collapse per show per run.** A full-season drop emits **one** event
   ("8 new episodes of Severance"), never eight. This is the single most
   important anti-noise rule in the design, and it lives in *detection* — not
   in the UI, and not in the sender — because that is the only layer that can
   see all of a show's changes at once.

Detection writes `pending_notifications` rows for eligible followers, then
updates the snapshot.

### 2.2 Phase 2 — Deliver (per USER, quiet-hours aware)

Drains `pending_notifications` for users **not currently inside their quiet
hours**, sends the push, then writes `notification_log`.

**The ledger is written on SEND, not on detection.** That one choice is what
makes quiet hours free: a notification that is due but currently silenced
simply stays pending and is picked up by a later run once the window opens. No
scheduler, no retry queue, no extra state — deferral falls out of the
two-phase split rather than being built.

Dedup is a unique constraint on `(user_id, show_id, event_key)`, so a retried
or overlapping run cannot double-send. Same reasoning as the deterministic
watch-event UUIDs in Phase 6 Step 5: idempotency belongs in a key, not in
careful sequencing.

---

## 3. Where it runs — and the scheduling decision

`app/api/cron/notifications/route.ts`, gated on a `CRON_SECRET` header.

**The route is idempotent and frequency-agnostic by construction.** Calling it
hourly, daily, or twice within a minute must all be safe. That is not
incidental polish: it is what makes the schedule a *deployment* choice rather
than a design constraint, and it is why the decision below could be made
without touching anything else in this document.

### 3.1 Why not Vercel cron alone — the interaction that forced this

Vercel Hobby is **once per day, ±59 min** (§0). The delay alone would be
acceptable. The interaction is not:

The single daily run lands at roughly the same UTC hour every day. For any
user whose quiet-hours window contains that hour, **every** run is deferred,
**every** day — they receive **nothing, ever**, with no error, no failed send,
and nothing in the UI to indicate it. A run at 03:00 UTC is 06:00 in UTC+3;
against a common 22:00–08:00 quiet window that user is permanently silenced.

That is categorically worse than a documented delay, and no amount of
quiet-hours cleverness fixes it — a "force send after N hours" escape hatch
just breaks the quiet-hours promise instead. **Quiet hours are only meaningful
if the job runs more often than the window is long.**

### 3.2 The decision: external hourly, with a Vercel daily floor

- **Primary: an external scheduler hitting the route hourly** with the
  `CRON_SECRET` (cron-job.org, GitHub Actions, or equivalent). Free, and needs
  no design change.
- **Floor: a Vercel daily cron on the same route.** So a dead, misconfigured,
  or silently-disabled external scheduler degrades to *daily notifications*
  rather than to *silence*. A single scheduler is a single point of failure
  whose failure mode is indistinguishable from "nothing has aired."

Both hit the same idempotent endpoint; overlapping invocations are safe by
§2.2's unique constraint.

**As built.** `vercel.json` declares the daily floor at `17 3 * * *` — a
non-round minute out of habit rather than necessity, since Hobby fires
anywhere within the hour regardless (§0). `vercel.json` is strict JSON and
cannot carry comments, which is why that reasoning lives here.

Authentication is the same for both callers: **Vercel automatically sends
`Authorization: Bearer $CRON_SECRET`** when that environment variable is set,
which is exactly the header `authorize()` in the route expects, so the
external scheduler is configured identically and no second code path exists.

An unset `CRON_SECRET` makes the route refuse every request rather than run
open — an unset secret must never mean "allow all", which is the shape of
default that gets deployed by accident. The route answers **404** rather than
401 on a bad secret: a 401 confirms the endpoint exists and is worth
attacking, and there is nothing here an unauthenticated caller should learn.

### 3.3 One approach explicitly ruled out

**Piggybacking detection on organic app traffic** (any page load pings a
globally-debounced trigger) is free and needs no external service — and is
self-defeating here. Notifications matter precisely when the user is *not* in
the app, and for a personal tracker "someone opened the app" mostly means "the
one user opened the app." It would deliver notifications only to someone
already looking at the screen. Not built; recorded so it is not rediscovered
as a clever idea later.

---

## 4. ⚠️ The service_role escalation — the biggest risk in this step

**This is the first code path in the project to use
`SUPABASE_SERVICE_ROLE_KEY`.** CLAUDE.md currently states that no code path
needs it. That sentence stops being true here and must be updated (§11).

It is unavoidable, and the reason is structural rather than convenience: the
cron must read **every** user's follow rows and write to **every** user's
pending/log rows. RLS own-rows policies exist specifically to forbid that, and
`auth.uid()` is `NULL` in a cron context — there is no user to act as.

**The blast radius is total.** That key carries `BYPASSRLS`: every policy in
the schema is simply not applied to it. Leaking it is silent, complete access
to every user's library, ratings, private notes, watch history, and comments —
strictly worse than leaking the TMDB or OMDb key, which cost a quota and a
rotation.

Containment, all four of which are load-bearing:

1. **Exactly one file may import `lib/supabase/server-env`** — the cron
   route's own data module. Enforced by a guard test (§11), not by convention.
2. **The route refuses to run without a valid `CRON_SECRET`**, compared with a
   timing-safe equality check, and returns 404 (not 401) on failure so the
   endpoint's existence is not confirmed to a prober.
3. **The service-role client never leaves that module**, and never handles a
   request-derived value that could steer a query at another user's rows.
4. **`server-env.ts` stays `server-only` with a lazy read**, as verified by
   sentinel grep in Phase 6 Step 3 — that property must be re-verified after
   this step, since it is now actually reachable.

An alternative considered and rejected: a `security definer` RPC scoped to
exactly the cron's needs (the `username_available` / `comment_like_counts`
pattern). It does not help — the cron still has to authenticate as *something*
to call it, and if that something is the anon key then any client can call it
too. The narrow-privilege win is illusory here.

---

## 5. Timezone: the freeze runs the OTHER WAY here

The brief said to use the frozen-local-date discipline from Phase 5 rather
than UTC. Applying it precisely, because this is a case where the surface rule
and its underlying reason point in **opposite directions** — and getting that
backwards produces exactly the bug `localDayKey` exists to prevent.

| | frozen? | why |
|---|---|---|
| **Air dates** | **YES** — calendar date, string-compared, never converted to an instant | a world fact about a broadcast, exactly `isFutureAirDate`'s existing rule (`lib/utils/dates.ts`) |
| **Quiet hours** | **NO** — live IANA zone, refreshed client-side | "do not wake me at 3am" is about where the user *is now* |

`lib/watchlog` freezes the day key because it records **history**: the day you
watched something is a fact about where you *were*, and re-deriving it after
you travel rewrites your streaks. Quiet hours are a **live preference** about
where you *are*. Freezing a zone captured at subscribe time would mean someone
who moves from Istanbul to Tokyo keeps being woken by their old offset — the
same class of bug, arriving through the opposite door.

So: store the **IANA zone name** (`Europe/Istanbul`), never a fixed offset
(`+03:00`), because offsets break across DST. Refresh it client-side whenever
`Intl.DateTimeFormat().resolvedOptions().timeZone` differs from what is
stored. Convert server-side at send time.

The shared discipline both cases obey is the one worth remembering: **never
derive a user's local time by assuming the server's zone.** The direction of
the freeze differs; that rule does not.

---

## 6. Account required — and why that is not a broken promise

Push needs a server-side row to exist *before* the device is asleep. There is
no local-first version of "wake this phone up." This is the one feature in the
app that structurally cannot work anonymously.

CLAUDE.md's **"signing in is an upgrade, never a gate"** is about the core
tracking experience, and this does not touch it: every existing feature keeps
working signed out. There is also direct precedent — **comments** (Phase 6
Step 6a) and **shared lists** (Phase 6 Step 6b) both require an account, for
the same reason: they are inherently server-dependent. Notifications are the
third, and the least surprising of the three.

Stated in the UI at the point of decision, not discovered at a dead toggle.

Bonus, and a real one: per-show follows are ordinary synced user data, so
following 12 shows on a phone means the same on a laptop for free.

---

## 7. Schema

Six tables. RLS on all of them, per the Phase 6 Step 3 rule that a `public`
table without RLS is world-readable through PostgREST.

**User-owned (own-rows RLS, exactly like every other table in this schema):**

- `push_subscriptions(id, user_id, endpoint UNIQUE, p256dh, auth, user_agent, created_at, updated_at)`
- `show_follows(user_id, show_id, followed_at, updated_at)` — PK `(user_id, show_id)`. `followed_at` is §2.1's gate.
- `notification_prefs(user_id PK, quiet_start, quiet_end, timezone, episode_aired bool, season_announced bool, updated_at)`

**World / server-owned (no user scoping; service-role only, `USING (false)`
for every API role so PostgREST exposes nothing):**

- `show_snapshots(show_id PK, last_episode_key, latest_season, seasons_count, checked_at)`

**Server-written, user-readable:**

- `pending_notifications(id, user_id, show_id, event_kind, event_key, payload jsonb, detected_at)` — UNIQUE `(user_id, show_id, event_key)`
- `notification_log(id, user_id, show_id, event_kind, event_key, sent_at)` — UNIQUE `(user_id, show_id, event_key)`

⚠️ **CORRECTION, made while building step 3.** This section originally said
`show_follows` and `notification_prefs` would join `SYNC_TABLES` "so
preferences sync like everything else". **They do not, and should not.**

`lib/sync` exists to reconcile a LOCAL-FIRST replica with the server —
tracking, ratings and the watch log are all fully usable offline and converge
later. Notification follows have no offline story at all: the only thing that
acts on them is a server-side cron, so a local replica could never be
authoritative and could never be acted upon while disconnected. Adding them
would mean an outbox entry, a reconcile rule and a local mirror for data whose
sole consumer runs on the server.

They are the same class as **comments** (Phase 6 Step 6a) and **lists** (6b):
account-gated and server-authoritative, deliberately outside `SYNC_TABLES`.
Cross-device consistency is not weakened by this — it is *stronger*, since a
server-authoritative row is identical everywhere by construction with no
convergence window at all.

`pending_notifications` and `notification_log` are likewise outside it, for
the original reason: they are delivery mechanics rather than user data.

An adversarial SQL suite (`supabase/tests/05_notifications_adversarial.sql`)
attacks it in the established style — attack, don't assert — including a
**negative control** proving the harness detects a missing gate, per every
prior suite in this project.

---

## 8. Anti-noise rules, collected

Because "noise gets notifications disabled entirely" is the actual failure
mode this feature dies of:

- **Default off for every show.** No auto-enable from `watching` status. Per-
  show opt-in only.
- **One notification per show per run** (§2.1 rule 3).
- **Suppression when already watched** (§1.1).
- **Two event kinds, independently toggleable**, and no others. There is no
  "recommended for you", no "trending", no re-engagement category — and the
  schema has no room for one, which is deliberate.
- **Quiet hours** (§5).

---

## 9. iOS — a real explanation, never a dead button

Per `docs/phase-5-pwa-design.md` §5: Web Push on iOS requires **16.4+ AND
home-screen install**. Safari-only; Chrome and Firefox on iOS cannot install.

Detection is **capability-based, never version-sniffed**:

```
'serviceWorker' in navigator && 'PushManager' in window
  && Notification.permission !== 'denied'
  && (not iOS || matchMedia('(display-mode: standalone)').matches)
```

On iOS Safari, not installed: the toggle is **replaced** by Add-to-Home-Screen
instructions — not disabled-with-a-tooltip, and not shown-then-failing. The
same honesty §5 of the PWA doc already committed to.

The permission prompt is never fired on page load. It is fired from a
deliberate user action, immediately after copy explaining exactly what will be
sent — because a denied permission is effectively permanent and a prompt fired
cold is the fastest way to earn one.

---

## 10. New dependencies and credentials

**`web-push`** — a deliberate exception to this project's documented
anti-dependency bias (`components/ui/icons.tsx`, `components/stats/`). Those
arguments were about bundle weight and API surface for *simple* things. VAPID
JWT signing plus AES128GCM payload encryption is real cryptography, where
hand-rolling is a bad idea for reasons that have nothing to do with effort.
Server-side only; never bundled to the client.

Two new credentials, bringing the project to seven:

| | public? | notes |
|---|---|---|
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | yes, by design | the browser must have it to subscribe |
| `VAPID_PRIVATE_KEY` | **no** | server-only, never `NEXT_PUBLIC_` |
| `CRON_SECRET` | **no** | the only thing standing between the internet and a service-role code path |

All three go in `.env.example` as empty templates. **A blank VAPID key must
remain a supported configuration** — the whole feature goes inert and the UI
says notifications are unavailable, exactly as a blank `OMDB_API_KEY` or an
unconfigured Supabase does today. The zero-config promise survives seven
credentials the same way it survived two.

---

## 11. The guard

Two assertions, both inverted in the established style:

1. **Exactly one file may import `@/lib/supabase/server-env`.** A test
   enumerates importers and fails if the set is anything other than the single
   allowed module. This is the *only* mechanical thing preventing a second
   service-role code path from appearing, and it must be described that way in
   CLAUDE.md rather than left as a comment.
2. **No `NEXT_PUBLIC_` prefix on `VAPID_PRIVATE_KEY` or `CRON_SECRET`**, plus
   the established sentinel-grep of `.next/static` after a build — the same
   discipline as Phase 4 Step 4 and Phase 6 Step 3, run again because the
   service-role key is now genuinely reachable rather than dead.

---

## 12. Out of scope, deliberately

- **Any behaviour-triggered notification**, forever (§1.1).
- **Notification categories beyond the two in §2.1.** Adding one is a design
  decision requiring the §1.1 test to be applied explicitly, not a config
  change.
- **Per-episode granularity** ("notify me only for season premieres"). The
  two toggles cover the real cases; more knobs is the other way features die.
- **Rich notifications** (images, action buttons). Title, body, and a deep
  link into the title page.
- **Email or SMS fallback.**

---

## 13. Build order

1. **Schema + RLS**, with the adversarial suite and its negative control.
   First because everything else writes to it, and because an RLS mistake here
   is the expensive kind.
2. **`Title.lastEpisodeToAir` / `nextEpisodeToAir`** across `types.ts`,
   `provider.ts`, and **both** providers — per CLAUDE.md's central rule, the
   interface changes before either implementation.
3. **Subscription + preferences UI**, including the iOS path.
4. **The detect/deliver route**, the `push` handler in the service worker, and
   the scheduler wiring.
5. **The guard** (§11), plus the CLAUDE.md service-role update.

Steps are separately committable and should be separately committed.
