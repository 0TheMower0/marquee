@AGENTS.md

# Marquee

A personal, non-commercial movie **and** TV tracker. The pitch: everything
Moviebase / TV Time / SeriesGuide / Trakt / Letterboxd put behind a paywall,
free — with films and series in one app instead of two.

Free, ad-free, non-monetized. Not a commercial product.

---

## Commands

```bash
npm run dev     # dev server (Turbopack) — works with no .env file at all
npm run build   # production build; also where client/server boundary violations fail
npm run lint    # eslint
npm run test    # vitest — currently just lib/tracking/upnext.ts's ranking math
```

---

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 + TypeScript |
| Styling | Tailwind CSS v4 (CSS-first `@theme`, no `tailwind.config.js`) |
| Fonts | `next/font/google` — Bebas Neue (display) + Inter (body), self-hosted at build |
| Persistence | localStorage today, behind an async interface (see below) |
| Deploy target | Vercel |
| Later | Supabase (accounts/social, Phase 6), PWA manifest + service worker (Phase 5) |

---

## THE central architectural rule

**No UI code ever talks to TMDB — or to any content source — directly.**

Everything goes through one interface in `lib/content/`:

```ts
interface ContentProvider {
  searchTitles(query, options)
  getTrending(mediaType)
  getTitle(id, mediaType)
  getSeasons(showId)
  getSeasonEpisodes(showId, seasonNumber)
  getSimilar(id, mediaType)
  getRecommendations(id, mediaType)
  getWatchProviders(id, mediaType, region)
}
```

```
lib/content/
  types.ts      Normalized domain types — Title, TitleSummary, Season, Episode,
                CastMember, WatchProvider. These are OUR shapes, not TMDB's.
                This file is the contract every component renders against.
  errors.ts     ContentError, with a discriminated `kind`:
                'not_found' | 'unauthorized' | 'rate_limited' | 'network' | 'unknown'
                Both providers throw only these, so error UI is written once.
  provider.ts   The ContentProvider interface.
  shared/       Code both providers legitimately need — currently just
                placeholder.ts (deterministic gradient-from-id), reused by
                tmdbProvider as its no-poster-image fallback in Step 3.
  mock/         mockProvider — ~25 hand-authored titles, full hand-authored
                season/episode data for 5 TV shows chosen to exercise
                distinct Up Next edge cases (currently airing, a Season 0,
                a canceled/truncated final season, ...) plus real per-season
                episode-count "shapes" for 6 more long-running shows — see
                the header comment in mock/episodes.ts. CSS-gradient art,
                simulated latency. Zero network.
  tmdb/         tmdbProvider — real TMDB v3 endpoints, v4 Bearer auth.
  index.ts      getContentProvider() — selects on NEXT_PUBLIC_CONTENT_PROVIDER,
                defaults to 'mock'.
```

Why this is worth the ceremony:

- The app runs and demos with **zero configuration** — no API key needed.
- UI work is testable offline, deterministically, with no rate limits.
- If TMDB's terms, pricing, or availability change, one directory is rewritten
  and nothing above it moves.

**Rule for adding features:** if a component needs data TMDB happens to
provide, add it to `types.ts` and the interface *first*, then implement it in
**both** providers. Never reach around the layer.

### `TitleSummary` vs `Title` — do not merge these back together

List-producing methods (`searchTitles`, `getTrending`, `getSimilar`,
`getRecommendations`) return `TitleSummary`. Only `getTitle` returns the fuller
`Title`, which adds `cast`, `backdropUrl`, `status`, `runtimeMinutes`,
`seasonCount`, `episodeCount`.

This looks like it could be simplified to one flat type. **It can't be, without
breaking the abstraction.** TMDB's list endpoints (search/trending/similar/
recommendations) do not return credits — only requesting a single title's
detail does. If list methods returned `Title` (with `cast`), `mockProvider`
could trivially fabricate full cast for every card, while `tmdbProvider`
legitimately could not without an extra API call per grid item. The two
providers would then satisfy the *same interface* with different real data
availability, which defeats the entire point of the abstraction: swap
providers, nothing else should change.

`mockProvider` deliberately mirrors this constraint even though it could
cheaply ignore it — `toSummary()` in `lib/content/mock/index.ts` is an
explicit field allowlist, not a spread-and-omit, specifically so it can never
silently start leaking `cast` into list results. If you're tempted to unify
`Title`/`TitleSummary`, first find a way to make `tmdbProvider` produce cast on
list endpoints too — you can't, so don't merge.

### Provider selection

`NEXT_PUBLIC_CONTENT_PROVIDER=mock|tmdb`, defaulting to `mock`. It is
`NEXT_PUBLIC_` on purpose — it is a mode flag, not a secret.

---

## Secret handling — non-negotiable

The TMDB token lives in `TMDB_READ_ACCESS_TOKEN`. It is a **v4 Read Access
Token**, sent as `Authorization: Bearer <token>`, never as a `?api_key=` query
param.

Three rules:

1. **Never** prefix it `NEXT_PUBLIC_`. That inlines it into the client bundle.
2. `lib/content/tmdb/*` and `lib/content/index.ts` begin with `import "server-only"`.
   An accidental client import is then a **build error**, not a runtime leak.
   Do not remove those imports to "fix" a build failure — the failure is the
   feature working.
3. All TMDB traffic originates server-side (Server Components today; see the
   client seam below).

`.env.local` is gitignored. `.env.example` is the committed template and must
never contain a real credential.

### The second credential: `OMDB_API_KEY` (Phase 4 Step 4)

External ratings come from OMDb, which is a **second upstream credential** and
gets the identical treatment: never `NEXT_PUBLIC_`, `lib/content/omdb/client.ts`
begins with `import "server-only"`, and the browser reaches it only through
`app/api/content/title/[mediaType]/[id]/ratings`.

Two differences from TMDB worth knowing, both forced by OMDb rather than
chosen:

- **The key goes in a query parameter** (`?apikey=`). OMDb supports no header
  form at all, so the "never as a query param" rule written for TMDB cannot
  apply. The mitigation is that the URL is built server-side only and never
  logged — `logSafeUrl()` exists so an error path can't accidentally print it.
- **1,000 requests/day on the free tier.** This is the binding constraint on
  the whole feature, not freshness. Responses are cached **7 days** at both
  layers (`OMDB_REVALIDATE_SECONDS` in `omdb/client.ts` and
  `CACHE_SECONDS.ratings` in `lib/api/respond.ts`). Ratings move in the third
  decimal over a week for anything but a brand new release. Do not shorten
  these without a reason.

**A blank `OMDB_API_KEY` is a supported configuration, not a broken one.**
`getExternalRatings()` returns `[]` and the detail page renders with TMDB's own
score — the zero-config guarantee still holds with two credentials just as it
did with one.

### Verified, not assumed

The boundary was tested in Step 3 and re-tested for OMDb in Phase 4 Step 4,
not taken on trust:

- A client component importing `@/lib/content` **fails the build** with a full
  import trace. That is `server-only` working; if you ever hit this error, fix
  the import — do not delete the guard.
- `.next/static` was grepped for `TMDB_READ_ACCESS_TOKEN`, `api.themoviedb.org`,
  `image.tmdb.org`, `Bearer `, `tmdbProvider`, `tmdbFetch` — all absent, with a
  positive control confirming the grep detects strings that *are* present.
- For OMDb the same grep covered `OMDB_API_KEY`, `omdbapi.com`, `apikey`,
  `fetchOmdbRatings`, `toExternalRatings` — all absent. Stronger still: a
  **sentinel value** was placed in `OMDB_API_KEY`, the app rebuilt, and
  `.next/static` grepped for that exact string — zero matches, proving the
  *value* doesn't leak rather than just the variable name. It is not inlined
  into `.next/server` either, because the key is read lazily at request time.
- Importing `lib/content/omdb/client.ts` from a Client Component was tried
  deliberately: the build failed with `You're importing a module that depends
  on "server-only"` plus the full component trace.

Worth being precise about one thing: **poster/backdrop URLs on
`image.tmdb.org` do reach the browser at runtime**, inside the RSC payload, and
must — otherwise no images render. What never reaches the browser is the token,
the API host, and the provider code. Those are different claims; don't conflate
them.

### TMDB fetch caching and the memoization tradeoff

`tmdbFetch` passes `AbortSignal.timeout(8s)`. Per
`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/fetch.md`,
passing a signal **opts the request out of Next's per-render fetch
memoization**. This was a deliberate trade: an un-timed-out hung connection
would stall a Server Component render indefinitely, which is worse than losing
same-URL dedupe within a single render.

The persistent data cache (`next.revalidate`) is unaffected, and that is the one
that actually saves API calls across requests. Lifetimes live in `REVALIDATE` in
`lib/content/tmdb/index.ts` — search 5 min, trending 1 hr, detail/related 24 hr,
watch providers 12 hr.

If duplicate same-URL fetches inside one render become a real problem, wrap the
provider methods in React's `cache()` — that dedupes regardless of the signal.
Do not solve it by removing the timeout.

### Client-side data seam — built (Phase 2 Step 1)

Server Components call `getContentProvider()` directly. Client Components
import `httpProvider` from `lib/content/http/`, which implements the **same**
`ContentProvider` interface by fetching `app/api/content/*`. Same contract,
same domain types, same `ContentError` kinds — the transport is the only
difference.

```
app/api/content/
  trending/                                    getTrending
  search/                                      searchTitles
  title/[mediaType]/[id]/                      getTitle
  title/[mediaType]/[id]/similar/              getSimilar
  title/[mediaType]/[id]/recommendations/      getRecommendations
  title/[mediaType]/[id]/watch-providers/      getWatchProviders
  title/[mediaType]/[id]/ratings/              getExternalRatings
  tv/[showId]/seasons/                         getSeasons
  tv/[showId]/seasons/[seasonNumber]/          getSeasonEpisodes

lib/api/validate.ts   Untrusted-input parsing; throws BadRequestError
lib/api/respond.ts    jsonOk / handleRouteError; server-only
lib/content/http/
  wire.ts             Error envelope + kind<->status maps. Shared by BOTH
                      sides, so it must stay free of `server-only`.
  index.ts            httpProvider. The ONE content module a Client
                      Component may import.
```

Three rules that are load-bearing:

1. **`lib/content/http/` must never import `getContentProvider`, `tmdbProvider`,
   or anything under `lib/content/tmdb/`.** Doing so drags server-only code
   into the client graph and fails the build. Verified by deliberately adding
   such an import — the build failed with a full import trace naming the
   offending client component.
2. **Route handlers never forward an upstream message.** `tmdbProvider` folds
   TMDB's own `status_message` into `ContentError.message`; `handleRouteError`
   logs that server-side and sends only the fixed string from `SAFE_MESSAGE`.
   Verified with a deliberately invalid token: the response body was
   `{"kind":"unauthorized","message":"The content source rejected the request."}`
   while `Invalid API key: You must be granted a valid key` appeared only in
   the server log.
3. **Validation errors are `BadRequestError`, not `ContentError`.** A malformed
   request is the caller's bug, not a content-source failure. Collapsing the
   two would make `ContentErrorKind` mean two different things. They surface as
   HTTP 400.

`unauthorized` maps to **502, not 401** — the caller isn't unauthorized, our
upstream credential is. See the comment on `KIND_STATUS` in `wire.ts`.

A blank search query returns an empty page rather than a 400, because that is
what `mockProvider` and `tmdbProvider` both do. The HTTP transport must not be
the odd one out — that is the whole point of the interface.

### These routes are a public surface — rate limited since Phase 6 Step 2

Once deployed, `app/api/content/*` is callable by anyone who finds the URL, not
just by our own client code. There is still **no auth** on them (that is Phase 6
Step 4), but there is now per-IP rate limiting — `lib/ratelimit/`.

Layers, outermost first:

- Every response sets `s-maxage` (see `CACHE_SECONDS`), so repeated identical
  requests are absorbed by the CDN rather than reaching TMDB.
- `next.revalidate` on the TMDB fetches caches upstream results independently.
- Input validation caps `page` at 500 and `query` at 200 characters, so a
  single request can't ask for something unbounded.
- **Per-IP sliding-window limits**, applied before validation and before any
  provider call, so a rejected caller costs us nothing upstream.
- **A global daily budget** on the one hard external quota (OMDb).

Caching is still not a substitute for any of this: a unique `?query=` per
request defeats every cache layer above it, which is exactly why `search` gets
a tighter rule than the rest.

**Per-IP, not per-user, and that ordering was the point.** An earlier version of
this section filed rate limiting under "Phase 6, where per-user identity finally
exists." That was wrong in the way that matters: **an attacker burning the quota
will not be signed in**, so per-user limits do nothing against the actual
threat. Per-IP needs no identity, so it had no reason to wait behind auth. Per-
user limits remain a worthwhile later refinement — better at catching one
abusive *account* — but they are a complement, never a replacement.

See `docs/phase-6-sync-design.md` §10 for the full Phase 6 step order, and the
Phase 6 status section below for how the limiter is built.

---

## Next.js 16 — things that differ from older training data

This project is on Next 16. Version-matched docs ship inside the package at
`node_modules/next/dist/docs/` — **read them rather than relying on recall.**
Confirmed differences that have already bitten:

- **`error.tsx` receives `unstable_retry`, not `reset`.** Signature is
  `{ error, unstable_retry }`. `reset` is gone.
- **`params` and `searchParams` are Promises** and must be awaited. Synchronous
  access was removed in 16 (it was merely deprecated in 15).
- Use the generated `PageProps<'/route/[param]'>` / `LayoutProps<'/route'>`
  helpers for typing; run `npx next typegen` if they go stale.
- **Turbopack is the default** for `dev` and `build` — no `--turbopack` flag.
- **`next lint` was removed.** `npm run lint` calls `eslint` directly, and
  `next build` no longer lints.
- `middleware.ts` is deprecated in favour of `proxy.ts`.
- Reading `process.env` in a Server Component can be inlined at build time. Call
  `connection()` from `next/server` first when a value must be read at runtime.

---

## Design system

Cinema/marquee identity: near-black warm surfaces, marquee gold primary,
electric cyan secondary, condensed display type, movie-ticket-shaped cards.
Deliberately *not* the generic dark-Material look every competitor ships.

### Tokens — `app/globals.css`

Two layers, and the split is load-bearing:

1. `:root` holds the **raw palette** (`--gold-400`, `--ink-800`, …) plus
   **semantic aliases** pointing at it (`--accent-primary: var(--gold-400)`).
2. `@theme inline` maps the semantic aliases into Tailwind utilities.

**The `inline` keyword is required, not stylistic.** Without it Tailwind emits
`var(--color-accent)`, which resolves once at `:root` — custom properties
inherit as already-substituted computed values, so a nested override would do
nothing. With `inline`, utilities emit `var(--accent-primary)` and re-resolve
at every element.

That is precisely what makes **Phase 4 dynamic theming** work: a title detail
page extracts colors from its artwork, sets `--accent-primary` /
`--accent-secondary` on a wrapper, and every `bg-accent` / `text-accent` /
`border-accent` beneath it re-tints — no component changes.

**Components reference semantic tokens only.** Never `--gold-400` directly, or
that element will not re-theme.

### Typography

- `font-display` = **Bebas Neue**. **It has no lowercase.** Valid for titles,
  nav labels and section headers only.
- `font-sans` = **Inter**. Everything mixed-case: overviews, episode names,
  long show titles, metadata, body copy.
- Scale: `text-display-{sm,md,lg,xl,2xl}` (Bebas, tight leading, tracked out)
  and `text-body-{sm,,lg}` + `text-meta{,-sm}` (Inter).

### `cn()` and the tailwind-merge trap

`lib/utils/cn.ts` extends tailwind-merge with our custom `--text-*` scale. That
configuration is **required, not cosmetic.**

tailwind-merge resolves conflicts by bucketing classes. It only knows
Tailwind's stock sizes (`text-sm`, `text-lg`, …), so it treats any other
`text-*` as a **colour**. That put `text-display-sm` and `text-accent` in the
same bucket, and only the last member survives — so
`cn("text-accent", "text-display-sm")` silently returned just
`text-display-sm`. The Outline button rendered at the correct size in the
wrong colour, with no warning anywhere. It was caught by looking at the
rendered page, not by the build.

**When adding a `--text-*` token to `globals.css`, add its name to
`FONT_SIZES` in `lib/utils/cn.ts` too.** Forgetting reintroduces the bug
silently.

### Component rules

- Semantic tokens only — never `--gold-400` / `bg-[#e8b33c]`. A raw value
  cannot re-theme, so it breaks Phase 4 for that element.
- Alpha modifiers on semantic tokens (`bg-accent/15`) still re-theme; the alpha
  applies to whatever the token currently resolves to. Safe to use.
- Anything with a mask goes on an inner element, never on the focusable
  wrapper — see the TicketCard note in `globals.css`.

### App shell — components/shell/

`Sidebar` and `BottomNav` both read from the single `NAV_ITEMS` list in
`nav-items.ts` — never hardcode the four routes twice. Both are Client
Components (`useActivePath` needs `usePathname`); `RootLayout` and `Footer`
stay Server Components.

