# Phase 7 Step 1 — CSV importers: design

Status: **proposed, not approved.** Nothing in this document is built yet.

Companion to `docs/phase-6-sync-design.md`. Read the "Watch DATES are a
separate store", "Local persistence" and "Sync" sections of CLAUDE.md first —
several decisions below are direct consequences of rules already established
there, and look arbitrary without them.

---

## 0. What was verified, and what was not

The brief said to research the real formats rather than guess. Results, stated
plainly — including two places the brief's own premises turned out to be wrong.

| Source | Verified? | Columns |
|---|---|---|
| **IMDb ratings** | ✅ multiple independent sources | `Const, Your Rating, Date Rated, Title, URL, Title Type, IMDb Rating, Runtime (mins), Year, Genres, Num Votes, Release Date, Directors` |
| **IMDb watchlist** | ✅ | `Position, Const, Created, Modified, Description, Title, Original Title, URL, Title Type, IMDb Rating, Runtime (mins), Year, Genres, Num Votes, Release Date, Directors, Your Rating, Date Rated` |
| **Letterboxd `diary.csv`** | ✅ | `Date, Name, Year, Letterboxd URI, Rating, Rewatch, Tags, Watched Date` |
| **Letterboxd `ratings.csv`** | ✅ | `Date, Name, Year, Letterboxd URI, Rating` |
| **Letterboxd `watchlist.csv` / `watched.csv`** | ✅ | `Date, Name, Year, Letterboxd URI` |
| **Moviebase CSV** | ❌ **could not verify it exists** | see §0.2 |
| **Trakt CSV** | ⚠️ partial — no single canonical format | see §0.3 |

### 0.1 CORRECTION: Letterboxd exports contain no IMDb ids

The brief says "IMDb ids appear in IMDb and Letterboxd exports." **They do not
appear in Letterboxd exports.** Every Letterboxd CSV carries a `Letterboxd URI`
and nothing else — no IMDb id, no TMDB id, despite Letterboxd itself being
TMDB-sourced. Letterboxd has internal numeric film ids and does not expose them
in exports.

This is not a detail. It moves the centre of gravity of the whole feature:

- **IMDb imports** are almost entirely Tier 1 (exact id match). The review queue
  is an edge case.
- **Letterboxd imports** are 100% title+year matching. The review queue is the
  *main path*, not the exception.

Any design that treats manual review as a rare fallback would be wrong for half
the sources. The review queue has to be good enough to process a few hundred
rows without exhausting the user.

**Rejected: scraping `letterboxd.com/film/<slug>/` to recover the TMDB id.**
Those pages do link to TMDB, so it would work. It is rejected because it means
3,000 requests to a third party per import, against their terms, from a server
that would get blocked, to build a load-bearing dependency on someone else's
page markup. The `Letterboxd URI` slug is still *used* below — as a matching
signal and a dedup key — just never fetched.

### 0.2 CORRECTION: there is no verifiable Moviebase CSV export

The brief asks for "Moviebase's own CSV export." I could not verify one exists.
What the evidence shows instead: Moviebase's backup feature produces **JSON**,
is **Premium-only**, its community forum now redirects to a contact page, and
Moviebase's *own* migration guidance routes users through Trakt rather than a
native file.

Worth noting: CLAUDE.md's roadmap line for this phase says
**"CSV importers (Trakt/Letterboxd/TV Time)"** — Moviebase is not on it. The
brief and the roadmap disagree, and the roadmap looks more right.

Recommendation: **drop Moviebase, ship IMDb + Letterboxd in Step 1**, and treat
Trakt/TV Time as Step 2 after their formats get the same verification pass. See
§9.

### 0.3 Trakt has no single canonical CSV

Trakt's own export is API/VIP-oriented; the CSVs people actually have come from
community tools (`xbgmsharp/trakt` and similar) whose id column is
*configurable* — `imdb`, `tmdb`, `tvdb`, `tvrage`, or `trakt`. So "Trakt CSV" is
a family of shapes, not one. Supportable, but it needs its own verification
pass and a column-mapping step, which is why it is not in Step 1.

### 0.4 One thing that verified cleanly and carries the whole design

TMDB's `/find/{external_id}?external_source=imdb_id` accepts `imdb_id` and
returns `movie_results`, `tv_results`, `tv_episode_results`, `tv_season_results`
and `person_results` in one response. That is Tier 1. It also means an IMDb
`tvEpisode` row is resolvable all the way to a show + season + episode — real
future value, deferred in §9 rather than dismissed.

