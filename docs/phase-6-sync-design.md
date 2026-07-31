# Phase 6 Step 1 — Sync architecture design

**Status:** **approved** (2026-07-31). All six review questions resolved in §9;
step order in §10. No code written — implementation begins at Step 2.
**Scope:** how local-first Marquee gains accounts and cross-device sync without
breaking the zero-config promise, and without ever losing a user's history.

---

## 0. On the core decision

> *Local storage stays authoritative for anonymous use, with account-linked sync
> layered on top.*

**Agreed — and it's the right call.** The alternative (account required, server
authoritative, local is a cache) buys a dramatically simpler sync story and
costs the app its identity. CLAUDE.md has promised zero-config since Phase 1,
the whole content-provider abstraction exists so the app runs with no
credentials at all, and "install and start tracking, no signup" is a real
differentiator against every competitor named in the pitch. Don't trade that
for implementation convenience.

Two things to sharpen, though, because the phrasing hides a decision and a cost.

**"Authoritative" needs to mean something narrower once signed in.** If local
stayed authoritative *after* sign-in, two devices could never converge — each
would consider itself correct forever. What you actually want is:

- Local is a **complete, self-sufficient replica**. Every read the UI performs
  hits local storage. The app is fully functional with the network off, signed
  in or not.
- The server is the **convergence point**, not the read path. It exists to
  merge replicas, not to serve the UI.

So: *local-first, server-as-sync-fabric*. The anonymous tier is then just the
degenerate case where there's one replica and no convergence point — which is
why it keeps working untouched.

**The cost you're accepting, stated plainly:** every feature from here on has to
work in both modes, forever. There is no future point where "just require an
account" simplifies anything, because the anonymous tier can't be withdrawn
without breaking the promise that justified it. That's a permanent tax on Phase
7 (importers), Phase 8 (Year in Review), and anything after. It's affordable —
most of those are read-only over local data anyway — but it should be a
conscious cost, not a surprise in six months.

**Where I do disagree with a likely reading of "layered on top":** it should not
mean *uploading the local records as they exist*. Section 2 argues that one of
the local encodings must be reshaped on the way to Postgres, and that this is
the single decision the rest of the design hangs off.

---

## 1. Principles

Four rules, in priority order. Everything below follows from these.

1. **Never lose a fact about the past.** A watched episode, a rating, a logged
   day. These are the user's history and are not reconstructible. Losing a
   recent *intent* (a status toggle, an un-mark) is recoverable with one tap;
   losing history is not.
2. **Conflict granularity must match the granularity of the user's action.**
   The user's action is "mark this one episode." If the conflict unit is bigger
   than that, a conflict destroys data the user never touched.
3. **Every sync operation is idempotent.** Replay after a crash, a retry, or a
   duplicated request must be a no-op. This is what makes the merge safe to
   simply *run again* instead of needing recovery logic.
4. **Derived data is never synced.** It's recomputed from synced inputs. Phase
   5 already built XP, streaks, freezes, and badge conditions this way; that
   discipline pays off here (§7).

---

## 2. Schema

### 2.1 The load-bearing decision: the range encoding does **not** survive

`WatchedEpisodes = Record<seasonNumber, EpisodeRange[]>` is the right shape in
localStorage and the wrong shape in Postgres. It should be **exploded into one
row per watched episode** server-side, and **re-collapsed into ranges** when
materialized back into local storage.

The range encoding was chosen (per the long note in `lib/tracking/types.ts`) for
two reasons: measured storage size against a ~5 MB browser budget (183 KB →
2.8 KB, a 65× win), and because "mark everything up to here" is *natively* one
range write. Check both against Postgres:

- **Size is irrelevant.** A heavy user at 3,000 watched episodes is roughly
  300 KB of rows, ~600 KB with indexes. Supabase's free tier is 500 MB. The
  constraint that justified the encoding does not exist on the server.
- **The write shape still holds** — "mark season watched" becomes a 24-row
  batch insert instead of one update. That's a rounding error, not a cost.

And against that near-zero cost sits the decisive benefit:

> **One row per episode makes episode marks commutative and idempotent, which
> makes your §4 scenario stop being a conflict at all.**

Phone marks S3E4 offline, laptop marks S3E5, both sync. Under a JSON blob of
ranges, that is a genuine whole-blob conflict and last-write-wins silently
destroys one device's episode. Under one row per episode, they are two
independent inserts into two different rows. Both land. There is nothing to
resolve. The merge rule is *union*, which is associative, commutative, and
order-independent — exactly the properties offline sync needs.

