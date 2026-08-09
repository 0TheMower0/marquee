# Phase 5 Step 6 — PWA manifest + service worker: design

Status: **approved 2026-08-09, not built.** Nothing in this document exists in
the codebase yet.

Read the "Local persistence", "Accounts", "Sync" and "Comments" sections of
CLAUDE.md first. Two decisions below — the static/dynamic cache line in §2 and
the quota risk in §8 — are direct consequences of rules already established
there and look arbitrary without them.

This step is deliberately **not** scaffolding for push notifications (Phase 7
Step 5). It is a prerequisite for that step, but it is designed here on its own
terms: a real manifest, a real caching strategy, a real update path. Building a
minimal worker as a side effect of the notifications feature is the outcome
this document exists to prevent.

---

## 0. What was verified, and what was not

The house rule is that a claim in a design doc says which it is.

### Verified this session, against this machine

| Claim | How |
|---|---|
| Next 16 ships a PWA guide and a `manifest.ts` file convention | `node_modules/next/dist/docs/01-app/02-guides/progressive-web-apps.md`, `.../03-file-conventions/01-metadata/manifest.md` |
| **Serwist "currently requires webpack configuration"** | stated verbatim in that guide — decisive, since this project is on Turbopack (§9) |
| The static/dynamic route split in §2 | real `next build` output, this session |
| `sharp@0.35.3` loads as ESM and is an explicit dependency | ran it; `package.json` line 21 |
| `public/` contains exactly one file (`tmdb-logo.svg`) — **no icons exist** | `ls public/` |
| No `sw.js`, `manifest.ts` or `manifest.json` exists anywhere | `find` |
| `app/layout.tsx` already sets `themeColor: "#0b0b0e"` and `viewportFit: "cover"` | read it — and it already carries a comment anticipating this step |
| `/title/[mediaType]/[id]` renders `CommentSection` | grep — this is the account-scoped hazard in §1 |
| Palette: `--ink-800 #0b0b0e` (page bg), `--ink-900 #060608`, `--gold-400 #e8b33c` | `app/globals.css` |

### NOT verified — asserted from general knowledge, flagged as such

- The precise iOS/WebKit **7-day storage eviction** window and its exemption for
  home-screen-installed apps (§5). The shape of the behaviour is well
  established; the exact threshold and its current status in the shipping
  WebKit should be re-checked before the install copy quotes a number at the
  user. **Do not put "7 days" in user-facing text until someone confirms it.**
- Whether `localStorage` shares an eviction bucket with Cache Storage in every
  target browser (§8). The mitigation is correct regardless — it is cheap and
  fails safe — but the severity claim rests on this.
- Exact iOS version floors for `theme_color` honouring and standalone display.

---

## 1. The invariant

The brief's hard requirement was: *don't cache anything account-scoped or
personal in a way that could leak between users on a shared device.*

A denylist ("don't cache `/profile`, `/account`, …") fails the first time
someone adds a route. So the rule is positive:

> **The service worker caches only responses that are byte-identical for every
> user.**

Cache Storage is **origin-scoped, not user-scoped**. On a shared device Alice's
cache *is* Bob's cache; signing out does not partition it. "Identical for
everyone" is therefore the only property that makes shared-device safety
structural rather than a promise someone has to keep remembering.

### That line is already drawn — by the build

`next build` prints `○ (Static)` vs `ƒ (Dynamic)`, and a statically prerendered
route is *by definition* the same bytes for every visitor. Verified output:

| | routes |
|---|---|
| ○ **static — cacheable** | `/`, `/search`, `/library`, `/schedule`, `/import`, `/profile/stats`, `/forgot-password`, `/_not-found` |
| ƒ **dynamic — never cached** | `/title/[mediaType]/[id]`, `/profile`, `/account`, `/lists`, `/lists/[id]`, `/lists/new`, `/signin`, `/signup`, `/auth/callback`, every `/api/*` |

Each static route is a client-rendered shell over `localStorage` (`/library`,
`/schedule`, `/profile/stats`, `/search`, `/import`) or over content
(`/`). None embeds anything user-specific.

**`/title/[mediaType]/[id]` sitting on the dynamic side matters more than it
looks.** It renders `CommentSection`, whose visibility is gated per reader
against that reader's own synced watch history (Phase 6 Step 6a). Caching that
HTML would serve one account's spoiler-gating decision to the next person on
the device — the single most dangerous response in this app to cache. It lands
on the correct side of the line without a special case.

