import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/db.js';
import { listSuggestions, resolveSuggestion, suggestImprovement } from '../src/feedback.js';
import { capacity } from '../src/tools.js';
import { freshDb, type TestDb } from './harness.js';

/**
 * The channel back to the person who builds this.
 *
 * The two properties worth defending are that it stays OUT of the portfolio,
 * and that repeat reports strengthen a finding rather than multiplying it. A
 * suggestion box that fills with duplicates is one nobody reads.
 */

let db: TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await freshDb('feedback');
  sql = db.sql;
});

afterAll(async () => {
  await db.drop();
});

describe('filing', () => {
  it('records a report with the occasion that prompted it', async () => {
    const res = await suggestImprovement(sql, {
      kind: 'bug',
      title: 'commit_tasks deadlocks the connection pool',
      detail: 'A pool query inside sql.begin() waits on a connection its own transaction holds.',
      trigger_context: 'Committing 12 tasks; every later call hung until a fresh instance came up.',
      severity: 'blocking',
      reported_from: 'claude session',
    });

    expect(res.ok).toBe(true);
    expect(res['filed']).toBe(true);
    expect(res['occurrences']).toBe(1);

    const rows = await sql<Array<{ trigger_context: string; severity: string; source: string }>>`
      select trigger_context, severity, source from feedback
       where title = 'commit_tasks deadlocks the connection pool'`;
    expect(rows[0]!.severity).toBe('blocking');
    expect(rows[0]!.source).toBe('agent');
    expect(rows[0]!.trigger_context).toContain('12 tasks');
  });

  it('counts a repeat rather than duplicating it', async () => {
    const again = await suggestImprovement(sql, {
      kind: 'bug',
      title: 'commit_tasks deadlocks the connection pool',
      detail: 'Hit it again in a different conversation.',
    });
    expect(again['occurrences']).toBe(2);
    expect(String(again.confidence.notes.join(' '))).toContain('already reported');

    const rows = await sql`select id from feedback where title = 'commit_tasks deadlocks the connection pool'`;
    expect(rows).toHaveLength(1);
  });

  it('keeps the worst severity ever reported, not the latest', async () => {
    await suggestImprovement(sql, {
      kind: 'bug',
      title: 'commit_tasks deadlocks the connection pool',
      detail: 'Minor this time.',
      severity: 'low',
    });
    const rows = await sql<Array<{ severity: string }>>`
      select severity from feedback where title = 'commit_tasks deadlocks the connection pool'`;
    // Something that was once blocking does not become low because a later
    // report caught it on a good day.
    expect(rows[0]!.severity).toBe('blocking');
  });

  it('reopens a declined item when it is hit again', async () => {
    await suggestImprovement(sql, {
      kind: 'feature',
      title: 'no way to record a recurring commitment',
      detail: 'Weekly calls have to be filed as ordinary tasks.',
    });
    const open = await listSuggestions(sql, {});
    const id = (open['suggestions'] as Array<{ id: string; title: string }>).find(
      (s) => s.title === 'no way to record a recurring commitment',
    )!.id;

    await resolveSuggestion(sql, { id, status: 'declined', note: 'not for V1' });

    await suggestImprovement(sql, {
      kind: 'feature',
      title: 'no way to record a recurring commitment',
      detail: 'Came up again.',
    });
    const rows = await sql<Array<{ status: string; occurrences: number }>>`
      select status, occurrences from feedback where id = ${id}`;
    // Being hit again is new evidence. Swallowing it would hide precisely the
    // recurring problems most worth fixing.
    expect(rows[0]!.status).toBe('open');
    expect(rows[0]!.occurrences).toBe(2);
  });
});

describe('it never becomes work in the portfolio', () => {
  it('does not create a task', async () => {
    const tasks = await sql<Array<{ n: number }>>`select count(*)::int as n from tasks`;
    await suggestImprovement(sql, {
      kind: 'improvement',
      title: 'telegram capacity reply is unreadable',
      detail: 'It reports hours instead of an answer.',
    });
    const after = await sql<Array<{ n: number }>>`select count(*)::int as n from tasks`;
    expect(after[0]!.n).toBe(tasks[0]!.n);
  });

  it('takes no share of the week and drives no demand', async () => {
    const res = await capacity(sql, { available_hours: 25 });
    const required = (res['hours'] as { required: number }).required;
    // Four suggestions are on file at this point. If any of them reached the
    // engine, this would not be zero.
    expect(required).toBe(0);
  });
});

describe('listing', () => {
  it('orders by severity, then by how often it has been hit', async () => {
    const res = await listSuggestions(sql, { status: 'open' });
    const items = res['suggestions'] as Array<{ title: string; severity: string }>;
    expect(items[0]!.severity).toBe('blocking');
  });

  it('filters by kind', async () => {
    const res = await listSuggestions(sql, { kind: 'improvement' });
    const items = res['suggestions'] as Array<{ kind: string }>;
    expect(items.every((i) => i.kind === 'improvement')).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it('says plainly when there is nothing, rather than returning an empty list', async () => {
    const res = await listSuggestions(sql, { status: 'planned' });
    expect(res['total']).toBe(0);
    expect(res.confidence.notes.join(' ')).toContain('nothing planned');
  });
});

describe('resolving', () => {
  it('reports a missing id instead of silently doing nothing', async () => {
    const res = await resolveSuggestion(sql, {
      id: '00000000-0000-0000-0000-000000000000',
      status: 'done',
    });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('not_found');
  });
});
