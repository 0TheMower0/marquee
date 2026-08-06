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

### Log writes never block or fail a tracking write

Appended only *after* the tracking write succeeds (never log what didn't
persist), fire-and-forget, errors warned and swallowed. Marking something
watched must not fail because a history record couldn't be appended. One
read-modify-write per **day**, so a 13-episode season mark is one storage
round trip, not 13 — with the same no-lock caveat as the multi-tab gap below.

### Known gap: multi-tab

Two tabs writing the same namespace will clobber each other — there is no
`storage`-event listener and no merge. Acceptable while everything is
device-local. **Scheduled for Phase 6 Step 5**, where sync makes it worse (two
tabs would carry two independent outboxes) and therefore has to fix it: see
`docs/phase-6-sync-design.md` §5.

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

## Phase roadmap

| Phase | Scope |
|---|---|
| 1 *(done)* | Foundation: content abstraction + both providers, design system, app shell, Home, detail page |
| 2 *(done)* | Search, My Library, watchlist/watched state |
| 3 *(done)* | Episode-level progress, "Up Next" engine |
| 4 *(done)* | Rich detail pages with artwork-derived dynamic theming |
| 5 *(step 6 outstanding)* | XP, levels, streaks, badges, stats dashboard; PWA manifest + service worker |
| **6** *(current)* | API rate limiting, Supabase accounts + sync, spoiler-safe comments, shared lists — design in `docs/phase-6-sync-design.md` |
| 7 | CSV importers (Trakt/Letterboxd/TV Time), new-episode notifications |
| 8 | Year in Review |

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
- [ ] **Step 6** — PWA manifest + service worker

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
        (`server-only`, lazy read), and no current code path needs it.
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
      - **Every session mutation is a Server Action; nothing Supabase-related
        runs in the browser at all.** Cookies can only be written from a Server
        Function or Route Handler, so a browser-SDK `signInWithPassword` would
        produce a session the *browser* knows about and the next server render
        does not — which is the "works correctly with Server Components"
        requirement failing. Measured consequence: `grep -ri supabase
        .next/static` returns **zero files**. A `browser-client.ts` was written
        and then **deleted** on discovering nothing imported it; Step 5 can add
        one when sync actually needs it.
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
- [ ] **Step 5** — Ongoing sync: outbox, pull cursor, conflict rules, multi-tab
      coordination (which also closes the multi-tab clobbering gap documented
      in the storage section)
- [ ] **Step 6** — Spoiler-safe comments, shared lists

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