---

## 1. Shape of the pipeline

```
file → parse (worker) → normalize → dedup → resolve (batched) → classify
     → PREVIEW → review queue → commit (cursor walk) → done
```

Nothing is written to storage until **commit**. Everything before it is job
state, which is itself persisted so the whole thing survives a reload.

### 1.1 Normalize early — one row shape, source-agnostic

Every parser's only job is to produce `ImportRow[]`. Nothing downstream knows
which source a row came from.

```ts
interface ImportRow {
  /** Stable within a file, across re-parses. Source + natural key —
   *  INCLUDES the watch date, because a Letterboxd rewatch is several
   *  legitimately different rows for one film. */
  sourceRowId: string;
  imdbId: string | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  slug: string | null;            // Letterboxd URI slug — dedup + match signal
  mediaTypeHint: "movie" | "tv" | "episode" | "unknown";
  score: number | null;           // normalized to OUR 0–100
  ratedOn: string | null;         // YYYY-MM-DD
  watchedOn: string | null;       // YYYY-MM-DD, LOCAL calendar date — see §5
  isRewatch: boolean;
  intent: "watchlist" | "watched" | "rating-only";
  sourceLine: number;             // for showing the user the raw row
}
```

Adding TV Time later is then one parser and zero changes to matching, review or
commit — the same reason `ContentProvider` exists.

### 1.2 Rating scales land on the same grid, which is lucky

- IMDb `1–10` integer → `×10` → `10–100`
- Letterboxd `0.5–5.0` in half-star steps → `×20` → `10–100`

Both produce 10-point steps on our 0–100 scale, so a 4-star Letterboxd rating
and an 8/10 IMDb rating both become exactly `80`. No source needs a special
case, and a user importing from both does not get two subtly different scales
in one library.

---

## 2. Matching strategy

### 2.1 Tier 1 — external id. Unambiguous, auto-imports.

`findByExternalId(imdbId)` → TMDB `/find`. Deterministic, authoritative, one
call. Covers effectively all of IMDb.

Unambiguous means: exactly one of the result arrays is populated and it holds
exactly one entry. A row that somehow returns both a movie and a TV result goes
to review like anything else ambiguous.

**This is a new `ContentProvider` capability**, so per the central architectural
rule it goes into `lib/content/types.ts` and `provider.ts` **first**, then gets
implemented in **both** providers — not bolted onto the TMDB one. `mockProvider`
gets real `imdbId` values on a handful of catalog titles specifically so the
import flow is exercisable offline with no key, preserving the zero-config
promise. A mock title without one returns `not_found`, honestly.

### 2.2 Tier 2 — title + year. The fallback, and it is where wrong matches live.

Normalization before comparison: lowercase → NFKD → strip diacritics → drop a
leading article (`the/a/an/le/la/les/el/il/der/die/das`) → collapse punctuation
and whitespace → strip a trailing `(1999)`.

Deterministic scoring — no ML, no opaque similarity library, so a bad match can
always be explained to the user in one sentence:

| Signal | Points |
|---|---|
| normalized title identical | +60 |
| token-set overlap (Dice) | up to +45 |
| year exact | +30 |
| year off by 1 | +15 |
| year off by 2 | +5 |
| year missing on either side | 0 |
| media type agrees with hint | +10 |
| media type contradicts hint | **−40** |
| popularity | **tiebreak only — never additive** |

Popularity being a pure tiebreak is deliberate and load-bearing. Popularity as
a score component is precisely the mechanism that silently matches `Dune` to
the 2021 film when the user meant 1984, and the user never notices.

### 2.3 Classification — the rule that must not erode

Every resolved row lands in exactly one bucket:

| Bucket | Condition | Fate |
|---|---|---|
| `exact` | external id → single result | **auto-import** |
| `confident` | normalized title equal **and** year equal **and** media type consistent **and** no second candidate also equal on title+year | **auto-import** |
| `ambiguous` | ≥1 candidate, anything short of the above | **review queue** |
| `unmatched` | 0 candidates | **review queue**, with manual search |
| `unsupported` | e.g. IMDb `tvEpisode`, `short`, `videoGame` in v1 | shown in preview as skipped — never silently dropped |
| `duplicate` | already in the library at ≥ this progress | shown as no-op |