The `lg` cutover (1024px, Tailwind's unmodified default) was verified against
exact computed layout, not eyeballed: at 1276px the sidebar measures exactly
224px (`w-56`) and the content column's `padding-left` is exactly 224px — no
gap, no overlap. Below 1024px the sidebar is `display:none` and BottomNav is
`display:block`, and vice versa above it.

`Sidebar`'s `SIDEBAR_WIDTH_CLASS` and the `lg:pl-56` on the content wrapper in
`app/layout.tsx` must change together — there's a comment at each site
pointing at the other.

### Quality floor — enforced, not aspirational

- **Focus**: one global `:focus-visible` rule in `globals.css` gives every
  interactive element a cyan ring. Cyan, not gold, because gold means
  *selected* and focus must never be confusable with selection.
- **Reduced motion**: one global `@media (prefers-reduced-motion: reduce)`
  block collapses all durations. Durations go to `0.01ms` rather than
  `animation: none` so `transitionend` / `animationend` listeners still fire.
- **Responsive**: mobile-first. Bottom nav under `lg`, sidebar at and above.
- **Semantic HTML**: real `<nav>`, `<main>`, `<button>`, `<a>`. No div soup.

---

## Pages — Home and title detail

### Error handling is two layers, not one

`error.tsx` is **not** where content failures are handled, and it can't be.
Next serializes a Server Component error down to a generic message plus a
digest before it reaches the client boundary — deliberately, so server
internals don't leak — which means **`ContentError.kind` cannot survive the
trip**. An error boundary can only ever say "something went wrong".

So there are two layers, and they are not alternatives:

| Layer | Handles | Sees `kind`? |
|---|---|---|
| `catch` at the call site → `ContentErrorState` | expected provider failures | yes |
| `app/error.tsx` (`unstable_retry`) | genuine render bugs | no |

`ContentErrorState` (`components/content/`) owns every `kind` → copy mapping in
one place, and suppresses the retry button for kinds where retrying is
pointless (`unauthorized`, `not_found`). Retry is `router.refresh()` in a
client component, which re-runs the server render — not `location.reload()`.

`not_found` is special-cased to `notFound()` rather than an error panel: a bad
title id is a routing outcome, not a failure. Note that Next returns **HTTP 200
for a streamed 404** and 404 only for non-streamed ones — that is documented
behaviour, not a bug to chase.

**Only the `await` goes inside the `try`.** JSX built in a `try` block is a
trap: React doesn't render the returned element until after the function has
returned, so render errors sail straight past that `catch`. eslint's
`react-hooks/error-boundaries` rule enforces this and will fail the lint.

### The theming root — now live (Phase 4 Step 2)

`app/title/[mediaType]/[id]/page.tsx` wraps its entire output in
`<div data-title-theme style={{ "--title-art-from", "--title-art-to",
...titleThemeVars(theme) }}>`.

That element sets `--accent-primary` / `--accent-secondary` (plus `-hover` and
`-dim`) from colours resolved out of the title's own artwork, and every
`bg-accent` / `text-accent` / `border-accent` beneath re-tints with **zero**
component changes — the payoff for the `@theme inline` decision in Phase 1
Step 1. See `lib/theme/` below for how the colours are produced.

`--title-art-*` stays driven by the placeholder gradient rather than the
extracted accent, deliberately: the hero wash sits *behind* the title text so
it must stay dark, while an accent is by definition clamped bright enough to
read as text on near-black. Same wrapper, two different jobs.

Verified live, not assumed: on the Barbie page the wrapper computes
`--accent-primary: #27c1fb` while the sidebar wordmark *outside* it still
computes `#e8b33c`. Scoping works.

### Grid geometry has one definition

`TITLE_GRID_CLASS` in `lib/utils/grid.ts` is imported by **both** `TitleGrid`
and `SkeletonGrid`. The skeleton is a Suspense fallback swapped for the real
grid mid-paint, so a column-count difference between them shows up as a visible
reflow at the worst possible moment. Don't inline the classes in either one.

Likewise `initialsFor()` in `lib/utils/initials.ts` is shared by TicketCard and
the detail-page poster, so a title's fallback monogram is identical in the grid
and on its own page.

---

## Local persistence — `lib/storage/`

```
lib/storage/
  types.ts      StorageDriver, Store, StoreConfig, StorageError, StorageStatus
  serialize.ts  Date-preserving JSON encode/decode
  drivers.ts    localStorage / memory / null drivers + lazy selection
  store.ts      defineStore() — namespacing, version envelope, migrations
  index.ts      public surface; import from here, never the inner modules
```

```ts
const library = defineStore<LibraryEntry>({
  namespace: "library",
  version: 1,
});

await library.set("movie:238", entry);   // rejects with StorageError
const entry = await library.get("movie:238");
const all = await library.getAll();
```

The interface is `Promise`-based even though localStorage is synchronous. That
is deliberate: Phase 3's episode-level tracking means thousands of rows, and
localStorage's ~5 MB synchronous, main-thread-blocking cap becomes a real
problem. With an async interface, swapping in IndexedDB is one more
implementation of `StorageDriver` plus a line in `drivers.ts`; with a sync one
it is a refactor of every call site.

### Keys

`marquee:<namespace>:<key>`. The namespace is validated to contain no `:`, so
one feature's keys can never masquerade as another's, and `clear()` is
prefix-scoped — it never calls `localStorage.clear()`, which would wipe
unrelated data on the origin.

**The schema version is deliberately not in the key.** Putting it there would
orphan every existing record the moment the version is bumped, which is the
exact opposite of a migration path. Version lives inside the value envelope:
`{ v: 1, d: <payload> }`.

### Migrations are lazy and per-record — this is the important part

Phase 3 *will* change the shape of tracking data when episodes arrive, and
users must not lose their library. The obvious design — on first access, read
the whole namespace, upgrade everything, write it back, bump a stored version
— is rejected for one decisive reason: **localStorage has no transactions.** A
user closing the tab mid-pass leaves the namespace half-migrated with no record
of how far it got, and the next load cannot distinguish upgraded records from
stale ones. That is precisely the data-loss event this layer exists to prevent.

Instead each record carries its own version and is migrated on read. Every
record is independently either old or new, and both are readable, so an
interrupted session loses nothing. There is no migration-in-progress state to
make crash-consistent, because no such state exists.

Migrations are keyed by **target** version and chain automatically:

```ts
migrations: {
  2: (old) => ({ status: (old as V1).watched ? "watched" : "unwatched" }),
  3: (old) => ({ ...(old as V2), episodes: [] }),
}
```

A v1 record read by v3 code runs `2` then `3`, then gets written back once at
v3 (best-effort — if that write fails the caller still receives correct data
and the record simply migrates again next time).

Two costs of this design, stated plainly so nobody "cleans them up":

- **Migrations can never be deleted.** A v1 record may still be sitting in a
  browser years from now. `migrations[2]` must survive forever.
- **Cross-record migrations are not expressible.** Splitting one key into
  several, or deduplicating across records, needs the whole namespace at once.
  If Phase 3 needs that, write an explicit one-off routine over `getAll()` at a
  higher layer. Do not try to smuggle it into a per-record migration — it sees
  one value and cannot write others.

### Data is never destroyed to make a read succeed

Four cases all resolve to "return `null`, leave the bytes on disk":

| Situation | Why not just delete it |
|---|---|
| Record written by a **newer** schema (`v` > code's) | User opened a cached old deployment, or we rolled back. Downgrading data we don't understand destroys it permanently; refusing means it returns intact on the next upgrade. |
| Migration function throws | A migration bug should be fixable by shipping a corrected migration, not a data-loss event. |
| No migration registered for a version step | We cannot guess the transform. |
| `validate()` rejects the shape | Cheap insurance against a migration bug handing the app the wrong type. |

### Write failure is a normal condition — handle it

`set()` **rejects with `StorageError`**, carrying a `reason` of
`quota_exceeded` / `unavailable` / `serialization` / `unknown`. Quota
exhaustion and blocked storage are ordinary states on the web, not exceptional
ones. A write that failed must not render as success — showing "added to
watchlist" for something that vanishes on reload is worse than an error.

```ts
try {
  await library.set(key, entry);
} catch (error) {
  if (error instanceof StorageError && error.reason === "quota_exceeded") {
    // surface it; do not pretend the write happened
  }
}
```

Reads never throw: a failed read degrades to `null`.

### Three environments, three drivers

| Environment | Driver | Behaviour |
|---|---|---|
| Browser, storage works | localStorage | persists |
| Browser, storage blocked or throwing | memory | works for the tab, `getStorageStatus() === "memory"` |
| No browser (SSR) | null | reads `null`, writes discarded, never throws |

SSR **must not** use the memory driver: a module-level `Map` on the server is
shared across every request, so one visitor's writes would be readable by the
next. Reading nothing during SSR is also simply correct — the server has no
access to this user's localStorage.

Detection is a real write/remove round trip, not a truthiness check: merely
accessing `localStorage` throws under some blocked-cookie settings, and Safari
private mode historically allowed access but threw on write. It runs lazily and
is cached, so importing this module during SSR is safe.

### Dates survive round-tripping

`JSON.stringify(new Date())` yields an ISO string and `JSON.parse` gives the
string back, so a naive round trip silently changes the type of every date
field — and tracking data is full of them. `serialize.ts` tags them as
`{ "__mq_date": "<iso>" }` and revives them.

**The replacer in `serialize.ts` must stay a `function`, never an arrow.**
`JSON.stringify` calls `Date.prototype.toJSON()` *before* the replacer sees the
value, so by then it is already a string and `instanceof Date` is false. The
only way to reach the original is `this[key]`, and an arrow function does not
receive that binding. Converting it to an arrow breaks date support silently —
every test that doesn't specifically assert types still passes.

### Watch DATES are a separate store — do not merge them into progress

`WatchedEpisodes` (see below) records **which** episodes are watched. It
deliberately records nothing about **when**.

That is not an oversight and must not be "fixed" by adding a timestamp to the
episode ranges. Attaching a date to each episode makes every episode unique,
which destroys the range encoding and takes a 30-show library's episode data
from ~3 KB back to ~183 KB — measured, see the note on `EpisodeRange` in
`lib/tracking/types.ts`.

**Phase 5 (streaks) and Phase 8 (Year in Review) both need watch dates.** That
log now exists — `lib/watchlog/`, built in Phase 5 Step 1 exactly as promised
here: a separate, append-only store keyed by date, in its own namespace with
its own schema version. Progress state and watch history are different
concerns with different shapes and different access patterns:

| | progress | watch history |
|---|---|---|
| question | "have I seen S3E7?" | "what did I watch in June?" |
| access | read constantly, per title | append on write, scanned in bulk |
| shape | ranges, keyed by season | events, keyed by date |
| mutability | edited freely | append-only |

Merging them forces one of the two to adopt the wrong shape. Keep them apart.

## Watch history — `lib/watchlog/`

```
lib/watchlog/
  types.ts    WatchEvent, day keys, local-date helpers, validation  [pure, tested]
  diff.ts     addedEpisodes(before, after)                          [pure, tested]
  queries.ts  streaks, per-year, totals, hour/weekday buckets       [pure, tested]
  store.ts    watchLogStore — namespace "watchlog", v1
  index.ts    public surface + appendWatchEvents / logEpisodeMutation
```

### One record per LOCAL calendar day

```
marquee:watchlog:2026-07-30 → { v: 1, d: [ {k,t,s,e,m,b}, ... ] }
```

`Store.keys()` strips the prefix and returns the bare key, so with a
day-keyed layout **the set of days with activity is `keys()` alone — no
record values are parsed at all.** Streak math reduces to listing keys and
sorting strings. That property is why keys in this namespace must stay
*exclusively* day keys: a stray metadata record would silently corrupt every
streak. "Tracking since" is derived as the earliest key precisely so no such
record is needed.

Measured at 3 episodes/day for two years (~2,000 events):

| shape | size |
|---|---|
| one key per event, ISO timestamp | ~310 KB |
| **day-bucketed (chosen)** | **~128 KB** |
| day-bucketed with tuple events | ~64 KB |

The tuple form was rejected on purpose: it halves a number already at ~2.5%
of budget, and costs real legibility in validation and future migrations. The
episode-range encoding earned its opacity with a 65x win; this would not.

### Timezone: the local date is frozen at write time

The day key is `YYYY-MM-DD` in the **device's timezone when the event was
recorded**, and is never recomputed. Storing an instant and deriving the day
at read time is actively wrong here: watch something at 8am Tuesday in Tokyo,
fly to LA, and that instant re-derives as Monday — **the user's streak history
rewrites itself because they travelled.** The day you watched something is a
fact about where you *were*.

⚠️ **Do not use `toISOString().slice(0, 10)` for this.** That returns the UTC
date. `lib/utils/dates.ts` uses that pattern for *air dates*, where UTC is
defensible, but here it would misfile evening viewing in every western
timezone. Demonstrated concretely at UTC+3: an event at 00:30 local on 30 July
files under **29 July** with the UTC pattern. `localDayKey()` uses
`getFullYear`/`getMonth`/`getDate` — the local accessors — and the suite
passes under both UTC and a non-zero-offset host.

Accepted edge case: crossing timezones can produce two day keys that felt like
one day, or skip one. That is the honest consequence of local dates.

### What this store is and is NOT authoritative for

**The log answers WHEN. Tracking answers HOW MUCH.**

Lifetime totals come from tracking state (`countRanges`), never from log
length. That split resolves two problems at once:

- **Backfill.** Existing users have watched data with no dates, and there is
  no honest way to invent them — `updatedAt` is one timestamp for a whole
  entry, so backfilling Breaking Bad from it would fabricate a 62-episode day
  and a streak that never happened. So **nothing is backfilled.** The log
  starts empty and `trackingSince()` makes the gap legible instead of
  invisible.
- **Un-marking.** Because totals never come from log rows, the log stays
  genuinely append-only — un-marking rewrites nothing and corrupts no count.

If XP were computed from log rows instead, backfill would reset every existing
user to zero and un-marking would require deleting from an "append-only" log.
Neither is necessary. **Do not re-point XP at the log.**

### Wiring: one diff, not six call sites

`applyEpisodeMutation` in `lib/tracking/context.tsx` is already the funnel
every episode operation passes through, and it holds both the before and after
`WatchedEpisodes`. `addedEpisodes()` diffs them, so `markEpisode` /
`markSeason` / `markSeasonUpTo` / `markWatchedUpTo` are all covered uniformly —
including operations added later — with no per-operation logging code.
Verified live: ticking S1E3 then hitting "mark season watched" logs **6 events,
not 7** — E3 is not re-logged, and keeps its non-bulk provenance.

Un-marks produce an empty diff and log nothing. Title-level `setStatus` logs
one movie (`k:"m"`) or one whole-show (`k:"t"`) event, and only on the
transition *into* watched, so re-marking can't duplicate.

`k:"t"` exists because the coarse "Watched" button sets `status` with empty
ranges and genuinely does not know which episodes exist — a third kind rather
than a silent gap for a common action.

### The `b` (bulk) flag, and the thing it is *not* for

Worth being precise, because the obvious worry is the wrong one: **N events on
one day does not break streak math.** Streaks count distinct days, so 13
events today is one day either way. The real problem is honesty — marking a
season watched today does not mean 13 episodes were *watched* today, and
logging it flat would invent a binge day in Year in Review. Streaks can still
credit the day; YiR can decline to call it a record session.

`bulk` is passed explicitly by each context method rather than inferred from
diff size. Inference happens to be correct today but would silently
misclassify a future operation, and this field is unrecoverable once written
wrong.

#### ⚠️ A bulk event's `m` records when you CLICKED, not when you watched

The note above anticipated half of the problem. The half it missed, found in
Phase 8 Step 1 by looking at real data before designing against it: **every
event in a bulk batch carries the same `m`** — the minute of the tap. Thirteen
episodes at 04:43 is one tap at 04:43.

That corrupts time-of-day and weekday aggregation, not just "biggest session".
Measured on a real 39-event log in which 33 events were a single "mark season
watched":

| | says |
|---|---|
| including bulk | "you watch most at **4am**" — 35 events in that hour |
| excluding bulk | that hour has **2** |

`byHourOfDay` and `byWeekday` in `queries.ts` both counted bulk events from
Phase 5 until Phase 8 Step 1. `byWeekday` skewed harder — it counted
`events.length` outright, so one 33-episode season mark added 33 to a single
weekday. Two shipped features were quietly affected: the stats dashboard's
hour histogram, and the **time-of-day badges**, where one 4am bulk mark could
earn "Night Owl". (Badges are ledgered and sticky, so the fix revokes nothing
already earned — only future evaluations change.)

Both now filter `b === 1`, and the filtering lives in `queries.ts` rather than
in each caller: there is no legitimate consumer of "what hour did you press
the button", so an opt-in flag would only be a way to reintroduce the bug.

One deliberate asymmetry: `byWeekday` still counts **untimed imports** while
`byHourOfDay` does not. A Letterboxd row has no clock time but a real calendar
date, so it knows exactly which weekday it was; discarding it would throw away
information we actually have.

### Log writes never block or fail a tracking write

Appended only *after* the tracking write succeeds (never log what didn't
persist), fire-and-forget, errors warned and swallowed. Marking something
watched must not fail because a history record couldn't be appended. One
read-modify-write per **day**, so a 13-episode season mark is one storage
round trip, not 13 — with the same no-lock caveat as the multi-tab gap below.

### Multi-tab — partly closed in Phase 6 Step 5

**What is fixed:** the sync side. `lib/sync/engine.ts` takes a Web Lock
(`ifAvailable`) around the outbox flush, so two tabs can no longer push the
same records twice or interleave read-modify-write cycles on the same day
record, and a `BroadcastChannel` tells other tabs when local storage changed
under them. Web Locks releases automatically when a tab crashes, which a
localStorage mutex cannot promise.

**What is still open:** two tabs mutating the *same* record through the
tracking or ratings context in the same instant still race, because each holds
its own React state and neither re-reads before writing. The window is a single
read-modify-write and each control disables itself while its own write is in
flight, so the realistic path stays sequential. Signed in, the damage is
bounded further — both writes reach the outbox and the server's LWW picks the
later intent — but signed out, the loser is simply lost. Closing it properly
means the contexts subscribing to the BroadcastChannel and re-reading, which is
a change to those contexts rather than to sync.

---

## Watchlist / watched state — `lib/tracking/`

```
lib/tracking/
  types.ts     TrackingStatus, TrackingEntry (discriminated on mediaType),
               EpisodeRange, WatchedEpisodes, SeasonEpisodeCounts
  ranges.ts    pure inclusive-range primitives + the canonical invariant
  progress.ts  episode operations and derived queries — pure, no storage
  store.ts     trackingStore — a lib/storage Store<TrackingEntry>, version 3,
               with the v1 -> v2 and v2 -> v3 migrations
  context.tsx  TrackingProvider + useTracking() — optimistic writes, rollback
  index.ts     public surface; import from here

components/tracking/
  tracking-badge.tsx    TicketCard's corner quick-toggle (watchlist only)
  tracking-actions.tsx  the full status control on the title detail page
```

`TrackingProvider` wraps `{children}` inside `<main>` in `app/layout.tsx` —
scoped there, not the whole `<body>`, because everything that currently reads
tracking state (TicketCard, My Library, the detail page) renders inside it.
Move it outward the day Sidebar or BottomNav need it too (an item-count badge,
say) — nothing about the provider itself assumes where it's mounted.

### One status, not two flags

`TrackingEntry.status` is `"watchlist" | "watching" | "watched"` — one field,
mutually exclusive by construction, matching the three sections of My Library
exactly. It is **not** a `watchlisted: boolean` plus a `watched: boolean`.
Setting a new status always replaces whatever came before; a title cannot be
simultaneously on the watchlist and marked watched. This was a deliberate
modeling choice, not an oversight — the three-section Library page is the
tell that the domain itself only has one status at a time.

`"Watching"` is offered only for TV (`TrackingActions` filters it out for a
movie). Phase 2 has no in-progress/position tracking at all — a movie is
watched in one sitting — so a "Watching" button for a movie would be present
and do nothing meaningful. Not shown beats shown-and-inert.

### Snapshots, not references

Each `TrackingEntry` stores a `TitleSummary` **snapshot** taken at the moment
of tracking (`toTrackingSummary()`, an explicit allowlist — the same pattern
as `mock/index.ts`'s `toSummary()`, for the same reason: spread-and-omit would
let a future `Title` field leak into every stored record without anyone
deciding it should). My Library renders directly from these snapshots rather
than re-fetching every tracked title from the provider on every visit, which
would be N calls for one page load. The tradeoff, stated plainly: a poster or
rating shown in My Library can go stale if the source data changes later. The
title detail page is unaffected — it always fetches a fresh `Title`
regardless of what's cached in a tracking entry.

### The corner badge is watchlist-only, on purpose

`TrackingBadge` (the TicketCard quick-toggle) only ever adds/removes
`"watchlist"`. Once a title is `"watching"` or `"watched"`, the badge renders
as a plain non-interactive indicator (`pointer-events: none`) — a check or eye
icon, not a button. A dense grid is exactly the wrong place for one mistap to
erase watched progress; changing those statuses requires the full control on
the detail page, which has room to ask more deliberately.

Structurally, `TrackingBadge` is a **sibling of TicketCard's `<Link>`, not
nested inside it** (`absolute` positioned, `z-10`, layered on top). A
`<button>` inside an `<a>` is invalid HTML and double-fires navigation on
click; siblings-with-layering avoids that outright rather than papering over
it with `stopPropagation`.

### Optimistic UI, and what "roll back visibly" means concretely

`setStatus()` / `remove()` on the tracking context update React state
**before** the storage write is even attempted, then await the write. On
failure they revert to the pre-optimistic snapshot and rethrow — callers are
expected to catch this and show something, which both `TrackingBadge` and
`TrackingActions` do: buttons flip back to their prior state, plus a visible
error (`role="alert"` text on the detail page; a `border-danger` flash plus a
screen-reader-only `role="status"` announcement on the compact badge, since
there's no room there for visible prose). The error clears itself after a few
seconds rather than sitting indefinitely.

Concurrency note, stated honestly rather than hidden: the rollback snapshot is
whatever `entries` was at the moment a specific call started, not whatever it
is when the write settles. Two concurrent writes to different keys can each
roll back over the other's optimistic update if both happen to fail around the
same time. Out of scope for Phase 2, which has no mutation queue — each caller
also disables its own control while its write is pending, so the actual common
case (one click, one in-flight write) is exact.

### Episode-level progress (Phase 3 Step 1)

`TvTrackingEntry.watchedEpisodes` is `Record<seasonNumber, EpisodeRange[]>`,
where an `EpisodeRange` is an inclusive `[start, end]` pair. See the long note
on `EpisodeRange` in `lib/tracking/types.ts` for the measurements behind that
choice; the summary is ~2.8 KB vs ~183 KB for a 30-show library, and the deeper
reason is that "mark everything up to here" — the operation people actually use
— is *natively* one range write per season.

**The canonical invariant (`lib/tracking/ranges.ts`): sorted, non-overlapping,
non-adjacent.** `[[1,3],[4,6]]` is never stored; it collapses to `[[1,6]]`.
Adjacency merging is what keeps a fully-watched 24-episode season at exactly
one range even when ticked off one episode at a time. Never hand-build these —
go through `ranges.ts`, and run anything off disk through
`normalizeWatchedEpisodes` before reasoning over it.

That invariant also buys real algorithmic simplicity: `nextUnwatched` is O(1)
per season rather than a scan, because if the first range starts at 1 then
non-adjacency guarantees a gap immediately after it ends.

Operations live in `progress.ts` as **pure transforms** of `WatchedEpisodes`;
`context.tsx` funnels all of them through one `applyEpisodeMutation` that owns
the optimistic update, rollback, normalization and status re-derivation. An
operation cannot get persistence wrong because it never sees it. Every one is
a single store write, including whole-season and binge-to-here.

Three behavioural decisions worth knowing:

- **Binge is a union, not a replace.** Marking up to S3E7 must not unmark an
  S5E1 the user had already ticked off out of order.
- **Specials (season 0) are opt-in and excluded from completion math.** Binging
  the main run never implicitly marks retrospectives watched, and
  `totalCount` / `percentComplete` / `nextUnwatched` ignore season 0 — otherwise
  a show never reaches 100% until you've watched every blooper reel.
- **`percentComplete` returns 100 only when genuinely complete.** 61 of 62
  episodes floors to 98, and the value is capped at 99 until `isComplete`.
  A user one episode short must never be shown "100%".

**Everything derived is computed, never stored** — remaining, percent, next
unwatched. Season structure is passed in as `SeasonEpisodeCounts` rather than
cached on the entry, because it is provider data: a returning show airing
episode 9 would silently make a stored total wrong. Ranges are also clamped to
each season's real length on read, so a stale `[1,13]` on a season trimmed to
10 reports 7 watched rather than 130% complete.

#### Coarse and fine granularity reconcile at the point of use

`status` and `watchedEpisodes` are two granularities of one fact, and `status`
is the one that always exists. A v1-migrated record — or a show marked watched
via the title-level button, which has no season list to work from — carries
`status: "watched"` with empty ranges.

`reconcileCoarseWatched()` expands that into concrete ranges **at the point of
use**, where the season list is finally in hand, and it runs on both the read
path (so queries report 100%) and before every edit (so a per-episode change
starts from "all watched" instead of silently discarding the user's earlier
statement). It is deliberately not a migration: migrations are pure and
synchronous and cannot fetch season data. That constraint is the whole reason
the v1 -> v2 migration is three lines — see the note in `store.ts`.

Status is re-derived after every episode mutation (`deriveStatus`): first
episode promotes to "watching", last promotes to "watched", and emptying
progress downgrades a now-contradictory "watched" to "watchlist". With no
season data available it returns the current status unchanged rather than
guessing.

---

## Search — `app/search/`

```
app/search/
  page.tsx        thin server shell (metadata only)
  search-view.tsx the real client component — input, filter, all fetching
```

Always goes through `httpProvider`, never `getContentProvider()` directly —
this is the client-data-seam abstraction from Phase 2 Step 1 doing its job:
Search needed a `signal` option on `searchTitles` to cancel in flight, and
that went into the shared `ContentProvider` interface (`provider.ts`) rather
than being bolted onto `httpProvider` alone, so mock/http both honor it and
`tmdbProvider` at least documents why it doesn't (see below).

### "Loading" is not a state variable — it's derived

The result of a search is one object: `{ forKey, status, items, errorMessage }`,
where `forKey` is `` `${trimmedQuery}::${mediaFilter}` ``. Render compares
`forKey` against the *current* query/filter to decide whether the stored
result is fresh; if it isn't (still debouncing, or a fetch is in flight, or —
edge case — the user changed the filter faster than the last fetch
resolved), the skeleton shows. There is no separate `isLoading` boolean.

This isn't a style preference — `setStatus("loading")` as the first line of
the effect body **fails the build**: eslint's `react-hooks/set-state-in-effect`
rejects synchronous `setState` in an effect's main body, precisely because
"loading" here is fully derivable from existing state rather than needing a
state variable of its own. Every `setResult(...)` call in this file lives
inside a `setTimeout` callback or a `.then()`/`.catch()` — genuinely
asynchronous continuations, which the rule allows — never at the top level of
the effect. If you're tempted to add `useState<boolean>` for a pending flag
here, check whether it's actually derivable first.

### Cancellation is two layers, and the second one matters more

1. **A real `AbortController`**, created per search and aborted in the
   effect's cleanup. Because React runs cleanup before the next effect fires,
   this alone cancels the previous request the instant the query or filter
   changes — no manual "abort the last one" bookkeeping needed.
2. **A request-id ref**, incremented per attempt; a `.then()`/`.catch()`
   discards its own result if the id has moved on.

Layer 2 is not redundant. `tmdbProvider.searchTitles` deliberately does not
act on `options.signal` (see the comment there) — extending it would mean
threading the incoming request's signal through
`app/api/content/search/route.ts` *and* `tmdbFetch`'s own timeout-signal
handling, which is real plumbing that belongs to the Step 1 client-data-seam
layer, not to building the search page. In TMDB mode, a stale request
therefore keeps running to completion and wastes the round trip — but its
result can never reach the screen, because layer 2 catches it regardless of
whether layer 1 actually stopped anything. Verified directly: a search whose
response was artificially held back until *after* a second, faster search had
already rendered did not overwrite it when finally released.

`SearchTitlesOptions.signal` is documented (in `provider.ts`) as allowed to
reject with the signal's own abort reason rather than a `ContentError` — an
aborted call isn't a content failure, it's the caller withdrawing the
request, and the request-id guard discards it either way without needing to
inspect what it rejected with.

### Three states, one thing in common: never blank

Idle (nothing typed), no results, and a fetch failure are all rendered
through `EmptyState`, same as everywhere else in the app. There's no fourth,
implicit "nothing rendered" branch — the `content` variable is assigned in
every branch of the if/else chain, with `results` as the trailing `else`.

### Tracking buttons work here for free

Search results are `TicketCard`s from the same `TitleGrid` component Home and
My Library use, so the watchlist quick-toggle from Phase 2 Step 3 is already
wired in — no search-specific tracking code exists. This is the payoff of
routing everything through one card component rather than a search-specific
result row.

---

## Season/episode UI — `components/tracking/season-list.tsx`

The title detail page for a TV title is wrapped in `Tabs` (Overview /
Seasons) instead of the flat layout movies still use — `TrackingActions`
sits above the tabs, always visible regardless of which one is active.
Movies are unaffected: `mediaType === "tv"` gates the whole tabbed branch.

```
app/title/[mediaType]/[id]/page.tsx
  fetches Title AND, for TV, Season[] via getSeasons() — both server-side.
  Season[] carries only episode COUNTS, never the episodes themselves.

components/tracking/
  show-progress-badge.tsx  hero badge: "24 / 62 episodes · 38%"
  season-list.tsx          the Seasons tab: show progress + season accordion
  progress-bar.tsx         shared by both of the above
```

### Only one season's episodes are ever mounted

Every season's *collapsed* row — name, progress bar, one button — is cheap
and computed from `Season.episodeCount` alone, already in hand from the
server-side `getSeasons()` call. Nothing about a collapsed row requires a
fetch. Expanding a season lazily fetches that ONE season's episodes via
`httpProvider.getSeasonEpisodes()` (the client-data-seam route from Phase 2
Step 1) and caches them; expanding a different season collapses the first.
**At most one season's episode list is in the DOM at any time**, regardless
of whether the show has 3 seasons or 20 — verified against Grey's Anatomy
(20 seasons): expanding season 12 after season 5 left total page height
essentially unchanged rather than additive, and only ~21 `<li>` elements
existed (one season's worth), not two seasons' worth combined.

This is *the* answer to "must not become an unusable wall" — it is a
consequence of the fetch strategy, not a separate collapsing trick bolted on
afterward.

### Unaired episodes — enforced at every level that can mark one watched

`isFutureAirDate()` (`lib/utils/dates.ts`) compares an episode's `airDate`
against today as a **plain string comparison** on the `"YYYY-MM-DD"` form —
deliberately not `Date` arithmetic, which would need timezone reasoning for a
value that's a calendar date, not an instant. `null` counts as NOT unaired:
most of the SEASON_SHAPES-tier shows (Breaking Bad, The Office, ...) have no
per-episode dates at all, only a real season premiere date, and treating
"unknown" the same as "hasn't aired" would make most of the catalog's TV
shows unmarkable.

An unaired episode is unmarkable through **every path that could mark it**,
not just the obvious one:

- The per-episode toggle and "mark up to here" — disabled outright.
- **"Mark season watched"** — this one is easy to get wrong, and did get it
  wrong once during testing: the pure `markSeason` in `progress.ts` has no
  concept of air dates at all (it only ever sees `SeasonEpisodeCounts` —
  numbers, never `Episode` objects), so it will happily mark a whole season
  including an episode that hasn't aired yet. The fix lives in
  `season-list.tsx`, the one place that actually holds real `Episode[]`
  data: clicking "mark season watched" ensures that season's episodes are
  loaded (fetching if the season was never expanded), finds the last AIRED
  episode, and marks only up to there.

**That fix introduced its own bug, caught by re-testing rather than assumed
fixed**: the obvious tool for "mark up to episode N" is
`markWatchedUpTo`/`markWatchedUpToEpisode` — but that function deliberately
sweeps every PRIOR season fully too (the correct behavior for the per-episode
binge button, "I binged to S4E2" implying you saw all of S1-3). Reusing it
for "mark season watched" would make marking a partially-aired season 4 also
silently mark all of seasons 1-3, which nothing in that button's label
promises. The real fix is `markSeasonUpTo` in `progress.ts` — same shape,
but scoped to ONE season, no sweep. `markWatchedUpTo` and `markSeasonUpTo`
look almost identical and exist for genuinely different callers; do not
collapse them into one "helpful" function.

### Progress percentages count scheduled episodes, including unaired ones

`episodeCount` on a currently-airing season includes episodes that haven't
aired yet (this matches how TMDB's own `number_of_episodes` works). A
consequence, accepted deliberately rather than special-cased: a currently
airing season/show can never show 100% — including one where every AIRED
episode is watched — until the unaired episode(s) actually air and get
watched too. Verified: The Bear's season 4, with episodes 1-3 watched and
episode 4 unaired, reports 75%, not 100%, and "Mark season watched" leaves
it at 75% rather than lying. This was a deliberate choice not to make, not
an oversight — excluding scheduled-but-unaired episodes from the denominator
would need threading air-date awareness into the pure progress-math layer
(`lib/tracking/progress.ts`), which currently knows only episode counts and
stays deliberately ignorant of dates. Revisit if it proves confusing in
practice.

---

## Per-title theming — `lib/theme/`

```
lib/theme/
  oklch.ts      pure colour-space maths + WCAG contrast
  harmonize.ts  clamp into the usable band, VERIFY, fall back to gold
  extract.ts    server-only: fetch artwork, sharp decode, hue histogram
  index.ts      resolveTitleTheme() + titleThemeVars()
  theme.test.ts 31 tests over the two pure modules
```

`oklch.ts` and `harmonize.ts` are pure — no I/O, no React — and carry the tests.
Only `extract.ts` touches the network, and it is `import "server-only"`.

### Extraction runs server-side. That was the whole decision.

The alternative is reading pixels off the loaded `<img>` with a canvas, which
costs the server nothing. It was rejected because it guarantees the page paints
in default gold and *then* lurches to the real palette, on every navigation —
and for a feature whose entire point is "this page feels like this title from
the moment you arrive", that flash isn't a blemish, it's the feature not
working. It would also last longest on slow connections, since it can't start
until the image has loaded.

What that costs is small and, crucially, paid per *title* rather than per
request: **3–9ms** to decode a 32×48 sample. Poster bytes sit in Next's
persistent fetch data cache; the derived palette sits in a bounded (256-entry)
process-local LRU in `extract.ts`.

Deliberately **not** `"use cache"`: that directive requires `cacheComponents:
true` in `next.config.ts`, which changes caching semantics for the whole app —
far too much blast radius for one visual feature. `unstable_cache` is deprecated
in Next 16. A cold server re-derives once, for single-digit milliseconds.

Failure handling distinguishes two classes on purpose: a successful decode that
finds no usable hue is a **permanent** property of that image and is cached (as
null), while a fetch/decode error is **transient** and is not cached — a network
blip must not poison a title's palette for the life of the process.

### Why OKLCH, and why hue is never touched

OKLCH's `L` is *perceptual*, so one lightness clamp behaves consistently across
every hue. In HSL, yellow and blue both claim `50%` lightness while differing by
roughly an order of magnitude in real luminance, so an HSL "safe band" would be
readable at some hues and illegible at others.

Only lightness and chroma are negotiable. **Hue is the title's identity** — it
is the entire reason a Chernobyl page reads cold and a Barbie page reads
electric.

The band was fitted to the brand colours so extracted accents land in the same
visual register as the designed ones:

| | OKLCH |
|---|---|
| gold `#e8b33c` | `0.795 0.143 83.5` |
| cyan `#35d6e8` | `0.804 0.127 206.5` |
| **band** | **L 0.74–0.86, C 0.07–0.19** |

### Clamping is NOT trusted to imply contrast

This is the part to not "simplify". WCAG relative luminance is not perceptually
uniform, so two colours at identical OKLCH lightness can differ substantially in
measured contrast. The band gets close; only measurement is authoritative.

Every candidate is verified against **both** roles the token plays — `text-accent`
on `--bg-base`, and `--fg-on-accent` text on an `bg-accent` fill — at
**4.5:1** (AA normal text, not the 3.0 large-text bar; `text-accent` is used at
metadata sizes). Failing candidates get walked lighter and re-measured; if
nothing in range passes, the caller falls back to gold.

The verify loop only ever walks lightness **up**, which is correct *only because
both reference surfaces are near-black* — raising L improves both ratios at
once. Introduce a light surface and the two constraints start pulling apart, and
this becomes a search rather than a walk. There's a note at the loop.

Measured on real posters, worst case across every tested title: **8.03:1** —
clears AA (4.5) and AAA (7.0).

### Provenance is explicit

`primaryOrigin` / `secondaryOrigin` are on the theme object and emitted as
`data-accent-origin` / `data-secondary-origin`, because these are genuinely
different claims and conflating them makes the feature impossible to debug:

- `artwork` — sampled from the real poster (preferred) or backdrop.
- `gradient` — sampled from the title's deterministic placeholder gradient.
  **Mock mode always lands here**, as does a tmdb title whose artwork yields
  nothing. Not extracted from any image.
- `derived` (secondary only) — no honest second hue existed, so this is the
  primary's hue rotated 150° (split-complement: reliably distinct without the
  vibration of an exact 180°). A design derivation, not an observation.
- `fallback` — brand palette.

Mock mode uses gradients rather than gold-for-everything so the feature is
actually visible offline; the gradient path runs the *identical* clamp-and-verify,
so it is held to exactly the same accessibility bar.

### Extraction tuning, and one bug worth remembering

Pixels are binned into 24 hue buckets, weighted by **chroma squared** so a small
vivid region outranks a large muted one. Letterbox black (`L<0.12`), blown
highlights (`L>0.95`) and greys (`C<0.02`) are dropped — they're properties of
the crop, not the artwork. If fewer than 5% of usable pixels carry any hue the
image is achromatic and the result is `null` (Schindler's List measures ~1%);
that's the difference between *near*-monochrome, whose faint hue gets amplified
to the chroma floor, and *truly* achromatic, which has nothing to extract.

Each bin's representative is **one real pixel** — ranked by chroma, 85th
percentile — using **both that pixel's L and its C together**. Percentiling L
and C independently synthesizes a colour from two different pixels that may
appear nowhere in the artwork, and in practice grabs the palest highlights of
the hue: it turned Spider-Verse's night-blue into a washed-out `#add6fe` where
the correct answer is `#7fb0de`. That bug shipped into the first draft and was
caught by diffing live output against the pre-measured prototype, not by any
test. Don't "tidy" that back into parallel arrays.

Source resolution was investigated as a suspect and **exonerated** — w185 vs
w500 changes mean chroma by <0.001, so no resample-kernel tuning is warranted.

---

## Accounts — `lib/auth/`

```
lib/auth/
  types.ts        AuthUser, AuthProfile, AuthAccount, SignUpInput, ...
  errors.ts       AuthError + kinds + SAFE_AUTH_MESSAGE
  provider.ts     the AuthProvider interface
  username.ts     format rules + reserved words          [pure, tested]
  form-state.ts   AuthActionState + IDLE_AUTH_STATE      [NOT "use server"]
  actions.ts      "use server" — the client seam
  anonymous/      anonymousAuthProvider — "never signed in"
  supabase/
    index.ts      supabaseAuthProvider                   [server-only]
    map-error.ts  GoTrue error -> AuthErrorKind          [pure, tested]
  index.ts        getAuthProvider() / getAccount()       [server-only]

lib/supabase/
  public-env.ts   URL + anon key, public by design
  server-env.ts   service role key                       [server-only]
  server-client.ts  per-request client                   [server-only]

proxy.ts          session refresh, and nothing else
app/auth/callback/route.ts   OAuth return + email links
```

**Signing in is an upgrade, never a gate.** Nothing in the app is behind it.
The three account-aware surfaces (`AccountCard` on Profile, `/account`, the
auth pages) each say so in copy, because that is the only way a user learns it.

### The three rules that shape everything else

1. **Local reads never touch the network.** `lib/tracking`, `lib/ratings`,
   `lib/watchlog`, `lib/badges`, `lib/xp` are untouched by this layer. An
   account is an identity; it is not yet a data path (Step 5).
2. **Auth is read server-side, written server-side.** Sessions are cookies,
   cookies are only writable from a Server Function or Route Handler, and a
   session the browser knows about but the server doesn't is the bug this
   avoids. Consequence: **no Supabase code ships to the browser** — `grep -ri
   supabase .next/static` is empty.
3. **Unconfigured is a supported mode, structurally.** `getAuthProvider()`
   returns the anonymous provider, whose `getAccount()` is `null` — the state
   every caller already handles.

### Where auth may be read, and where it may not

**Never in `app/layout.tsx`.** `cookies()` is request-time, so one call there
makes every route dynamic — Home, title pages, all of it — to render a chrome
element most visitors don't use. Verified in build output: with Supabase
configured, only `/account`, `/profile`, `/signin`, `/signup` are dynamic;
`/`, `/search`, `/library`, `/profile/stats` stay static.

`AccountCard` is a Server Component in its own `<Suspense>` on `/profile`, so
a slow auth round trip can't delay the XP/streak/badge cards that need no
server at all.

### Usernames

Format in **both** `username.ts` and a Postgres CHECK (the app can be
bypassed). Uniqueness **only** in the `lower(username)` unique index — never
select-then-insert, which is a race; a 23505 is an ordinary outcome. Reserved
words **only** in the app layer, which is a stated, accepted asymmetry.

Stored as typed, unique case-insensitively (GitHub's model). ASCII-only, and
that is a limitation not an oversight: Unicode usernames need
confusable-script normalization to not be an impersonation vector, and
half-doing that is worse than not doing it. Display names are unrestricted.

### Account enumeration is resisted in four places

Vague `invalid_credentials`; `email_not_confirmed` folded into it; password
reset that resolves for unknown addresses; and no error for an
already-registered signup email. Each is a place a well-meaning "better error
message" would undo the protection — the tests pin the second one specifically.

There is an availability RPC for **usernames** and deliberately none for
**emails**: a username is a public handle, an address is not.

### `proxy.ts` — and why rate limiting is still not allowed in it

Both files quote the same Next documentation line to reach opposite
conclusions, so the distinction matters:

| | needs | verdict |
|---|---|---|
| rate limiting | a counter surviving *between* requests | ✗ proxy — that's shared state, which proxy can't promise |
| session refresh | only *this* request's cookies | ✓ proxy — and nowhere else works |

A Server Component render cannot write a refreshed token (no `Set-Cookie`
after streaming starts), so proxy is the only place an ordinary page
navigation can persist one. Delete it and you get intermittent random logouts
under refresh-token rotation, not an obvious failure.

## Sync — `lib/sync/`

```
lib/sync/
  uuid.ts       v4 + deterministic v5              [pure, tested]
  wire.ts       local <-> server row translation   [pure, tested]
  merge.ts      the first-login merge              [pure, tested]
  reconcile.ts  steady-state LWW on pull           [pure, tested]
  outbox.ts     the offline queue
  state.ts      cursors, merge record, notes toggle
  backend.ts    SupabaseSyncBackend + nullSyncBackend
  engine.ts     sequencing and I/O only
  record.ts     the seam mutation funnels call
  context.tsx   SyncProvider + useSync()
```

**Local storage is a complete replica and every UI read hits it.** The server
is a convergence point, never the read path. Nothing in this package is on the
critical path of rendering anything.

### The pure/impure split is the safety property

`merge.ts` and `reconcile.ts` decide what data *becomes*, take snapshots, and
return plans. They touch no storage and no network, so every rule is testable
against plain objects. `engine.ts` does the sequencing and owns no decisions.
Keep it that way: this is the one operation in the app that can destroy years
of history, and "we tested it against a real database once" does not survive a
refactor.

### Two different merge rules, one principle

| | rule | why |
|---|---|---|
| First-login merge | union / max | joins two histories that never knew about each other, so "later" is meaningless |
| Steady-state pull | per-record LWW on `client_updated_at` | reconciles two views of one shared history, where a later edit genuinely supersedes |

### Three things that are easy to get wrong

1. **Write the derived event id back.** Pre-account log events get a
   deterministic v5; if it isn't persisted onto the local event, the merge
   duplicates the entire watch log on its second run. A replay test pins this.
2. **The pending-write guard.** A pull must never overwrite local state still
   sitting in the outbox, or an offline mark visibly vanishes and then returns.
3. **`CURSOR_COLUMN` must match the indexed column.** `updated_at` on every
   table. `if not exists` on an index matches the NAME, not the definition, so
   a mismatched index silently stays wrong.

### Conflict rules are in the database

Triggers, not client logic: a read-compare-write is a race, costs a round trip
per record, and PostgREST is public so client-side rules are bypassable. Stale
writes are skipped silently — raising would make the outbox retry forever a
write that is correctly being ignored. Trigger names must keep sorting
`clamp` before `lww`. See `supabase/tests/02_sync_conflict_rules.sql`, which
attacks them rather than asserting they exist.

### Backups

Taken before any merge, **never garbage-collected**, and a failed backup write
**aborts the merge** — the only place in this codebase where a failed local
write must stop the operation rather than degrade. `restoreSnapshot` is
additive on purpose: it does not delete records created since the snapshot,
because an undo that destroys newer work is worse than the bug it fixes.

## ⚠️ The service_role key — total blast radius, one importer

`SUPABASE_SERVICE_ROLE_KEY` carries **BYPASSRLS**. Every policy in every
migration under `supabase/` is simply **not applied** to a client holding it.

Be precise about what that means, because it is easy to file mentally next to
the other credentials and it does not belong there. Leaking the TMDB or OMDb
key costs a quota and a rotation. Leaking this one is **unmediated read and
write access to every user's library, ratings, private notes, watch history
and comments**, with no audit trail distinguishing it from legitimate traffic
and no database-side control able to intervene. It is the single most
dangerous value in the project.

**Exactly one file may import `lib/supabase/server-env`:**

```
lib/notifications/server/store.ts     the Phase 7 Step 5 notification cron
```

It earns that because the cron must read *every* user's follow rows and write
to *every* user's queue — precisely what own-rows RLS exists to forbid — and
runs with no `auth.uid()` to act as. Nothing else in the app has that shape;
everything else uses the user's own JWT and is subject to RLS.

**The guard test is the only thing stopping a second importer.**
`lib/notifications/service-role-guard.test.ts` enumerates importers and fails
on any file not in its allowlist. Nothing else prevents it: `server-only`
stops the key reaching a *browser*, and the typed table allowlist inside
`store.ts` constrains what *that module* can touch — but neither stops a new
file importing `server-env` and building its own unconstrained client. Only
the guard does. It is not a nicety; treat deleting or loosening it as removing
the containment itself.

Containment is also visible in the code rather than only asserted by the test:

- **The client never escapes.** `client()` in `store.ts` is module-private and
  is not exported. There is no `getServiceRoleClient()` anywhere. The named
  operations that module exports ARE the complete inventory of what the
  notifier can do.
- **Reachable tables are a typed allowlist.** `writeTable("comments")` does
  not compile. Neither does `writeTable("watched_episodes")` — that one is
  read-only-reachable on purpose, because the only legitimate reason to
  consult watch state is to *suppress* a redundant notification, never to
  modify anything. Verified by attempting it: TS2345.
- **No caller-supplied value picks a table or a user.** Every operation
  hard-codes its own table and takes typed arguments; there is no generic
  `query(table, filter)` seam for a future caller to widen.

If you need a second privileged path: first check whether the user's own JWT
would do — it almost always will. If it genuinely cannot, add a named module
with the same shape (private client, typed allowlist), add it to the guard's
allowlist with a comment saying why, and expect that entry to be reviewed.

## Comments — `lib/comments/`

```
lib/comments/
  types.ts      CommentScope, Comment, isGatedScope           [pure]
  validate.ts   body sanitization + length limits              [pure, tested]
  wire.ts       row <-> domain mapping, thread grouping        [pure, tested]
  errors.ts     CommentError + Postgres-code mapping           [pure, tested]
  queries.ts    server-only: the SSR + on-demand read path
  actions.ts    "use server" — post/edit/delete/like/report

components/comments/
  comment-section.tsx     server wrapper: gates on account, streams
  comments-client.tsx     owns thread state, dispatches mutations
  comment-item.tsx        one comment: like/reply/edit/delete/report
  episode-discussion.tsx  the per-episode lazy-loaded toggle
```

**The differentiator is enforced by the database, not the client.** A reader
who hasn't watched an episode gets zero rows for it — not a blurred row, not
something hidden-then-revealable in devtools. `can_view_comment_scope()`
(the migration) is the single source of truth for this, called both from the
RLS policies themselves and, via RPC, from `queries.ts` to decide what the UI
shows — never a second TypeScript reimplementation that could drift from what
the database actually enforces.

**Gating is asymmetric, on purpose**: TV title-level discussion is open (no
episode to move spoiler-bearing chat to instead), movie title-level and every
TV episode are gated on the reader's own (synced) watch status. See the
migration's header comment for the full reasoning.

**Two bugs that only live testing found, not the SQL adversarial suite**: a
missing try/catch around the data fetch that took down an entire title page on
a transient failure, and two INSERT calls missing `user_id`/`reporter_id` —
which failed as an ordinary-looking RLS rejection rather than the missing-field
bug it actually was, since a NULL compared against `auth.uid()` is never TRUE.
Both are detailed in the Phase 6 Step 6a status entry below; the second is
worth remembering as a category — an RLS rejection is not proof the POLICY is
wrong, verify what the row you're writing actually contains first.

## Phase roadmap

| Phase | Scope |
|---|---|
| 1 *(done)* | Foundation: content abstraction + both providers, design system, app shell, Home, detail page |
| 2 *(done)* | Search, My Library, watchlist/watched state |
| 3 *(done)* | Episode-level progress, "Up Next" engine |
| 4 *(done)* | Rich detail pages with artwork-derived dynamic theming |
| 5 *(done)* | XP, levels, streaks, badges, stats dashboard; PWA manifest + service worker |
| 6 *(done)* | API rate limiting, Supabase accounts + sync, spoiler-safe comments, shared lists — design in `docs/phase-6-sync-design.md` |
| **7** *(done)* | CSV importers (IMDb, Letterboxd, Trakt; TV Time deliberately skipped), the new-episode feed, new-episode push notifications — designs in `docs/phase-7-import-design.md` and `docs/phase-7-notifications-design.md` |
| **8** *(current)* | Year in Review; Home customization — reorderable sections, first-page picker |

**Do not build ahead of the current phase.** Architect so later phases slot in;
do not implement them early.

---

## Phase 1 status

- [x] **Step 1** — Scaffold, design tokens, fonts, env files, this document
- [x] **Step 2** — Content layer: types, interface, errors, mock provider + catalog
- [x] **Step 3** — TMDB provider, normalization, `server-only` guards
- [x] **Step 4** — Design system: Button, Card, Badge, Tabs, Skeleton, EmptyState, TicketCard
      *(the temporary `/styleguide` route was deleted in Step 6)*
- [x] **Step 5** — App shell: nav, four routes, footer
- [x] **Step 6** — Home (trending grid) + `/title/[mediaType]/[id]`

**Phase 1 is complete.**

## Phase 2 status

- [x] **Step 1** — Client data seam: `app/api/content/*` route handlers +
      `lib/content/http/httpProvider`
- [x] **Step 2** — `lib/storage/` — async KV layer: namespaced keys, versioned
      envelope with lazy per-record migrations, graceful degradation,
      Date-safe serialization
- [x] **Step 3** — Watchlist / watched state: `lib/tracking/`, optimistic UI
      with visible rollback, TicketCard quick-toggle, detail-page controls,
      My Library's three sections
- [x] **Step 4** — Search UI: `app/search/`, debounced + cancellable, three
      EmptyState-backed states, media-type filter, tracking-enabled results

**Phase 2 is complete.**

## Phase 3 status

- [x] **Step 0** — Mock catalog episode data expanded: 5 shows fully
      hand-authored to cover distinct Up Next edge cases, real per-season
      shapes for 6 more (see `mock/episodes.ts`)
- [x] **Step 1** — Episode-level data model: range encoding, v1 -> v2
      migration, operations + derived queries (`lib/tracking/progress.ts`)
- [x] **Step 2** — Season/episode UI on the title detail page: Seasons tab,
      per-season accordion, episode watched toggles, "mark up to here",
      unaired-episode handling (`components/tracking/season-list.tsx`)
- [x] **Step 3** — The "Up Next" engine, over `nextUnwatchedEpisode`:
      weighted ranking (`lib/tracking/upnext.ts`, unit-tested — this
      introduced Vitest to the repo) surfaced as a Home rail
      (`components/tracking/up-next-rail.tsx`)
- [x] **Step 4** — Up Next surfaced beyond the Home rail. Reuses the Step 3
      engine (`selectUpNextCandidates` / `buildUpNextItem` / `rankUpNext`) —
      the fetch-orchestration logic that used to live inline in
      `UpNextRail` was pulled out into `components/tracking/use-up-next-items.ts`
      (a hook) and `up-next-card.tsx` (the card, now `w-full` so it fits a
      grid cell as well as the rail's fixed-width scroll slot) specifically
      so this step's two consumers didn't duplicate it:
      - [x] Empty state for Up Next — routes to Search (Home; Trending is
            already one scroll down on that page) or both Search and
            Trending (Library, where neither is otherwise reachable).
            Replaces the bare `return null` from Step 3.
      - [x] "Continue Watching" section in My Library
            (`components/tracking/continue-watching-section.tsx`) — the
            fuller, untruncated, responsive-grid view of the same ranked
            list, replacing what used to be a plain "Watching" `TitleGrid`
      - [x] Progress bars on `TicketCard` for in-progress (`"watching"`)
            shows (`components/tracking/ticket-progress-bar.tsx`) — a client
            wrapper rendered as a sibling of `TrackingBadge` (same reasoning:
            a mask lives strictly on an inner, non-interactive element, so
            this is never nested inside `.ticket-surface`/`.ticket-lift`).
            Fetches `getSeasons` only — episode COUNTS are enough for a
            percentage via the existing `getTitleProgress`, no per-episode
            fetch needed. Positioned `calc(var(--ticket-stub) + 0.5rem)` up
            from the card's bottom edge specifically to clear the
            perforation seam, after reusing `.ticket-surface` itself
            (not just its offsets) garbled the up-next card once already —
            see the comment in `up-next-card.tsx`.

**Phase 3 is complete.**

## Phase 4 status

- [x] **Step 1** — Real poster and backdrop images. The gradient placeholder
      is now the FALLBACK, not the default — it still renders whenever
      there's no `posterUrl`/`backdropUrl` (mock mode, always) or the real
      image failed to load (tmdb mode, occasionally), via `onError`.
      next/image throughout: `image.tmdb.org` permitted as a remote pattern
      in `next.config.ts`; the TMDB poster size in
      `lib/content/tmdb/normalize.ts` is split into `posterCard` (w342 —
      every grid/list context: TicketCard, search results,
      similar/recommendations, Up Next cards) vs `posterDetail` (w500 — only
      the one, larger detail-page hero poster), so a 230px-wide grid card
      and a 176px hero poster never ship the same source bytes; each render
      site then supplies its own `sizes` (see `POSTER_GRID_SIZES` in
      `lib/utils/grid.ts` for the grid math, and the `sizes` constants in
      `up-next-card.tsx` / the detail page for the other two) so next/image's
      own responsive `srcset` negotiation picks correctly-small derivatives
      per breakpoint on top of that. Blur-up is a hand-rolled `blurDataURL`
      matching each title's own placeholder gradient
      (`lib/utils/image.ts`) — Next can only auto-generate a blur preview for
      statically imported local files, not runtime remote URLs, so this
      reuses the same two gradient stops the true fallback already shows,
      meaning loading and "no image" share one visual language instead of
      two. `components/title/poster-image.tsx` (TicketCard, the Up Next
      card, and the hero poster) and `backdrop-image.tsx` (the hero backdrop
      only — no monogram, since the hero's own gradient wash layer is
      already its fallback) are both Client Components specifically because
      the `onError` handler is an event handler, and a Server Component
      cannot pass one to next/image across the boundary.
- [x] **Step 2** — Dynamic per-title theming: accents resolved from each
      title's own artwork (or its placeholder gradient in mock mode) and set
      on the existing `data-title-theme` wrapper, so every `bg-accent` /
      `text-accent` / `border-accent` re-tints with no component changes.
      Server-side extraction (no flash of default colours), OKLCH clamping
      with **measured** WCAG AA verification in both token roles, and an
      invisible fall back to marquee gold. See `lib/theme/` above for the
      full reasoning — especially why clamping alone is not trusted, and the
      independent-percentile bug. Adds `sharp` as an explicit dependency: it
      was already present as a transitive dep of Next, and relying on a
      transitive we don't declare is a latent break.
- [x] **Step 3** — Cast, key crew, and "Where to Watch" on the detail page.
      `Title.crew: CrewMember[]` is new (`lib/content/types.ts`); `CrewRole`
      is deliberately narrower than "everyone who worked on this" —
      `"creator"` (TV, from TMDB's stable `created_by`) or
      `"director"`/`"writer"` (movie, from `credits.crew` filtered by
      department). TV does NOT get director/writer credits: a TV show's
      aggregate `credits.crew` reflects whichever episode TMDB last indexed,
      not the series as a whole, so attributing it to the show would be
      attributing a random episode's crew — not attempted rather than shown
      wrong. See the doc comment on `toCrew` in `lib/content/tmdb/normalize.ts`.
      `components/title/cast-crew-section.tsx` renders NOTHING (no heading,
      no empty box) when both lists are empty, and cast/crew render
      independently of each other — Grey's Anatomy in the mock catalog is
      the deliberate "no crew credited" edge case, cast still shows fine on
      its own. Cast/crew photos reuse `PosterImage` from Step 1 (same
      gradient-plus-monogram fallback, just circular), namespaced by
      `person-${id}` so the same real person gets the same gradient whether
      they show up as an actor or a director.
      `components/title/watch-providers-section.tsx` renders nothing when
      `getWatchProviders()` returns `[]` — which is *always*, in mock mode
      (see the comment in `lib/content/mock/index.ts`), so mock mode never
      shows this section at all; that IS the graceful-empty-data path, not a
      gap in it. Region defaults to `"US"` inside the provider — the
      plumbing is region-*capable* (interface, API route, and this component
      all accept/pass a region) but not region-*aware* of any real visitor,
      since that needs geo-IP infrastructure this project doesn't have yet.
      **JustWatch attribution is structural, not a separate step to
      remember**: the credit lives inside the same early-return as the
      section itself, so it is impossible to render provider data without
      the credit or render the credit without data.
      One real bug caught by browser-testing against live TMDB data, not by
      any test: `toCrew`'s de-dup Set was originally shared across the
      director and writer filters, so a person credited as both (Matt Reeves
      on The Batman — director AND one of four writers) was silently dropped
      from Writers because he'd already been marked "seen" as Director. Mock
      mode's crew is hand-authored and never exercises `toCrew` at all, so
      this shipped past lint/build/tests/mock-mode-verification and was only
      caught by loading a real title in tmdb mode. Fixed by scoping the
      de-dup Set to each role's own list. Don't reintroduce a shared Set —
      the dedup is meant to catch one person holding two jobs in the SAME
      role (e.g. "Screenplay" + "Story"), not to prevent a person appearing
      in two different roles.
- [x] **Step 4** — External ratings (IMDb / Rotten Tomatoes / Metacritic) via
      OMDb, alongside TMDB's own score. `getExternalRatings(id, mediaType)` is
      on the `ContentProvider` interface and implemented in both providers;
      see the OMDb credential rules above. Key points:
      - **OMDb is keyed by IMDb id, and getting one differs by media type.**
        TMDB returns `imdb_id` at the top level of a MOVIE detail response but
        a TV detail response has no such field — a show's IMDb id only exists
        under `external_ids`, which needs `append_to_response=external_ids`.
        Using only `imdb_id` would have silently produced zero ratings for
        every TV show. `extractImdbId` checks `external_ids` first so both
        media types resolve through one path.
      - `getTitle` and `getExternalRatings` both go through
        `fetchTitleDetail()` so they issue the **identical** TMDB URL and
        share one data-cache entry. Next's data cache is keyed by full URL, so
        a differing `append_to_response` string would silently double our TMDB
        call volume per detail page. Don't inline either call site.
      - **OMDb reports failure in the BODY** (`Response: "False"`), sometimes
        with HTTP 200, and returns **401 for both an invalid key and an
        exhausted quota** — so status code alone cannot tell those apart. The
        `Error` string is the only signal distinguishing `rate_limited` from
        `unauthorized`. Probed against the live API; see `kindFromOmdbError`.
      - "OMDb has no record of this title" returns `[]` rather than throwing.
        That's an ordinary outcome, not a failure.
      - **OMDb carries no Metacritic score for TV at all, and only sporadic
        Rotten Tomatoes.** Measured against the live API with a real key:
        `Metascore` was `"N/A"` for 6/6 series tested (Breaking Bad, Game of
        Thrones, Chernobyl, Stranger Things, The Simpsons, Rick and Morty),
        and only Breaking Bad had an RT entry. All 4 movies tested returned
        all three sources. So a **movie shows four rating chips and a TV show
        usually shows two** — that is the data source's limit, not a bug, and
        it is exactly why the row degrades per source rather than assuming a
        fixed set. Do not "fix" this by fabricating TV scores; if full TV
        coverage is ever wanted it needs a different upstream.
      - `lib/content/omdb/normalize.ts` is deliberately **not** `server-only`
        (same reasoning as `http/wire.ts`: pure parsing, no credential) so it
        can be unit-tested — 16 tests over realistic OMDb payloads covering
        `"N/A"` strings, comma-grouped vote counts, out-of-range values, and
        failure-reported-as-200. This is the layer mock data cannot exercise.
      - The row **degrades per source by construction**: it maps over the
        ratings that exist, so a missing source renders nothing and no
        combination can produce an empty box. With every external source
        missing it still shows TMDB alone. Mock mode deliberately ships
        incomplete data for three titles (`MOCK_RATING_OMISSIONS`) so those
        paths are reachable offline instead of only against a live API.
      - Streamed in its own `<Suspense>` boundary — "never block the page on a
        secondary source" means OMDb's latency must not sit in the page's TTFB.
      - Source marks use each brand's colour, NOT the Step 2 page accent: the
        whole value of five sources is telling them apart. Metacritic uses its
        real green/yellow/red score bands, which is both authentic and avoids
        its brand yellow colliding with IMDb's near-identical one.
- [x] **Step 5** — A user's own 0–100 rating and private notes, on any title
      marked "watched". `lib/ratings/` — a SEPARATE store from
      `lib/tracking/`, not a field on `TrackingEntry`: different access
      pattern (edited rarely, via a dedicated control) and a different
      versioning lifecycle, same reasoning CLAUDE.md already gives for
      keeping watch dates out of episode-progress data. `score` and `note`
      are independent — a title can have one without the other — and if a
      patch leaves BOTH empty the record is deleted rather than persisted as
      an empty husk (`mergeRatingPatch` in `lib/ratings/types.ts`, a pure
      function with its own test file, 20 tests). Version 1, no migrations
      yet — same "must never be deleted once written" discipline as
      `trackingStore`.
      - **The slider is a native `<input type="range">`**, not hand-rolled —
        "must work well with a thumb on mobile" is most of what native
        range inputs already are, and a custom pointer-tracking
        implementation would just reimplement years of browser touch tuning
        worse. `accent-accent` themes the native thumb/track to the Step 2
        per-title accent for free.
      - **Commit strategy, and why**: React's `onChange` for a range input
        fires on the native `input` event — continuously, on every pixel of
        drag — not on `change`, which only fires once on release. Relying on
        that distinction would write to storage on every intermediate value.
        So `onChange` only updates LOCAL state; the actual commit is wired to
        `onPointerUp` (mouse AND touch — Pointer Events unify them) and
        `onKeyUp` (arrow-key adjustment), with `onBlur` as a safety net. A ref
        tracks the last-committed value so blur-after-pointerup doesn't
        double-write. See the doc comment in `rating-slider.tsx` before
        "simplifying" this to a plain `onChange` — that reintroduces the
        write-per-pixel problem.
      - **Notes autosave**: debounced (800ms) while typing, flushed
        immediately on blur. No Save button — nothing else that mutates
        tracking/rating state in this app has one, and this would be the odd
        one out. The one accepted gap: closing the tab mid-debounce with no
        blur loses the last unsaved keystrokes, the same tradeoff already
        made for search debouncing.
      - **"YOU" in the ratings row and the editing control are deliberately
        two separate components** (`MyRatingChip`, `MyRatingSection`)
        reading the SAME `useRatings()` context rather than one owning the
        other's state — they can't disagree, and the editing control isn't
        squeezed into a chip. Both gate independently on `useTracking()`'s
        status being `"watched"`; showing a rating control for something you
        haven't watched isn't a control this app offers.
      - **A real bug, caught only by looking at the rendered page**: Bebas
        Neue's em-dash glyph renders almost invisibly at `text-display-2xl`
        — confirmed via `getBoundingClientRect` (a real 40×80px box) with
        nothing visibly inside it. Lint, types, and build all passed with it
        in place. `font-display` is documented above as valid for
        titles/nav/headers, not arbitrary punctuation, and this is exactly
        that failure mode. Fixed by rendering "Not rated" in `font-sans` body
        text instead of a lone "—" in the display face — see the comment in
        `rating-slider.tsx`. Don't put a bare symbol into `text-display-*`
        without checking it renders.
      - **My Library's "Rated" filter** lives only on the Watched section
        (`app/library/library-view.tsx`) — rating requires "watched", so
        Watchlist has no toggle. Switching to "Rated" swaps the empty-state
        copy too ("No rated titles yet" vs "Nothing watched yet"), because
        those are genuinely different situations and showing the wrong one
        would misdirect the user.

**Phase 4 is complete.**

## Phase 5 status

- [x] **Step 1** — The append-only watch-date log (`lib/watchlog/`), fulfilling
      the promise made in "Watch DATES are a separate store" since Phase 3.
      See that section above for the full design: day-bucketed records keyed
      by **local** calendar date frozen at write time, `keys()`-only streak
      math, no backfill (an honest gap, never invented dates), and the
      when/how-much split that keeps the log genuinely append-only. Wired into
      every mutation through a single before/after diff in
      `applyEpisodeMutation` rather than six call sites. Ships the pure query
      functions (streaks, per-year, totals, hour/weekday buckets) with 64
      tests; **no UI** — that is Step 3.
- [x] **Step 2** — XP and levels (`lib/xp/`).
      - **XP is computed, never stored** — `computeXp()` in `formula.ts` is a
        pure function over already-resolved counts, so the whole curve can be
        retuned with no migration. What DID need a small, deliberate schema
        change (`trackingStore` v2 -> v3) is two XP-only fallback fields:
        `MovieTrackingEntry.runtimeMinutes` and
        `TvTrackingEntry.knownEpisodeCount`, captured for free from the full
        `Title` that `TrackingActions` already has in hand at the moment
        `setStatus` is called (see the `hint` parameter in
        `lib/tracking/context.tsx`) — no new provider fetch, and no
        contradiction of "season structure is not stored on the entry": these
        are single scalars for one XP edge case, not cached season data. Old
        records migrate to `null` — an honest gap, matching the watch log's
        own no-backfill decision, not a fabricated number.
      - **Episodes earn a flat rate; movies earn real per-title runtime.**
        Accepted, deliberate asymmetry: true per-episode accuracy would mean
        threading runtime into the watch log per event, which that log's own
        design brief reserves for time-windowed figures, and precise
        per-episode data fights the entire reason the range encoding exists.
        The flat rate still delivers the case that matters — a 2-hour film
        outscores a single episode by a wide margin.
      - **Season-complete bonus is scoped to "watching" shows only** — the
        one place in this codebase a `getSeasons()` fetch happens for XP, and
        it's the same bounded, ref-guarded, cached-per-showId idiom Up Next
        already uses (a third appearance of that pattern, not a new one). A
        "watched" show earns the flat series bonus once; season bonuses are
        NOT retroactively enumerated for it — doing so would need a season
        fetch for every finished show just to count them, real cost for what
        was asked for as a "small bonus."
      - **The level curve's exponent is 2.2, tuned across two rounds of the
        same Phase 7 import pressure-test, each against a bigger scenario
        than the last.** `xpForLevel(2) = BASE * 1^x = BASE` for ANY
        exponent, so the exponent reshapes only the late curve while leaving
        "level 2 within the first session" untouched — level 3 barely moves
        either. Round 1 (1.7 → 2.0): a modest 2,000-episode CSV import at
        1.7 landed past level 100 — past the entire rank ladder on day one.
        2.0 fixed that specific case. Round 2 (2.0 → 2.2): 2.0 was
        pressure-tested against too small a scenario. A REALISTIC heavy
        importer — the profile actually likely to use a CSV import feature,
        not a contrived extreme — is closer to 3,000 episodes + 500 movies
        (~370,000 XP), and at 2.0 that landed at level 69: one level short of
        "Marquee Legend" (71+), still maxed out for practical purposes. 2.2
        puts the same scenario at level 47 (Critic) — real headroom left.
        Stopped there rather than pushing to 2.4 (which would put it at
        level 34): that starts undervaluing a genuinely large REAL library,
        and the same curve governs an organic multi-year user, not just
        importers. Both scenarios are named test cases in
        `lib/xp/xp.test.ts`, "the Phase 7 import scenario" — retune this
        constant again if either ever proves wrong in practice; the tests
        will say which.
      - **Ranks**: Ticket Holder → Matinee Regular → Aisle Seat Veteran →
        Repertory Regular → Film Buff → Cinephile → Projectionist → Archivist
        → Critic → Auteur → Festival Programmer → Marquee Legend (71+, open-
        ended top rank). See `RANKS` in `lib/xp/levels.ts`.
      - **Level-up detection needs a persisted marker**, not just a `useRef`:
        XP is recomputed fresh every render, so "did the level just increase"
        can only be answered against a REMEMBERED prior value that survives a
        reload. `lib/xp/store.ts` — one record, "highest level seen" — goes
        through `defineStore` like everything else persisted in this app,
        even for a single scalar, rather than touching `localStorage`
        directly. The toast is a one-shot signal (`useXp()`'s
        `justLeveledUp`), checked once per mount, and the new level is
        persisted immediately so a reload mid-celebration can't re-fire it.
      - Reduced motion needed no bespoke handling in the toast — `motion-safe:`
        classes (matching `ProgressBar`'s existing idiom) plus the global
        `@media (prefers-reduced-motion: reduce)` rule already in
        `globals.css` both apply; content still appears instantly either way.
      - **A real Rules-of-Hooks bug, caught before it ever ran**: the first
        draft of `use-xp.ts` had an early `return` sitting between two hook
        calls, gated on `ready`. That's invisible while `ready` starts and
        stays false, and breaks the moment it flips true mid-lifetime — a new
        hook call appearing at a position React didn't see on the previous
        render. Caught by re-reading the hook's own control flow against the
        Rules of Hooks before ever loading a browser, not by lint or the type
        checker (neither flagged it). Fixed by moving every hook above any
        conditional return and branching only on the RETURNED values.
      - 46 new tests across `lib/xp/xp.test.ts` and `resolve.test.ts`
        (formula, level curve, rank boundaries, the coarse-mark fallback
        rule, season-completion math including the Season-0 exclusion).
      - XP bar lives on `/profile` (`components/profile/`), reusing
        `ProgressBar` from `lib/tracking` unmodified — "same visual, same
        math" already covered this third use case with no new component.
- [x] **Step 3** — Streaks (`lib/watchlog/streaks.ts`). Badges are not part of
      this step — split out of the original "Streaks and badges UI" line;
      badges remain unscheduled.
      - **Freezes are computed, never stored** — same discipline as XP.
        `computeStreakStatus()` re-derives `currentStreak`, `longestStreak`,
        and `freezesAvailable` from nothing but the log's day keys (the same
        `keys()`-only read `currentStreak`/`longestStreak` in `queries.ts`
        already used), every time it's called. No new persistence exists for
        this feature at all.
      - **The mechanic**: 1 freeze banked per `FREEZE_EARN_INTERVAL_DAYS` (7)
        of *lifetime* active days — not "days within an unbroken streak",
        deliberately, because tying earning to streak length would make
        freezes require the very thing they exist to protect against — capped
        at `MAX_BANKED_FREEZES` (3). A freeze bridges exactly ONE missed
        calendar day; two or more consecutive missed days break the streak
        regardless of freezes banked. Spent greedily, in chronological order,
        the moment a bridgeable gap is walked.
      - **`queries.ts`'s `currentStreak`/`longestStreak` were left
        untouched**, not replaced — they're still the correct answer to "the
        raw, unforgiving streak", and `streaks.ts` is intentionally a
        separate module built alongside them, not a rewrite.
      - **The "mid-day, not yet extended" rule extends naturally to a second
        day when a freeze covers it.** Gap-to-today of 0 or 1 = alive as
        before (Step 1's rule, unchanged). Gap of exactly 2 (yesterday missed,
        nothing logged yet today either) = alive AND `freezeActive: true` if
        a freeze is banked, otherwise broken. Gap of 3+ = broken regardless —
        a freeze forgives one off day, not an extended absence. This live
        "gap to today" case is provisional by construial, not by a stored
        flag: if the user logs something today it becomes the next day walked
        by the historical loop, which spends the freeze for real; if they log
        nothing today either, the gap grows past what any freeze can bridge
        on the next call. Nothing needs to be "given back" either way.
      - **A backdated entry can only help, never retroactively break an
        existing streak — proved as a structural invariant, not asserted.**
        Because the whole computation is a stateless walk over the FULL
        sorted day-key set every time (never incremental, never dependent on
        insertion order), inserting one more active day can only narrow an
        existing gap or leave others unchanged — narrowing a gap can only
        hold a run's length steady or extend it, and can only hold freeze
        spend steady or free one up. There is no path through the loop where
        adding a day lowers `currentStreak`, `longestStreak`, or
        `freezesAvailable`. Tested directly: every possible single-day
        backfill across three different fixture scenarios (including one with
        a freeze-bridged run) is checked to never regress any of the three.
      - **`dayDifference()`** (new, in `lib/watchlog/types.ts`) computes whole
        calendar days between two day keys through `Date.UTC` on both sides
        rather than subtracting two local `Date`s — local subtraction is off
        by one across a DST boundary (a 23- or 25-hour day isn't
        86,400,000ms), while anchoring both sides through the same UTC
        conversion cancels the local offset out entirely. Verified directly
        against both the 2026 US spring-forward (03-08) and fall-back (11-01)
        dates, not just asserted correct.
      - **No guilt-tripping messaging, by design, in two different ways for
        the two surfaces.** `StreakBadge` (Home, `components/streak/`) is the
        "ambient but not nagging" placement — a small accent-tinted chip
        (`Badge variant="accent"`, same visual language as
        `ShowProgressBadge`) that renders NOTHING at a 0 streak rather than
        showing "0-day streak", because a visible zero would itself be the
        nag. `StreakSummary` (Profile) states a 0 streak plainly instead
        ("no active streak right now — watch something to start one") since
        Profile is a page visited specifically to check stats, where silence
        would read as broken rather than absent. Neither surface uses
        danger/warning tokens, a countdown, or urgency copy anywhere;
        `freezeActive` is framed as reassurance ("protected by a freeze" /
        "still alive"), never as a warning.
      - **`useStreak()`** (`components/streak/use-streak.ts`), shared by both
        surfaces, same orchestration-hook idiom as `use-up-next-items.ts` and
        `use-xp.ts`. Re-fetches `getActiveDays()` whenever `useTracking()`'s
        `entries` changes — not because tracking state and the watch log are
        the same thing, but because a tracking mutation is the only thing
        that ever appends to the log, so `entries` changing is a cheap,
        close-enough proxy for "the log may have changed" without a dedicated
        event bus for one hook. Documented as an accepted approximation (it
        can re-fetch on tracking changes that never touch the log, e.g.
        moving something to "watchlist") rather than a precise dependency.
      - 25 new tests in `lib/watchlog/streaks.test.ts` (earning, capping,
        spending, the live gap-to-today case, the backdating invariant,
        DST-boundary `dayDifference`) — 228 total across the suite.
      - **Not independently verified in-browser this step** — the Chrome
        extension was disconnected for the whole session. Verified instead:
        lint/tests/build all pass, and the actually-running dev server's own
        log showed both new components compiling and hot-reloading with zero
        errors when Home and `/profile` were requested. The visual/interactive
        pass (badge appearance, Profile card, 375px) is still owed.
- [x] **Step 4** — Badges (`lib/badges/`). 20 badges across five categories —
      exploration, completion, habit, taste, discovery — designed around
      taste and exploration rather than raw volume (a "watched 100 episodes"
      badge was explicitly rejected as boring during design review; "watched
      titles across 6 genres" says something about the person instead).
      - **Unlock conditions are pure, computed functions over data already in
        hand** — `lib/tracking`, `lib/ratings`, `lib/watchlog` — no badge ever
        triggers a content-provider fetch to evaluate. Two ideas from the
        original proposal (a country-diversity badge, a real-vote-count
        "obscure title" badge) were dropped because `Title`/`TitleSummary`
        carry no `originCountry`/`originalLanguage`/`voteCount` today; adding
        them is real scope (new field on `Title`, implemented in BOTH
        providers) deferred rather than done implicitly. Noted here as
        candidates if `Title` is ever extended: **Passport** (5 distinct
        countries) and **Under the Radar** (watched something under ~500 TMDB
        votes). "First to Know" (watched something TMDB has no rating for at
        all) ships instead, using data already on hand.
      - **Derived-not-stored could NOT be taken literally, and that's a
        deliberate, discussed exception, not a lapse.** Most badges are
        monotonic (genres watched can only grow), but a few conditions — most
        notably "Caught Up" (watchlist currently empty) — can become false
        again later. A purely live-recomputed badge would flicker on and off
        the badge case and give the unlock toast no reliable moment to fire,
        the identical problem `lib/xp/store.ts`'s `seenLevelStore` already
        solved for level-ups. **`lib/badges/store.ts`'s `badgesEarnedStore`
        mirrors that store exactly**: one record per earned badge, key =
        badge id, value = `{ earnedAt }`. Nothing about a badge's UNLOCK
        LOGIC is stored — only WHEN it first became true — so adding or
        retuning a badge's predicate still needs no migration, which is what
        "derived, not stored" was actually protecting.
      - **`evaluateBadges()` (`lib/badges/evaluate.ts`) is pure**: given the
        20 definitions, a `BadgeContext`, and the current ledger, it returns
        every badge's live status (`record !== undefined || predicate(context)`
        — ledgered OR live-true, which is exactly what makes stickiness work)
        plus which ids are newly true and NOT yet ledgered. It does not touch
        storage; `components/badges/use-badges.ts` decides what to persist
        and when to celebrate.
      - **First-ever-evaluation backfills silently, with no toast storm.** A
        user adopting this feature after months of existing tracking/rating/
        streak history would otherwise open Profile to 6+ toasts firing at
        once for things they did long before badges existed. `useBadges()`
        captures "was the ledger completely empty when it first loaded" once,
        consumes that flag unconditionally on the FIRST evaluation pass
        regardless of outcome (fixed after an early draft only consumed it
        inside the `newlyEarnedIds.length > 0` branch, which meant a genuinely
        new user's very first REAL badge, earned live later, would have been
        silently swallowed too — caught by tracing the flag's lifecycle by
        hand, not by a test), and only suppresses the toast on that one pass.
        Every badge is still persisted either way; only the celebration is
        skipped for the backfill.
      - **`statuses` is derived in the render body, not synced into state via
        an effect** — eslint's `react-hooks/set-state-in-effect` rejects that
        outright, the same rule the Search page's own comment documents.
        Worth being precise about the fix, because the first attempt still
        failed differently: moving the setState calls into the effect's
        conditional branch (`if (newlyEarnedIds.length === 0) return;`
        before them) was NOT enough — the rule objects to synchronous
        `setState` ANYWHERE in an effect body, conditional or not. Both
        `setLedger`/`setNewlyUnlocked` calls had to move inside the
        `Promise.all(...).then()` continuation that follows persisting the
        newly-earned badges, the identical idiom `use-xp.ts`'s
        `justLeveledUp` effect already uses (`setJustLeveledUp` inside
        `getHighestLevelSeen().then(...)`, not at the top level).
      - **New watch-log aggregates** (`lib/watchlog/queries.ts`):
        `maxEpisodesOfSameTitleInADay` (Marathoner), `hasRepeatedMark`
        (Second Helping — detects a genuine unmark-then-remark, the ONLY way
        the exact same kind+title+episode can appear twice in the log, since
        both `logEpisodeMutation` and `setStatus` log strictly on a
        transition INTO watched), and `earliestDayForTitle` (Deep Cut). Plus
        one field on `StreakStatus` itself, `freezesSpentLifetime` (Comeback)
        — counts only a freeze that has ACTUALLY bridged a historical gap,
        deliberately excluding a currently-`freezeActive` provisional bridge
        that hasn't been confirmed by a later log entry yet.
      - **"Second Helping" was checked for feasibility, not approximated,
        per an explicit instruction to skip it and say why if it couldn't be
        done honestly.** It IS detectable, exactly: `logEpisodeMutation` and
        `setStatus` both log strictly on a transition INTO watched, so a
        duplicate `(kind, title[, season, episode])` tuple in the log can only
        mean the user unmarked something and marked it watched again later —
        never a bulk-action artifact or a double-log bug.
      - **"Deep Cut"** (released 40+ years before you watched it) compares a
        title's release year against the EARLIEST day it was ever logged, not
        "now" — a title marked watched before Phase 5 Step 1 shipped has no
        log entry at all and simply cannot unlock this one, the same honest
        no-backfill gap already accepted for streaks and XP.
      - Locked badges show their own `description` (the same string an
        unlocked badge would show as "how you got it" reversed to "how to get
        it") — nothing is ever blanked out or hidden for being locked, which
        is the whole point per the brief: a visible condition is what makes a
        locked badge motivating instead of a surprise.
      - `RibbonIcon` added to `components/ui/icons.tsx`, deliberately
        distinct from `StarIcon` (XP) — two different gamification systems on
        the same page needed two different marks.
      - 37 new tests in `lib/badges/badges.test.ts` (every predicate's locked
        and unlocked boundary, `evaluateBadges`'s newly-earned detection, and
        an explicit stickiness test: a badge stays unlocked via the ledger
        even after its live condition goes false again) plus new coverage in
        `lib/watchlog/watchlog.test.ts` and `streaks.test.ts` for the four
        new aggregates — 280 total across the suite.
      - **Not independently verified in-browser this step**, same Chrome
        extension gap as Step 3. Verified instead: lint/tests/build/typecheck
        all pass, and the actually-running dev server hot-reloaded `/profile`
        with the new `BadgeCase` wired in and zero new errors in its log.
- [x] **Step 5** — The stats dashboard (`lib/stats/`, `components/stats/`,
      `/profile/stats`). Its own route rather than one more card on the
      already-long Profile page — Profile already carries XP, streak, and
      badge cards; this adds total watch time, this-year/all-time episode
      and film counts, genre and decade breakdowns, most-watched shows,
      rating distribution with a TMDB comparison, and a full-year viewing
      heatmap. Reached from Profile via a "Full stats" button.
      - **Hand-rolled charts, deliberately, not a charting library.** This
        project has zero chart dependencies and a demonstrated preference
        for avoiding exactly this kind of dependency — see the doc comment
        on `Icon()` in `components/ui/icons.tsx`, which makes the identical
        argument for icons: no bundle weight, no API surface to learn, and
        (the part that actually mattered here) automatic theme integration.
        `BarChart` and `CalendarHeatmap` (`components/stats/`) are plain
        `bg-accent`/`bg-accent-2` elements, so they re-theme for free; a
        library would need explicit color props wired to the same tokens,
        which is real integration work for no benefit on charts this simple
        (proportional bars and a calendar grid).
      - **`BarChart` stacks label+value above a full-width bar** rather than
        a fixed label column beside the bar — a fixed column either
        truncates long genre/show names or squeezes the bar unpredictably
        at 375px. Stacking guarantees the bar always gets the full row
        width regardless of label length. Reused for genres, decades,
        most-watched shows, AND the rating distribution — one component,
        four sections, consistent with the "don't duplicate chart logic"
        instinct the rest of this codebase already has for cards/hooks.
      - **`CalendarHeatmap` scrolls horizontally inside its own container**
        rather than shrinking cells to fit 375px — 53 weeks cannot fit a
        phone width at a legible cell size, and GitHub's own mobile
        contribution graph makes the identical trade. The page itself never
        gains horizontal scroll, only this one element, matching the
        general "wide content scrolls in its own container" rule this
        project already follows for tables/code blocks elsewhere.
      - **A DST bug caught before it ever ran, not after**: the first draft
        of `computeHeatmap` walked from Jan 1 to Dec 31 by adding a fixed
        86,400,000ms to a local `Date` each step — the exact hazard
        `lib/watchlog/types.ts`'s `shiftDay` documents and exists to avoid
        (a 23- or 25-hour local day around a DST transition means a fixed
        millisecond step can land off local midnight). Caught while writing
        the function, before it was ever tested wrong, by recognizing the
        same pattern already fixed once in this codebase. Rewritten to
        `date.setDate(date.getDate() + 1)`, which operates on calendar
        fields and normalizes correctly regardless — verified directly with
        a test walking the 2026 spring-forward date and asserting no
        duplicate or missing day key.
      - **Rating comparison uses the SAME fairness discipline as the
        "Contrarian" badge**: a title only contributes to either average if
        it has BOTH a user score and a TMDB rating, so "your average" and
        "TMDB's average" are always computed over the identical set of
        titles — never your full rated list against a mismatched
        population.
      - **"This year" can only come from the watch log; "all-time" can
        only come from tracking state** — not a stylistic choice, a hard
        data constraint. Tracking entries carry no per-event dates, so
        "this year" is answered by `lib/watchlog`'s existing `totals()` +
        `daysInYear()`; the watch log has no data before Phase 5 Step 1
        shipped (no backfill, by design), so all-time totals use
        `episodesWatchedFor`/movie-watched-count from tracking state
        directly, which is exact and complete back to day one. The
        dashboard says so explicitly under the episode/film counts rather
        than leaving the "this year" gap implicit.
      - **The gamification summary strip reuses `useXp`/`useStreak`/
        `useBadges` directly** rather than recomputing level/streak/badge
        counts a second time — only one of these hooks is ever mounted at
        once, since Profile and `/profile/stats` are different routes, so
        this is reuse, not duplicate work. Accepted, minor consequence: if a
        level-up happens while `/profile/stats` is open, `useXp()`'s
        internal "highest level seen" marker gets updated by THIS mount, so
        the celebratory toast (which only Profile's `XpSummary` renders)
        won't fire on a later Profile visit. Narrow enough (leveling up
        specifically while on the stats page, before checking Profile) that
        it wasn't worth a cross-page suppression mechanism.
      - 25 new tests in `lib/stats/aggregate.test.ts` (every aggregation
        function, including the DST-boundary heatmap case) — 297 total
        across the suite. Two existing badge/stats test fixtures had a
        latent bug caught while writing these (`options.year ?? 2000`
        silently defaulted an explicitly-passed `year: null` back to 2000,
        since `??` doesn't distinguish `null` from `undefined`) — it never
        flipped a badges.test.ts assertion because the miscounted decade
        still landed under the required threshold, but it was fixed in both
        files rather than left latent now that it was visible.
      - **Not independently verified in-browser this step**, same Chrome
        extension gap as Steps 3 and 4. Verified instead: lint / tests /
        build / typecheck all pass, and the actually-running dev server
        served `/`, `/profile`, and `/profile/stats` all at 200 with zero
        new errors in its log.
- [x] **Step 6** — PWA manifest + service worker. Design in
      `docs/phase-5-pwa-design.md`, approved 2026-08-09; all four steps of
      its §10 build order are built. Read the doc before touching this — the
      caching rule is a consequence of the Phase 6 comments gating and is
      unsafe to re-derive by eye.
      **A prerequisite for Phase 7 Step 5** (new-episode push notifications),
      which needs Web Push and therefore a service worker to deliver anything
      while the app is closed. Built on its own terms — a real manifest, a
      real service worker with its own caching strategy — rather than as a
      side effect of the notifications feature. It was already outstanding
      before notifications created a second reason to finish it.
      - [x] **1/4 — Icons + `app/manifest.ts`.** Four icons (192, 512,
        512-maskable, a separate 180 `apple-touch-icon` since iOS ignores
        `purpose: maskable`), generated by a committed `sharp` script
        (`npm run icons`) from hand-written SVG geometry rather than text —
        Bebas Neue is self-hosted by `next/font` under a hashed name a
        standalone script can't resolve. PNGs are flattened to no alpha
        channel: the notches are painted in the background colour rather
        than subtracted, which is only correct while the files are opaque.
        **Measured, correcting the design doc**: `beforeinstallprompt` does
        NOT fire from the manifest alone — Chrome also requires a registered
        service worker with a `fetch` handler. iOS install (a manual
        Share → Add to Home Screen action, unlockable by no manifest) is
        fully live after this step; the Android prompt waited for step 2.
      - [x] **2/4 — The service worker** (`public/sw.js`). The rule is
        positive: only responses byte-identical for every user are cached,
        which the build's own static/dynamic split enforces rather than a
        hand-maintained denylist — putting the comment-bearing title page on
        the never-cached side for free. Cache-first for `/_next/static` and
        bounded for `/_next/image`, stale-while-revalidate bounded for
        `/api/content`, network-first-with-fallback for allowlisted
        navigations. Install precaches route documents AND scrapes them for
        their own `/_next/static` references, so offline works from the
        FIRST visit — measured at 5 documents and 19 assets on a real build.
        Both halves of the stale-worker guard: `Cache-Control: no-cache` on
        `/sw.js` (next.config `headers()`) and `updateViaCache: 'none'` at
        registration, with the `?v=` build id from the git SHA rather than a
        timestamp (`next.config.ts` can evaluate more than once; a
        nondeterministic version could inline two different values into two
        chunks). **A real gap found while verifying**: `install` fires once
        per worker version, so a worker whose caches were evicted under quota
        pressure never rebuilds them — offline silently breaks until the next
        deploy. `/offline` (the one entry that can never be fetched on
        demand, since it's only needed when the network is already gone) is
        now a sentinel checked once per worker startup, re-running the
        precache if it's missing. Verified against the built output with a
        live Supabase session: visited a title page, `/profile`, `/lists`,
        `/account` — zero cache entries, with a planted-violation negative
        control proving the check can actually fail. Killed the server
        entirely and loaded `/library`: rendered fully from cache with all
        19 tracked entries. Corrects the design doc's "LRU" to **FIFO** —
        `cache.keys()` is insertion order; true LRU would double writes on
        every cache hit to better order a bound that only exists to cap
        growth.
      - [x] **3/4 — The update prompt** (`components/pwa/`). Dismissal is a
        plain `useState` flag, reset — not merely left alone — every time a
        waiting worker is freshly reconfirmed: on load, after an
        `updatefound` install completes, and on every `visibilitychange`
        recheck. So a dismissal suppresses the CURRENT surfacing only; it
        stops appearing for exactly one reason, the update being applied.
        Non-blocking (`role="status"`, no backdrop, no focus trap) —
        contrast with `MergePrompt`, which IS a modal because that action is
        genuinely irreversible. **Verified end to end against two real
        builds**, not simulated: built version A, loaded it, rebuilt as
        version B, reloaded the same tab. The browser's own update mechanics
        produced old-active/new-waiting with no manual trickery. From there:
        prompt appeared unprompted, dismiss hid it, a `visibilitychange`
        recheck brought it back while still waiting, and clicking Reload
        drove `SKIP_WAITING` → `controllerchange` → an actual reload now
        controlled by the new worker with the old build's caches deleted.
        Confirmed nothing about dismissal ever touches `localStorage` or
        `sessionStorage`.
      - [x] **4/4 — The guard** (`lib/pwa/`). `discover-routes.ts` walks
        `app/` for `page.tsx`/`route.ts` structurally rather than spawning
        `next build` inside the test suite — the discovered 30-route set was
        diffed BY HAND against a real build's route table and matched
        exactly, the same manual-verification discipline this project
        already uses for the Phase 4 Step 4 credential greps and Phase 6
        Step 3 sentinel checks, not a standing automated assertion.
        `route-guard.test.ts` classifies every discovered route into exactly
        one of: `CACHEABLE_ROUTES` (parsed out of `public/sw.js`'s own
        marker comments, never hand-copied), the `/api/content/**` prefix,
        or an explicit `NEVER_CACHED_ROUTES` list carrying a reason per
        entry — mirroring the Phase 7 Step 2 inverted-guard pattern
        (`SYNC_TABLES_BY_WRITE_KIND`). `/manifest.webmanifest`, `/offline`
        and `/_not-found` are now classified deliberately rather than by
        omission — `/_not-found` turned out to be cacheable in name only
        (`notFound()` renders it inline within another route; no navigation
        ever reaches it to populate or read a cache entry).
        The `/api/content/**` no-auth rule is a regex over import specifiers
        (`@/lib/auth`, `@/lib/supabase`, `next/headers`) — deliberately not a
        full AST parse, since this exists to catch an ordinary accidental
        addition, not to defeat deliberate obfuscation.
        **A bonus check, added beyond what was asked**: every
        `CACHEABLE_ROUTES` page's OWN file is scanned for the same forbidden
        imports, stated explicitly as a partial substitute for the real
        static/dynamic build check (it cannot see an import several
        components deep — only a real build's `○`/`ƒ` split can). It found a
        real false positive on the very first run: `/forgot-password` calls
        `isSupabaseConfigured()` from `@/lib/supabase/public-env`, which
        CLAUDE.md already documents as public by design and reads no
        session — narrowed the rule to exclude that one submodule rather
        than weakening the `/api/content/**` rule, which has no reason to
        touch Supabase at all and stays maximally strict.
        **Both required negative controls run against the live repo, not a
        harness, then reverted with `git checkout --`**: a real unclassified
        route tripped the completeness assertion by name; a real
        `next/headers` import added to `app/api/content/trending/route.ts`
        tripped the no-auth assertion with a message centered on the CACHING
        RULE it would invalidate, not merely "forbidden import found" — the
        bar this step explicitly set. A third, self-imposed control proved
        the bonus partial check too.
      762 tests across the suite (8 new).

## Phase 6 status

Full design, with the reasoning behind every decision below, lives in
**`docs/phase-6-sync-design.md`**. Read it before implementing any step here —
several of these choices look arbitrary without it (especially why the episode
range encoding is deliberately NOT preserved server-side).

- [x] **Step 1** — Sync architecture design (`docs/phase-6-sync-design.md`).
      Approved 2026-07-31. The load-bearing decisions:
      - **Local-first, server-as-sync-fabric.** Local storage stays a complete,
        self-sufficient replica and every UI read hits it — signed in or not.
        The server is a convergence point, never the read path. The anonymous
        tier is the degenerate case with one replica, which is why the
        zero-config promise survives. Accepted cost, named explicitly: every
        future feature works in both modes forever.
      - **The `EpisodeRange` encoding does NOT survive into Postgres.** It is
        exploded to one row per watched episode server-side and re-collapsed
        via `normalizeRanges()` on pull. The encoding exists to beat a ~5 MB
        browser budget that has no server equivalent; keeping it would make
        episode progress a JSON blob, turning "phone marks S3E4, laptop marks
        S3E5" into a whole-blob conflict where last-write-wins silently eats
        one device's episode. As rows, that scenario is two inserts into two
        primary keys and there is no conflict at all. The encoding is a client
        storage representation, not a domain model.
      - **Conflict granularity must match the granularity of the user's
        action.** Per-record LWW on a client-set `client_updated_at` is
        acceptable *because* every record is small enough that losing one costs
        one tap. Two timestamp columns, deliberately: `updated_at` (server-set)
        drives the pull cursor, `client_updated_at` (client-set) drives LWW —
        using server time would mean a Monday offline edit loses to a Sunday
        edit purely because it synced later.
      - **RLS is not hardening, it is the only thing between the anon key and
        every user's data.** A `public` table without RLS enabled is
        world-readable through PostgREST. The doc spells out per-operation
        policies for every table and the four failure modes, chief among them:
        an UPDATE policy whose `WITH CHECK` is broader than its `USING` lets a
        user reassign `user_id` and write into another account. (Step 3
        corrected this: the hole is a *broader* `WITH CHECK`, e.g. `(true)`,
        NOT an omitted one — Postgres defaults `WITH CHECK` to `USING`.)
      - **`watch_events.day_key` must never be derived server-side.** It is the
        local calendar day frozen at write time; recomputing it from a
        timestamp rewrites a user's streak history when they travel — the exact
        bug `lib/watchlog/types.ts` exists to prevent.
      - **First-login merge is additive-only, idempotent, and backed up
        first.** Union and max semantics (not LWW) because it joins two
        histories that were never connected; ships with a summary naming every
        title whose status differed or whose notes were concatenated. Automatic
        when either side is empty, confirmed when both are non-empty — that
        prompt guards the wrong-account case, the one irreversible failure.
      - **Three Phase 5 features needed zero sync design** — XP, streaks, and
        badge conditions are all computed, never stored, so they recompute from
        synced inputs automatically. Direct vindication of that discipline.
- [x] **Step 2** — Per-IP rate limiting on `app/api/content/*`
      (`lib/ratelimit/`). Deliberately ahead of all Supabase work and with **no
      dependency on accounts** — see "These routes are a public surface" above.
      - **It lives in the route handlers, NOT in `proxy.ts`**, and that is a
        documentation-driven decision rather than a preference. Next 16's own
        proxy reference says: *"Proxy is meant to be invoked separately of your
        render code and in optimized cases deployed to your CDN... you should
        not attempt relying on shared modules or globals."* An in-process
        counter **is** a shared global, so proxy is precisely where the
        framework tells you module state isn't dependable. Calling the guard
        per handler also buys what a matcher can't: the rule is chosen per
        route, which is the only reason the OMDb route's tighter limit is
        expressible at all.
      - **Reading `x-forwarded-for` from the RIGHT is the whole security
        property.** `NextRequest.ip` was removed in Next 15, so the IP comes
        from headers — and `X-Forwarded-For` is client-supplied. The common
        `parts[0]` idiom is the bug: an attacker sends
        `X-Forwarded-For: <forged>`, the proxy appends what it really saw, and
        reading the left end hands them a fresh bucket per forged value,
        silently defeating the entire limiter. Reading from the right is also
        correct when a proxy *replaces* the header, so it is safe under both
        behaviours. `RATE_LIMIT_TRUSTED_PROXY_HOPS` (default 1, i.e. Vercel)
        covers deeper proxy chains. Verified live, not assumed: five different
        forged prefixes sharing one real client IP all stayed 429, while a
        genuinely different client IP got 200 — the control matters, since
        "everything 429s" would look identical otherwise.
      - **A sliding window, not a fixed one.** A fixed window allows `limit`
        requests at 11:59:59 and another `limit` at 12:00:00 — a 2x burst
        straddling the boundary, which is the exact shape of a scrape. Keeping
        timestamps costs at most `limit` numbers per key and makes
        `Retry-After` exact rather than a guess at "time until reset."
      - **The in-memory store is per-PROCESS and is documented as such.** On
        serverless, N warm instances means an effective ceiling of N x limit,
        and a cold start resets a bucket. This is not a strict distributed
        limiter and must not be described as one. It still cuts a scrape by
        orders of magnitude at zero dependencies and zero credentials, which
        keeps the zero-config promise. `RateLimitStore` is the swap point: a
        Redis implementation is one class plus one line in `limiter.ts`, no
        route handler moves — the same arrangement `StorageDriver` uses to keep
        the IndexedDB path open.
      - **The global daily budget exists because per-IP structurally cannot
        defend a global quota.** OMDb's free tier is 1,000/day across all
        callers; a thousand IPs taking one each, or one caller forging
        `X-Forwarded-For`, exhausts it with every per-IP bucket still green.
        `budget.ts` doesn't depend on caller identity at all, so spoofing can't
        evade it. It counts route invocations, not confirmed OMDb network calls
        (a request served from Next's data cache is counted despite spending no
        quota) — over-counting on purpose, because it fails in the safe
        direction and the budget sits well above real traffic.
      - **Exhausted budget returns `[]`, not a 429.** That is the exact state a
        blank `OMDB_API_KEY` already produces, which CLAUDE.md documents as
        supported rather than broken. Erroring would break a page over a
        *secondary* source being unavailable. It uses
        `CACHE_SECONDS.ratingsDegraded` (5 min), **never** the 7-day `ratings`
        lifetime — caching a degraded answer for a week would turn a few hours
        of throttling into a week of missing ratings.
      - **`budget.ts` uses `toISOString().slice(0, 10)`, and that is correct
        here** — worth stating so nobody "fixes" it to match the hard warning
        in `lib/watchlog/types.ts`. That warning is about a user's personal
        watch history, where the day is a fact about where the *user* was. This
        is a vendor's global quota counter: no user's timezone is involved,
        every instance must agree on one boundary, and a local date would make
        the reset point depend on which region an instance ran in.
      - **Our 429 and an upstream 429 share status and `kind`, deliberately.**
        `RATE_LIMITED_MESSAGE` (we limited you) is distinct from
        `SAFE_MESSAGE.rate_limited` (TMDB limited us), so the two causes stay
        distinguishable in a log — but both are HTTP 429 with kind
        `rate_limited`, because from the client's side the situation and the
        correct reaction are identical. That is the same test CLAUDE.md applies
        when insisting validation errors stay separate from `ContentError`
        (there the client's reaction genuinely differs: fix the request vs.
        retry it unchanged). Server-side the two never mix — the limiter
        returns a `Response` directly and never constructs a `ContentError`.
      - The 429 sets `cache-control: no-store`. A CDN that cached one caller's
        429 would serve it to everyone sharing that edge, turning a per-IP
        limit into an outage.
      - Limits: `read` 120/min, `search` 30/min, `ratings` 15/min. Sized against
        real page behaviour — a TV detail page fires ~6 of these at once, so a
        limit a normal page view can trip is not a limit, it's an outage.
        `RATE_LIMIT_DISABLED=1` exists for local load testing and is off by
        default, so the limiter runs in development too: one that only runs in
        production is one whose bugs are found in production.
      - 29 tests in `lib/ratelimit/ratelimit.test.ts` (spoofing, IPv6/port
        normalization, window boundaries, the cross-boundary burst, exact
        `Retry-After`, memory eviction, budget rollover) — 326 total. Verified
        live against the dev server: search allowed exactly 30 then 429'd,
        ratings exactly 15, per-rule buckets stayed independent, and the 429
        carried `retry-after: 43` with `no-store`.
- [x] **Step 3** — Supabase schema + RLS (`supabase/`). Schema only; no app
      code reads these tables yet. See `supabase/README.md`.
      - **Schema and RLS ship in ONE migration, deliberately.** The tempting
        split is "0001 tables, 0002 policies". Postgres DDL is transactional,
        so keeping them together means there is no instant — and no
        partially-applied migration state — in which a table exists without
        RLS. Split in two, anyone who applies only the first has published
        every user's data through PostgREST to anyone holding the anon key.
        A guard at the end re-checks `pg_tables` and aborts the migration if
        any `public` table has RLS off, because forgetting `enable row level
        security` otherwise produces no warning of any kind.
      - **A wrong claim this project had been repeating, now corrected and
        tested.** Earlier docs (and the Step 1 design doc) said an UPDATE
        policy with `USING` but no `WITH CHECK` lets a user reassign `user_id`
        into another account. **That is false.** Postgres defaults `WITH CHECK`
        to the `USING` expression when omitted, so that shape is safe. The
        actual hole is a `WITH CHECK` *broader* than `USING` — `(true)` being
        the common real-world case. Found by building a negative control that
        failed to reproduce the "vulnerability", then probing the three policy
        shapes against live PostgreSQL 18 rather than trusting the claim.
        Both clauses are still written explicitly everywhere: it keeps intent
        reviewable and prevents a later accidental widening.
      - **And a genuinely treacherous subtlety, check 12.** The *same* broken
        table attacked with `... WHERE user_id = me` is BLOCKED, while the
        unqualified `UPDATE ... SET user_id = <other>` succeeds. When an
        UPDATE references the table's columns, SELECT policies also apply to
        the post-update row, so a restrictive SELECT policy is real defence in
        depth — but it **masks** a broken `WITH CHECK`. Probing this hole the
        natural way certifies it as safe. Both forms are now pinned as tests.
      - **The test attacks, it does not assert.** `supabase/tests/01_rls_adversarial.sql`
        signs in as Alice (`set local role authenticated` +
        `request.jwt.claims`, exactly how PostgREST presents a request) and
        tries to read Bob's row by exact primary key, probe with
        `where user_id <> me`, read his private notes and watch history,
        update and delete his rows, forge an insert attributed to him, and
        hijack ownership of her own row. 12 checks, all passing, exit code 0.
        It runs in a transaction and rolls back, so it is safe against a live
        project.
      - Verified against a real PostgreSQL 18 instance, not reasoned about: a
        throwaway cluster on port 55432 with a shim reproducing Supabase's
        `auth` schema, `auth.uid()` and API roles. (Windows needed
        `shared_buffers=1MB`/no background workers to get past
        `could not reserve shared memory region ... error code 487`.)
      - **`rating_notes` is the strictest table** and its policy set must never
        be relaxed for sharing — that separation is the whole reason the table
        exists (design doc §7).
      - **Three credentials now, and the third is the dangerous one.**
        `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are
        public by design — the browser must authenticate with something, and
        the anon key is safe **only because** RLS is on every table.
        `SUPABASE_SERVICE_ROLE_KEY` carries **BYPASSRLS**: every policy in the
        schema is simply not applied to it, so leaking it is total silent
        access to every user's library, ratings, private notes and history —
        strictly worse than leaking the TMDB or OMDb key, which cost a quota
        and a rotation. It is read only through `lib/supabase/server-env.ts`
        (`server-only`, lazy read). ⚠️ **No longer unused as of Phase 7
        Step 5** — see the service-role section below, which supersedes the
        "no current code path needs it" this line used to end with.
      - **Verified with a sentinel and a POSITIVE CONTROL**, same discipline as
        Phase 4 Step 4. A sentinel value in `SUPABASE_SERVICE_ROLE_KEY`
        appeared **0 times** in `.next/static` *and* 0 times in `.next/server`
        (the lazy read keeps it out of the compiled server output too), while
        the anon-key sentinel WAS found in `.next/static` — which is what
        proves the grep can detect strings that are present. The first attempt
        at this control silently proved nothing because the sentinel routes
        were placed in `app/_sentinel/`, and **a leading underscore makes a
        folder private in the App Router**, so neither route was ever built.
        Importing `server-env.ts` from a Client Component was then tried
        deliberately: the build failed with `'server-only' cannot be imported
        from a Client Component module` plus the full import trace.
- [x] **Step 4a** — Authentication (`lib/auth/`). **The first-login merge is
      deliberately NOT in this step** — the design doc's Step 4 was split on
      instruction, so an identity exists before anything moves data. Signing in
      today changes nothing about where a user's library lives, and both
      `/account` and the Profile card say so in as many words.
      - **`AuthProvider`, selected exactly like `ContentProvider`.**
        `getAuthProvider()` returns `supabaseAuthProvider` when
        `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` are present and
        `anonymousAuthProvider` otherwise. The anonymous one is **production
        behaviour, not a test double**: `getAccount()` returns `null`, which
        every account-aware surface already handles, so the whole feature is
        *inert* rather than *broken* unconfigured — no
        `isSupabaseConfigured()` checks scattered through the UI.
      - **One deliberate difference from `getContentProvider()`**: a typo'd
        `NEXT_PUBLIC_CONTENT_PROVIDER` throws, because silently serving mock
        data when you asked for TMDB is a lie. Absent Supabase config does NOT
        throw, because it is this app's documented default state. Two
        similar-looking selectors, two different rules.
      - **No auth read in the root layout, and that was the load-bearing
        rendering decision.** `cookies()` is a request-time API, so calling
        `getAccount()` in `app/layout.tsx` would opt *every* route into dynamic
        rendering for a chrome element most visitors never use. Verified
        against the real build output rather than assumed: with Supabase
        configured, `/`, `/search`, `/library`, `/profile/stats` and
        `/forgot-password` stay **static**, and only `/account`, `/profile`,
        `/signin`, `/signup` go dynamic. The cost paid instead is that
        `AccountCard` is a Server Component inside its own `<Suspense>` on
        `/profile` — same "never block the page on a secondary source" rule the
        OMDb ratings row follows.
      - **Every session mutation is a Server Action.** Cookies can only be
        written from a Server Function or Route Handler, so a browser-SDK
        `signInWithPassword` would produce a session the *browser* knows about
        and the next server render does not — which is the "works correctly
        with Server Components" requirement failing. That rule still holds.
        **Superseded in Step 5:** at the end of Step 4 no Supabase code reached
        the browser at all (`grep -ri supabase .next/static` returned zero
        files) and `browser-client.ts` was deleted as dead. Step 5 restored it,
        because sync reads localStorage and must work offline — see the Step 5
        notes. Auth writes are still server-only; the browser client only
        *reads* the session and authorizes data calls, and the service role key
        still never leaves the server.
      - **`proxy.ts` exists solely to refresh the session, and CLAUDE.md needs
        the distinction spelled out because Step 2 quotes the same doc line to
        argue the opposite.** Rate limiting must not live in proxy because an
        in-process counter is shared state, and proxy is exactly where the
        framework says state isn't dependable. Session refresh needs *only this
        request's* cookies, so none of that warning applies — and it cannot
        live anywhere else, since a Server Component render cannot write the
        refreshed token back. Without it: silent random logouts under refresh
        -token rotation. Guarded twice for the anonymous path — unconfigured
        returns immediately, and so does any request with no `sb-` cookie.
        Measured: 4–6ms on the skip path, 13ms when a session cookie is
        actually present.
      - **`getUser()`, never `getSession()`, on the server.** `getSession()`
        returns whatever the cookie decodes to *without verifying the
        signature*, so server-side it is a user-supplied claim rather than a
        fact — anyone could hand-craft a cookie asserting any user id.
      - **Usernames: three rules, three enforcement points, on purpose.**
        Format is enforced in `lib/auth/username.ts` *and* as a Postgres CHECK
        (the app can be bypassed; a direct PostgREST call cannot bypass the
        column constraint). Uniqueness is enforced **only** by a unique index
        on `lower(username)` — never by select-then-insert, which is a race —
        so a 23505 is treated as an ordinary outcome, not an exception. The
        reserved-word list is enforced **only** in the app layer, and that
        asymmetry is stated plainly rather than hidden: a direct API call could
        claim `admin`. The list is product policy that changes, and a CHECK
        constraint would need a migration per edit, including one that could
        fail because a row already holds the newly-reserved name. Revisit if
        usernames ever become publicly addressable (`/@name`).
      - **The reserved list includes every current and plausible route
        segment** (`search`, `library`, `profile`, `settings`, `signin`, …).
        Reserving them now is free; reserving them *later* means taking a name
        off someone. A test asserts each current route is in the list.
      - **No `security definer` trigger creates profile rows.** The obvious
        design — a trigger on `auth.users` — collides with `force row level
        security` on `profiles` and would need a privileged bypass path to
        audit. Instead `ensureProfile()` runs **as the user**, under the
        ordinary `profiles_insert_self` policy, on the first authenticated
        entry point. The whole RLS model stays uniform. The cost is that the
        row appears one request after the user does, which is exactly why
        `AuthAccount.profile` is nullable.
      - **Signing up can never fail because a username was taken.** The
        availability check is a courtesy; between it and the eventual insert
        the name can go. `ensureProfile()` tries the wanted name, then falls
        back to obviously-generated `user_<8 hex>` placeholders that the
        account page invites renaming. A 23505 also covers the primary key, so
        it re-selects rather than inspecting a constraint name — a concurrent
        request having already created the row is a different fix from a name
        collision.
      - **Account enumeration is resisted in four separate places, and each is
        a place a later "improvement" would undo it.** (1)
        `invalid_credentials` copy is vague, matching what GoTrue itself
        returns. (2) `email_not_confirmed` is folded INTO
        `invalid_credentials`, because distinguishing it says "this address IS
        registered" through a side door — paid for by always offering "resend
        confirmation" rather than only when we can prove it's needed. (3)
        `requestPasswordReset` resolves for unknown addresses and the copy is
        worded true either way. (4) An already-registered email is **not**
        reported as an error at signup; GoTrue deliberately returns a fake user
        with empty `identities` there, and detecting that would hand back the
        disclosure it went out of its way to withhold. There is deliberately no
        availability RPC for email — a username is a public handle, an address
        is not.
      - **`username_available` is the one privileged surface**: `security
        definer`, `set search_path = ''`, fully-qualified references, returning
        a bare boolean. Needed because `profiles` is `authenticated`-only and a
        sign-up form is by definition not authenticated. It is an existence
        oracle by construction, which is why a new `RATE_LIMITS.auth` rule
        (10/min) covers it and every other auth action. Verified end to end
        against the running server: exactly 10 allowed, then refused with a
        decrementing `retryAfterSeconds`.
      - **A real bug only a *configured* production build could find.**
        `AuthActionState`/`IDLE_AUTH_STATE` were exported from `actions.ts`,
        which carries `"use server"` — where every export is compiled into a
        callable server endpoint reference, so a plain object arrives on the
        client as `undefined`. Types do not catch it (both sides are correctly
        typed; the value goes missing at the module boundary), and the
        *unconfigured* build passed because the auth pages render "accounts
        unavailable" and never mount a form. Fixed by moving constants to
        `lib/auth/form-state.ts`; `actions.ts` now exports functions only.
      - **The sentinel grep needed a real positive control, and the first one
        proved nothing.** `SUPABASE_SERVICE_ROLE_KEY`'s sentinel: 0 hits in
        `.next/static`, 0 in `.next/server`. But the anon-key sentinel was also
        0 — not a broken grep, a *stronger* result than expected: no Supabase
        code reaches the browser at all this step. A known-present string
        ("Continue with GitHub") was used as the control instead, and matched.
        A deliberate client import of `@/lib/auth` failed the build with the
        full trace through `lib/auth/index.ts` → `lib/auth/supabase/index.ts` →
        `lib/supabase/server-client.ts`.
      - **Verified signed out in both modes, every route 200, zero server
        errors** — including with a garbage `sb-` cookie, which engages the
        proxy, fails to reach the auth server, and still serves the page.
        `/account` redirects to `/signin?next=%2Faccount` (as a streamed 307
        inside an HTTP 200 — the same documented Next behaviour CLAUDE.md
        already notes for `notFound()`).
      - **Not verified in a real browser, and not against a real Supabase
        project.** The Chrome extension was disconnected again (fourth session
        running), and `supabase start` needs Docker, which isn't installed —
        so no live auth server, no real OAuth round trip, no real email. What
        was exercised: every route over HTTP in both configured and
        unconfigured modes, the proxy's engage/skip paths, the rate limiter end
        to end, the build's static/dynamic split, the credential boundary, and
        36 unit tests over the pure logic. **Still owed**: a real sign-up →
        confirm → sign-in → rename → sign-out round trip against a live
        project, and the 375px visual pass.
      - 36 new tests in `lib/auth/auth.test.ts` (username policy incl. every
        rejection boundary and the exact-vs-prefix reserved check, the Supabase
        error mapping incl. the deliberate `email_not_confirmed` collapse, and
        the anonymous provider's full contract) — 356 total across the suite.
- [ ] **Step 4b** — The first-login merge: pre-merge backup, the merge itself,
      and the post-merge summary
- [x] **Step 5** — Sync (`lib/sync/`, `components/sync/`, and one migration).
      The first-login merge, steady-state conflict resolution, the offline
      outbox, and multi-tab coordination — which also closes the clobbering gap
      the storage section has documented since Phase 2.
      - **The riskiest logic is pure and therefore tested.** `merge.ts` and
        `reconcile.ts` take snapshots and return plans; they touch no storage
        and no network. `engine.ts` is the part that is hard to test, so it was
        kept to sequencing and I/O with no decisions of its own. 62 tests cover
        overlapping ranges, a title tracked differently on each side,
        disagreeing scores, independently written notes, badges earned on one
        side only, and a full merge replay.
      - **The merge is additive-only.** No branch removes a local title,
        episode, rating, note, badge, or log event. Union for episodes and
        events, max-progress for status, LEAST for badge dates, GREATEST for
        XP, later-wins for scores, and **concatenation** for notes. The worst
        outcome it can produce is a duplicate or a resurrection, which is the
        guarantee the brief asked for.
      - **A real duplication bug, caught by a replay test rather than by
        review.** Pre-account watch-log events get a deterministic UUIDv5 from
        `(userId, dayKey, index)` so a retried merge is a no-op. That was
        implemented — and the merge still DOUBLED the entire watch log on its
        second run, because the derived id was not written back onto the local
        event. The union step matches local against remote by id, and a local
        event with no id looks like a different event from the row it created.
        `hasRepeatedMark` would then have reported rewatches that never
        happened. Fixed by persisting the derived id; that also removes the
        dependency on array-index stability after the first merge.
      - **The v5 implementation is pinned by the published RFC 4122 vector**
        (`uuidV5("www.example.com", DNS)`), not just by self-consistency — a
        refactor of the bit-twiddling would otherwise silently re-derive every
        pre-account event id in existence and re-upload the user's whole
        history under new ids.
      - **Conflict rules live in Postgres triggers, not in the client.** A
        read-compare-write in the sync client is a race (another device can
        commit between the read and the write), costs a round trip per record,
        and is bypassable — PostgREST is a public API. As BEFORE triggers the
        comparison happens inside the writing statement, under the row lock,
        for every writer. A stale write is skipped SILENTLY (`return null`)
        rather than rejected: raising would make the outbox retry forever a
        write that is correctly being ignored.
      - **Trigger ORDER is load-bearing and depends on the names.** Postgres
        fires same-event triggers alphabetically, so `<table>_clamp` (which
        pins a future-dated `client_updated_at` to `now()`) must sort before
        `<table>_lww`. It does. Renaming either without re-checking would let a
        device with a fast clock win using the very timestamp the clamp exists
        to reject.
      - **Verified against a real PostgreSQL 18, not asserted.**
        `supabase/tests/02_sync_conflict_rules.sql` attacks the triggers: 11
        checks including an older write trying to overwrite a newer one, an
        older re-mark trying to resurrect a tombstone, and a **negative control
        that must pass by failing to protect** — an unprotected table where the
        newer write IS lost. Without check 11, checks 1–10 would pass against a
        database with no triggers at all. Exit code 0.
      - **A second real bug, caught by applying the migration and reading the
        NOTICEs.** The draft added a `watch_events (user_id, created_at)` index
        with `if not exists`, on the assumption that an append-only table has
        no `updated_at`. It has one, the index NAME was already taken, so the
        statement was silently skipped — and the sync client was querying
        `created_at`, making that pull a sequential scan over every event the
        user had ever logged. `if not exists` matches the name, never the
        definition. Every table now uses `updated_at`, and `CURSOR_COLUMN` in
        `backend.ts` must keep matching the indexed column exactly.
      - **The pending-write guard is what makes offline safe.** Every
        reconcile function takes the `client_updated_at` of any un-pushed local
        write for the same record and ignores the server row if it is not
        newer. Without it: mark an episode offline, reconnect, a pull lands
        before the flush, the server's older state overwrites local, and the
        mark vanishes from the screen while still sitting in the outbox — where
        it reappears minutes later.
      - **Episodes have no per-episode local timestamp to compare against**,
        because the range encoding structurally cannot hold one — that is the
        65x storage win. It does not need one: anything already pushed is on
        the server and the server's LWW resolved it, so a row coming back IS
        the resolved answer. The only state the server does not know about is
        the outbox, which is exactly what the guard covers.
      - **`reconcileTitle` carries local episodes across a title update.**
        Episodes arrive from their own table, so a status change from another
        device must not bring `watchedEpisodes: {}` with it. Missing this would
        wipe a whole show's progress on a one-field update.
      - **Two outbox modes, and the distinction falls out of the key rather
        than a flag.** State records key on their natural key so repeated
        writes coalesce; `watch_events` keys on its UUID so nothing ever
        coalesces. Flush is per-record and grouped per table in `SYNC_TABLES`
        order — `watched_episodes` has an FK to `tracked_titles`, and pushing
        an episode first fails with a 23503 which `classify()` treats as
        permanent, parking a good write in the error state forever.
      - **Failure is visible, and success is not.** `phase: "offline"` is
        informational (queued writes are the system working); `phase: "error"`
        is `role="alert"` with danger tokens and a retry, because it will not
        resolve by waiting. Success gets one calm line — a permanent green
        banner trains people to ignore the spot where the red one appears.
        Retryable vs. permanent is decided by SQLSTATE: 23xxx / 42501 / 22P02
        and the PostgREST schema-drift codes are permanent, everything else
        retries with capped exponential backoff.
      - **Multi-tab, finally.** A `BroadcastChannel` announces local changes
        and the Web Locks API (`ifAvailable`, so a second tab skips rather than
        queueing) makes the flush exclusive. Web Locks releases automatically
        when a tab crashes, which a localStorage mutex cannot promise. Where
        unavailable the task runs unguarded — sync is idempotent throughout, so
        the failure mode is duplicated work, not corruption.
      - **Backups are never garbage-collected**, per §6.1, and
        `takePreMergeBackup` **throws and aborts the merge** if it cannot
        write. That is the one place in this codebase where a failed local
        write must stop the operation instead of degrading — everywhere else a
        failed write costs a nicety; here it removes the only way back.
        `restoreSnapshot` is deliberately additive: it restores what the
        snapshot holds and does NOT delete anything created since, because an
        "undo" that destroys newer work is worse than the bug it fixes. The UI
        says so rather than promising a clean rollback.
      - **The merge prompt is not about conflicts.** It appears only when both
        sides are non-empty, and it exists for the single irreversible failure
        in the design: signing into the WRONG account and uploading your
        library into someone else's. It leads with the two counts, because
        "this device has 214 titles; this account has 38" is the sentence that
        makes someone realise, in a way "merge your data?" never would.
        `autoFocus` lands on the SAFE action.
      - **`titleOf` read `.title` when `TitleSummary` calls it `.name`** — it
        type-checked (the server row's `summary` is `unknown`) and silently
        made every entry in the user-visible merge summary fall back to a raw
        provider id. Caught only by building a real `TitleSummary` in the test
        fixtures instead of a loose object literal.
      - **Row shapes are `type` aliases, not `interface`s**, and that is
        load-bearing: TypeScript gives aliases an implicit index signature but
        not interfaces, so only the alias form is assignable to the
        `Record<string, unknown>` the outbox and `push` take.
      - **`browser-client.ts` is back**, after Step 4 deleted it as dead. Sync
        reads localStorage and must flush on reconnect, so routing it through
        Server Actions would make every queued write depend on our server as
        well as Supabase, and a 300-row batch would cross two hops. Auth writes
        remain server-only; the browser client only reads the session. The
        service role key still never leaves the server.
      - **`SyncProvider` reads the session client-side**, which is what lets it
        mount in the root layout without undoing Step 4's rendering decision —
        verified in the build output: Home, Search, Library and stats are still
        **static**. It re-reads on mount, on `onAuthStateChange`, and on
        pathname change, because a Server Action setting a cookie fires no
        client-side auth event.
      - **A `set-state-in-effect` violation, same rule as Phase 5 Step 4**:
        resetting the status on sign-out was a synchronous `setState` in an
        effect. Fixed by deriving it — "signed out" and "disabled" are the same
        state, so it was state that did not need to exist.
      - 62 new tests (`merge.test.ts`, `reconcile.test.ts`) plus 11 database
        checks — 418 total across the suite.
      - **Not verified in a browser during the build.** The Chrome extension
        has been disconnected for six sessions. What WAS verified: the conflict
        rules against a real PostgreSQL 18 with a negative control, all three
        migrations applying cleanly in order, lint / typecheck / tests / build,
        and the static/dynamic split holding.
- [x] **Step 5b** — Insecure-origin fixes and storage failure visibility.
      A live two-device test (phone on `http://192.168.1.112:3000`) surfaced
      what the build could not: tracking controls disabled, My Library empty,
      and nothing anywhere saying why.
      - **`crypto.randomUUID` and `crypto.subtle` are SECURE-CONTEXT ONLY.**
        They exist on `https://` and on `localhost` — which is exactly why
        desktop was fine and the phone was not. On a plain-HTTP origin both are
        `undefined` and calling them throws `TypeError`. Step 5 used both.
        Consequences, each confirmed by simulating the environment in a test:
        `appendWatchEvents` rejected **before its try block**, so every watch
        event on a non-HTTPS origin was silently dropped (the call site is
        `void appendWatchEvents(...)`, so the rejection was unhandled and
        invisible); and `buildMergePlan` threw whenever the local watch log was
        non-empty, so the first-login merge failed and no account data ever
        arrived — which is the empty Library.
      - **SHA-1 is now a plain-JS implementation used UNCONDITIONALLY**, not
        "subtle if available, fallback otherwise". These ids are watch-log
        primary keys and the whole "just run the merge again" strategy depends
        on the same input producing the same id on every device — including one
        device on HTTPS and another not. Two implementations of one critical
        value is how a divergence ships, and the symptom would be the user's
        entire pre-account history inserted a second time. Pinned by the
        published RFC 4122 vector, plus a test asserting an insecure origin
        derives ids **identical** to a secure one.
      - `randomUuid()` falls back to `crypto.getRandomValues`, which is *not*
        secure-context gated, so the fallback keeps real randomness.
      - **Supabase's own auth-js was checked and is not the problem** — it
        guards `crypto.subtle` explicitly and degrades PKCE to `plain`. The
        crypto fault was entirely ours.
      - **`ready` can no longer stick.** `TrackingProvider` and
        `RatingsProvider` had no `.catch()` on the initial read, so a rejected
        read left `ready` false forever — and `ready` gates everything:
        `TrackingActions` renders `disabled`, `TrackingBadge` renders `null`,
        My Library renders its loading branch. An app that refuses every
        interaction and looks empty, with no explanation. The storage layer is
        written so reads degrade to `null` rather than throwing, so in
        principle this could not fire; that is precisely why it needed
        handling. **Fail open and loud, never silent and frozen.**
      - **Blocked storage is now impossible to mistake for "no data".**
        `StorageBanner` (app-wide, in the layout) fires on the `memory` driver;
        My Library has a distinct `loadFailed` state that says the data could
        not be READ rather than that there is none; and a `DiagnosticsPanel`
        on Profile reports storage driver, secure context, account, and sync
        phase in one place. It is on **Profile, not `/account`**, because the
        point is diagnosing a device where something is broken and `/account`
        needs a working session — one of the things that might be broken.
      - **`useSyncExternalStore`, not `useState` + `useEffect`**, for reading
        storage status: a synchronous `setState` in an effect is what
        `react-hooks/set-state-in-effect` rejects (third time in this
        codebase), and it gets the SSR snapshot right by construction, so the
        banner never flashes into server HTML and back out.
      - ⚠️ **CORRECTED IN STEP 5c: the crypto faults were NOT the cause of what
        the live test saw.** This section originally claimed they "fully
        explain the empty Library". They do not — they are real bugs that would
        bite a signed-in user on a non-HTTPS *production* deployment, and they
        were latent on the device in question. The actual cause was
        `allowedDevOrigins`. Both fixes stand on their own merit; the
        attribution was wrong and is corrected below.
      - 5 new tests simulating a non-secure context (including a guard
        asserting the simulation really is missing both APIs, so the block
        cannot pass trivially) — 423 total.
      - **Still owed**: a live two-device round trip — sign in on a second
        device, edit both sides offline, reconnect, and confirm convergence.
- [x] **Step 5c** — The real cause, found by reproducing rather than reasoning.
      Symptoms on a phone at `http://192.168.1.112:3000`: Library stuck on
      loading skeletons, tracking controls disabled, **and the diagnostics
      panel added in Step 5b not clickable either**. That last one is the tell:
      a Client Component that cannot be clicked means **hydration never
      completed**, so the problem was never in the storage or tracking
      providers.
      - **Root cause: Next 16 blocks cross-origin requests to dev-only assets
        by default.** The dev server initializes with `localhost`, so reaching
        it at a LAN IP is cross-origin; the HMR WebSocket handshake fails with
        `ERR_INVALID_HTTP_RESPONSE` and the dev client never hydrates. Fixed
        with `allowedDevOrigins` in `next.config.ts`, which **auto-detects this
        machine's LAN IPv4 addresses** rather than hardcoding one — a hardcoded
        IP fixes today's laptop and breaks the next one in the same confusing
        way. `DEV_ALLOWED_ORIGINS` is the escape hatch for tunnels and VPNs.
      - **It is DEV-ONLY. A non-HTTPS production deployment was never broken.**
        Proved by running `next start` and probing the same LAN origin: fully
        hydrated, real empty state, zero errors. That single comparison is what
        separated "our app breaks on insecure origins" from "our dev server
        does", and the two have completely different fixes.
      - **Reproduced with headless Chrome over CDP**, not inferred: a control
        (localhost, secure) against the repro (LAN IP, insecure), capturing
        `Runtime.exceptionThrown`, console errors, and a DOM probe.
        Decisive readings — `secureContext: false`, `localStorageWorks: true`
        (storage was never the problem), 15 skeletons, and **zero exceptions**.
        Nothing threw; it hung. That is why every Step 5b mechanism stayed
        silent: `StorageBanner` needs the memory driver, `loadFailed` needs a
        rejection, and both need hydration to render at all.
      - **The structural fix: a warning that survives JS never running.** Every
        diagnostic in this app was a Client Component, so all of them were mute
        in precisely the case they existed for. `InteractivityWarning` is
        server-rendered markup hidden by CSS once `HydrationFlag`'s effect sets
        `data-hydrated` on `<html>` — inverted from the obvious design, because
        the message that must survive a total JS failure cannot depend on JS to
        appear. Not a `<noscript>`: that covers "JS is switched off", not "JS
        loaded and then failed", which renders nothing at all.
      - **The reveal is an animation DELAY, not a duration.** The global
        reduced-motion rule forces every `animation-duration` to `0.01ms`,
        which would defeat a duration-based fade — the delay survives it, so
        the banner still appears at the right moment, just instantly.
      - **Verified in both directions**, which matters more than it sounds: a
        warning that is always visible is noise, and one that never appears is
        decoration. Scripts enabled → `display: none`. Scripts disabled via
        CDP `Emulation.setScriptExecutionDisabled` → `display: flex`,
        `visibility: visible`, `opacity: 1`, real box. 6s delay so a healthy
        load never flashes it.
      - **Interactive confirmation on the insecure origin after the fix**:
        diagnostics button found and clicked, panel opened reporting
        "Storage: Saving normally / Secure context: No (plain HTTP)", tracking
        controls enabled, clicking Watched persisted
        `marquee:tracking:movie:the-godfather`, and the watch log recorded the
        event. Zero exceptions throughout.
      - **A useful cross-check on the Step 5b tests**: the real browser on the
        insecure origin reports `hasSubtle: false, hasRandomUUID: false` —
        exactly what the unit-test simulation produces by deleting them. The
        simulation was faithful; it was simply testing a bug that was not the
        one being hunted.
      - **The debugging lesson worth keeping.** Three symptoms pointed at
        storage, and storage was fine. What actually identified it was the one
        symptom that did NOT fit — a diagnostic panel that could not be
        clicked. When a diagnostic built for a failure is itself dead, the
        fault is below the layer being diagnosed, and no amount of hardening
        that layer will find it.
- [x] **Step 6a** — Spoiler-safe comments (`lib/comments/`, `components/comments/`,
      one migration). Shared lists are a separate, unstarted step — see below.
      The differentiator this ships: an episode comment is invisible to a
      reader who hasn't watched that episode — not blurred, not client-side
      hidden-then-revealed, **absent from the query result entirely**. A
      reader inspecting network traffic sees nothing, because the row never
      left the database. Verified live against a real Supabase project, not
      just asserted: Episode 1 (watched) showed the post form; Episode 2
      (unwatched, same show, same session) showed "Locked for now" with zero
      rows returned — see the live-testing section below.
      - **The gating asymmetry is a judgment call, stated plainly.** The brief
        said "episode comments hidden until watched" and left title-level
        ungated. Applied literally, a MOVIE's only comment bucket — there is
        no episode to move spoilers to instead — would sit wide open the
        instant you land on its page, undermining the pitch for half the
        catalog. So: TV title-level stays OPEN (general "no spoilers pls"
        chatter, no episode exists to carry it to instead); MOVIE title-level
        is GATED on `tracked_titles.status = 'watched'`; TV episode-level is
        GATED on a `watched_episodes` row for that exact episode. Reuses
        Phase 6 Step 5's SYNCED tracking tables as ground truth, which is
        also why gating is only as current as the reader's last sync — the
        same eventual-consistency the sync design already accepts everywhere
        else, not a new weakness introduced here.
      - **One function drives both the SELECT and INSERT policies, on
        purpose.** `can_view_comment_scope(media_type, title_id, season,
        episode)` — `security invoker`, so it runs as the calling user and
        its own queries are themselves subject to that user's RLS on
        `watched_episodes`/`tracked_titles`; no elevated privilege needed at
        all. If SELECT and INSERT used separate logic they could drift apart
        — a reader could be shown a "write a comment" box for a scope whose
        own comments they can't read back, a confusing, security-adjacent bug
        this design rules out by construction. The same function is RPC'd
        directly from `lib/comments/queries.ts` to compute `canParticipate`
        for the UI, rather than a second TypeScript reimplementation of the
        gating rule that could silently disagree with what RLS actually
        enforces.
      - **Replies: exactly one level, and a reply's scope is NEVER taken from
        the client.** `comments_enforce_nesting()` (BEFORE INSERT) looks up
        the parent, rejects a reply-to-a-reply, and OVERWRITES the new row's
        `media_type`/`title_id`/`season_number`/`episode_number` from the
        parent's real values — Postgres evaluates RLS `WITH CHECK` against
        the row *after* BEFORE triggers run, so this means a reply is always
        gated on its parent's actual scope regardless of what a client
        claims. Also blocks replying to an already-hidden comment unless you
        are its author.
      - **Likes and reports both re-derive visibility at write time**, the
        same function again: you cannot like or report a comment you are not
        allowed to see. Without this, "like" becomes a scope-existence
        oracle — probing comment ids and watching insert succeed/fail would
        let a client detect hidden episode discussion it otherwise can't read
        at all.
      - **Like counts are computed, never stored** — the same discipline
        Phase 5 applied to XP/streaks/badges, extended to a new domain, and
        it removes an entire trigger/drift-bug surface for free.
        `comment_like_counts(uuid[])` is `security definer`, batched (avoids
        an N+1 across a whole thread), and discloses a NUMBER only — never
        who liked what, never a row. `comment_likes` itself stays a plain
        own-rows table, the uniform pattern every other table in this schema
        uses; a user's own SELECT answers "did I like this," the RPC answers
        "how many," and the two are never conflated.
      - **The "basic moderation path" is auto-hide at 3 distinct reports, and
        deliberately nothing more.** Building a fictional admin dashboard for
        a personal, non-commercial project would be real scope creep; the
        honest "basic" version is a `security definer` trigger
        (`comment_reports_auto_hide`) that counts distinct reporters per
        comment and flips `status` to `'hidden'` at the threshold — the same
        narrow, justified privilege-elevation class as `username_available`.
        Stated as an accepted limitation, same tone as the rate limiter's own
        "not a strict distributed limiter" admission: 3 coordinated bad-faith
        accounts CAN trigger this, and there is **no un-hide path** in this
        system yet — `comments_lock_immutable_fields()` explicitly rejects
        `'hidden' -> 'visible'` via a plain UPDATE, even for the comment's own
        author. A site operator can flip it back via the Supabase SQL editor
        with the service role until an admin UI exists in a later phase.
      - **Deletion is a tombstone, matching every other table in this
        schema** — there is no DELETE policy for `comments` at all (only
        `comment_likes` gets one; a like is a toggle that orphans nothing,
        unlike a comment with replies under it).
        `comments_lock_immutable_fields()` forces `body := ''` the instant
        `deleted_at` is set, unconditionally, even if the client forgot to —
        a tombstoned comment can never retain its text. The same trigger also
        auto-stamps `edited_at` server-side whenever body changes, so a
        client cannot post an edit while claiming it was never edited.
      - **17 adversarial checks against real PostgreSQL 18**
        (`supabase/tests/03_comments_adversarial.sql`), same discipline as
        `01_rls_adversarial.sql`/`02_sync_conflict_rules.sql` — it attacks,
        it does not assert. Check 1 is the load-bearing one: a reader who
        hasn't watched an episode gets **zero rows**, both from a list query
        and a direct SELECT by id. Also covers: posting into a scope you
        can't read back is rejected (3); TV title-level stays open, movie
        title-level is gated (4, 5); reply scope is inherited and one-level
        nesting is enforced (6, 6b); liking/reporting something you can't see
        is rejected (7, 9b); no self-reports (9a); auto-hide fires at exactly
        3 distinct reporters, not 2 (10); the author still sees their own
        hidden comment, everyone else doesn't (11); un-hiding is rejected
        even for the author (12); editing after delete is rejected and body
        is force-cleared (14); identity-field tampering on UPDATE is rejected
        (15); a negative control proves the harness can actually detect a
        missing gate (17).
      - **A real RLS-semantics nuance found while writing check 16b.** No
        DELETE policy exists for `comments`, and the first draft of that
        check expected a plain UPDATE-style rejection to *raise*. It doesn't:
        Postgres's rule when NO policy grants a command is to authorize ZERO
        ROWS for it, so the DELETE statement completes successfully having
        removed nothing — no exception at all. The check was wrong, not the
        schema; fixed to assert on `GET DIAGNOSTICS ROW_COUNT` plus an
        out-of-band read confirming the row still exists, the same shape the
        adjacent UPDATE check already used.
      - **Two real application-layer bugs, found ONLY by live testing against
        a real Supabase project — the adversarial SQL suite could not have
        caught either, because both were bugs in the TypeScript, not the
        database.**
        1. `CommentSection` (a Server Component) called `getCommentSectionData`
           with no try/catch. A live check against the real project — before
           the comments migration had even been applied there yet — hit a
           schema-cache miss, and with nothing catching it, the error
           propagated straight through to `app/error.tsx`, replacing the
           **entire title page** — poster, cast, tracking controls,
           everything — with the generic "Something broke" screen. CLAUDE.md
           already states the rule this violated ("never block the page on a
           secondary source," applied to the OMDb ratings row and watch-
           providers section); `CommentSection` simply hadn't been brought
           into line with it. Fixed with the same try/catch-and-degrade
           pattern as `RatingsSection`, plus its own `<Suspense>` boundary at
           both call sites in `page.tsx` so a slow (not just failing) fetch
           can't block the page either.
        2. `postCommentAction` and `reportCommentAction` both **omitted
           `user_id`/`reporter_id` from their INSERT payloads.** Neither
           column has a default, and — the genuinely misleading part — the
           gap did NOT surface as a NOT NULL violation. `user_id = (select
           auth.uid())` in the INSERT policy's `WITH CHECK` compares NULL
           against a UUID, which is never TRUE, so Postgres rejected the row
           as an ordinary-looking `42501` ("row-level security policy"
           violation) — **reading exactly like a gating failure.** This sent
           debugging in the wrong direction for a real stretch: a temporary
           diagnostic action confirmed the RPC gating check AND the raw
           `tracked_titles` row were both completely correct (`rpcResult:
           true`, `status: "watched"`), which is what finally pointed at the
           INSERT payload itself rather than the gating logic. Fixed by
           explicitly setting both fields; `toggleLikeAction`'s upsert
           already did this correctly and was the pattern the other two
           should have matched from the start.
      - **The debugging lesson worth keeping, stated the same way the Step 5c
        one was:** an error that LOOKS like a security/gating rejection is
        not necessarily one. Before concluding "the policy is wrong," verify
        the row you're trying to write actually contains what you think it
        contains — a temporary server-side log of the RAW (never client-
        facing) error, plus a direct RPC-and-row comparison, settled in
        minutes what guessing had not.
      - **A lighter, permanent version of that diagnostic logging was kept.**
        `lib/comments/actions.ts`'s `failure()` now logs server-side (never
        to the client) specifically for `forbidden`/`unknown`/`network`
        outcomes — kinds the UI shouldn't be able to trigger through normal
        use, unlike `invalid_input`/`rate_limited`, which are ordinary user
        edges the UI already anticipates and doesn't need a log line for.
      - **Full live round trip confirmed working**, not just the schema:
        post, like (count updates, button toggles to "Unlike"), reply (nests
        correctly, no further Reply button offered — matches one-level-
        nesting), edit (body updates, "· edited" marker appears, server-
        stamped), delete (renders "[deleted]" with every control hidden,
        thread structure preserved — the reply stayed visible after its
        parent was deleted), and a full page reload confirming every one of
        those persisted server-side rather than only in optimistic client
        state. Zero console errors throughout the confirmed-working portion
        of the session. Test comments were deleted afterward to leave the
        account clean; the incidental tracking state created along the way
        (Breaking Bad marked "watching" with S1E1 watched) was deliberately
        left rather than reverted, and is worth knowing about.
      - **Placement**: TV gets a third "Discussion" tab alongside Overview/
        Seasons (open, title-level). Movie gets a "Discussion" section below
        Cast & Crew (gated, title-level). Episode-level discussion is inline
        per-episode in `season-list.tsx`
        (`components/comments/episode-discussion.tsx`), collapsed by
        default and fetched only on expand via a Server Action
        (`fetchCommentThreadAction` — `lib/comments/queries.ts` is
        `server-only` and unreachable directly from that Client Component) —
        the same "fetch nothing until asked" discipline that file's own
        header comment already documents for episode lists themselves, one
        layer deeper. A show with 200 episodes never fetches 200 threads for
        one page view. Gated client-side on `useSync()?.userId` purely as a
        UX nicety (no toggle promising a feature that would just reject); the
        Server Action re-checks the session regardless.
      - **Rate limits**: `RATE_LIMITS.comments` (12/min, post/edit/delete
        shared — splitting further buys little for a real cost),
        `commentLikes` (60/min — a toggle, not content, and a real person
        liking several comments while scrolling a thread is normal),
        `commentReports` (5/min — the tightest, same severity class as
        `auth`, because reporting is itself an abuse vector: a single account
        spamming reports across many comments trying to find two allies for
        the 3-reporter auto-hide threshold is the thing worth slowing down).
      - **Sanitization is about whitespace/control characters, not HTML.**
        Comments render as a plain React text child — never
        `dangerouslySetInnerHTML`, no markdown parser — so injection is
        structurally impossible by construction, a stronger guarantee than
        any sanitizer since it can't be bypassed by a sanitizer bug.
        `sanitizeCommentBody` instead strips zero-width/bidi-override
        characters (a real spoof vector independent of any markup — a bidi
        override can make text DISPLAY as something other than what it
        literally contains) and collapses 3+ newlines. Built from explicit
        numeric code points rather than literal or `\u`-escaped characters in
        the source — both render identically to nothing in an editor, which
        would make the regex itself unreviewable in a diff for a file whose
        whole job is stripping exactly those characters. The Edit tool
        pasted the literal invisible characters in twice while this file was
        being written, caught only by scanning the file's own codepoints
        programmatically afterward — worth remembering if this file is ever
        touched again.
      - **Not built this step, and out of scope on purpose**: shared lists
        (built separately as Step 6b below), an admin UI for un-hiding a
        comment or reviewing reports, and per-account report-abuse detection
        beyond the unique-report-per-account constraint.
- [x] **Step 6b** — Shared and public lists (`supabase/migrations/20260810000001_lists.sql`,
      `lib/lists/`, `components/lists/`, `app/lists/`). Named lists with
      private/unlisted/public visibility, a shareable link (the list's own
      `id`), collaborative editing via invite/accept, an "agree on" view for
      collaborative lists, and following public lists.
      - **The RLS self-reference recursion trap is the single most important
        thing to understand before touching this migration.** `can_view_list`
        and `can_edit_list` both query the SAME `lists` table their own
        policies protect — a `security invoker` version of either would
        recurse forever (the inner query re-triggers the calling policy,
        which calls the function again). Every list-related helper
        (`can_view_list`, `can_edit_list`, `shares_editable_list_with`,
        `list_follower_counts`) is `security definer` specifically to avoid
        this, even the ones not strictly self-referential — consistency over
        proving each one safe individually. `auth.uid()` inside a definer
        function still resolves to the CALLING user (it reads the
        session-level `request.jwt.claims` GUC, unaffected by definer's
        privilege escalation), so this doesn't weaken who the function acts
        as, only what it's allowed to read while doing so.
      - **Public and unlisted are IDENTICAL at the RLS layer, on purpose.**
        `can_view_list` treats both as "any authenticated user, given the
        id" — discoverability, not visibility, is what actually separates
        them, and that distinction is pushed entirely to the query layer:
        `getPublicLists()` is the ONE place that filters
        `visibility = 'public'` explicitly, with a doc comment warning that
        forgetting that `.eq` would silently turn "unlisted" into "public"
        for anyone who calls it. Confirmed with the user before building:
        shareable links work for signed-in Marquee accounts only, matching
        Step 6a's comments precedent exactly — no anonymous-viewer carve-out
        was added anywhere.
      - **A new, deliberately narrow cross-user RLS exception**, confirmed
        with the user before implementation since `tracked_titles` had been
        strictly own-rows-only since Phase 6 Step 3: the "what can we all
        agree on" view needs to see OTHER members' watchlist/watched status.
        `shares_editable_list_with(other_user, media_type, title_id)` grants
        that only for a title that is actually on a list where both the
        caller and `other_user` are owner-or-accepted-collaborator — nothing
        else about either person's library is exposed. This is a second,
        additive SELECT policy (`tracked_titles_select_shared_list_member`),
        not a replacement for the Step 3 own-rows policy — Postgres OR's
        multiple permissive policies for the same command together, so nei-
        ther can accidentally narrow the other.
      - **Adversarial SQL testing caught the same false claim Step 3 already
        corrected, this time by construction rather than by re-deriving it**:
        every `WITH CHECK` in this migration is written explicitly rather
        than relying on the (correct, but easy to forget) Postgres default of
        mirroring `USING`. `supabase/tests/04_lists_adversarial.sql` — 17
        checks, all passing on the FIRST real run against a fresh PostgreSQL
        18 cluster. Check 12 is the one worth remembering: after alice's
        private list becomes PUBLIC, carol (a total outsider) correctly
        gains read access to the list and its items, but NOT to alice's
        `tracked_titles` row for a title on it — proving the agreement
        carve-out requires actual EDIT membership, not mere visibility, and
        that visibility alone can never leak tracking data. Check 17 is the
        negative control (an unprotected mirror table must leak) — the same
        discipline every adversarial suite in this project follows: attack,
        don't assert, and always prove the harness can detect a missing gate.
      - **`list_collaborators` needed explicit named FK constraints**, caught
        during design review before ever running the migration, not from a
        test failure: it has TWO foreign keys to `profiles` (`user_id` and
        `invited_by`), and PostgREST cannot disambiguate
        `member:profiles!list_collaborators_user_id_fkey(...)` from
        `inviter:profiles!list_collaborators_invited_by_fkey(...)` in a
        `.select()` embed without them named. `list_items.added_by` got the
        same treatment for consistency, though it only has the one FK.
      - **Deletion policy is deliberately asymmetric per relationship**,
        matching who should be allowed to lose what: `lists.owner_id` and
        comment-style ownership FKs `on delete cascade` (content dies with
        its owner's account), but `list_collaborators.invited_by` and
        `list_items.added_by` are `on delete set null` — a collaborator's
        own account deletion must not destroy content they contributed to
        someone ELSE's list; only their attribution is lost.
      - **Rate limits** (`lib/ratelimit/rules.ts`): `lists` (10/min — creates
        and edits, infrequent by nature), `listItems` (60/min — the add/
        remove-while-building-a-list action, needs real headroom),
        `listCollaborators` (8/min — invites are a lighter-weight version of
        the same abuse vector comment reports already guard against),
        `listFollowers` (60/min — a toggle, not content).
      - **`lib/lists/` mirrors `lib/comments/`'s pure/impure split exactly**:
        `types.ts`/`validate.ts`/`errors.ts`/`wire.ts` pure and unit-tested
        (26 tests — heaviest coverage on `computeAgreementItems`, the actual
        payoff of this feature, covering both directions: never a false
        agreement, never a hidden real one), `queries.ts` is `server-only`
        (the read path), `actions.ts` is `"use server"` (the write path /
        client seam), and `index.ts` deliberately does NOT re-export
        `queries.ts` so a Client Component importing the barrel can't drag
        server-only code along with it.
      - **The Step 6a lesson applied directly, not just cited**:
        `lib/lists/actions.ts` opens with the exact missing-`user_id` bug
        from comments as its header comment, and every INSERT below sets its
        owner-ish column (`owner_id`, `added_by`, `invited_by`, `user_id`)
        explicitly. `components/lists/list-detail.tsx` wraps `getListDetail`
        in try/catch with its own `<Suspense>` boundary in
        `app/lists/[id]/page.tsx` — the doc comment there names the exact
        `CommentSection` incident (a schema-cache miss taking down an entire
        title page) as the reason it exists.
      - **`getListDetail` returns `null` for "doesn't exist" and "you can't
        see it" indistinguishably, on purpose** — telling a visitor "this
        list is private" instead of a plain 404 would itself leak that a
        list with that id exists. The route resolves the ambiguity to
        `notFound()` either way.
      - **`AddItemSearch` (the inline title search inside a list) hit the
        identical "loading" trap `search-view.tsx`'s own comment warns
        about** while it was being written, not after: a first draft tracked
        an explicit `"loading"` status, set synchronously at the top of the
        debounced fetch — which is exactly what `react-hooks/set-state-in-
        effect` rejects, and would have failed the build. Rewritten to the
        same `forQuery`-comparison derivation `SearchView` uses: no
        `isLoading` state variable, "loading" is just "no result yet whose
        `forQuery` matches the current query."
      - **The list-items grid reuses `TicketCard` directly, not `TitleGrid`
        wrapping single-item arrays** — an early draft nested a full
        `TitleGrid` (its own `grid-cols-2` container) inside each outer grid
        cell to get one card, which would have rendered every poster at half
        width inside dead space. Caught by reasoning through the layout
        before running it, not by a screenshot. The remove ("×") button on
        an editable card sits top-LEFT, not top-right — `TicketCard` already
        places `TrackingBadge` top-right as a sibling of its own `<Link>`
        (never nested inside it, for the same "a button inside an anchor is
        invalid HTML" reason CLAUDE.md documents there), and two
        absolute-positioned controls competing for one corner would overlap
        and steal each other's clicks.
      - **The agreement view is button-triggered, not fetched on every list
        load.** It's a real cross-user query plus a pure filter, genuine cost
        that the vast majority of solo lists would pay for nothing — a
        button makes that cost visible and opt-in instead of hidden inside
        every list page's load time.
      - **Nav entry points**: a "My lists" button on the Library page
        (deliberately NOT folded into the three tracking-status sections
        there — a list isn't a tracking state, it holds titles regardless of
        anyone's watched status) and a `PendingInvites` section on Profile,
        in its own `<Suspense>` boundary for the same reason `AccountCard`
        has one — a network round trip must not block the local-storage-only
        XP/streak/badge cards beneath it. No 5th item was added to the fixed
        4-item `NAV_ITEMS` global nav; that list stays the Phase 1 four.
      - Full static verification: typecheck, lint, all 480 vitest tests
        (26 new), and `next build` all clean.
      - **Live-verified end to end against the real Supabase project, with a
        second real account** (the invite/accept/agreement cluster cannot be
        exercised any other way): create, add an item, cycle all three
        visibility settings, confirm Discover tracks only `public`, confirm a
        private list 404s for a signed-in non-member (not a "this is
        private" message — see `getListDetail`'s own reasoning above),
        invite, accept, and the agreement view correctly surfacing a title
        both accounts had watchlisted. Two real bugs surfaced, neither of
        which any adversarial SQL check or static tool caught — both are now
        pinned as tests.
      - **Bug 1 — `RETURNING` on `lists` INSERT fails RLS against your own
        brand-new row, live, in pure SQL, with no app involved.** Creating a
        list failed 100% of the time with `42501: new row violates row-level
        security policy for table "lists"` — reading exactly like an
        ordinary WITH CHECK rejection, even though `owner_id` was set
        correctly and `auth.uid()` resolved correctly (both confirmed by
        direct SQL, not assumed). The actual cause, found by systematically
        isolating each layer against the live database rather than
        re-deriving it from the SQL text: **Postgres applies a SELECT
        policy's `USING` clause to `RETURNING` output**, and `can_view_list()`
        — the function `lists_select_visible` calls — re-queries `public.lists`
        *by id* to decide visibility. For a row still being created by the
        SAME command, that internal re-query cannot see it yet, so the
        RETURNING-triggered visibility check fails even though the row is
        unquestionably the caller's own. Confirmed by elimination: the exact
        same INSERT with `RETURNING` dropped succeeded; `can_view_list()`
        called as its own separate statement on the same row immediately
        afterward returned `true`. **This is why `createListAction` generates
        its `id` with `randomUUID()` up front** rather than reading it back
        from `RETURNING` — seeded doc comment on `reselectSummary` explains
        it in full. It's a narrow, structural gap: `list_items`/
        `list_collaborators` never hit it, because their SELECT policies
        (`can_view_list`/`can_edit_list`) query the ALREADY-existing `lists`
        table, never the table being written to. `can_view_comment_scope`
        (Step 6a) never hit it either, for the identical reason. Only a
        SELECT policy that is self-referential on the exact table being
        inserted into, with RETURNING, is exposed — `updateListAction`/
        `deleteListAction` keep their chained `.select()` because by
        construction they only ever target a row that was already committed
        in an earlier, separate request.
      - **Bug 2 — a pending invite was invisible to the person it was for.**
        Account A invited account B; the invite row existed and account A
        could see it as "Invited"; account B's Profile page showed nothing at
        all, with no error anywhere. Root cause, confirmed live by
        impersonating the actual invited user before touching any code:
        their own `list_collaborators` row WAS visible to them
        (`user_id = auth.uid()` passes, as designed), but `can_view_list()`
        only counted an *accepted* collaborator, never a merely *invited*
        one — so `getPendingInvites()`'s `list:lists!inner(...)` embed
        silently dropped the row, because the embedded `lists` row failed
        its own visibility check. An invite that exists and is readable on
        one side and simply never appears on the other, with a 200 and no
        error, is a hard failure mode to catch any way other than live,
        cross-account testing. Fixed in
        `20260810000002_lists_invite_visibility_fix.sql`: `can_view_list()`
        now also counts `status = 'invited'`, on the reasoning that you
        obviously need to see which list you've been invited to in order to
        decide whether to accept it. Deliberately narrow — `can_edit_list()`
        is untouched, so an invitee gains read access to the list and its
        items only, never the ability to add items, edit the list, or touch
        the collaborator roster; verified by two new adversarial checks
        (3b/3b2) that an invited-not-accepted bob still can't write anything.
      - **The adversarial suite had a real gap, not just the policy.** The
        original check 3a asserted the OPPOSITE of the now-correct behavior
        (that an invited collaborator should see NOTHING) — 17 checks passed
        against a schema where the one person who needed to see a pending
        invite couldn't. Rewritten as 3a/3a2 (list and items ARE visible to
        an invitee) plus 3b/3b2 (still no write access), re-verified clean
        against a fresh PostgreSQL 18 cluster with both migrations applied in
        order. Writing this check caught a second, smaller bug in the TEST
        itself while it was being written: an `UPDATE` blocked by RLS doesn't
        raise (same 0-rows-not-an-error semantics check 14b already
        documents), so a `begin/exception` block around it unconditionally
        "failed" regardless of whether the row actually changed — fixed by
        re-reading the row afterward instead of trusting the absence of an
        exception.
      - **A third thing investigated and NOT found to be a bug**: account A's
        session was unexpectedly signed out mid-session, right as an invite
        was submitted. Checked directly rather than assumed: no code in
        `lib/lists/` touches session state at all (the only `signOut` call in
        the codebase lives in `lib/auth/actions.ts` and nothing in the list
        path calls it), and Supabase's own auth audit log had no explicit
        logout event for the window in question. Concluded ordinary session
        expiry over real wall-clock time, not a list-specific bug — noted
        here in case the same symptom recurs at the same point in a future
        session, which would upgrade it from coincidence to something worth
        re-opening.

**Phase 6 is complete.**

## Phase 7 status

Full design, including the verified column layouts of every supported export
and the reasoning behind the matching rules, lives in
**`docs/phase-7-import-design.md`**. Read §2.3 before touching the classifier —
the rule about what auto-imports is the one thing in this feature that must
not erode.

- [x] **Step 1** — CSV importers for IMDb and Letterboxd (`lib/import/`,
      `components/import/`, `app/import/`, plus `findByExternalId` across the
      content layer).
      - **Two premises in the original brief turned out to be wrong, and
        checking beat assuming.** (1) **Letterboxd exports carry no IMDb or
        TMDB id** — only a `Letterboxd URI`. So every Letterboxd row goes
        through title+year matching and the review queue is that source's
        MAIN path, not an edge case; only IMDb gets exact-id matching. (2)
        **There is no verifiable Moviebase CSV export** — its backup is JSON
        and Premium-only, and Moviebase's own migration guidance routes
        through Trakt. Dropped in favour of the roadmap's Trakt, deferred to
        Step 2 pending its own verification pass. Scraping Letterboxd film
        pages for the TMDB id was considered and rejected: thousands of
        third-party requests per import, against their terms, building a
        load-bearing dependency on someone else's markup.
      - **The rule that decides what silently enters a library.** Only an
        external-id match, or a title+year match exact on BOTH fields **and
        unique**, auto-imports. Everything else is a human decision.
        Deliberately absent, and to stay absent: a numeric confidence
        threshold (a dial gets turned down the first time the queue feels
        long, and its failure mode is invisible) and a popularity tiebreak on
        an otherwise exact tie (that is a remake). Popularity is a TIEBREAK
        ONLY, never added to the score — popularity-as-score is precisely how
        "Dune" gets silently matched to 2021 when the user meant 1984.
      - **`agreesExactly` reads signals, never the score**, so retuning the
        point weights cannot promote a candidate into `confident`. That is
        only safe while every exactly-agreeing candidate outranks every other
        one, and the arithmetic margin is just 5 points (a floor of 90 against
        a ceiling of 85). A test pins it, because bumping `titleDiceMax` from
        45 to 55 would break the invariant with nothing else complaining.
      - **Article stripping deliberately collapses "Heat" and "The Heat".**
        That is the cost of fixing the far more common IMDb-vs-TMDB
        `"Godfather, The: Part II"` case, and it is contained by `confident`
        also requiring an exact year: the collision produces a review-queue
        row, never a silent wrong import. Tested as containment rather than as
        absence of collision.
      - **Commit is a cursor walk, not a transaction** — localStorage has
        none, the same fact that forced per-record lazy migrations in
        `lib/storage`. Additive only, reusing the first-login merge's
        semantics: max progress on status (an existing `watched` is NEVER
        demoted by an imported `watchlist`), local score wins unless the user
        opts in, notes untouched, TV episode ranges untouched.
      - **Dates are validated, never converted.** Letterboxd's `Watched Date`
        is already a `YYYY-MM-DD` calendar date and is used VERBATIM as a
        watch-log day key — parsing it through a `Date` would reintroduce
        exactly the timezone bug `lib/watchlog/types.ts` exists to prevent.
        Non-ISO formats are REJECTED rather than guessed at, because
        `03/04/2019` is two different real dates depending on the reader and a
        plausible wrong date is the invisible-failure this feature is built to
        avoid. IMDb's `Date Rated` is not a watch date and is opt-in only.
      - **Imported events omit `m` and `b`.** No source records a watch TIME,
        and `lib/watchlog/types.ts` already anticipated this ("omitted when
        genuinely unknown, which is what a Phase 7 CSV import would produce").
        `b` (bulk) stays off because a diary row IS one real viewing on one
        real date — flagging a decade of genuine history as bulk would
        understate it in Year in Review.
      - **Idempotency has two layers, because signed-out has no honest id.**
        `importId` is a hash of the file's BYTES, so re-selecting the same
        export is recognized and refused. Signed IN, events also get a
        deterministic `uuidV5(userId, importId, sourceRowId)`, which makes the
        same file imported on a second device dedupe server-side. Signed OUT
        there is no `userId`, and inventing one would collide across accounts,
        so events append with no id — the established pre-account shape the
        first-login merge already knows how to assign.
      - **Rate limiting: OMDb is never called at all.** The binding constraint
        was our OWN limiter — `search` at 30/min would 429 thirty rows into a
        3,000-row file. Solved by request SHAPE, not a looser limit:
        `POST /api/import/resolve` takes batches of 25 under
        `RATE_LIMITS.importResolve`, so 3,000 rows is ~120 requests. Rows are
        deduped BEFORE resolving (a diary holds one row per viewing, so a film
        watched four times is one lookup) and server-side concurrency is
        capped at 4.
      - **`findByExternalId` returns an ARRAY**, not a title-or-null, and the
        counts are the contract: `[]` unknown, `[one]` unambiguous, `[two,…]`
        ambiguous. TMDB's `/find` answers with five parallel result arrays and
        an id can populate more than one; a nullable return would force the
        provider to PICK, which is a policy decision it has no business
        making. **The type checker caught that there are THREE provider
        implementations, not two** — `httpProvider` needed it too, and got a
        real implementation (`/api/content/find/[imdbId]`, under the ordinary
        `read` limit) rather than a stub.
      - **Job persistence is deliberately lossy**, because a naively stored
        3,000-row job is several megabytes against a ~5MB budget the user's
        ACTUAL library lives in: `overview` dropped from stored summaries,
        candidates kept only while a row is undecided. `saveJob` lets a
        `StorageError` PROPAGATE rather than degrading quietly — everywhere
        else a failed local write costs a nicety, but here the write IS the
        promise that you can close the tab and come back, so a silent failure
        would keep that promise on screen while breaking it in fact. The UI
        says to finish in one sitting.
      - **The review queue is one row at a time and keyboard-first, and that
        is the feature rather than polish.** A table of 200 rows with
        dropdowns is faster to build and worse at the only job the screen has:
        it invites skimming, and a skimmed decision is how a wrong match gets
        committed. A wrong match is worse than no match, because an unmatched
        row is visibly unmatched while a wrongly-matched one looks correct
        forever. Rows are sorted easiest-first so the hard ones cluster at the
        end where a user can stop. Every candidate carries a plain-language
        reason generated from the scoring signals ("title matches exactly,
        year differs by 3") — the practical payoff of a transparent scorer
        over an opaque similarity number.
      - **There is no "accept the rest" path, and one must not be added.**
        `committableRows()` commits only rows that were decided, so leaving
        review early imports LESS, never a guess.
      - **Letterboxd's `watchlist.csv` and `watched.csv` have byte-identical
        headers.** Inside the export ZIP the filenames settle it; for a
        renamed loose file `detectLetterboxdSource` returns null and the UI
        ASKS, because the difference is "plan to watch" versus "have seen"
        across a whole library.
      - **A minimal ZIP reader** (`lib/import/zip.ts`) over the platform's
        `DecompressionStream("deflate-raw")` — structure parsing only, no
        compression reimplemented. Requiring someone to unzip first is exactly
        the friction that stops people switching. Sizes come from the CENTRAL
        directory (a streaming archiver writes zeroes locally) and the extra-
        field length is re-read from the LOCAL header (they legitimately
        differ); both are pinned by tests. `__MACOSX/` shadows are skipped.
      - **Two bugs found only by live testing, both at boundaries no unit test
        covered.** (1) `AmbiguousFile` carried a parsed `CsvTable`, whose
        `CsvRecord`s expose `get`/`has` as METHODS — functions are not
        structured-cloneable, so `postMessage` threw and the import died,
        only ever for an ambiguous file. Every module was individually correct
        and fully tested; the failure lived only *between* them. Now carries
        raw text, and `parse-file.test.ts` asserts a `ParseResult` survives
        `structuredClone`. (2) A JSX comment placed inside `&& ( ... )` parses
        as an object literal, not a comment, and stopped the file compiling —
        worth knowing because the error (`Expected '</', got 'ident'`) points
        at the line AFTER the real problem.
      - **Verified live end to end in mock mode**: IMDb ids matched exactly
        and a `tvEpisode` row bucketed `unsupported` rather than dropped;
        Letterboxd diary matched by title with both rewatch rows deduped to
        one lookup but kept as two rows; the review queue's keyboard picks and
        skips flowed back to the preview; commit filed six events on their own
        real 2024 dates rather than today; re-importing the identical file was
        refused; a renamed watchlist/watched CSV asked which it was. The
        commit assertions were checked against storage TIMESTAMPS to separate
        the import's writes from pre-existing data — which is what showed The
        Godfather being promoted `watchlist -> watched` while KEEPING its
        local score over the imported one.
      - 161 import tests; 641 across the suite.
- [x] **Step 2** — Routing import commits through the sync seam, and inverting
      the guard that let the bug ship.
      - **The bug**: `commit.ts` wrote straight to `trackingStore` /
        `ratingsStore` / `watchLogStore` and never called
        `lib/sync/record.ts`. For a signed-in user a 3,000-row import landed
        on ONE device and **silently never reached any other**. Nothing
        failed — the local write succeeded, the UI was correct, and
        `commit.test.ts` passed in full because it installs an in-memory
        driver and mounts no sync user, so there was no outbox for anything
        to be missing FROM. Found by noticing an empty outbox while cleaning
        up test data, not by any test.
      - `commitRow` now calls the recorders AFTER each successful local
        write — never before, per `record.ts`'s rule that queuing a write
        that failed locally would upload state the device does not have.
      - **`commit-sync.test.ts` installs a REAL signed-in user and asserts on
        REAL outbox contents.** Mocking `record.ts` and asserting it was
        called would be weaker: it passes even if the recorder no-ops.
      - **The guard is INVERTED, and that is the part worth keeping.** The
        bug shipped because adding a local write that skipped the seam
        required NO action to go wrong — silence was the bug, and every other
        test checks a write kind someone remembered to think about, which is
        exactly the population a forgotten one is not in. So the guard
        asserts COMPLETENESS: every key `commitRow` returns must appear in
        `SYNC_TABLES_BY_WRITE_KIND`. Adding a write kind now FAILS a test
        until its outbox table is written down — or until "this one does not
        sync" is written down deliberately as `[]`. Default outcome flips
        from silent-wrong to loud-unfinished.
      - Both halves were proved by negative control: removing
        `recordTitleWrite` failed two tests with "commitRow reported a title
        write but queued no tracked_titles row".
- [x] **Step 3** — Episode-level import, review-queue grouping, and Trakt.
      Built in that order deliberately: episode import first as its own step
      (it also unblocks the IMDb `tvEpisode` rows Step 1 counted as
      `unsupported`), then the grouping so Trakt would arrive into a queue
      that could already display it, then Trakt on top.
      - **Merging imported episodes is a per-season UNION** via `addRange`.
        `removeRange` is not imported at all, so "an import never subtracts"
        is structural rather than a rule to remember. Union is monotonic, so
        the never-demote guarantee holds by construction.
      - **The one case where a union would DEMOTE, and it is subtle.** A show
        marked watched at the TITLE level carries `status: "watched"` with
        EMPTY ranges — the user asserting they saw the whole show. Merging 40
        imported episodes into a 62-episode show grows the ranges while
        *lowering* apparent progress, silently discarding 22 the user had
        already claimed. A demotion wearing the costume of an addition. So
        those shows are skipped by `shouldMergeRanges` — but **their watch
        EVENTS are still written**, because the log is append-only and cannot
        demote anything. The split follows the line this codebase already
        draws: progress answers *how much*, the log answers *when*.
      - **Episode rows promote to `watching`, never `watched`.** Whether N
        imported episodes complete a show is a question only season counts
        answer, and `deriveStatus` correctly declines to guess without them.
      - **`instantToLocalMoment` is a SECOND date function, and rejects bare
        dates.** `toDayKey` validates-and-never-converts because IMDb and
        Letterboxd write calendar dates; Trakt writes an instant, whose
        leading date portion is the **UTC** day — systematically tomorrow for
        evening viewing in the Americas, the exact bug
        `lib/watchlog/types.ts` exists to prevent, arriving through a
        different door. Each function is wrong where the other belongs, so
        rejecting the wrong input makes misuse impossible rather than
        documented. Trakt's timestamp also yields a REAL `m` (minute of day),
        which no earlier source could supply.
      - **A review unit is a DEDUP GROUP — there is no episode special
        case.** `resolveRows` already groups by `dedupKey` and gives every
        row in a group the same candidates and bucket, so rows that resolved
        together are by construction the rows one decision covers. A film
        matched once is a unit of 1; rewatched three times, a unit of 3; a
        show's 62 episodes, a unit of 62. **Fewer decisions, not a faster
        interface** — still one unit at a time, still keyboard-first, no
        table. This puts a hard requirement on any parser emitting episode
        rows: `title`/`year`/`imdbId` must describe the SHOW, or 62 episodes
        become 62 decisions. Pinned by a test.
      - **Trakt is two unrelated formats** (design doc §11). The VIP export
        carries `tmdb_id` directly; community-tool exports name their id
        column after its type and have no `year` at all, so an export with an
        unresolvable id column AND no year is flagged BEFORE resolution —
        learning that after a multi-minute resolve is the worst moment.
        `collected_at` imports as *watchlist*: it means the user OWNS
        something, and mapping a shelf to a viewing history would invent one.
      - **`rating` vs `trakt_rating` is protected by construction, and the
        test was written BEFORE the parser.** `readTraktUserRating` is the
        only place any rating column is read; the community columns are
        listed as DATA (`TRAKT_COMMUNITY_RATING_COLUMNS`) so a test can sweep
        them rather than trusting a comment. There is deliberately **no
        fallback** — the titles with an empty `rating` are exactly the ones
        the user chose NOT to rate, so `?? trakt_rating` would assign crowd
        scores to precisely the wrong set while reading as defensive coding.
        Negative control: adding that fallback failed two tests, one naming
        the column.
      - **Two bugs live testing found that 700+ tests did not**, both hiding
        behind plausible output. (1) Episode COMMIT shipped without updating
        the classifier, so episode rows were still bucketed `unsupported` and
        never reached it. (2) Worse — `resolve.ts` held its OWN copy of "can
        we import this", so fixing the classifier left it behind and episode
        rows were skipped before any lookup, falling out `unmatched` with
        zero candidates for a show whose IMDb id resolved perfectly. The
        endpoint returned 200 and the UI said "No matches found",
        indistinguishable from a genuine miss. Caught by querying
        `/api/content/find/tt0903747` by hand and watching it answer while
        the resolver claimed nothing. Fixed by sharing ONE exported
        predicate — duplicated knowledge was the actual bug, and patching the
        second copy would have left it primed to drift again.
      - Also: an `"episode"` media-type hint now implies `"tv"` in the
        scorer. Left as its own value it earned neither the agreement bonus
        nor the conflict penalty, so a film could match an episode row
        unpenalised.
      - **Measured against LIVE TMDB** (design doc §2.4, whose hypothesis was
        pessimistic): Letterboxd **48/50 confident** on a deliberately
        adversarial set (five remake pairs, an article collision, accented
        titles), IMDb **15/15 exact**, Trakt **5/5** including episode rows,
        and — the number that matters — **zero wrong matches reached
        `confident`**, verified by TMDB id and year rather than by name. The
        review queue cleared 37 rows by keyboard at **~13ms per decision**.
        Caveat stated honestly: the fixture's years were correct because it
        was generated. A real Letterboxd export shares that property (its
        years are TMDB-sourced), but this was NOT tested against a
        hand-edited file, where §2.3's rules would push far more rows into
        review by design.
      - **A debugging lesson worth keeping**, and the third instance of it in
        this project: three plausible performance hypotheses (per-keystroke
        `saveJob` serialization, `next/image` churn, main-thread blocking)
        were each killed by measurement — 0.37ms, 8 `data:` URIs, zero long
        tasks. The apparent 4.5s-per-decision was an artifact of the CDP
        measurement harness, not the app. Measuring what the USER experiences (a
        `MutationObserver` on the real DOM update) gave the answer
        immediately. Same shape as Step 5c's "the diagnostic that cannot be
        clicked".
      - 252 import tests; 732 across the suite.
      - **Not yet done** (at the time this was first written): `traktTmdbId`
        was written and tested but unwired. ⚠️ **CORRECTED**: it is wired —
        `resolve.ts`'s Tier 0 reads `row.tmdbId` generically for every source,
        and `parseTrakt` populates that field via `traktTmdbId`, so a VIP
        export's TMDB id is used directly and spends no IMDb lookup at all.
        This note sat stale for a step before being caught while writing up
        Step 4b — a reminder that a "not yet done" note needs to be deleted
        the moment the gap closes, not left for the next reader to trust.
        Still genuinely outstanding: no run has been done against a
        hand-edited export with wrong years.
- [x] **Step 4** — TV Time importer: deliberately SKIPPED, not deferred.
      TV Time shut down; anyone who had data there has already moved it to
      Trakt (which this project supports) or lost it. Verifying an archived
      export format and building a parser for it would be real work in
      service of a user who most likely does not exist anymore — a different
      judgment from Moviebase in Step 1, which was dropped for lack of a
      verifiable export at all. This one is live, verifiable, and skipped
      anyway because the audience is gone. Checked off rather than left as an
      open box, so it reads as a decision and not a TODO nobody actioned.
- [x] **Step 4b** — The new-episode feed (`lib/schedule/`, `components/schedule/`,
      `/schedule`). A calendar-style view of every "watching" or "watched"
      show's next unwatched episode, grouped into **Ready to watch** (already
      aired, unwatched — the headline section), **This week**, and **Later**.
      Split out of the original "new-episode notifications" roadmap line on
      purpose: this is the in-app display half, needs no service worker, and
      was finished ahead of the push half, which stays blocked on Phase 5
      Step 6 (below).
      - **Not a reimplementation of the Up Next ranking engine
        (`lib/tracking/upnext.ts`) — the same underlying question, asked over
        a wider set of shows.** `lib/schedule/build.ts`'s
        `selectScheduleCandidates` calls the exact same two functions
        `selectUpNextCandidates` does — `reconcileCoarseWatched` then
        `nextUnwatchedEpisode` — rather than duplicating them. The one
        difference is the status filter: Up Next stops at `"watching"`
        ("continue", not "discover"); the feed also includes `"watched"`,
        because the feed's single most valuable state — a show marked fully
        watched that has SINCE aired an episode nobody told it about — only
        exists for shows Up Next has already stopped looking at.
        `"watchlist"` stays excluded from both: nothing started, nothing to
        have missed.
      - **"Between seasons" and "ended" needed no extra data or extra
        branching to handle gracefully — they're just the empty case.**
        `nextUnwatchedEpisode` returns `null` the moment a show is fully
        caught up on everything TMDB currently lists, which is exactly what
        both situations look like from the data available. No `Title.status`
        field, no extra `getTitle` call per show — the feed simply produces
        nothing for that show, which is correct: a feed whose entire point is
        "what's actionable" has nothing to say about a show with nothing
        actionable, and a synthetic "nothing new" card would be pure noise at
        library scale.
      - **A "today" bucket was requested but deliberately not built as a
        fourth, separate group.** This project already has exactly one
        convention for "has this air date happened yet" — `isFutureAirDate`
        (lib/utils/dates.ts), which treats a same-day date as already aired.
        A literal "today" bucket for UPCOMING episodes would need same-day to
        mean the opposite thing in the same feature, which is precisely the
        kind of competing-convention bug CLAUDE.md already warns about for
        `localDayKey` vs `toISOString().slice(0, 10)`. So a same-day episode
        lands in "Ready to watch" — which is also strictly better UX: it's
        the single most valuable thing this feed can show, and burying it one
        tier down as merely "today's upcoming" would undersell it.
      - **A real UTC/local mismatch, caught by the test suite before it ever
        reached a browser.** The first draft's bucket boundary called
        `isFutureAirDate` (which always reads the real system clock) for the
        ready/not-ready split, then separately compared an explicit `today`
        parameter (for test determinism) against the air date to decide
        this-week vs later. Those two "todays" can disagree — and did, the
        moment a test pinned `today` to a date in the past relative to the
        real clock: every future-dated fixture bucketed as "ready" instead of
        "this-week"/"later", because `isFutureAirDate` was still comparing
        against the REAL today. Fixed by not calling `isFutureAirDate` here
        at all — `bucketFor` reimplements the identical comparison via
        `dayDifference` (lib/watchlog/types.ts) against the one explicit
        `today` the whole function uses, so ready/this-week/later can never
        disagree with each other about what day it is. The "today" reference
        itself is UTC (`new Date().toISOString().slice(0, 10)`), matching
        `isFutureAirDate`'s own convention for a calendar-date field — NOT
        `localDayKey()`, which is the right "today" for a watch EVENT
        (anchored to where the user physically was) but the wrong one for
        TMDB's own UTC-dated schedule.
      - **Fetch cost was the explicit brief** ("someone tracking 40 shows
        shouldn't trigger 40 calls on page load"), and is met with the same
        two-stage shape `use-up-next-items.ts` already established
        (`getSeasons` for every eligible show, then `getSeasonEpisodes` for
        just each show's ONE target season) plus one addition: both stages
        now go through `mapWithConcurrency` (extracted from
        `lib/import/resolve.ts` into `lib/utils/concurrency.ts` — Phase 7
        Step 1 built it to cap upstream lookups during CSV resolution, and a
        second hand-written copy here would have been exactly the kind of
        duplicated logic that has drifted out of sync elsewhere in this
        codebase before) with a concurrency cap of 4. Up Next's own unbounded
        fan-out is left as-is and is still the right call THERE — a rail is
        realistically a handful of in-progress shows — but a feed spanning
        every watching-or-watched show is precisely the wide-fan-out case the
        cap exists for. Each response still lands in Next's 24h TMDB data
        cache regardless, so the cap only bounds concurrent in-flight
        requests on a cold load, not total requests paid over time.
      - **Entry point: a "Full schedule" link on the Up Next rail's own
        heading row on Home**, not a 5th global nav item (`NAV_ITEMS` stays
        the fixed Phase 1 four) and not buried on Library. Rendered in BOTH
        of `UpNextRail`'s branches (empty and populated) specifically so it's
        reachable even for a visitor with nothing "watching" yet — exactly
        the visitor whose "watched" show might have a new episode waiting,
        which Up Next itself has no way to surface.
      - Marking an episode watched from a schedule card reuses
        `markEpisodeWatched` from `useTracking()` directly (the same
        function `UpNextCard` calls) — no new mutation path, no new
        optimistic-update/rollback logic.
      - 16 new tests in `lib/schedule/build.test.ts` (candidate inclusion
        for both statuses, watchlist/movie exclusion, the coarse-watched
        reconciliation, a new season appearing mid-caught-up, the dropped-
        candidate cases, every bucket boundary including same-day and the
        exact 7-day edge, and sort order including a null air date sorting
        last) — 754 across the suite.
      - **Verified live**, not just unit-tested: `/schedule` renders real
        tracked shows from local storage (Breaking Bad and Stranger Things,
        both correctly bucketed "Ready to watch" from the existing mock
        library), the Home entry point link resolves to `/schedule`, and
        clicking "Mark watched" on a card correctly advances that show to
        its next unwatched episode end-to-end — confirming the write path
        through the real `useTracking()` context, not a stub. The
        this-week/later buckets were NOT separately clicked through live, to
        avoid adding synthetic tracking entries to the same real browser
        profile Phase 7's earlier steps had to deliberately clean test data
        out of — covered instead by the unit tests exercising the identical
        `ScheduleSection` rendering path.
- [x] **Step 5** — New-episode PUSH notifications (`lib/notifications/`,
      `components/notifications/`, `app/notifications/`,
      `app/api/cron/notifications/`, one migration). Design in
      **`docs/phase-7-notifications-design.md`** — read §1 before touching
      any of it. Unblocked by Phase 5 Step 6, which shipped the service
      worker this needs to receive a push while the app is closed.
      - **THE REFRAME, which is why this feature is as small as it is.**
        "Notify about the world changing, never about the user's behaviour"
        is not only an ethical rule: "you haven't watched S6E1" would require
        the server to read every user's watch progress, while "S6E1 aired"
        does not. So the trigger is a **per-show world fact**, which is what
        lets ONE upstream call serve every follower of a show, and removes
        watch progress from the server's requirements entirely.
      - **Suppression-only, and it must stay that way.** Watch state IS
        consulted — if you already watched S6E1, sending "S6E1 aired!" is
        redundant noise — but only ever to REMOVE a recipient, never to
        create one. The mechanical test, so nobody has to re-derive the
        ethics: **if deleting all watch data would remove the notification,
        it was a behaviour ping.** A world event survives that deletion; a
        nag does not. `lib/notifications/detect.ts` cannot express one — its
        whole signature is `(Title, snapshot)`, with no user in scope — and
        the suppression read lives in a separate module whose deletion would
        still leave every notification being sent.
      - **The rule is enforced by the SCHEMA, not just prose.**
        `notification_event_kind` is a Postgres enum, so adding
        `you_are_behind` needs a migration and therefore review, rather than
        a one-line client change. Check 16 of the adversarial suite pins it.
      - **Two phases, and the split is what makes quiet hours free.** Detect
        (per show, deduped across users) writes to `pending_notifications`;
        deliver (per user, quiet-hours aware) drains it. The ledger is
        written **on send, never on detection**, so a notification that is
        due but currently silenced simply stays queued and a later run picks
        it up — no scheduler, no retry queue, no timer.
      - **Scheduling forced a real correction, verified before building.**
        Vercel Hobby cron is **daily-only with ±59min precision**. The delay
        was acceptable; the interaction was not — the single daily run lands
        at the same UTC hour, so any user whose quiet window contains that
        hour would be silenced **permanently**, with no error anywhere.
        Quiet hours are only meaningful if the job runs more often than the
        window is long. Resolved by an **external hourly scheduler with the
        Vercel daily cron kept as a floor**, so a dead scheduler degrades to
        daily rather than to silence. The route is idempotent and
        frequency-agnostic by construction, which is what made this a
        deployment change rather than a redesign.
      - **The freeze runs the OPPOSITE way from `lib/watchlog`.** That module
        freezes a day key because it records HISTORY — a fact about where the
        user *was*. Quiet hours are a LIVE preference about where they *are*,
        so the IANA zone is refreshed by the client and never frozen;
        freezing it would wake someone at 3am after they moved country. A
        fixed offset would be wrong for a third reason: DST. Air dates stay
        frozen calendar dates as always. The rule both obey: **never derive a
        user's local time by assuming the server's zone.**
      - **First-ever use of `SUPABASE_SERVICE_ROLE_KEY`** — see the standing
        section above for the blast radius and the containment. Short
        version: exactly one importer, enforced by a guard test that is the
        only mechanical thing preventing a second; the client never escapes
        its module; reachable tables are a typed allowlist where
        `writeTable("watched_episodes")` is a compile error.
      - **Anti-noise, collected**: default off for every show, no global
        "all shows" switch anywhere, never derived from tracking status, one
        notification per show per run (a full-season drop is "8 new
        episodes", not eight pushes — enforced in *detection*, the only layer
        that sees the whole change at once), OS-level `tag` collapsing, and
        exactly two event kinds with no room in the schema for a third.
      - **iOS gets instructions, never a dead button.** Capability is
        feature-detected, never version-sniffed, so the commonly-cited 16.4
        floor appears in neither code nor copy — the design doc flags that
        number as asserted rather than verified.
      - **`web-push` is a deliberate exception** to this project's
        anti-dependency bias. The icons/charts arguments are about bundle
        weight and API surface for simple things; VAPID JWT signing plus RFC
        8291 payload encryption is real cryptography where a subtle mistake
        is silent.
      - Corrects the design doc: follows and prefs do **not** join
        `SYNC_TABLES`. `lib/sync` reconciles a local-first replica, but these
        have no offline story — the only consumer is a server-side cron — so
        they are the same class as comments and lists: account-gated and
        server-authoritative, which makes cross-device consistency *stronger*
        than sync rather than weaker.
      - **Verified**: 17 adversarial SQL checks against real PostgreSQL 18
        (negative control plus targeted controls proving the `followed_at`
        lock and the `USING (false)` table each fail when broken); 4 guard
        negative controls (a rogue service-role importer, an exported client,
        a forbidden `writeTable`, and the route guard catching both new
        routes unprompted); 51 unit tests across quiet hours, detection and
        delivery, with the timezone suite re-run under four host zones
        including a half-hour offset. 817 across the suite.
      - **Not verified**: no live end-to-end push. That needs VAPID keys, a
        deployed HTTPS origin and a real device — none of which exist in this
        environment. Everything up to `webpush.sendNotification` is
        exercised; the network hop itself is not. **Still owed**: a real
        subscribe → cron → device round trip, and the iOS
        install-then-subscribe path on actual hardware.

**Phase 7 is complete.**

## Phase 8 status

- [x] **Step 1** — Year in Review (`lib/yir/`, `components/yir/`,
      `app/profile/year/`). A shareable summary of someone's viewing year,
      built on the watch-date log that has existed for this since Phase 5.
      - **A ROLLING 12 MONTHS, NOT A CALENDAR YEAR**, and the label says so in
        three places — the page heading, the metadata title, and the opener
        card with the real date range. Being mistaken for a calendar-year
        summary is the one misreading that would make every number wrong.
        Reasons, in order: a feature that is empty for four months is one
        nobody builds a habit around; December-Wrapped works because Spotify
        already has your whole year, whereas a new tracker's year-one users
        would open a near-empty card and conclude it was broken; and the log
        has no backfill, so a January boundary would routinely describe a
        period that mostly predates the data.
      - **The design was driven by looking at real data first**, and it
        changed the plan. See the bulk-flag section above for the measurement:
        85% of a real log was a single click, and the rhythm card — the one
        the `m` field exists for — would have confidently reported "you're a
        4am watcher" off the back of it. `computeRhythm` therefore counts only
        timed, NON-BULK events and returns null below a sample floor, so the
        card is **absent rather than wrong**. Verified live: on the real log it
        does not render.
      - **Cards are selected by data sufficiency, not a fixed template.** The
        brief asked for a thin year to feel charming rather than empty, and
        the answer is not a special thin layout — it is that the deck is
        assembled from whatever the data supports. This works because of an
        asymmetry visible in real data: **distribution stats degrade
        gracefully and volume stats do not.** "Across 6 decades, 1975 to 2024"
        is charming at n=12; "39 things watched" is not.
      - **The headline ladder has a rung that leans INTO thinness.** A first
        draft fell through every branch for the most common year-one user
        (three films, three genres, three decades → no persona, no critic
        verdict, no top show) and produced the blandest possible line. The fix
        was not a lower threshold but a different framing: "Three decades in
        3 titles" is a better line *because* the count is small. Caught by a
        test written for that exact case.
      - **Shareable as an IMAGE, not a public link**, and the reason is
        architectural rather than aesthetic. A link would make this the first
        feature to upload personal data to a server, would need an account
        (most users are signed out), a new public-read surface with its own
        RLS, and would break the "works offline from local data" requirement —
        while creating a URL that outlives the user's intent. An image is
        rendered on-device and leaves only if handed to someone, which gives
        the strongest privacy guarantee available: **what you see is exactly
        what you share.** 1080×1350 (4:5) rather than 9:16, because story
        ratios get centre-cropped in chat previews and the brief was group
        chats. Drawn with the canvas 2D API, not html2canvas — same
        anti-dependency reasoning as the icons and charts.
      - **Privacy is structural, not filtered.** `RatingEntry.note` is never
        read (a test asserts no note text survives into the computed output),
        and `lib/lists` is **never imported at all** — not "filtered by
        visibility", simply not touched, which is a guarantee verifiable by
        grep rather than by reasoning about a filter.
      - **The importer case is handled by provenance, not by guessing.** Live
        events always carry `m`; IMDb and Letterboxd imports never do (only
        Trakt supplies a real time), so a missing `m` reliably means "time
        unknown". When untimed events dominate, the tally card says so
        outright — "most of this came from imported history" — because a
        diary entry is something you watched but an import is not a viewing
        year, and the card must not dress one up as the other.
      - **Hours are labelled as estimates and suppressed when they aren't
        worth stating.** Movie runtime is null on pre-Phase-5 records and
        per-episode runtime is stored nowhere, so `runtimeConfidence` tracks
        how much of the figure rests on a real measurement; below 20% the line
        is dropped rather than shown with false precision. A coarse
        whole-show mark contributes no runtime at all — we genuinely do not
        know how many episodes it stood for.
      - Works offline and signed out: everything is computed from local
        storage, and `/profile/year` builds **static**.
      - 31 tests in `lib/yir/yir.test.ts` (windowing, the bulk problem, the
        thin year, the empty case, the importer case, join failures, the
        privacy assertion) plus 3 new watchlog tests pinning the bulk fix —
        851 across the suite.
      - **Verified live against real local data at 375px**: 7 cards, no
        horizontal scroll, no overflowing elements; the rhythm card correctly
        absent; the critic card correctly scoped to the 3 titles both watched
        in range and rated. The share image was rendered and **looked at** —
        which is how two flaws were found that no test would have caught: raw
        ISO dates where the on-screen card says "Aug 12, 2025", and a dead
        band between the stats and the critic line whenever the stat list was
        short. Both fixed.
      - **Not verified**: the OS share sheet itself. `canShare({files})` is
        true on this machine, so invoking it would open a modal that hangs the
        automation session. The render, the blob, the dimensions and the
        download fallback are all exercised; the hand-off to the OS is not.
- [x] **Step 2** — Home customization (`lib/home/`, `components/home/`,
      `components/settings/`, `app/settings/`). Moviebase paywalls exactly
      this; here it's Settings. Reorder/hide Home's two sections (Up Next,
      Trending), pick the app's first page (Home/Library/Schedule/Search),
      toggle the streak badge. Synced like everything else in this app —
      `home_config` is the 8th table through the Phase 6 sync pipeline.
      - **Native home-screen widgets need a native app, not a PWA — asked and
        answered rather than silently skipped.** No web API lets a PWA render
        live content on the OS home screen itself. The honest web equivalent
        is the **Badging API** (`navigator.setAppBadge()`) — a small count on
        the app icon, the closest thing the web platform actually offers.
        **Deliberately deferred, not built now**: keeping a badge accurate
        while the app is CLOSED needs code running with the app closed, and
        this codebase already has exactly one thing that does that — the
        Phase 7 Step 5 Web Push `push` handler in `public/sw.js`, which
        already runs a service worker wake-up per notification and already
        sets a *notification's own* `badge:` icon (a different, unrelated
        field). A future step calling `self.registration.setAppBadge(n)`
        inside that SAME handler is real, honest, and nearly free —
        building any badging infrastructure before Phase 7 Step 5 existed
        would have meant standing up a service worker wake-up path twice.
        Tracked as a candidate for whenever push notifications get their
        next real pass, not this step.
      - **`HomeConfig` is one preference blob, not per-field records** —
        `firstPage`, `sections` (order + visibility), `showStreakBadge`, one
        `updatedAt`. Deliberately the simplest sync rule in the app: *newer
        `client_updated_at` wins, wholesale* — no field-level union, because
        an arbitrary preference blob has no honest union (unlike episode
        ranges, where a union is obviously correct). A dedicated merge test
        pins that the two sides never blend.
      - **Excluded from the first-login merge's "are you sure" gate on
        purpose.** `isSnapshotEmpty()` (design doc §6.6) drives whether the
        scary "this looks like two different libraries" confirmation
        appears, and that gate exists for exactly one irreversible risk:
        uploading a library into the wrong account. A UI preference carries
        none of that risk, so `homeConfig` doesn't count toward it.
      - **`setHomeConfig()` — the UI-facing write path — enqueues an outbox
        write; the sync engine's pull-apply and `restoreSnapshot` do NOT go
        through it**, writing `homeConfigStore` directly instead, exactly
        matching how `lib/xp/store.ts`'s `seenLevelStore` is already written
        directly from those same two call sites. Routing a just-pulled or
        just-restored value back through the public setter would re-enqueue
        it right back into the outbox it came from.
      - **A real circular import, caught before it ever ran wrong.** The
        barrel `lib/home/index.ts` re-exports `store.ts`, which (once wired
        for sync) imports `lib/sync/record.ts`, which imports
        `lib/sync/wire.ts` — and `wire.ts` needed `isHomeConfig` from
        `lib/home`. Importing the BARREL there would have closed the loop
        for real. Fixed by having `wire.ts` import `@/lib/home/types`
        directly instead, which is also simply consistent with how every
        OTHER cross-domain type in that file is already imported
        (tracking/ratings/watchlog all use their own `/types` sub-path, not
        their barrel) — `/types` has no path back into `lib/sync` at all, so
        there is no cycle to reason about. Verified with real tests and a
        real `next build`, not just reasoned about — ESM circular imports
        often "work" by accident when nothing dereferences the loop at
        module-evaluation time, which is exactly the kind of thing worth not
        trusting on faith.
      - **The first-page redirect is a `beforeInteractive` inline script
        (`lib/home/redirect-script.ts`), not a React effect — has to be.**
        `beforeInteractive` runs before hydration, before any React tree
        exists for an effect to belong to, so it reads `localStorage`
        directly and synchronously, bypassing `lib/storage`'s async driver
        entirely — awaiting a Promise here would defeat the entire point of
        running this early. Scoped to `location.pathname === "/"`: App
        Router client-side `<Link>` navigation never reloads the document,
        so the script can only run again on a genuine cold load, but a cold
        load of `/library` directly must not itself bounce anywhere — only a
        cold load of `/` is "which page did you actually mean to open."
        Wrapped in one try/catch with no rethrow: blocked or corrupted
        storage must degrade to staying on Home, never to a thrown error
        stalling page load.
      - **The generated script is unit-tested by actually EXECUTING it**,
        not pattern-matched — `new Function("localStorage", "location",
        script)` runs the real generated source against fake
        `localStorage`/`location` objects passed as the function's own
        parameters, which shadow anything of the same name in the runner's
        environment regardless of what globals it does or doesn't have. A
        redirect bug here means every cold open of the app lands somewhere
        the user didn't choose — worth the strongest coverage available, the
        same reasoning `public/sw.js`'s `CACHEABLE_ROUTES` guard already
        applies by parsing the real worker source instead of a hand-copied
        list.
      - **`HOME_CONFIG_NAMESPACE`/`HOME_CONFIG_KEY` are exported constants,
        not a hardcoded string repeated in the redirect script.** The
        localStorage key the redirect script reads is built from the exact
        same two exports `lib/home/store.ts` passes to `defineStore` — a
        rename of either would otherwise silently break the redirect with no
        error anywhere, since the script has no way to signal "the key I'm
        reading doesn't exist" versus "nothing is stored yet."
      - **`HomeSections` (`components/home/`) reorders by real DOM order via
        a plain `.map()`, never CSS `order`** — `order` only moves pixels; it
        changes neither tab order nor screen-reader reading order, which
        would leave both silently mismatched from what's visually on screen
        the moment a user reorders anything. Takes both sections as
        already-rendered nodes (`slots: Record<HomeSectionId, ReactNode>`)
        handed down from `app/page.tsx` — Trending stays exactly what it was
        (a Server Component streamed behind its own Suspense boundary), Up
        Next stays a Client Component, and neither needs to know it's
        reorderable. `HomeSections` itself decides WHERE each one sits,
        never what's inside it.
      - **Hiding every section falls through to an `EmptyState`**, not a
        blank gap under the page header — the same "never blank" rule
        CLAUDE.md already documents for Search's three states and Up Next's
        own empty state, applied to a genuinely new way to reach zero
        visible content. Its action button links back to `/settings`.
      - **Reached from a "Settings" button on Profile, not a 5th
        `NAV_ITEMS` entry** — the same placement precedent as `/lists`,
        `/schedule`, and `/notifications`: a low-frequency route lives on
        whichever page it's most contextually relevant to, not in the fixed
        four-item global nav.
      - **`/settings` classified `cacheable` in `public/sw.js`** — static,
        identical for every visitor, since `home_config` lives in local
        storage read client-side, the same reasoning already covering
        `/library` and `/schedule`. The route-classification guard
        (`lib/pwa/route-guard.test.ts`, Phase 5 Step 6) failed loudly the
        moment the route existed and was unclassified, exactly as designed.
      - **Native `<input type="radio">`/`<input type="checkbox">`
        throughout the settings screen**, matching every other form control
        in this app (the rating slider, notification settings) rather than
        a custom widget — real platform focus rings and touch handling for
        free, and the first-page picker stays a VISIBLE native radio group
        rather than a hidden-input-plus-styled-pill pattern specifically so
        the global `:focus-visible` cyan ring (CLAUDE.md's "Quality floor")
        lands on something a sighted keyboard user can actually see.
      - **Optimistic writes with visible rollback** (`useHomeConfig`,
        `components/home/`), same shape as `lib/tracking/context.tsx`'s
        `setStatus`: update local state immediately, await the storage
        write, revert AND surface a transient error banner on failure. Lower
        stakes than a watch/rating write — a dropped write here costs a
        misordered Home layout, not lost history — but "a failed write must
        not render as success" is still the documented rule for this whole
        storage layer, not a tracking-specific one.
      - 46 new tests (`lib/home/types.test.ts`, `redirect-script.test.ts`,
        `lib/sync/wire.test.ts`/`merge.test.ts` additions) — 897 across the
        suite. Adversarial SQL: `supabase/tests/06_home_config_adversarial.sql`,
        9 checks against a real PostgreSQL 18 including both novel
        protections (the clamp, the LWW reject) proven to actually fail when
        their triggers are removed, then restored and re-confirmed clean.
      - **Live-verified** against the real dev server (screenshot/pixel
        tooling was unavailable this session — verified instead via DOM
        queries and direct `localStorage` reads through the page's own JS
        context, which if anything pins the actual data contract more
        precisely than a screenshot would): reordering and hiding sections
        reflects on Home immediately; hiding both renders the empty state
        with a working settings link; setting the first page to Library and
        cold-loading `/` redirects to `/library`; clicking an in-app `<Link>`
        to Home from another page does **not** redirect, even with a
        non-Home first page configured; the streak-badge toggle persists and
        reads back correctly after a reload. Zero console errors throughout.

---

## Legal / attribution

TMDB **Developer** (free, non-commercial) terms apply. Keep the app free and
unmonetized or the terms no longer cover it.

- **TMDB attribution** is required in the UI footer: "This product uses the
  TMDB API but is not endorsed or certified by TMDB", plus the TMDB logo.
- **JustWatch attribution** is a *separate* requirement. TMDB sources watch
  provider data from JustWatch, and their terms require a visible "Powered by
  JustWatch" credit **wherever that data is displayed**. `getWatchProviders()`
  exists but is not rendered anywhere yet — whoever builds the Phase 4 detail
  page owes this credit the moment it renders.

---

## Conventions

- Comment the non-obvious *why*, not the obvious *what*.
- Small, reviewable steps. Do not dump thirty files at once.
- Say plainly when a requested approach is a bad idea.
- Server Components by default; `"use client"` only where interaction demands it.
