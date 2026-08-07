# Supabase — schema, RLS, and the adversarial test

Phase 6 Steps 3, 4, 5, and 6a. The sync design and reasoning live in
[`../docs/phase-6-sync-design.md`](../docs/phase-6-sync-design.md); the
comments design lives inline in `20260809000001_comments.sql`'s own header
comment.

```
supabase/
  migrations/
    20260801000001_initial_schema.sql      tables + RLS + policies, one transaction
    20260806000001_usernames.sql           profiles.username + availability RPC
    20260807000001_sync_conflict_rules.sql LWW / LEAST / GREATEST triggers
    20260809000001_comments.sql            comments, likes, reports + spoiler gating
  tests/
    00_local_supabase_shim.sql          auth schema/roles, LOCAL ONLY
    01_rls_adversarial.sql              the RLS attack, safe to run anywhere
    02_sync_conflict_rules.sql          the conflict-rule attack, safe anywhere
    03_comments_adversarial.sql         the spoiler-gating attack, safe anywhere
```

> ⚠️ **`20260807000001` must be applied before sync is safe to use.** It is not
> an optimization. Without those triggers every upsert simply overwrites, so a
> device that has been offline for a week reconnects and its stale state wins —
> the "last to sync wins" failure the whole design exists to prevent. Check 2 in
> `02_sync_conflict_rules.sql` is exactly that scenario.

Step 3 was schema only. **Step 4 (auth) is the first application code to read
these tables** — it reads and writes `profiles`, and nothing else. The sync
tables stay untouched until Step 5.

## Applying the migration

**Against a real project** — paste `migrations/20260801000001_initial_schema.sql`
into the Supabase SQL editor, or use the CLI:

```bash
supabase db push
```

Do **not** apply `tests/00_local_supabase_shim.sql` to a real project. Supabase
already provides `auth.users`, `auth.uid()` and the API roles; the shim only
exists so the migration and its test can run against plain PostgreSQL.

## Running the adversarial test

The test wraps everything in a transaction and **rolls back**, so it persists
nothing and is safe to run against a live project. Paste
`tests/01_rls_adversarial.sql` into the SQL editor. A pass ends with
`=== ALL CHECKS PASSED ===`; any failure raises an exception naming the
specific attack that succeeded.

### Locally, against plain PostgreSQL

```bash
initdb -D ./pgdata -U postgres --auth=trust
postgres -D ./pgdata -p 55432 &

createdb -h 127.0.0.1 -p 55432 -U postgres marquee_rls_test
psql -h 127.0.0.1 -p 55432 -U postgres -d marquee_rls_test -v ON_ERROR_STOP=1 \
  -f supabase/tests/00_local_supabase_shim.sql \
  -f supabase/migrations/20260801000001_initial_schema.sql \
  -f supabase/tests/01_rls_adversarial.sql
```

> **Windows note.** If the postmaster starts but every connection hangs and the
> log shows `could not reserve shared memory region ... error code 487`, the
> child backends cannot map shared memory at the inherited address (ASLR or an
> injected DLL). Starting with a small footprint works around it:
> `-c shared_buffers=1MB -c max_connections=10 -c autovacuum=off -c max_worker_processes=0`.

## What the test actually does

It signs in as Alice and attacks Bob's rows. It does not assert that RLS is
"enabled" — it tries to break in and fails loudly if anything succeeds.

| # | Attack | Expected |
|---|---|---|
| 1 | Unqualified `SELECT` over `tracked_titles` | only Alice's row |
| 2 | `SELECT` Bob's row **by exact primary key** | 0 rows |
| 3 | `WHERE user_id <> me` probe | 0 rows |
| 4 | Read Bob's **private note** | invisible |
| 5 | Read Bob's watch history | invisible |
| 6 | `UPDATE` Bob's row | 0 rows affected |
| 7 | `DELETE` Bob's rows | 0 rows affected |
| 8 | `INSERT` a row attributed to Bob | rejected, 42501 |
| 9 | Reassign own row's `user_id` to Bob | rejected by `WITH CHECK` |
| 10 | **Negative control** — same hijack vs. `WITH CHECK (true)` | **succeeds** |
| 11 | Same hijack vs. a `USING`-only policy | blocked |
| 12 | Broken table attacked *with* a `WHERE` clause | blocked |

Checks 10-12 are the ones worth understanding.

**10 is a negative control, and it must pass by *succeeding*.** A security test
that also passes against a deliberately broken policy proves nothing. This one
demonstrates it can tell the difference, which is what makes check 9 meaningful.

**11 corrects a claim this project previously believed.** "An UPDATE policy with
`USING` but no `WITH CHECK` lets a user reassign `user_id`" is **false**:
Postgres defaults `WITH CHECK` to the `USING` expression when omitted. The real
vulnerable shape is a `WITH CHECK` *broader* than `USING` — `(true)` being the
common case. Both clauses are still written explicitly in the migration, to keep
intent reviewable and prevent a later accidental widening.

