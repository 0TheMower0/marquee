#!/usr/bin/env bash
#
# Run every adversarial SQL suite in supabase/tests/ against a throwaway
# PostgreSQL cluster.
#
# =============================================================================
# WHY THIS SCRIPT EXISTS
# =============================================================================
# These suites are the only thing standing between a policy regression and
# every user's library, and they are inherently manual — they need a real
# PostgreSQL, which is not something `npm test` can assume. That is fine;
# CLAUDE.md already treats manual verification as a legitimate discipline (the
# Phase 4 credential greps, the Phase 5 route-table diff).
#
# What was NOT fine is how much setup running them took. `01_rls_adversarial`
# broke in Phase 6 Step 4a — a `username NOT NULL` column was added and the
# seed was never updated — and stayed broken through four phases, because
# every run meant reconstructing initdb, a port, the shim, and the migration
# order by hand. Friction is what let it rot; this removes the friction.
#
# Two properties that matter, both of which were missing from the ad-hoc runs:
#
#   1. EXIT CODES ARE CHECKED. `psql -v ON_ERROR_STOP=1` aborts a file on the
#      first error, but only the exit status reports it. Piping output through
#      `tail` (the obvious thing to do with a chatty suite) reports tail's
#      status instead, which is how a fully-aborted suite read as "passed".
#   2. SUITES ARE DISCOVERED, NOT LISTED. A new NN_*.sql file is picked up
#      automatically, so adding one cannot be half-done.
#
# Usage:  npm run test:sql
# Requires: PostgreSQL binaries on PATH, or PG_BIN pointing at them.

set -uo pipefail

PG_BIN="${PG_BIN:-/c/Program Files/PostgreSQL/18/bin}"
PORT="${PG_TEST_PORT:-55433}"
PGDATA="${PG_TEST_DATA:-${TMPDIR:-/tmp}/marquee_sqltest_pg}"
DB="marquee_sqltest"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -x "$PG_BIN/initdb.exe" ] && [ ! -x "$PG_BIN/initdb" ]; then
  echo "ERROR: PostgreSQL binaries not found at: $PG_BIN"
  echo "Set PG_BIN to your PostgreSQL bin directory, e.g."
  echo "  PG_BIN='/c/Program Files/PostgreSQL/18/bin' npm run test:sql"
  exit 1
fi

INITDB="$PG_BIN/initdb"; [ -x "$PG_BIN/initdb.exe" ] && INITDB="$PG_BIN/initdb.exe"
PGCTL="$PG_BIN/pg_ctl";  [ -x "$PG_BIN/pg_ctl.exe" ]  && PGCTL="$PG_BIN/pg_ctl.exe"
PSQL="$PG_BIN/psql";     [ -x "$PG_BIN/psql.exe" ]    && PSQL="$PG_BIN/psql.exe"

export PGPASSWORD=postgres
CONN=(-h 127.0.0.1 -p "$PORT" -U postgres)

cleanup() {
  "$PGCTL" -D "$PGDATA" stop -m immediate >/dev/null 2>&1
  rm -rf "$PGDATA"
}
trap cleanup EXIT

echo "=== starting throwaway cluster on port $PORT"
rm -rf "$PGDATA"
mkdir -p "$PGDATA"
PWFILE="$(mktemp)"; echo postgres > "$PWFILE"
"$INITDB" -D "$PGDATA" -U postgres --pwfile="$PWFILE" -E UTF8 --no-locale >/dev/null 2>&1
rm -f "$PWFILE"

# shared_buffers/max_worker_processes kept tiny: Windows otherwise fails to
# reserve the shared memory region ("could not reserve shared memory region
# ... error code 487"). fsync off because this cluster is deleted on exit.
"$PGCTL" -D "$PGDATA" -o "-p $PORT -c shared_buffers=1MB -c max_connections=20 -c max_worker_processes=0 -c autovacuum=off -c fsync=off" -l "$PGDATA/server.log" start >/dev/null 2>&1

for _ in $(seq 1 30); do
  "$PSQL" "${CONN[@]}" -d postgres -c "select 1" >/dev/null 2>&1 && break
  sleep 1
done

"$PSQL" "${CONN[@]}" -d postgres -q -c "drop database if exists $DB;" -c "create database $DB;" >/dev/null 2>&1
DBCONN=("${CONN[@]}" -d "$DB" -v ON_ERROR_STOP=1 -q)

echo "=== applying the Supabase shim + every migration in order"
"$PSQL" "${DBCONN[@]}" -f "$ROOT/supabase/tests/00_local_supabase_shim.sql" >/dev/null
if [ $? -ne 0 ]; then echo "FAILED: shim did not apply"; exit 1; fi

for migration in "$ROOT"/supabase/migrations/*.sql; do
  if ! "$PSQL" "${DBCONN[@]}" -f "$migration" >/dev/null; then
    echo "FAILED to apply migration: $(basename "$migration")"
    exit 1
  fi
done
echo "    $(ls "$ROOT"/supabase/migrations/*.sql | wc -l) migrations applied"

# Discovered, never hand-listed — a new suite is included the moment it exists.
failures=0
total=0
for suite in "$ROOT"/supabase/tests/[0-9][0-9]_*.sql; do
  name="$(basename "$suite")"
  case "$name" in 00_*) continue ;; esac
  total=$((total + 1))

  output="$("$PSQL" "${DBCONN[@]}" -f "$suite" 2>&1)"
  status=$?

  if [ $status -ne 0 ]; then
    echo ""
    echo "FAIL  $name  (psql exit $status)"
    echo "$output" | grep -iE "error|fatal|exception" | head -5 | sed 's/^/        /'
    failures=$((failures + 1))
  else
    passes="$(printf '%s' "$output" | grep -c 'PASS')"
    echo "ok    $name  ($passes checks reported)"
  fi
done

echo ""
if [ $failures -gt 0 ]; then
  echo "=== $failures of $total suite(s) FAILED"
  exit 1
fi
echo "=== all $total suites passed"