**Consequence to accept:** a title page is not available offline. That is the
right trade. The alternative is a per-user cache partition, which Cache Storage
does not offer.

---

## 2. Strategy by request class

| Request | Strategy | Why |
|---|---|---|
| `/_next/static/**` (JS, CSS, self-hosted fonts) | **cache-first, never revalidate** | Content-hashed by the build. A stale entry is *impossible* — the filename changes when the bytes do. |
| Navigation to an **allowlisted static route** | **network-first**, cache as fallback | An online user always gets the current build; the cache is purely the offline path. This is also what stops a stale worker pinning a live user to an old page. |
| Navigation to **anything else** | **never cached**; network-only, `/offline` on failure | The account-scoped set from §1. |
| `/api/content/**` | **stale-while-revalidate**, bounded ~150 entries | A pure TMDB/mock proxy: no auth, no personal data, identical for every caller. This is what makes `/schedule` and Up Next work offline with last-known season data rather than being decorative. **See §7.2 — this assumption is guarded by a test, not a comment.** |
| `/_next/image?url=…` (TMDB posters) | **cache-first**, bounded LRU ~60 entries | Content, not personal. The bulk of the bytes. The bound is load-bearing — see §8. |
| `*.supabase.co`, Server Action POSTs, `/api/import/resolve`, **any non-GET** | **passthrough — never read, never written** | Account-scoped or mutating. |

Note that TMDB images are never fetched cross-origin by the browser: `next/image`
proxies them through `/_next/image`, so `image.tmdb.org` never appears as a
request the worker sees. One less origin to reason about.

---

## 3. Offline cold start

The brief: *"the app already works offline for tracking. Make that true for a
cold start too, not just a warm tab."*

Runtime-caching-only satisfies a warm tab and fails a cold start — nothing is
cached until it has been requested once. So on `install` the worker:

1. Fetches and caches the allowlisted static route documents plus `/offline`.
2. **Scrapes those documents for their own `/_next/static/` references and
   precaches those too.** The HTML literally lists its own scripts and
   stylesheets, so this needs no build manifest and no coupling to `.next/`
   internals — which matters, because Turbopack is free to change that layout
   and a postbuild script reading `.next/` would break silently when it did.
3. If the scrape yields nothing, it degrades to runtime caching rather than
   failing the install. The caveat then becomes "offline works from the second
   visit", which is a degradation, not a breakage.

**`/offline` is a real route, not a browser error page.** It should name which
parts of the app still work and link to `/library` and `/schedule`, which
genuinely do — a generic "you are offline" would be actively misleading in an
app whose whole premise is that the data is already on the device.

---

## 4. The update problem

A stale worker serving an old build is the classic failure and the brief called
it out. Four mechanisms, and the first is the one that leaves no way out if
missed:

1. **`/sw.js` served with `Cache-Control: no-cache, no-store, must-revalidate`**
   (via `headers()` in `next.config.ts`, as the Next guide shows) **and**
   `updateViaCache: 'none'` at registration. Without both, the browser may serve
   a 24-hour-old service worker and there is no recovery path from inside the
   app.
2. **Cache names versioned by build id.** New deploy → new names → old caches
   deleted in `activate`.
3. **No automatic `skipWaiting()`.** Swapping the worker under a running page
   can leave that page requesting hashed chunks the new build no longer serves,
   producing chunk-load errors mid-session. The new worker installs and
   *waits*; the app surfaces it (below) and only then posts `SKIP_WAITING` and
   reloads.
4. **`registration.update()` on `visibilitychange`**, so a long-lived tab
   notices a deploy rather than waiting for a navigation.

### 4.1 The prompt is dismissible but PERSISTENT

The answer to "how does the user know" is: we tell them, on screen — a
"New version available — Reload" prompt.

**Dismissing it must not be permanent.** A user who taps X once and is then
stuck on an old build indefinitely is the same failure this section exists to
prevent, just with an extra click in front of it. So:

- Dismissal is **per-visit, held in memory only** — no `localStorage` flag, no
  "don't show again". The next load (or the next `visibilitychange` update
  check) surfaces it again while a waiting worker is still waiting.
- It stops appearing for exactly one reason: the update was actually applied.
- Non-blocking — it must never sit over content or interrupt what someone is
  doing. It is an offer, repeated, not a modal.

Storing the dismissal is the tempting "polish" here and it is the bug. Write
the reasoning at the call site.

---

## 5. iOS — differences, not parity

Stated plainly per the brief. Flagged where unverified (§0).