Stated as one sentence, because it is the thing to defend in review:

> **Only two things auto-import: an external-id match, or a title+year match
> that is exact on both fields and unique. Everything else is a human
> decision.**

Two things explicitly rejected:

- **A numeric confidence threshold** ("auto-accept above 85"). A threshold is a
  dial, and a dial gets turned down the first time someone finds the review
  queue long. Its failure mode is invisible, which is the exact property the
  brief says to avoid.
- **Breaking a title+year tie by popularity.** If two candidates both match
  title and year exactly, that is a remake or a re-release and it is genuinely
  ambiguous. It goes to review even when one candidate is a hundred times more
  popular.

### 2.4 Expected ambiguity rate — a hypothesis, not a claim

Letterboxd's data is TMDB-sourced, so its title strings should match TMDB's
closely and most rows should land `confident` despite having no id. Ambiguity
should concentrate in foreign-language films (original vs. English title),
re-releases, and shared title+year.

That is a hypothesis. It gets **measured against a real export** before this
step is called done, not asserted. If Letterboxd ambiguity turns out to be 30%
rather than 5%, the review queue's ergonomics matter far more than this
document assumes and the design should be revisited.

---

## 3. Review queue design

The user resolves these by hand, so the cost of the feature is measured in
their attention. For a Letterboxd import this could be a few hundred rows.

### 3.1 Route and flow

A dedicated `/import` route with an explicit stepper:

```
Upload → Resolving (progress, cancellable) → Preview → Review → Commit → Done
```

Resolution happens **before** the preview. That ordering is what makes the
preview honest: it can state real counts instead of estimates.

### 3.2 Preview — nothing has been written yet

```
  147 will import      ← exact + confident
   38 need review      ← ambiguous + unmatched
   22 already in your library
    6 unsupported (IMDb TV episodes)
    2 failed to parse (line 331, line 902)
```

Each count expands into its list. One prominent line states that nothing has
been written, and the commit button is the only thing in the flow that writes.

### 3.3 The queue itself

**One row at a time, not a table.** A table of 200 rows with dropdowns invites
skimming, and a skimmed decision is how a wrong match gets committed. The whole
point of this screen is deliberation.

```
┌─ Reviewing 12 of 38 ────────────────────────────────┐
│                                                      │
│  FROM YOUR FILE            line 412                  │
│  Gravity                                             │
│  2013 · ★★★★☆ · watched 2019-03-14                  │
│                                                      │
│  BEST MATCHES                                        │
│  [1] ▣  Gravity              2013  Film              │
│         title matches exactly, year matches          │
│  [2] ▣  Gravity              2010  Film              │
│         title matches exactly, year differs by 3     │
│  [3] ▣  Gravity Falls        2012  Series            │
│         partial title match, wrong media type        │
│                                                      │
│  [1-3] pick   [/] search manually   [s] skip         │
└──────────────────────────────────────────────────────┘
```

- **Left: the raw CSV row**, including its line number, so the user checks
  against ground truth rather than against our interpretation of it.
- **Right: 3–5 candidates**, each with poster, title, year, media type, and a
  **plain-language reason**. The reason is generated from the scoring signals in
  §2.2 — which is the practical payoff of a transparent scorer over a black-box
  similarity number.
- **Keyboard-first.** Number keys pick, `/` opens manual search, `s` skips,
  arrows navigate. Two hundred rows through a mouse is how people start
  rushing, and rushing produces exactly the invisible wrong matches this whole
  design exists to prevent.
- **Sorted easiest-first** (highest top-candidate score). Momentum early, the
  genuinely hard ones clustered at the end where the user can stop and leave
  them pending.
- **Manual search reuses `AddItemSearch`** from Phase 6 Step 6b rather than a
  second search control.

### 3.4 Leaving mid-review is a supported outcome

Closing the tab at row 12 of 38 saves. On return, the job resumes at row 12.

Committing with rows still unresolved imports **only** the resolved and
auto-matched ones; unresolved rows stay pending in the saved job.

**There is deliberately no "import my best guess for the rest" button.** That
button is the feature the brief rules out, wearing a friendly label.

### 3.5 Skip-and-remember (optional, flag for scope)

"Don't ask again for this title" persists a `normalizedTitle+year → tmdbId`
decision, so a later import from a different source does not re-ask what the
user already answered. Genuinely useful for someone importing IMDb *and*
Letterboxd. Cheap, but it is new persisted state, so it is called out rather
than smuggled in.

