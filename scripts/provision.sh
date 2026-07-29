#!/usr/bin/env bash
#
# Provision a TaskOS database: apply the four migrations in order, then prove the
# triggers on the database you just built.
#
#   ./scripts/provision.sh "postgresql://user:pass@host:5432/postgres"
#
# Safe to re-run: the schema migration is not idempotent (it will refuse if the
# tables already exist), but the seed and the holding-venture migration are, so a
# second run against an existing TaskOS database updates the seed and stops.
#
# The trigger proof runs inside a transaction and rolls back, so it leaves
# nothing behind — but it does write and roll back, so do not point it at a
# database holding data you cannot afford to have briefly locked.

set -euo pipefail

DB_URL="${1:-${DATABASE_URL:-}}"

if [[ -z "$DB_URL" ]]; then
  cat >&2 <<'USAGE'
usage: ./scripts/provision.sh <DATABASE_URL>

For Supabase, use the connection string from
  Project Settings -> Database -> Connection string -> URI
Use the DIRECT connection (port 5432) for migrations, not the pooler: the
pooler cannot run the multi-statement DDL these migrations contain.

The MCP server itself should then use the TRANSACTION POOLER string (port 6543),
because each serverless invocation opens its own connection.
USAGE
  exit 64
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "==> checking connectivity"
psql "$DB_URL" -tAc 'select version()' | sed 's/^/    /'

for file in 0001_schema 0002_triggers 0003_seed 0004_unsorted_venture; do
  path="$here/supabase/migrations/${file}.sql"
  [[ -f "$path" ]] || { echo "missing migration: $path" >&2; exit 1; }
  echo "==> applying ${file}.sql"
  psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$path"
done

echo "==> proving the triggers against this database"
# The proof ends with 'ALL TRIGGER TESTS PASSED' and rolls its fixture back.
psql "$DB_URL" -f "$here/supabase/tests/triggers.sql" 2>&1 | grep -E 'PASS|FAIL|PASSED' | sed 's/^NOTICE:  /    /'

echo
echo "==> what is in there now"
psql "$DB_URL" -c "
  select
    (select count(*) from ventures where active) as active_ventures,
    (select count(*) from ventures where not active) as holding_ventures,
    (select count(*) from milestones) as milestones,
    (select count(*) from outcome_targets) as outcome_targets,
    (select count(*) from tasks) as tasks,
    (select active_tz from settings where id = 1) as active_tz,
    (select buffer_ratio from settings where id = 1) as buffer_ratio,
    taskos_today() as today_in_active_tz"

cat <<'NEXT'

==> next
  1. Generate a token:            openssl rand -hex 32
  2. Set it and the pooler URL on the MCP deployment:
       TASKOS_TOKEN=<the token>
       DATABASE_URL=<transaction pooler string, port 6543>
  3. Deploy:                      cd apps/mcp && vercel deploy --prod
  4. Register the connector in claude.ai with the /api/mcp URL and that token.
  5. Ask Claude: "I have about 25 hours this week - what's going to slip?"

  No tasks were seeded, by design: enter them conversationally.
NEXT
