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
  mock/         mockProvider — ~25 hand-authored titles, full episode lists for
                two shows, CSS-gradient art, simulated latency. Zero network.
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

### Verified, not assumed

The boundary was tested in Step 3, not taken on trust:

- A client component importing `@/lib/content` **fails the build** with a full
  import trace. That is `server-only` working; if you ever hit this error, fix
  the import — do not delete the guard.
- `.next/static` was grepped for `TMDB_READ_ACCESS_TOKEN`, `api.themoviedb.org`,
  `image.tmdb.org`, `Bearer `, `tmdbProvider`, `tmdbFetch` — all absent, with a
  positive control confirming the grep detects strings that *are* present.

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

### The Phase 4 theming root

`app/title/[mediaType]/[id]/page.tsx` wraps its entire output in
`<div data-title-theme style={{ "--title-art-from", "--title-art-to" }}>`.

That element is the seam Phase 4 plugs into: it will set `--accent-primary` /
`--accent-secondary` there from extracted artwork colours, and every
`bg-accent` / `text-accent` / `border-accent` beneath re-tints with no
component changes. The two `--title-art-*` properties already do exactly this
in miniature — per-title values set on the wrapper, consumed by the hero wash —
so Phase 4 needs no new mechanism, just more properties on the same element.

Verified live, not assumed: overriding `--accent-primary` on that wrapper
retinted the rating badge inside it (gold → green) while the sidebar wordmark
outside it stayed unchanged.

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

### Known gap: multi-tab

Two tabs writing the same namespace will clobber each other — there is no
`storage`-event listener and no merge. Acceptable while everything is
device-local; revisit alongside Phase 6 accounts, where sync arrives anyway.

---

## Phase roadmap

| Phase | Scope |
|---|---|
| 1 *(done)* | Foundation: content abstraction + both providers, design system, app shell, Home, detail page |
| **2** *(current)* | Search, My Library, watchlist/watched state |
| 3 | Episode-level progress, "Up Next" engine |
| 4 | Rich detail pages with artwork-derived dynamic theming |
| 5 | XP, levels, streaks, badges; PWA manifest + service worker |
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
- [ ] **Step 3** — Watchlist / watched state on top of that storage
- [ ] **Step 4** — Search UI, wired to `httpProvider.searchTitles`

Search UI comes last deliberately: it is the easy part once the transport and
storage exist, and building it first would have tempted a shortcut around the
provider abstraction.

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
