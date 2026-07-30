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

### These routes are a public surface — Phase 6 owes them rate limiting

Once deployed, `app/api/content/*` is callable by anyone who finds the URL, not
just by our own client code. There is **no rate limiting, no auth, and no
abuse protection on them today.** That is acceptable for a personal,
unadvertised deployment and is not acceptable indefinitely.

What already limits the blast radius:

- Every response sets `s-maxage` (see `CACHE_SECONDS`), so repeated identical
  requests are absorbed by the CDN rather than reaching TMDB.
- `next.revalidate` on the TMDB fetches caches upstream results independently.
- Input validation caps `page` at 500 and `query` at 200 characters, so a
  single request can't ask for something unbounded.

What is still missing, and belongs with Phase 6 (accounts/Supabase, where
per-user identity finally exists): real per-IP or per-user rate limiting on
these routes. Without it a determined caller can still burn our TMDB quota via
cache-missing queries — a unique `?query=` string per request defeats every
cache layer listed above. Do not treat the caching as a substitute.

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

**Phase 5 (streaks) and Phase 8 (Year in Review) both need watch dates.** When
they land, they get a **separate, append-only log keyed by date** — roughly
"on 2026-07-14, these episodes were watched" — living in its own storage
namespace with its own schema version. Progress state and watch history are
different concerns with different shapes and different access patterns:

| | progress | watch history |
|---|---|---|
| question | "have I seen S3E7?" | "what did I watch in June?" |
| access | read constantly, per title | append on write, scanned in bulk |
| shape | ranges, keyed by season | events, keyed by date |
| mutability | edited freely | append-only |

Merging them forces one of the two to adopt the wrong shape. Keep them apart.

### Known gap: multi-tab

Two tabs writing the same namespace will clobber each other — there is no
`storage`-event listener and no merge. Acceptable while everything is
device-local; revisit alongside Phase 6 accounts, where sync arrives anyway.

---

## Watchlist / watched state — `lib/tracking/`

```
lib/tracking/
  types.ts     TrackingStatus, TrackingEntry (discriminated on mediaType),
               EpisodeRange, WatchedEpisodes, SeasonEpisodeCounts
  ranges.ts    pure inclusive-range primitives + the canonical invariant
  progress.ts  episode operations and derived queries — pure, no storage
  store.ts     trackingStore — a lib/storage Store<TrackingEntry>, version 2,
               with the v1 -> v2 migration
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

## Phase roadmap

| Phase | Scope |
|---|---|
| 1 *(done)* | Foundation: content abstraction + both providers, design system, app shell, Home, detail page |
| 2 *(done)* | Search, My Library, watchlist/watched state |
| 3 *(done)* | Episode-level progress, "Up Next" engine |
| 4 *(done)* | Rich detail pages with artwork-derived dynamic theming |
| **5** *(current)* | XP, levels, streaks, badges; PWA manifest + service worker |
| 6 | Supabase accounts, spoiler-safe comments, shared lists |
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
