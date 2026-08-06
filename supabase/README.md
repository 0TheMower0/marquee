# Supabase — schema, RLS, and the adversarial test

Phase 6 Steps 3 and 4. The design and reasoning live in
[`../docs/phase-6-sync-design.md`](../docs/phase-6-sync-design.md).

```
supabase/
  migrations/
    20260801000001_initial_schema.sql   tables + RLS + policies, one transaction
    20260806000001_usernames.sql        profiles.username + availability RPC
  tests/
    00_local_supabase_shim.sql          auth schema/roles, LOCAL ONLY
    01_rls_adversarial.sql              the attack, safe to run anywhere
```

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
