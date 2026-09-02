import type { Queryable } from './db.js';

/**
 * What the code needs from the database, and whether it is actually there.
 *
 * THIS EXISTS BECAUSE OF A REAL OUTAGE. A deploy added `tasks.ai_preparable` to
 * the commit_tasks insert while migration 0014 had not been run, so every task
 * write failed with "column does not exist" — the single most-used path in the
 * system, broken by a column nothing had needed a minute earlier. Nothing in the
 * build caught it: it typechecked, the whole suite passed, because the test
 * harness applies every migration in the directory and production does not.
 *
 * That gap is structural. Migrations here are run by hand, in a SQL editor, by
 * the one person who also has a business to run, and code always ships first. So
 * the code cannot assume the column is there. Two things follow:
 *
 *   1. A missing column must DEGRADE the feature that needs it, never break the
 *      feature next to it. Losing "Claude can draft this" is a small loss;
 *      losing the ability to write down a task at all is the system failing at
 *      the only job it has.
 *   2. The drift must be VISIBLE before somebody hits it. /health reports it by
 *      name, so "which migration have I not run" is a question with an answer
 *      rather than a search through a directory.
 */

/**
 * Columns added after the initial schema, and the feature each one carries.
 *
 * `nullable: true` means the migration RELAXED an existing column rather than
 * adding one. That case exists because 0015 makes delegation_tokens.person_id
 * nullable and adds no column at all — so a checker that only looked for
 * missing columns would report "current" while owner_link failed on a not-null
 * violation, which is precisely the silent-drift failure this file was written
 * to end.
 */
export const EXPECTED_COLUMNS: Array<{
  table: string;
  column: string;
  migration: string;
  feature: string;
  nullable?: true;
}> = [
  { table: 'settings', column: 'default_weekly_hours', migration: '0008', feature: 'the stored working week' },
  { table: 'people', column: 'hours_per_week', migration: '0010', feature: 'delegated capacity' },
  { table: 'tasks', column: 'snoozed_until', migration: '0010', feature: 'snooze_task' },
  { table: 'delegation_tokens', column: 'id', migration: '0011', feature: 'delegation links' },
  { table: 'task_comments', column: 'id', migration: '0011', feature: 'delegate comments' },
  { table: 'tasks', column: 'actual_by_person_id', migration: '0011', feature: 'calibration quarantine' },
  { table: 'day_allocation', column: 'day_of_week', migration: '0012', feature: 'whose day it is' },
  { table: 'tasks', column: 'prepared_at', migration: '0013', feature: 'prepared work' },
  { table: 'tasks', column: 'ai_preparable', migration: '0014', feature: 'AI-drafted slots in day_plan' },
  { table: 'settings', column: 'work_start_hour', migration: '0014', feature: 'the hours of the day' },
  { table: 'day_allocation', column: 'start_hour', migration: '0014', feature: 'per-weekday hours' },
  {
    table: 'delegation_tokens',
    column: 'person_id',
    migration: '0015',
    feature: "Tal's own page (owner_link)",
    nullable: true,
  },
  {
    table: 'chat_pairing_codes',
    column: 'code',
    migration: '0016',
    feature: 'pairing a worker to a Telegram chat',
  },
  { table: 'task_nudges', column: 'task_id', migration: '0016', feature: 'chasing quiet delegates' },
  {
    table: 'people',
    column: 'telegram_paired_at',
    migration: '0016',
    feature: 'sending work to a worker in chat',
  },
  {
    table: 'engagements',
    column: 'id',
    migration: '0017',
    feature: 'date-range overrides of the weekly shape (set_engagement)',
  },
];

interface Snapshot {
  at: number;
  present: Set<string>;
  /** table.column for every column the database allows NULL in. */
  nullable: Set<string>;
}

let cache: Snapshot | null = null;

/**
 * Cached for a minute.
 *
 * Long enough that a hot path does not pay for the lookup, short enough that
 * running the migration takes effect without a redeploy — which matters, because
 * the person running it is watching to see whether it worked.
 */
const TTL_MS = 60_000;

async function snapshot(sql: Queryable, now: number): Promise<Snapshot> {
  if (cache && now - cache.at < TTL_MS) return cache;

  const rows = await sql<
    Array<{ table_name: string; column_name: string; is_nullable: string }>
  >`
    select table_name, column_name, is_nullable from information_schema.columns
     where table_schema = 'public'`;
  cache = {
    at: now,
    present: new Set(rows.map((r) => `${r.table_name}.${r.column_name}`)),
    nullable: new Set(
      rows.filter((r) => r.is_nullable === 'YES').map((r) => `${r.table_name}.${r.column_name}`),
    ),
  };
  return cache;
}

/** Reset between tests, and after a migration is applied in-process. */
export function forgetSchema(): void {
  cache = null;
}

export async function hasColumn(
  sql: Queryable,
  table: string,
  column: string,
): Promise<boolean> {
  const snap = await snapshot(sql, Date.now());
  return snap.present.has(`${table}.${column}`);
}

export interface SchemaDrift {
  ok: boolean;
  missing: Array<{ table: string; column: string; migration: string; feature: string }>;
  /** The lowest-numbered migration that has not been applied. */
  next_migration: string | null;
}

/**
 * What the running code expects and the database does not have.
 *
 * Reported by /health WITHOUT a credential, and that is a considered choice: it
 * names table and column names that are already in a public repository, and
 * knowing that a migration is outstanding is worth far more to the person who
 * has to run it than it is to anybody else.
 */
export async function schemaDrift(sql: Queryable): Promise<SchemaDrift> {
  const snap = await snapshot(sql, Date.now());
  const missing = EXPECTED_COLUMNS.filter((e) => {
    const key = `${e.table}.${e.column}`;
    if (!snap.present.has(key)) return true;
    // Present but still NOT NULL where the migration was supposed to relax it.
    return Boolean(e.nullable) && !snap.nullable.has(key);
  });
  const next = missing.length > 0 ? missing.map((m) => m.migration).sort()[0]! : null;
  return { ok: missing.length === 0, missing, next_migration: next };
}
