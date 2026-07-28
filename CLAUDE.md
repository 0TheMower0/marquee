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

### Client-side data seam (not built yet — Phase 2)

Phase 1 pages are Server Components that call the provider directly, so no API
routes exist. Search-as-you-type needs client-side fetching. When that lands:

1. Add route handlers under `app/api/content/*` that call
   `getContentProvider()` server-side and return normalized JSON.
2. Add `lib/content/http/` — an `httpProvider` implementing the **same**
   `ContentProvider` interface by fetching those routes.

Client components then get the identical interface. Do **not** solve this by
importing the TMDB provider into a client component.

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

## Local persistence

An **async** key-value interface with a localStorage driver.

The interface is `Promise`-based even though localStorage is synchronous. That
is deliberate: Phase 2's episode-level tracking means thousands of rows, and
localStorage's ~5 MB synchronous, main-thread-blocking cap becomes a real
problem. With an async interface, swapping in IndexedDB is a one-file change;
with a sync one it is a refactor of every call site.

---

## Phase roadmap

| Phase | Scope |
|---|---|
| **1** *(current)* | Foundation: content abstraction + both providers, design system, app shell, Home, detail page |
| 2 | Search, My Library, watchlist/watched state |
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
- [ ] **Step 4** — Design system: Button, Card, Badge, Tabs, Skeleton, EmptyState, TicketCard
- [ ] **Step 5** — App shell: nav, four routes, footer
- [ ] **Step 6** — Home (trending grid) + `/title/[mediaType]/[id]`

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