---

## 4. Idempotency and resumability

Precedent: the deterministic UUIDv5 scheme in `lib/sync/uuid.ts`, and the bug
Phase 6 Step 5 hit with it.

```
importId = uuidv5(NAMESPACE_IMPORT, sha1(fileBytes))
eventId  = uuidv5(NAMESPACE_WATCHLOG, `${userId}:${dayKey}:${importId}:${sourceRowId}`)
```

- Same file → same `importId` → the app can say *"you imported this file on
  12 Aug"* instead of silently doubling it.
- Same row → same `eventId` → Phase 6's union merge dedupes it. **The derived id
  must be written back onto the local event.** That exact omission is what
  doubled the entire watch log on its second merge in Phase 6 Step 5; the
  replay test that caught it is the precedent to copy.
- `sha1` comes from the plain-JS implementation added in Step 5b, used
  unconditionally — `crypto.subtle` is secure-context-only and would derive
  different ids on a plain-HTTP origin, which for primary keys means duplicated
  history.

**Commit is a cursor walk, not a transaction.** Rows commit one at a time and a
cursor advances after each success. localStorage has no transactions — the
reason per-record lazy migrations exist in `lib/storage` — so a cursor is the
only crash-safe shape available. Interrupted at row 900 of 3,000, it resumes at
900.

**Import is additive and never downgrades**, reusing the first-login merge
semantics from `lib/sync/merge.ts` rather than reimplementing them:

| Field | Rule |
|---|---|
| status | max progress — a local `watched` is never demoted to an imported `watchlist` |
| score | local wins, unless the user chooses "prefer imported" once, globally |
| notes | untouched by import |
| watch events | union by deterministic id |

---

## 5. Dates — the part that makes streaks meaningful

`Watched Date` in a Letterboxd diary is already `YYYY-MM-DD` with no timezone.

**It is used verbatim as the watch-log day key. It is never parsed into a
`Date`.** Constructing a `Date` and re-deriving the day is exactly the bug
`lib/watchlog/types.ts` warns about at length — an imported calendar date
needs *validation*, not *conversion*. This also happens to be the easy path,
which is a good sign.

- Letterboxd `Date` (when the entry was logged) ≠ `Watched Date`. Use the
  latter.
- **Rewatches produce multiple events**, one per diary row, which is correct —
  that is real history. This is why `sourceRowId` includes the date.