- **No `beforeinstallprompt`.** An install *button* is impossible. The only
  route is Share → Add to Home Screen, and the UI has to say that in words. The
  Next guide reaches the same conclusion and recommends against a custom
  install button generally, since it does not work on Safari iOS.
- **Safari only.** Chrome and Firefox on iOS cannot add to the home screen at
  all — they are WebKit shells without that capability.
- **⚠️ Storage eviction is the strongest real argument for installing.** WebKit
  evicts site data — Cache Storage **and** `localStorage` — after a period of no
  interaction for non-installed sites; home-screen-installed apps are exempt.
  For an app that keeps the user's entire library in `localStorage`, that is not
  a performance note, it is data loss. It belongs in the install copy rather
  than buried. **The exact window is unverified (§0) — do not quote a number
  until it is.**
- **No `purpose: maskable` support.** iOS applies its own mask and ignores the
  hint, so it needs a separate 180×180 `apple-touch-icon` with padding baked in.
- **`apple-mobile-web-app-capable` is deliberately NOT emitted.** Next only
  writes the standardized `mobile-web-app-capable` (confirmed in
  `node_modules/next/dist/lib/metadata/metadata.js`), and iOS 15.4+ honours the
  manifest's own `display: "standalone"` anyway, so the apple-prefixed tag buys
  nothing on any device from 2022 onward. Adding it back would cost a Chrome
  DevTools deprecation warning on every page load, which is real console noise
  in a project that checks the console as a matter of routine. Considered and
  declined — do not "fix" this.
- Push (Phase 7 Step 5) needs **iOS 16.4+ AND home-screen install**. Noted for
  sequencing; not built here.

---

## 6. Icons

**Four files, not the usual nine.** Modern Android downsamples from 512 and the
intermediate sizes (48/72/96/144/384) are cargo-culted from an older Chrome.

| File | Purpose |
|---|---|
| `icon-192.png` | Android home screen; manifest minimum |
| `icon-512.png` | Android splash, install prompt, the size Lighthouse checks |
| `icon-512-maskable.png` (`purpose: "maskable"`) | Without it Android puts the icon in a **white circle badge**, which looks broken on a near-black app |
| `apple-touch-icon.png` (180×180) | iOS, which ignores `maskable` (§5) |

`app/favicon.ico` already exists and stays. A fifth output, `icon.svg`, is
written alongside them so the mark is reviewable as text and usable wherever a
vector is preferable; it is referenced from `metadata.icons.icon`.

**All four PNGs are flattened to no alpha channel.** The notches and
perforations are *painted* in the background colour rather than subtracted from
the ticket's path (the CSS version goes to real trouble with `mask-composite`
precisely so it can sit on any background; a static icon does not need to).
That shortcut is only correct while the files are opaque, so flattening makes
opacity an encoded property rather than something that merely happens to be
true — and it avoids iOS compositing a transparent `apple-touch-icon` onto
white.

**Generated by a committed script via `sharp`** (already an explicit dependency
since Phase 4 Step 2) from **hand-written SVG geometry** — a ticket silhouette
in `--gold-400` on `--ink-900`, matching the existing `.ticket-surface`
identity. Geometry rather than text on purpose: it avoids depending on Bebas
Neue's font file (self-hosted by `next/font`, not readily available to a build
script), and it keeps the icons regenerable rather than opaque binaries nobody
can edit.

Manifest itself is `app/manifest.ts` (the Next 16 file convention), with
`display: "standalone"`, `background_color`/`theme_color` from the palette, and
`start_url: "/"`.

---

## 7. The guard

The way this ships broken is silence: someone adds a route later, it is dynamic
and account-scoped, and the worker caches it. Nothing fails. So the allowlist is
**inverted**, the same way the Phase 7 Step 2 sync guard was — which was the
part of that step that actually earned its keep.

### 7.1 Route classification completeness

A test enumerates every route in `app/` and asserts each one is **either** in
the cacheable allowlist **or** in an explicit never-cached list. A new route
fails the test until someone classifies it deliberately.

Default outcome flips from *silent leak* to *loud unfinished*.

The test should also assert the allowlist still matches the real `○ (Static)`
set, so a route that changes from static to dynamic — which can happen by
adding a single `cookies()` call several layers down, with no local edit to the
route file at all — trips the guard rather than quietly becoming cacheable
user-specific HTML.

### 7.2 `/api/content/**` has no auth — as a test, not a comment

Per the brief's second addition, and it is the right call: *"this route family
has no auth" is exactly the kind of thing that stays true until it quietly
doesn't.*