**12 is the trap.** The *same* broken table, attacked with `... WHERE user_id = me`,
is **blocked** — because when an `UPDATE` references the table's columns,
`SELECT` policies apply to the post-update row too, and the restrictive `SELECT`
policy rejects a row owned by someone else. That is genuine defence in depth,
but it means the natural way to probe for this hole *hides* it. Probe with an
unqualified `UPDATE ... SET user_id = <other>` or you will certify a broken
policy as safe.

## The conflict-rule test (Phase 6 Step 5)

`tests/02_sync_conflict_rules.sql` attacks the triggers the same way
`01_rls_adversarial.sql` attacks the policies — it tries to lose data and fails
loudly if it succeeds.

| # | Attack | Expected |
|---|---|---|
| 1 | A newer `client_updated_at` upserts over an older row | wins |
| 2 | An **older** `client_updated_at` upserts over a newer row | **ignored** |
| 3 | That stale write | no-op, does **not** raise |
| 4 | Two devices marking *different* episodes | both land, no conflict |
| 5 | Un-mark → older re-mark → newer re-mark | tombstone, held, resurrected |
| 6 | An older score arriving beside a newer note | score kept, note untouched |
| 7 | The same `watch_event` id inserted twice | one row |
| 8 | `day_key` after a write | byte-identical, never re-derived |
| 9 | A later `earned_at` for an existing badge | earliest kept |
| 10 | A stale device's `highest_level_seen` | greatest kept |
| 11 | **Negative control** — same attack on a table with no trigger | **older write wins** |

**Check 3 is subtler than it looks.** A stale write must be silently skipped,
not rejected. If it raised, the outbox would treat a correctly-ignored write as
a failure and retry it forever, and the user would see a permanent sync error
for something working exactly as designed.

**Check 11 must pass by failing to protect.** It builds an unprotected table,
runs the same attack, and asserts the newer write IS lost. Without it, checks
1–10 would pass just as happily against a database where none of the triggers
exist.

## The spoiler-gating test (Phase 6 Step 6a)

`tests/03_comments_adversarial.sql` — 17 checks, same discipline as the two
above: it attacks, it does not assert. Check 1 is the whole feature in one
assertion: a reader who has not watched an episode gets **zero rows** for it,
both from a list query and a direct `SELECT` by id — not a hidden-but-present
row, nothing at all. Also covers posting into a scope you can't read back
(rejected), the TV-open/movie-gated title-level asymmetry, reply-scope
inheritance and one-level nesting, liking/reporting something you can't see
(rejected), self-reports (rejected), the auto-hide threshold firing at exactly
3 distinct reporters and not 2, the comment's own author still seeing it once
hidden while nobody else can, un-hiding being rejected even for the author,
editing after delete being rejected with the body force-cleared, identity-
field tampering on `UPDATE`, and a negative control proving the harness can
tell a protected table from an unprotected one.

**Check 16 needed a real fix, not just a passing run.** The first draft
expected a plain `UPDATE`/`DELETE` against another user's row to *raise*. It
doesn't — Postgres's rule when no policy grants a command is to authorize ZERO
ROWS for it, so the statement succeeds having changed nothing, no exception at
all. Fixed to assert on `GET DIAGNOSTICS ROW_COUNT` plus an out-of-band read
confirming the row survives, the same shape already used for the `UPDATE`
check beside it.

## Dashboard settings auth depends on (Phase 6 Step 4)

Four settings live in the Supabase dashboard, not in this repo. The app cannot
enforce them, so they are listed here rather than assumed.

| Setting | Where | Why it matters |
|---|---|---|
| **Redirect URLs** allowlist | Authentication → URL Configuration | The `redirect_to` this app sends is only honoured if it is on this list. **This is the actual control that stops the callback becoming an open redirect** — add your production origin and `http://localhost:3000`, and nothing else. |
| **Confirm email** ON | Authentication → Providers → Email | Without it, `signUp` returns a live session and anyone can register any address. The app handles both settings (`SignUpResult.needsEmailVerification`), so this is a policy choice, not a code dependency. |
| **GitHub provider** enabled + client id/secret | Authentication → Providers | The only OAuth provider wired up. The callback URL to give GitHub is the Supabase one (`<project>.supabase.co/auth/v1/callback`), *not* this app's `/auth/callback`. |
| **Email templates** using `{{ .TokenHash }}` | Authentication → Email Templates | Optional but recommended — see below. |

### Why the email templates are worth changing

The stock templates produce a link that lands on `/auth/callback?code=...`, and
the PKCE code verifier for that exchange is in a cookie **on the device that
started the signup**. Sign up on a laptop, open the email on a phone, and the
exchange fails with a confusing error.

Changing the confirmation and recovery templates to point at

```
{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email
```

(and `type=recovery` for the recovery template) removes that device affinity.
`app/auth/callback/route.ts` handles **both** shapes, so either configuration
works and switching is safe at any time.

## Adding a table later

Put `enable row level security`, `force row level security`, and all four
policies in the **same migration** that creates the table. Postgres DDL is
transactional, so there is then no state — not even a partially-applied
migration — in which the table exists without RLS. A guard at the end of the
migration re-checks `pg_tables` and aborts if any `public` table has RLS off.