- **IMDb `Date Rated` is not a watch date.** Default: do not synthesize watch
  events from IMDb at all. Offered as an explicit, clearly-labelled opt-in
  ("IMDb doesn't record watch dates — use the date you rated each title as an
  approximation?"), default **off**. Inventing dates is what the watch log's
  no-backfill rule exists to refuse.
- **The `b` (bulk) flag stays false for diary rows.** Their dates are real and
  one-film-per-day; flagging them bulk would understate a genuine viewing
  history in Year in Review.
- Proposed: an optional `src?: string` on `WatchEvent` carrying the `importId`.
  Additive and optional, so old records reading as `undefined` need no
  migration. It is what makes import provenance and "undo this import"
  possible.

---

## 6. Rate limiting and API budget

**OMDb is never called.** External ratings are a detail-page concern; import has
no use for them. The 1,000/day budget is untouched by a 3,000-row import.

**Our own limiter is the real constraint, and it currently blocks this.**
`RATE_LIMITS.search` is 30/min — a 3,000-row import would 429 on row 31. So:

- A dedicated **`POST /api/import/resolve`** taking a **batch of up to 25 rows**
  and returning candidate sets, under a new `RATE_LIMITS.import` rule. 3,000
  rows becomes ~120 requests instead of 3,000.
- **Dedup before resolving.** A diary with twelve rewatches of one film is one
  lookup. Key: `imdbId ?? slug ?? normalized(title)+year`.
- **Bounded concurrency server-side** (4 in flight against TMDB per batch),
  batches sequential client-side. Well inside TMDB's limits without needing to
  know their exact current number.
- **A longer `revalidate` for `/find`** than for search — an IMDb→TMDB id
  mapping is effectively immutable, so 24h (matching `detail`) rather than
  search's 5 minutes.
- A 429 backs off and retries; because job state is persisted, even a hard
  failure resumes rather than restarting.

---

## 7. Where parsing happens

**In a Web Worker, on the client.** Two reasons, and the second matters more:

1. A 10,000-row file should not jank the main thread.
2. **Local-first.** Uploading a user's complete viewing history to our server
   to parse it is a privacy regression in an app whose entire premise is that
   this data lives on their device. The only thing that reaches the server is
   the resolution request — `{imdbId, title, year}` tuples, which is already
   exactly what a search query is.

**CSV parsing: hand-rolled RFC 4180**, ~120 lines, heavily unit-tested: quoted
fields, embedded commas and newlines, escaped quotes, BOM, CRLF. Consistent
with this project's rejection of chart and icon libraries — though stated
honestly, CSV is subtler than icons, and the tests are what make hand-rolling
defensible rather than the line count. Letterboxd titles contain commas
constantly, so this gets adversarial fixtures.

**ZIP: Letterboxd exports a `.zip`.** A minimal ZIP reader over the platform's
`DecompressionStream('deflate-raw')` is ~80 lines and needs no dependency —
the central directory is simple and entries are deflate. The alternative is
telling the user to unzip first and drop loose CSVs. Flagged as a decision in
§10; the reader is cheap enough that accepting both seems right.

---

## 8. New surfaces this step adds

```
lib/import/
  types.ts       ImportRow, ResolvedRow, ImportJob, buckets     [pure, tested]
  csv.ts         RFC 4180 parser                                [pure, tested]
  zip.ts         minimal reader over DecompressionStream        [pure, tested]
  sources/
    imdb.ts      ratings + watchlist → ImportRow[]              [pure, tested]
    letterboxd.ts diary/ratings/watchlist/watched → ImportRow[] [pure, tested]
  normalize.ts   title normalization + scoring                  [pure, tested]
  classify.ts    the §2.3 bucket rules                          [pure, tested]
  dedup.ts       pre-resolution dedup keys                      [pure, tested]
  commit.ts      cursor walk, merge semantics
  store.ts       importStore — job state, resumable
  worker.ts      parse + orchestrate off the main thread

app/api/import/resolve/    batched matching endpoint
app/import/                the stepper UI
components/import/         dropzone, preview, review queue, progress
```

The pure/impure split matches `lib/comments/` and `lib/lists/`: every decision
(parsing, normalizing, scoring, classifying, dedup) is a pure function with
tests; only `commit.ts`, `store.ts` and the worker touch I/O. Matching rules
are exactly the kind of thing that must be testable against plain objects
rather than "we tried it on one file once."

---

## 9. Scope

**In, for Step 1:** IMDb ratings, IMDb watchlist, Letterboxd diary / ratings /
watchlist / watched.

**Deferred, deliberately:**

- **Trakt and TV Time** — no verified canonical format yet (§0.3). They need
  the same verification pass, plus a column-mapping step for Trakt's
  configurable id column.
- **IMDb `tvEpisode` rows → episode-level progress.** Genuinely resolvable via
  `/find`'s `tv_episode_results`, and genuinely valuable. Deferred because it
  roughly doubles the commit surface (episode ranges, per-episode watch events)
  and Step 1 is already large. Surfaced in the preview as `unsupported` so the
  user knows those rows exist and were not lost.
- **Export.** The mirror feature, obviously wanted eventually, not this step.

---

## 10. Open decisions — for review before building

1. **Moviebase → Trakt, or drop the third source?** There is no verifiable
   Moviebase CSV (§0.2), and CLAUDE.md's roadmap says Trakt/Letterboxd/TV Time.
   Recommendation: ship IMDb + Letterboxd in Step 1, Trakt in a Step 2 after
   its own format verification.
2. **ZIP handling**: built-in minimal reader (recommended — ~80 lines, no
   dependency, accepts the file the user actually downloaded), or require the
   user to unzip and drop loose CSVs?
3. **Skip-and-remember** (§3.5): in or out for Step 1? It is new persisted
   state, small but real.
4. **CSV parser**: hand-rolled (recommended, consistent with project
   precedent) or take a dependency? This is the one place the no-dependency
   instinct is arguably worth re-examining, so it is put explicitly rather
   than assumed.

Decisions already made and not up for negotiation unless challenged: no
threshold-based auto-accept (§2.3), no popularity tiebreak on exact title+year
(§2.3), no "best guess the rest" button (§3.4), no IMDb rating-date-as-watch-date
by default (§5), no Letterboxd scraping (§0.1).
