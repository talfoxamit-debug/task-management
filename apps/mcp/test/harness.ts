import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

export const MIGRATIONS = [
  '0001_schema.sql',
  '0002_triggers.sql',
  '0003_seed.sql',
  '0004_unsorted_venture.sql',
];

function psql(db: string, args: string[]): void {
  execFileSync('psql', ['-h', HOST, '-p', String(PORT), '-U', USER, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', ...args], {
    stdio: 'pipe',
  });
}

export interface TestDb {
  sql: Sql;
  name: string;
  drop: () => Promise<void>;
}

/** A fresh database with every migration applied and the seed loaded. */
export async function freshDb(label: string): Promise<TestDb> {
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
  await sql`update settings set started_at = now() - ${`${days} days`}::interval where id = 1`;
}

/** Plant an event this many days ago, so daysOfEvents crosses the 14-day gate. */
export async function plantOldEvent(sql: Sql, days: number): Promise<void> {
  await sql`
    insert into events (actor, verb, payload, at)
    values ('test', 'backdated', '{}'::jsonb, now() - ${`${days} days`}::interval)
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
