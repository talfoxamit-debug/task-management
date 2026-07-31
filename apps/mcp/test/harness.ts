import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';
import { setSql, type Sql } from '../src/db.js';

/**
 * Integration harness. These tests run against a real PostgreSQL, not a mock:
 * the four triggers, the cycle-prevention walk and the transaction boundaries in
 * commit_tasks are the things most likely to be wrong, and none of them exist in
 * a fake.
 *
 * Requires a local server. Start one with:
 *   /usr/lib/postgresql/16/bin/initdb -D <dir> -U postgres --auth=trust
 *   /usr/lib/postgresql/16/bin/pg_ctl -D <dir> -o '-p 5433' start
 */

const HOST = process.env['TEST_PGHOST'] ?? 'localhost';
const PORT = Number(process.env['TEST_PGPORT'] ?? 5433);
const USER = process.env['TEST_PGUSER'] ?? 'postgres';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../../../supabase/migrations');

/**
 * Every migration in the directory, in filename order.
 *
 * Read rather than listed. A hardcoded list looks harmless and then silently
 * omits the migration someone added last week, so the suite runs against a
 * schema that no longer resembles production and passes while doing it. The
 * numeric prefixes are what make sorted filename order the right order.
 */
export const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();

function psql(db: string, args: string[]): void {
  execFileSync('psql', ['-h', HOST, '-p', String(PORT), '-U', USER, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
    stdio: 'pipe',
  });
}

export interface TestDb {
  sql: Sql;
  name: string;
  /** Connection string for this database, for code that reads DATABASE_URL. */
  url: string;
  drop: () => Promise<void>;
}

/**
 * Fail with an actionable message rather than a raw psql error. These tests
 * deliberately do NOT skip when the server is absent: a silently skipped
 * integration suite reads as a passing one.
 */
function requireServer(): void {
  try {
    execFileSync('psql', ['-h', HOST, '-p', String(PORT), '-U', USER, '-d', 'postgres', '-tAc', 'select 1'], {
      stdio: 'pipe',
    });
  } catch (e) {
    throw new Error(
      [
        `No PostgreSQL at ${HOST}:${PORT} (user ${USER}).`,
        'These are integration tests: the four triggers, the cycle-prevention walk and',
        "commit_tasks' transaction boundary do not exist in a mock, so they are not skipped.",
        '',
        'Start one:',
        '  export PGDATA=/var/lib/taskos-pg',
        '  /usr/lib/postgresql/16/bin/initdb -D $PGDATA -U postgres --auth=trust',
        "  /usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -o '-p 5433' -l /tmp/pg.log start",
        '',
        'Or point elsewhere with TEST_PGHOST / TEST_PGPORT / TEST_PGUSER.',
        '',
        `Underlying error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`,
      ].join('\n'),
    );
  }
}

/** A fresh database with every migration applied and the seed loaded. */
export async function freshDb(label: string): Promise<TestDb> {
  requireServer();
  const name = `taskos_test_${label}_${process.pid}`;
  execFileSync('psql', ['-h', HOST, '-p', String(PORT), '-U', USER, '-d', 'postgres', '-q', '-c',
    `drop database if exists ${name}`], { stdio: 'pipe' });
  execFileSync('psql', ['-h', HOST, '-p', String(PORT), '-U', USER, '-d', 'postgres', '-q', '-c',
    `create database ${name}`], { stdio: 'pipe' });

  for (const file of MIGRATIONS) {
    const full = path.join(migrationsDir, file);
    readFileSync(full, 'utf8'); // fail loudly if a migration is missing
    psql(name, ['-f', full]);
  }

  const sql = postgres({
    host: HOST,
    port: PORT,
    user: USER,
    database: name,
    max: 2,
    prepare: false,
    onnotice: () => {},
    types: {
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
    },
  }) as unknown as Sql;

  setSql(sql);

  return {
    sql,
    name,
    url: `postgresql://${USER}@${HOST}:${PORT}/${name}`,
    drop: async () => {
      await sql.end({ timeout: 5 });
      setSql(null);
      execFileSync('psql', ['-h', HOST, '-p', String(PORT), '-U', USER, '-d', 'postgres', '-q', '-c',
        `drop database if exists ${name}`], { stdio: 'pipe' });
    },
  };
}

/** Move settings.started_at back, to cross the D4 cold-start gates. */
export async function ageSystem(sql: Sql, days: number): Promise<void> {
  await sql`update settings set started_at = now() - ${`${days} days`}::interval`;
}

/** Plant an event this many days ago, so daysOfEvents crosses the 14-day gate. */
export async function plantOldEvent(sql: Sql, days: number): Promise<void> {
  await sql`
    insert into events (actor, verb, payload, at, workspace_id)
    values ('test', 'backdated', '{}'::jsonb, now() - ${`${days} days`}::interval,
            (select id from workspaces limit 1))
  `;
}

export async function ventureId(sql: Sql, slug: string): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`select id from ventures where slug = ${slug}`;
  return rows[0]!.id;
}

export async function milestoneId(sql: Sql, name: string): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`select id from milestones where name = ${name}`;
  return rows[0]!.id;
}

export async function taskIdByTitle(sql: Sql, title: string): Promise<string> {
  const rows = await sql<Array<{ id: string }>>`select id from tasks where title = ${title}`;
  return rows[0]!.id;
}