That is the whole argument. The encoding is a **client storage representation,
not a domain model**, and CLAUDE.md already treats it that way ("never
hand-build these — go through `ranges.ts`"). Translating at the sync boundary
extends an existing rule rather than breaking one.

**The invariant survives the round trip for free.** Pull explodes rows → episode
numbers → `normalizeRanges()`, which re-establishes sorted/non-overlapping/
non-adjacent by construction. A corrupt or overlapping server state cannot
produce a corrupt local state.

*If row count ever became a problem* (it won't at this scale), the mitigation is
a hybrid: rows stay the write path, plus a materialized ranges column for bulk
pull. Don't build that now.

### 2.2 Tables

Composite natural keys throughout, no surrogate UUIDs except where noted. This
is deliberate: local records have no UUIDs, so a natural key is what lets a
local record map onto a server row deterministically, with no id-resolution
step. Every write becomes `INSERT ... ON CONFLICT (natural key) DO UPDATE`,
which is idempotent by construction (Principle 3).

```sql
-- Minimal. Exists for Phase 6's comments/shared lists to reference.
-- CONTAINS NOTHING SENSITIVE — see §3, it's the one table with a
-- non-self SELECT policy.
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

create table tracked_titles (
  user_id             uuid        not null references auth.users(id) on delete cascade,
  media_type          text        not null check (media_type in ('movie','tv')),
  title_id            text        not null,
  status              text        not null check (status in ('watchlist','watching','watched')),
  -- TitleSummary snapshot. jsonb because it is read as a unit and never
  -- queried by field: it is denormalized provider data by design, not
  -- relational data. (If server-side aggregation is ever wanted, revisit.)
  summary             jsonb       not null,
  -- Phase 5 Step 2 XP-only fallback scalars. Nullable = honest gap.
  runtime_minutes     int,
  known_episode_count int,
  added_at            timestamptz not null,
  -- Set by the CLIENT, at the moment the user acted. Drives LWW. See §4.
  client_updated_at   timestamptz not null,
  -- Set by the SERVER. Drives the pull cursor only. See §4.
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  primary key (user_id, media_type, title_id)
);

create table watched_episodes (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  media_type        text        not null default 'tv' check (media_type = 'tv'),
  title_id          text        not null,
  season_number     int         not null check (season_number >= 0), -- 0 = Specials
  episode_number    int         not null check (episode_number >= 1),
  client_updated_at timestamptz not null,
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,                                     -- tombstone, see §4
  primary key (user_id, media_type, title_id, season_number, episode_number),
  foreign key (user_id, media_type, title_id)
    references tracked_titles (user_id, media_type, title_id) on delete cascade
);

create table ratings (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  media_type        text        not null check (media_type in ('movie','tv')),
  title_id          text        not null,
  score             int         check (score between 0 and 100),
  client_updated_at timestamptz not null,
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  primary key (user_id, media_type, title_id)
);

-- SEPARATE TABLE, deliberately. See §7.
create table rating_notes (
  user_id           uuid        not null references auth.users(id) on delete cascade,
  media_type        text        not null check (media_type in ('movie','tv')),
  title_id          text        not null,
  note              text        not null,
  client_updated_at timestamptz not null,
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  primary key (user_id, media_type, title_id)
);

create table watch_events (
  -- Client-generated UUID. The ONLY surrogate key here, and it is load-bearing:
  -- the log is append-only and genuine duplicates are meaningful (the "Second
  -- Helping" badge detects an unmark-then-remark), so a content-derived natural
  -- key would collapse real data. A client UUID makes replay idempotent without
  -- deduping anything real. See §6.2 for how pre-account events get a UUID.
  id             uuid        primary key,
  user_id        uuid        not null references auth.users(id) on delete cascade,
  -- LOCAL calendar day, frozen at write time. `date`, never `timestamptz`.
  -- READ THE WARNING BELOW BEFORE TOUCHING THIS COLUMN.
  day_key        date        not null,
  kind           text        not null check (kind in ('episode','movie','title')),
  media_type     text        not null check (media_type in ('movie','tv')),
  title_id       text        not null,
  season_number  int,
  episode_number int,
  minute_of_day  int         check (minute_of_day between 0 and 1439),
  bulk           boolean     not null default false,
  created_at     timestamptz not null default now(),
  check ((kind = 'episode') = (season_number is not null and episode_number is not null))
);

create table badges_earned (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  badge_id   text        not null,
  earned_at  timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);

create table xp_state (
  user_id            uuid        primary key references auth.users(id) on delete cascade,
  highest_level_seen int         not null default 1,
  updated_at         timestamptz not null default now()
);
```

Plus, on every synced table, the pull cursor index:

```sql
create index on <table> (user_id, updated_at);
```

### 2.3 ⚠️ `watch_events.day_key` must never be derived server-side

This is the trap a backend engineer walks straight into, and it would silently
destroy the streak feature.

`day_key` is `YYYY-MM-DD` **in the device's local timezone at the moment the
event was recorded**, frozen forever. It is not a timestamp and must never be
computed from one. `lib/watchlog/types.ts` documents why at length: derive the
day from an instant at read time and a user who watches something at 8am in
Tokyo, then flies to LA, has that event silently re-file to the previous day —
**their streak history rewrites itself because they travelled.**

Concretely, forbidden server-side:

```sql
-- ❌ NEVER. Recomputes the day in UTC (or in the server's zone).
day_key := (created_at AT TIME ZONE 'UTC')::date
```

The column is `date` (which carries no timezone and undergoes no conversion),
it is written verbatim from the client's `localDayKey()`, and `created_at`
exists only as recording metadata that nothing reads for day arithmetic. Any
future migration, backfill, or trigger touching this column is a streak-data
bug until proven otherwise.

### 2.4 Why `watch_events` has no FK to `tracked_titles`

Deliberate asymmetry with `watched_episodes`. The watch log is an **immutable
record of what happened**; `tracked_titles` is **current state**. Removing a
show from your library should not erase the fact that you watched it in June.
`watched_episodes`, by contrast, *is* current state and is meaningless without
its title, so the FK (and its cascade) is correct there.

---

## 3. Row Level Security

**The default is a leak.** A table in the `public` schema with RLS *not* enabled
is world-readable and world-writable through the PostgREST API to anyone holding
the anon key — which ships in the client bundle by design. Enabling RLS is not
hardening, it is the only thing standing between the anon key and every user's
data.

### 3.1 The uniform policy set

Every table in §2.2 **except `profiles`** gets exactly this, substituting the
table name. No exceptions, no shortcuts.

```sql
alter table <T> enable row level security;
alter table <T> force  row level security;

revoke all on <T> from anon;

create policy "<T>_select_own" on <T>
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "<T>_insert_own" on <T>
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "<T>_update_own" on <T>
  for update to authenticated
  using      ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "<T>_delete_own" on <T>
  for delete to authenticated
  using ((select auth.uid()) = user_id);
```

### 3.2 The four things that actually go wrong

**1. `UPDATE` with a `WITH CHECK` broader than its `USING`.** `USING` controls
*which rows you may update*; `WITH CHECK` controls *what the row may look like
afterwards*. A `WITH CHECK (true)` — usually written to "just let updates
through" — lets a user take their own row and **reassign `user_id` to someone
else's account**, a write into another user's data from a policy that looks
deliberate.

> ⚠️ **Corrected 2026-08-01.** This item previously claimed the hole was
> `USING` *without* `WITH CHECK`. **That is wrong**: Postgres defaults
> `WITH CHECK` to the `USING` expression when omitted, so a USING-only UPDATE
> policy blocks the hijack. Verified empirically against PostgreSQL 18 —
> checks 10-12 in `supabase/tests/01_rls_adversarial.sql` demonstrate the
> broken shape hijacking, the USING-only shape holding, and the masking
> effect below. Write both clauses anyway: it makes intent reviewable and
> stops a later accidental widening. Just not for the reason usually given.

**1b. A restrictive `SELECT` policy masks a broken `WITH CHECK`.** Found while
building the test, and the reason a hole can survive a hand-check: when an
`UPDATE` references the table's columns, `SELECT` policies apply to the
post-update row too. So attacking a genuinely broken table with the natural
`... WHERE user_id = me` form is **blocked**, and only the unqualified
`UPDATE ... SET user_id = <other>` exposes it. Real defence in depth, and a
real trap — probe without a `WHERE` clause or you will certify a hole as safe.

**2. Writing `for all` and assuming it covers everything.** It does — Postgres
falls back to the `USING` expression for `WITH CHECK` when the latter is
omitted — but the behaviour is subtle enough that it should not be relied on.
Four explicit per-operation policies are auditable at a glance; one `for all` is
a thing you have to reason about. Verbosity is the point.

**3. Forgetting `enable row level security` on a new table.** There is no
warning. The table simply works, for everyone. Enforce it as a migration
checklist item and verify with the query in §3.4.

**4. Shipping `service_role` to the client.** That key has `BYPASSRLS`. Every
policy above is irrelevant to it. It belongs only in server-side code, never in
a `NEXT_PUBLIC_` variable — the same rule CLAUDE.md already enforces for
`TMDB_READ_ACCESS_TOKEN` and `OMDB_API_KEY`, and it should be verified the same
way (grep `.next/static` for the value, with a sentinel, as Phase 4 Step 4 did).

### 3.3 `profiles` — the one intentional exception

Phase 6's comments and shared lists need to render *other people's* display
names, so `profiles` needs a broader SELECT:

```sql
alter table profiles enable row level security;
alter table profiles force  row level security;

-- Readable by any signed-in user. THIS IS WHY THE TABLE HOLDS NOTHING PRIVATE.
create policy "profiles_select_all" on profiles
  for select to authenticated
  using (true);

create policy "profiles_insert_self" on profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

create policy "profiles_update_self" on profiles
  for update to authenticated
  using      ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
```

Consequences to hold onto: **never add an email, a real name, or any
preference column to this table.** Email lives in `auth.users`, which is not
exposed through the API. If a profile ever needs private fields, they go in a
second `profile_private` table with the standard own-rows-only policy — not as
extra columns here.

### 3.4 Verification, not assumption

Same discipline Phase 4 applied to the secret boundary. Before shipping:

```sql
-- Must return zero rows.
select tablename from pg_tables
where schemaname = 'public' and rowsecurity = false;

-- Every policy, eyeballed for a missing with_check on UPDATE.
select tablename, policyname, cmd, qual, with_check
from pg_policies where schemaname = 'public' order by tablename, cmd;
```

And an actual two-account test: sign in as A, attempt to `select`, `update`, and
`insert` rows carrying B's `user_id`, and confirm all three fail. A policy that
has never been attacked has not been tested.

---

## 4. Ongoing conflict resolution

### 4.1 Your scenario is no longer a conflict

Phone marks S3E4 offline; laptop marks S3E5; both sync. Under §2.1's schema
these are inserts into two distinct primary keys. Both succeed, in any order,
with any amount of delay between them. Final state: both episodes watched.
**There is no conflict and no rule is needed.** That is the entire return on
exploding the range encoding, and it's why that decision leads the document.

### 4.2 What remains, and the rule

Genuine conflicts only arise when two devices touch **the same record**. For
those: **per-record last-write-wins, keyed on `client_updated_at`.**

You're right that LWW loses data. The design position is that LWW is acceptable
*only* when the record is small enough that losing it costs the user one tap —
and the schema is shaped specifically to keep every record that small
(Principle 2). Blob-granularity LWW is what's unacceptable, and none exists here.

| Conflict | Rule | What the loser costs |
|---|---|---|
| Same episode: one marks, one un-marks | LWW on the episode row; un-mark writes `deleted_at`, not a hard delete | One episode's state. One tap. |
| Same title, different `status` | LWW | One status. One tap. |
| Same title, different `score` | LWW | One number. Re-enterable. |
| Same title, different `note` | LWW **+ local shadow copy** (below) | Real prose — see 4.4. |
| `watch_events` | No conflict possible — append-only, UUID-keyed, union | — |
| `badges_earned` | `LEAST(earned_at)` — earliest wins | Nothing; it's monotonic |
| `xp_state.highest_level_seen` | `GREATEST` | Nothing; it's monotonic |

**Tombstones, not deletes.** Un-marking sets `deleted_at`. A hard delete doesn't
commute with a concurrent insert: an offline device that re-marks the episode
would resurrect it, or lose it, depending purely on sync order. A tombstone with
`client_updated_at` makes the outcome a function of *when the user acted*, not
of network timing. `watched_episodes` under this scheme is precisely a
LWW-Element-Set CRDT — we get the convergence property on the highest-risk data
without any CRDT machinery.

### 4.3 Why `client_updated_at` and not the server's clock

Two timestamp columns, doing two different jobs, and conflating them is a real
bug:

- **`updated_at` (server, `default now()`)** drives the pull cursor. It must be
  server-monotonic or a client with a skewed clock could write a row that every
  other device's `> last_pulled_at` query skips forever.
- **`client_updated_at` (client)** drives LWW. It must reflect *when the user
  acted*.

If LWW used server time, a phone edit made Monday offline would lose to a laptop
edit made Sunday, purely because the phone reconnected on Tuesday. The later
*sync* would beat the later *intent*. That's backwards.

**Clamp future-dated `client_updated_at` to server `now()` on write** (a
trigger). A device whose clock reads 2030 would otherwise win every conflict
forever, permanently and unrecoverably.

Worth being precise about the cost, because the obvious framing is wrong:
clamping a *fast* clock is not a tradeoff, it is generally **more** correct. A
device claiming `T+10s` when the server is at `T` gets clamped to `T` — still
later than every prior write, so it still wins the conflicts it should. The
clamp only engages on times that are in the future *relative to the server*,
i.e. on claims that were wrong to begin with, and pinning those to `now()`
lands closer to the real ordering than honouring them would.

The genuinely unaddressed weakness is the opposite direction. A **slow** clock
loses conflicts it should win, and no clamp can fix that: "an hour slow" is
indistinguishable from "a legitimate offline write made an hour ago," which is
the exact case this design exists to support. Fixing it properly needs hybrid
logical clocks — real machinery, a new concept in every future feature, to
correct an ordering error on simultaneous multi-device edits in a
single-user app. Disproportionate. Accepted as a known limit.

### 4.4 Notes get one extra protection

A note is the only record here containing something the user *wrote*, and
retyping a paragraph is not "one tap." LWW still applies (a merge UI is
disproportionate here), but the overwritten text is **kept locally** in a
capped, time-limited shadow store so it's recoverable rather than gone. Cheap,
and it converts the one genuinely painful LWW loss into an annoyance.

### 4.5 Rejected: full CRDT / operation log

Considered and not proposed. Once episodes are rows, the data is *already*
mostly commutative, and the remaining conflicts are single scalar fields where
LWW is honest and adequate. A proper op-log or Yjs-style CRDT would add
substantial machinery, a new mental model for every future feature, and a
migration path for existing records — to improve outcomes on "you changed a
rating on two devices at once," which for a personal single-user-multi-device
app is close to a non-event. Revisit only if shared/collaborative lists in a
later phase need genuine multi-writer editing.

---

## 5. Offline behaviour

The app is offline-capable today because every read is local. Sync must not
change that. It doesn't:

**Reads never touch the network.** The UI reads local storage, signed in or not.
There is no loading state, no cache-miss path, no degraded mode. (Content data —
posters, metadata — is a separate concern already handled by the provider layer
and its own caching.)

**Writes go local first, then to an outbox.** This is the existing optimistic
pattern from Phase 2 Step 3, unchanged: state updates before the write is
attempted, rolls back visibly on failure. Sync appends to a local outbox
*after* the local write succeeds — the same ordering rule the watch log already
follows ("never log what didn't persist").

**The outbox has two modes**, and the distinction matters:

- **Coalescing**, for state records (`tracked_titles`, `ratings`,
  `rating_notes`, `watched_episodes`). Toggle a status five times offline and
  only the final state needs to reach the server; LWW makes the intermediate
  values irrelevant. Key the outbox by natural key and overwrite.
- **Accumulating**, for `watch_events`. Every event matters — five marks are
  five rows. Never coalesce.

**Flush is per-record, not a global queue.** A permanently failing upsert for
one title must not block every other pending write behind it. Failures retry
with backoff and stay in the outbox; they never surface as a blocking error,
matching the existing "log writes never block or fail a tracking write" rule.

**Pull is a cursor.** `select * from T where user_id = auth.uid() and updated_at
> :last_pulled_at`, per table, with `last_pulled_at` stored locally. Supabase
Realtime can push changes as an optimization later; the cursor works without it
and should be the baseline.

**Multi-tab finally gets fixed here.** CLAUDE.md documents the known gap — two
tabs writing the same namespace clobber each other, with the explicit note to
"revisit alongside Phase 6 accounts, where sync arrives anyway." Sync makes it
worse (two tabs with two outboxes), so this step should add a `BroadcastChannel`
(or `storage` event) listener so tabs observe each other's writes and share one
outbox. It's a prerequisite, not a nice-to-have.

**The service worker is orthogonal.** Phase 5 Step 6 caches the app shell so the
page *loads* offline; this design makes the data *work* offline. Neither depends
on the other, and they can ship in either order.

---

## 6. First-login merge

The requirement — *worst case duplicate data, never missing* — drives every
choice here.

### 6.1 The safety net comes first

Before a single byte is uploaded:

1. **Snapshot the entire local state** to one JSON blob and write it to a
   separate local namespace (`marquee:premerge-backup`), keyed by timestamp.
2. **Offer it as a file download** in the same step, with copy explaining what
   it is.

This is minutes of work and it is the difference between "a bug cost someone
years of tracking" and "a bug cost someone an afternoon." Do it before anything
else, and do not garbage-collect the backup automatically.

### 6.2 The merge is additive-only and idempotent

**No local data is deleted at any point in the merge**, including after it
succeeds. Local remains the offline replica anyway, so there is no cleanup step
that could go wrong.

Every operation is an upsert by natural key or an insert by UUID, so **running
the merge twice is a no-op**. That is the entire crash-recovery strategy: if it
fails or the tab closes halfway, run it again. There is no half-migrated state
to detect, which is the same reasoning that made `lib/storage`'s per-record lazy
migrations safe (localStorage has no transactions, so never design a process
that needs one).

Progress is tracked in a local `merge_state` record listing completed
namespaces, so a resumed merge skips finished work — an optimization, not a
correctness requirement.

**Pre-account watch-log events need UUIDs minted, and they must be
deterministic.** This is the one place the idempotency claim above could
quietly fail. Local events predate the account and have no `id` — they're bare
`{k,t,s,e,m,b}` objects inside a day's array. If the merge minted a random v4
UUID per event, a retried merge would mint *different* UUIDs for the same
events and insert every one of them a second time. The append-only log would
silently double, `hasRepeatedMark` would start reporting rewatches that never
happened, and the "just run it again" recovery strategy would be actively
destructive.

So pre-account events get a **deterministic UUIDv5 derived from
`(user_id, day_key, array index)`**. Replaying the same local array yields
byte-identical UUIDs, so the second insert is an `ON CONFLICT DO NOTHING`
no-op. The array index is what keeps genuine same-day duplicates distinct —
hashing event *content* instead would collapse two real marks of the same
episode on the same day into one row, destroying exactly the signal the
"Second Helping" badge reads. The log is append-only, so indices of existing
entries are stable across retries.

Events written *after* sign-in are simpler: generate a v4 UUID at write time
and persist it locally alongside the event, so the id exists before the row
ever reaches the outbox.

### 6.3 Merge rules — union and max, not last-write-wins

**The first-login merge uses different rules than steady-state sync (§4), and
that's principled, not inconsistent.** They are different situations:

- The **initial merge** unions *two histories that were never connected* — a
  large local body of truth meeting a mostly- or entirely-empty server. Union
  and max semantics are correct: nothing on either side is stale, because
  neither side ever knew about the other.
- **Steady-state sync** reconciles *two views of one shared history*, where a
  later edit genuinely supersedes an earlier one. LWW-on-intent is correct there.

| Table | Rule | Can it lose data? |
|---|---|---|
| `watched_episodes` | **Union.** Local has no tombstones, so the merge can only *add* episodes. | No. Structurally impossible. |
| `watch_events` | **Union** by UUID. | No. |
| `tracked_titles.status` | **Max progress**: `watchlist < watching < watched`. | No progress lost. Can resurrect a deliberate downgrade — see below. |
| `tracked_titles` scalars (`runtime_minutes`, `known_episode_count`) | Prefer non-null. | No. |
| `ratings.score` | Later `client_updated_at`. | One number, if both sides differ. |
| `rating_notes.note` | **Concatenate** if both non-empty and different, with a visible merge marker. | No. |
| `badges_earned` | Union, `LEAST(earned_at)`. | No. |
| `xp_state` | `GREATEST(highest_level_seen)`. | No. |

Two of those need defending.

**Status uses max-progress rather than LWW.** The failure mode it accepts: a
user who deliberately moved something from "watched" back to "watchlist" on
device A may see it return to "watched." The failure mode it prevents: a
"watched" show silently reverting to "watchlist" and appearing unwatched.

The asymmetry is what decides it. A resurrection is **visible** — it sits in
your Library looking wrong, and two clicks fix it. A loss is **silent** — the
title simply sits in the watchlist as though you'd never seen it, so you may
rewatch something and your stats are quietly wrong with nothing to notice.
Visible-and-fixable beats silent-and-wrong, and the second is losing a fact
about the past (Principle 1) where the first is losing a recent intent.

A full "review every disagreement before merging" screen was considered and
rejected: for a first-ever account the server is empty, so it would show zero
rows on the overwhelmingly common path. The **post-merge summary** in §6.4 is
the cheaper answer and removes the only real objection — it makes a
resurrection something you were told about rather than something you stumble on.

Note that episode data merges by union *regardless* of status, so no
episode-level detail rides on this choice.

**Notes concatenate rather than choose — and the split with §4.4's LWW is
semantic, not a wart.** Two notes written before either device knew about the
other were authored **independently**; neither supersedes the other, so
concatenating is the semantically correct merge of two separate pieces of
writing about one title. A steady-state edit is *intended* to replace what came
before, and concatenating there would accumulate every draft the user ever
typed.

That is the same independent-histories vs. shared-history distinction that
already justifies union-and-max here and LWW in §4 — one principle applied
twice, not two ad-hoc rules. The concatenated form carries a dated marker
(`--- merged from another device, 2026-07-31 ---`) so the affected notes are
findable and cleanable.

The path is rare enough to be worth naming: it requires anonymous use on two
separate devices *and* notes written on the same title on both. On a
first-ever account it is impossible.

### 6.4 The merge summary — ships with the merge, not later

**This is part of Step 4's deliverable, not a follow-up.** A merge that silently
rewrites a user's library is mysterious even when it's correct; the summary is
what makes it trustworthy, and it's also the mechanism that makes max-progress
status merging (§6.3) acceptable rather than sneaky.

After the merge completes, show a dismissible summary stating plainly what
happened:

- How many titles, episodes, ratings, notes, watch-log days, and badges were
  merged in from this device.
- **Every title whose status differed between the two sides**, with what it was
  on each and what it is now. This is the short list — usually empty, never
  long — and it is exactly where a resurrected "watched" would show up.
- **Every title whose notes were concatenated**, linked, so ugly merges are
  findable immediately rather than discovered months later.
- A pointer to the pre-merge backup from §6.1, with what it is and how to use it.

The summary is generated *from the merge itself* (each merge rule reports what
it did), not recomputed afterward by diffing — a diff would have to guess at
intent and could not distinguish "max-progress promoted this" from "the user
changed it on the other device last week."

It should be re-openable from Profile for some reasonable window rather than
being a one-shot toast, because the merge happens at the exact moment a user is
busy doing something else (signing in) and is the moment they are least likely
to read carefully.

### 6.5 What happens after

**Nothing is recomputed, because nothing derived is stored.** XP, level, rank,
streaks, freeze counts, badge conditions, and every stats-page aggregate
recompute from the merged base on next render, automatically. This is the payoff
of Phase 5's computed-not-stored discipline: the merge doesn't need to touch any
of them.

Worth noting: the merge can only *increase* a user's streak. Adding days to the
watch log can only narrow gaps, and Phase 5 Step 3 proves as a structural
invariant (with tests) that a backdated day never lowers `currentStreak`,
`longestStreak`, or `freezesAvailable`. So the merge cannot damage streak
history — that's already guaranteed by the existing walk.

Coarse/fine status reconciliation (`reconcileCoarseWatched`) should **not** run
as part of the merge. It needs season data, which needs a provider fetch; the
existing design deliberately resolves this lazily at the point of use. The merge
moves raw data only and lets the existing mechanism handle it.

### 6.6 When the merge runs automatically, and when it asks

**Automatic when either side is empty. Confirmed only when two non-empty bodies
of data meet.**

Requiring confirmation every time is friction placed on the two cases that
cannot go wrong:

- A brand-new user with no local data — the merge is a no-op, and the dialog
  would report finding nothing.
- An anonymous user with local history creating their first account — the
  server is empty, so the merge is a pure upload with nothing to conflict
  against.

Both run silently, with the §6.1 backup still taken and the §6.4 summary still
shown.

The case that *does* warrant a prompt is local history meeting an account that
already has data, and the reason is not conflict — it's **the wrong account**.
Sign into someone else's account on your own device and an automatic merge
uploads your personal library into their account. The local backup does not
help: it protects your data, it does not un-upload it from somewhere else.
That's the one irreversible outcome in this whole design, and the moment two
non-empty datasets meet is exactly when a user would notice the mistake.

So the prompt names what it found on both sides — "this device has 214 tracked
titles; the account you're signing into has 38" — and asks before merging. One
dialog, on the rarest path, guarding the only unrecoverable failure.

### 6.7 Sign-in on a second device, and sign-out

**"First login" is per device, not per account.** A user signing in on device
two runs the identical merge — local history meets a now-populated server, same
union-and-max rules, same safety net, subject to the confirmation rule in §6.6.

**Sign-out must not wipe local data.** Someone signing out casually and losing
their library would be exactly the unforgivable outcome, just triggered by a
different button. Local data stays and the app reverts to the anonymous tier.
For the shared-device case, offer a *separate, explicitly labelled* "sign out and
erase local data" action — never the default.

---

## 7. What does not sync

### Never syncs — because it isn't stored anywhere

XP totals, level, rank, streak lengths, freeze counts, badge unlock *conditions*,
and all stats-dashboard aggregates. All pure functions over tracking, ratings,
and the watch log. **Three whole Phase 5 features needed zero sync design**,
which is a direct vindication of the computed-not-stored rule — worth stating
because it's the strongest argument for continuing to apply it.

### Never syncs — device-local by nature

Storage driver status / memory-mode flag, the heatmap's selected year and other
UI state, the pre-merge backup blob, `last_pulled_at` cursors, and the outbox
itself.

### Syncs, but structurally isolated: private notes

Notes were raised as a "maybe shouldn't sync" candidate. **Settled: they sync,
but from their own table — which is the better answer to the concern behind the
question.**

Not syncing them means a note written on your laptop is invisible on your phone.
That's not privacy, that's a broken feature; the user wrote it into an app whose
whole job is remembering things for them.

The actual risk is *leakage into a future sharing feature* — Phase 6 explicitly
includes shared lists and comments. The structural defence is `rating_notes` as
a separate table (§2.2):

- Its RLS policy is own-rows-only and **is never relaxed**, even if `ratings`
  one day gains a "visible to people I share a list with" policy. Two tables,
  two policies, no shared blast radius.
- A future `shared_list_items` view or projection physically *cannot* leak a
  note by accident, because a careless `select *` on `ratings` doesn't reach it.
  Column-level omission relies on remembering; table-level separation doesn't.
- This mirrors the codebase's existing instinct exactly — CLAUDE.md already
  separates stores whose access patterns and lifecycles differ, and "a score may
  one day be public, a note never will be" is precisely that kind of difference.

**Plus one user-facing control:** a single "sync private notes" toggle, default
**on**. Some people genuinely want notes never to leave one device, and honoring
that is one skipped table in the sync loop — near-zero cost for a real choice.
Off means notes stay local; scores still sync.

**The real cost, stated honestly:** it is not "one extra table," it is that one
local record (`RatingEntry` holds both `score` and `note`) maps to two server
rows, an asymmetry the sync layer has to carry. That's consistent with the
design rather than new debt — §2.1 already accepts a much larger local/server
asymmetry for the range encoding — but it is a real seam.

The counter-argument is YAGNI, and it was weighed: if sharing never ships, this
separation was free but pointless. What settles it is that **sharing is in Phase
6, not a distant maybe**. Building one table now and splitting later means
performing that migration with real user data and a live sharing feature already
reading from it — the worst possible moment. And the failure modes are lopsided:
being wrong this way costs one unused table, while being wrong the other way
leaks someone's private notes into a shared list.

### Explicitly out of scope for Phase 6

UI preferences, theme choices, and anything else not already persisted. Don't
grow the sync surface while establishing it.

---

## 8. How this lands in the codebase

Briefly, since it shapes the review — no implementation here.

**Two new abstraction layers, both following `getContentProvider()`'s pattern**,
because that pattern is exactly what makes zero-config work:

- **`lib/auth/`** — an `AuthProvider` interface with a Supabase implementation
  and an **anonymous implementation** that reports "never signed in."
- **`lib/sync/`** — a `SyncBackend` interface with a Supabase implementation and
  a **null implementation** that no-ops every method.

Selected on `NEXT_PUBLIC_SUPABASE_URL` being present, defaulting to
anonymous/null. **With no Supabase env vars the entire feature is inert and the
app behaves exactly as it does today** — the zero-config promise becomes a
structural property of the code rather than something to remember to preserve.
Same reasoning as `NEXT_PUBLIC_CONTENT_PROVIDER` defaulting to `mock`.

**Existing stores don't change shape.** `lib/tracking`, `lib/ratings`,
`lib/watchlog`, `lib/badges`, `lib/xp` keep their current local representations,
including the range encoding. The explode/collapse translation lives in
`lib/sync/` and nowhere else — the one place that knows both representations.

**The anon key is `NEXT_PUBLIC_`; the service role key is not, ever.** Same
handling and same verification as the TMDB and OMDb credentials.

---

## 9. Decisions taken

All six questions raised in review are settled. Recorded here with the reasoning
so a later reader doesn't reopen them without new information.

1. **Status merges by max-progress, plus a post-merge summary.** (§6.3, §6.4)
   Resurrections are visible and cost two clicks; losses are silent and corrupt
   stats. A full pre-merge review screen was rejected — it shows zero rows on
   the common path. The summary is the cheaper answer and ships in Step 4.

2. **Notes concatenate on merge, LWW-with-shadow-copy in steady state.** (§6.3,
   §4.4) Not two mechanisms for one problem: independently-authored notes
   genuinely don't supersede each other, an edit genuinely does. Same
   independent-histories vs. shared-history split that governs §6 vs. §4
   throughout.

3. **`rating_notes` stays a separate table.** (§2.2, §7) Sharing is in this
   phase, so the alternative is migrating live data under a live feature. Wrong
   this way costs an unused table; wrong the other way leaks private notes.

4. **The merge is automatic when either side is empty, confirmed when both are
   non-empty.** (§6.6) The prompt guards the wrong-account case — the one
   irreversible failure in this design — and stays off the two paths that
   cannot go wrong.

5. **Future-dated `client_updated_at` is clamped to server `now()`.** (§4.3)
   Corrected from the first draft: clamping a fast clock is *more* correct, not
   a tradeoff. Slow clocks remain a known, accepted limit; hybrid logical clocks
   are disproportionate here.

6. **Per-IP rate limiting is promoted ahead of this work** — see §10.

---

## 10. Phase 6 step order

Sync is not the first thing to build. The revised order:

| Step | Scope |
|---|---|
| **1** | This design document |
| **2** | **Per-IP rate limiting on `app/api/content/*`** |
| **3** | Supabase project, schema, RLS, and the §3.4 verification |
| **4** | Auth + the first-login merge, backup, and summary |
| **5** | Ongoing sync: outbox, pull cursor, conflict rules, multi-tab |
| **6** | Spoiler-safe comments, shared lists |

**Why rate limiting moves to Step 2, ahead of any schema work.** CLAUDE.md
previously filed this under "Phase 6, where per-user identity finally exists."
That reasoning is half wrong, and the half that's wrong is the important half:

> An attacker burning the TMDB quota with unique `?query=` strings that defeat
> every cache layer **will not be signed in.** Per-user limits do nothing
> against them.

Per-IP is the control that actually protects the quota, it needs no identity at
all, and it therefore has **zero dependency on auth or Supabase**. It is the
only thing standing between a deployed URL and the quota, so it should land
before anything else in this phase and certainly before any public deployment.

Per-user limits remain worth adding as a **later refinement** once identity
exists — they're better at catching a single abusive *account* — but they are a
complement to per-IP, never a replacement, and nothing should wait on them.
