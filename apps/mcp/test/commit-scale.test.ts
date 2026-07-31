import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/db.js';
import { commitTasks, capacity } from '../src/tools.js';
import { freshDb, ventureId, type TestDb } from './harness.js';

/**
 * commit_tasks at the size a real planning session produces.
 *
 * The rest of the suite commits two or three tasks at a time, which proves the
 * transaction boundary and nothing about scale. A real session hands over forty
 * or more with dependency edges named by title, and the failure mode at that
 * size is not a wrong answer — it is a request that dies and leaves the person
 * unable to tell whether half their planning landed.
 */

let db: TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await freshDb('commitscale');
  sql = db.sql;
});

afterAll(async () => {
  await db.drop();
});

describe('a realistic planning batch', () => {
  it('commits 44 tasks with a dependency chain in one transaction', async () => {
    const tasks = Array.from({ length: 44 }, (_, i) => ({
      title: `Task number ${i + 1}`,
      venture: 'yachtyhub',
      estimate_minutes: 60 + i,
      value: ((i % 10) + 1) as number,
      criticality: 'blocking' as const,
      context: 'deep_work' as const,
      notes: `A realistic note of the length these actually carry, describing what "Task number ${i + 1}" means and why it matters, because real captures are sentences and not labels.`,
      ...(i > 0 ? { depends_on: [`Task number ${i}`] } : {}),
    }));

    const started = Date.now();
    const res = await commitTasks(sql, { tasks, idempotency_key: 'scale-1' });
    const elapsed = Date.now() - started;

    expect(res.ok).toBe(true);
    const rows = await sql<Array<{ n: number }>>`select count(*)::int as n from tasks`;
    expect(rows[0]!.n).toBeGreaterThanOrEqual(44);

    // A 43-edge chain, every edge resolved by title.
    const edges = await sql<Array<{ n: number }>>`
      select count(*)::int as n from task_dependencies`;
    expect(edges[0]!.n).toBe(43);

    // Not a benchmark, a canary: this runs against a local socket, so anything
    // remotely near a serverless limit here means real trouble over a pooler.
    expect(elapsed).toBeLessThan(20_000);
  });

  it('replays rather than duplicating when the same key is sent again', async () => {
    const before = await sql<Array<{ n: number }>>`select count(*)::int as n from tasks`;
    const again = await commitTasks(sql, {
      tasks: [{ title: 'Task number 1', venture: 'yachtyhub' }],
      idempotency_key: 'scale-1',
    });
    expect(again['replayed']).toBe(true);
    const after = await sql<Array<{ n: number }>>`select count(*)::int as n from tasks`;
    // This is what makes a retry after an ambiguous failure safe.
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('still answers capacity() with that many tasks attached', async () => {
    const v = await ventureId(sql, 'yachtyhub');
    expect(v).toBeTruthy();
    const res = await capacity(sql, { available_hours: 25 });
    expect(res.ok).toBe(true);
  });
});

describe('the single-connection deadlock', () => {
  /**
   * The bug this file now guards against, and how it survived so long.
   *
   * commit_tasks called resolveWorkspaceId(sql) — the POOL handle — from inside
   * sql.begin(). The pool has one connection, the open transaction holds it, and
   * the transaction cannot finish until this query returns. It never does.
   *
   * In production that took the whole server down rather than the one call:
   * every later request, including bare reads, queued behind a transaction that
   * would never end, and only a fresh lambda cleared it. The symptom was "the
   * server stopped responding after commit_tasks", which is exactly what a
   * connection-level deadlock looks like from outside.
   *
   * The test harness used max: 2. The spare connection answered, the deadlock
   * never formed, and every test passed. It now uses max: 1, so this test fails
   * within its timeout if a pool query is ever put back inside a transaction.
   */
  it('completes rather than hanging, with a pool of exactly one', async () => {
    const one = await commitTasks(sql, {
      tasks: [{ title: 'Single task through a one-connection pool', venture: 'yachtyhub' }],
      idempotency_key: 'deadlock-probe',
    });
    expect(one.ok).toBe(true);

    // And the connection is usable afterwards. Before the fix this second call
    // was the one that revealed the server was wedged.
    const after = await sql<Array<{ n: number }>>`select count(*)::int as n from tasks`;
    expect(after[0]!.n).toBeGreaterThan(0);
  }, 15_000);
});