§2 caches `/api/content/**` on the strength of one assumption — that it is a
pure content proxy with no session read and no per-user variation. If a later
step ever puts something user-scoped behind that prefix (a personalised
recommendation, a "seen by you" flag, a rate-limit response keyed to an
account), the caching rule silently becomes a cross-user leak, and nothing
about that change would look like it touched the service worker.

So the assumption is asserted:

- Every route file under `app/api/content/**` must not import from `@/lib/auth`,
  `@/lib/supabase`, or read `cookies()` / `headers()` for identity.
- Any new route file under that prefix must be explicitly listed, the same
  inversion as 7.1 — so adding one requires stating that it is user-agnostic.

Failure message should name the caching rule it invalidates, not just the
import, so whoever hits it understands they are looking at a leak and not a
lint nit.

### 7.3 Verified against the built output, not just reasoned about

Same discipline as the credential greps in Phase 4 Step 4 and Phase 6 Step 3:
after `next build`, confirm the static/dynamic split still matches the
allowlist, and confirm live that a signed-in title page never appears in Cache
Storage. A guard that only ever ran against source is not the guard that was
promised.

---

## 8. The non-obvious risk: quota eviction can destroy the library

An unbounded image cache is not merely wasted disk. Under storage pressure
browsers evict **per origin**, and this app keeps the user's entire watch
history in `localStorage`. A poster cache that grows without limit can push the
origin over quota and get that history evicted — the worst possible outcome of a
feature added for offline *convenience*.

That is why the bounds in §2 are a **data-safety** measure, not tidiness, and
why they should be commented as such so nobody relaxes them for a smoother
scroll.

Paired mitigation: request **`navigator.storage.persist()`**, which exempts the
origin from eviction where granted. It is a strong fit for a local-first app and
costs one call. Grant behaviour differs by browser (heuristic in Chrome, prompt
in Firefox, granted on install in Safari) so it must be treated as best-effort —
report the outcome in the existing `DiagnosticsPanel` on `/profile` rather than
assuming it succeeded.

Severity here rests on the unverified claim in §0 about shared eviction buckets.
The mitigation is correct either way.

---

## 9. Out of scope, deliberately

- **Serwist / Workbox.** The Next 16 guide states Serwist "currently requires
  webpack configuration"; this project is on Turbopack. A hand-rolled worker is
  also consistent with the existing precedent for icons (`components/ui/icons.tsx`)
  and charts (`components/stats/`), both of which argue the same way.
- **Push notifications, VAPID keys, `web-push`.** Phase 7 Step 5. This step
  must not grow a `push` handler "while we're here" — that is precisely the
  sideways build the sequencing decision rejected.
- **Background sync / periodic sync.** `lib/sync`'s outbox already flushes on
  reconnect.
- **A custom install button.** Broken on iOS (§5); the Next guide recommends
  against it.

---

## 10. Build order

Agreed for the next session:

1. **Icons + `app/manifest.ts`** — no service worker at all. Worth landing
   alone: it is independently verifiable, and it means a caching bug and an
   install bug can never be confused for each other.

   ⚠️ **CORRECTION, measured while building step 1.** This step originally
   said "installable, with no service worker at all", and §6 called a manifest
   "what makes the app installable at all; offline support is not a
   prerequisite". That is **half right, and the half that is wrong is the
   Android half**:

   | | after step 1 | needs step 2 |
   |---|---|---|
   | **iOS Safari** | ✅ fully live. Add to Home Screen is a manual user action available on any page regardless; the manifest and `apple-touch-icon` are what make it launch standalone with the right icon instead of as a browser bookmark. | — |
   | **Chrome / Android** | ❌ no install prompt | ✅ |

   Observed directly on `localhost` (a secure context) with a valid manifest,
   both 192 and 512 icons resolving 200, and `display: standalone`:
   **`beforeinstallprompt` did not fire.** The remaining unmet criterion is
   Chrome's requirement for a registered service worker with a `fetch`
   handler — it dropped the *offline-capable* requirement, not the
   service-worker one.

   This does not change the build order: separating the two is still right,
   and iOS install quality genuinely is live after step 1. It only changes
   what "done" looks like for this step — **do not expect an Android install
   prompt until step 2 lands, and do not go hunting for a manifest bug when
   it does not appear.**
2. **The service worker** — §2 strategy, §3 precache.
3. **The update prompt** — §4, including the persistent-dismissal rule in §4.1.
4. **The guard** — §7, both halves.

Steps 1 and 2 are separately committable and should be separately committed.
