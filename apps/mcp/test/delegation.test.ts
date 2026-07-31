import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/db.js';
import {
  delegateLink,
  listDelegationLinks,
  looksLikeToken,
  resolveToken,
  revokeDelegation,
} from '../src/delegation.js';
import {
  delegateClose,
  delegateComment,
  delegateUndo,
  loadDelegateView,
  ownsTask,
} from '../src/delegate-data.js';
import { commitTasks } from '../src/tools.js';
import { createPerson } from '../src/registry.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * Delegation links.
 *
 * A link IS the credential — no account, no password. That trade is only
 * acceptable because of how narrow the link's reach is, so these tests are
 * mostly about the edges of that reach: what one person's link can see of
 * another's work, what a revoked or expired link does, and what a token for one
 * task can touch.
 *
 * The bar is that a leaked link is a contained incident rather than a breach.
 */

let db: TestDb;
let sql: Sql;
let othmanLink: string;
let saarLink: string;

const ENV = { ...process.env };

async function tokenFor(person: string, extra: Record<string, unknown> = {}) {
  const res = await delegateLink(sql, { person, ...extra } as never);
  return String(res['link']).split('/').pop()!;
}

beforeAll(async () => {
  db = await freshDb('delegation');
  sql = db.sql;
  process.env['TASKOS_PUBLIC_URL'] = 'https://taskos.example';

  await createPerson(sql, { name: 'Othman', hours_per_week: 40 });
  await createPerson(sql, { name: 'Saar', hours_per_week: 8 });

  await commitTasks(sql, {
    tasks: [
      {
        title: 'Rewire the checkout redirect',
        venture: 'yachtyhub',
        assignee: 'Othman',
        estimate_minutes: 90,
        deadline_date: '2026-08-06',
        notes: 'The redirect loop is what is blocking the demo.',
      },
      { title: 'Purge the CDN cache', venture: 'yachtyhub', assignee: 'Othman', estimate_minutes: 30 },
      { title: 'Saar private thing', venture: 'yachtyhub', assignee: 'Saar', estimate_minutes: 45 },
      { title: 'Tal keeps this one', venture: 'yachtyhub', estimate_minutes: 60 },
    ],
    idempotency_key: 'deleg-seed',
  });

  othmanLink = await tokenFor('Othman');
  saarLink = await tokenFor('Saar');
});

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  process.env = { ...ENV, TASKOS_PUBLIC_URL: 'https://taskos.example' };
});

describe('minting', () => {
  it('returns the secret exactly once and stores only its hash', async () => {
    const rows = await sql<Array<{ token_hash: string; token_prefix: string }>>`
      select token_hash, token_prefix from delegation_tokens limit 1`;
    // A database dump, a backup or a screenshot of a query must yield nothing
    // that works.
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.token_hash).not.toContain('tdp_');
    expect(rows[0]!.token_prefix.length).toBeLessThanOrEqual(12);
  });

  it('will not mint a second live link, and says why', async () => {
    const again = await delegateLink(sql, { person: 'Othman' });
    expect(again['already_live']).toBe(true);
    expect(again['link']).toBeNull();
    expect(again.confidence.notes.join(' ')).toContain('cannot be shown again');
  });

  it('rotates with a grace window, so the old link keeps working', async () => {
    const before = othmanLink;
    const rotated = await delegateLink(sql, { person: 'Othman', rotate: true, grace_hours: 72 });
    expect(rotated['rotated']).toBe(true);

    // Rotation that locks somebody out immediately is rotation nobody performs.
    const old = await resolveToken(sql, before);
    expect(old.ok).toBe(true);
    if (old.ok) expect(old.token.superseded_link).toBe('rotated');

    const fresh = await resolveToken(sql, String(rotated['link']).split('/').pop()!);
    expect(fresh.ok).toBe(true);
    othmanLink = String(rotated['link']).split('/').pop()!;
  });

  it('refuses a task link for work the person is not assigned', async () => {
    const res = await delegateLink(sql, {
      person: 'Saar',
      scope: 'task',
      task_id: await taskIdByTitle(sql, 'Rewire the checkout redirect'),
    });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('not_assigned');
  });

  it('warns about notes written before anyone else could read them', async () => {
    // Task-scoped so it does not disturb Othman's person link, and pointed at
    // the one task that actually carries notes.
    const res = await delegateLink(sql, {
      person: 'Othman',
      scope: 'task',
      task_id: await taskIdByTitle(sql, 'Rewire the checkout redirect'),
    });
    // The likeliest place a private aside is sitting is a note written when
    // nobody else could ever read it.
    expect(res.confidence.notes.join(' ')).toMatch(/notes written before/);
    expect(res.confidence.notes.join(' ')).toContain('Rewire the checkout redirect');
  });

  it('names who to give it to and refuses an unknown person', async () => {
    const res = await delegateLink(sql, { person: 'Nobody' });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.message).toContain('nothing was written');
    expect(res.errors?.[0]?.message).toContain('Othman');
  });
});

describe('resolution', () => {
  it('rejects malformed input before touching the database', async () => {
    expect(looksLikeToken('nonsense')).toBe(false);
    expect(looksLikeToken('tdp_short')).toBe(false);
    for (const bad of ['', 'nonsense', '../../etc/passwd', 'tdp_' + 'a'.repeat(200)]) {
      const res = await resolveToken(sql, bad);
      expect(res.ok).toBe(false);
    }
  });

  it('refuses a revoked link immediately', async () => {
    const throwaway = await tokenFor('Saar', { rotate: true });
    expect((await resolveToken(sql, throwaway)).ok).toBe(true);
    await revokeDelegation(sql, { person: 'Saar', reason: 'left the project' });
    const after = await resolveToken(sql, throwaway);
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('revoked');
  });

  it('refuses an expired link, and revokes it on the way past', async () => {
    const t = await tokenFor('Saar', { rotate: true, expires_in_days: 1 });
    await sql`update delegation_tokens set expires_at = now() - interval '1 hour'
               where revoked_at is null and expires_at is not null`;
    const res = await resolveToken(sql, t);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');

    // Enforced on read rather than by a sweeper, so there is no window in which
    // an expired link still works because a job has not run yet.
    const rows = await sql<Array<{ revoked_reason: string }>>`
      select revoked_reason from delegation_tokens where revoked_reason = 'expired'`;
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('what a link can reach', () => {
  it("shows only that person's own work", async () => {
    const t = await resolveToken(sql, othmanLink);
    expect(t.ok).toBe(true);
    if (!t.ok) return;

    const view = await loadDelegateView(sql, t.token);
    const titles = [...view.open, ...view.later].map((x) => x.title);
    expect(titles).toContain('Rewire the checkout redirect');
    expect(titles).toContain('Purge the CDN cache');
    // The two that must never appear.
    expect(titles).not.toContain('Saar private thing');
    expect(titles).not.toContain('Tal keeps this one');
  });

  it('cannot act on another person\'s task', async () => {
    const t = await resolveToken(sql, othmanLink);
    if (!t.ok) throw new Error('expected a live token');
    const saarTask = await taskIdByTitle(sql, 'Saar private thing');

    expect(await ownsTask(sql, t.token, saarTask)).toBe(false);

    const closed = await delegateClose(sql, t.token, saarTask, '30');
    expect(closed.ok).toBe(false);
    const row = await sql<Array<{ status: string }>>`
      select status from tasks where id = ${saarTask}`;
    expect(row[0]!.status).not.toBe('done');

    const commented = await delegateComment(sql, t.token, saarTask, 'hello', false);
    expect(commented.ok).toBe(false);
  });

  it('a task-scoped link reaches exactly one task', async () => {
    const one = await taskIdByTitle(sql, 'Purge the CDN cache');
    const res = await delegateLink(sql, { person: 'Othman', scope: 'task', task_id: one });
    const t = await resolveToken(sql, String(res['link']).split('/').pop()!);
    if (!t.ok) throw new Error('expected a live token');

    const view = await loadDelegateView(sql, t.token);
    expect([...view.open, ...view.later].map((x) => x.title)).toEqual(['Purge the CDN cache']);

    // And it cannot reach the person's other work, even though it is theirs.
    const other = await taskIdByTitle(sql, 'Rewire the checkout redirect');
    expect(await ownsTask(sql, t.token, other)).toBe(false);
  });

  it('reports what a task unblocks as a count, never as titles', async () => {
    await commitTasks(sql, {
      tasks: [
        { title: 'Depends on the redirect', venture: 'yachtyhub', depends_on: ['Rewire the checkout redirect'] },
      ],
      idempotency_key: 'deleg-dep',
    });
    const t = await resolveToken(sql, othmanLink);
    if (!t.ok) throw new Error('expected a live token');
    const view = await loadDelegateView(sql, t.token);
    const task = [...view.open, ...view.later].find((x) => x.title === 'Rewire the checkout redirect')!;
    expect(task.unblocks).toBe(1);
    // Rendering the dependent titles would leak Tal's work into a page built to
    // be forwarded, and the leak widens with graph density.
    expect(JSON.stringify(view)).not.toContain('Depends on the redirect');
  });

  it('says which timezone it used rather than assuming one', async () => {
    const t = await resolveToken(sql, othmanLink);
    if (!t.ok) throw new Error('expected a live token');
    const view = await loadDelegateView(sql, t.token);
    expect(view.timezone_source).toBe('workspace');
    await sql`update people set timezone = 'Asia/Jerusalem' where name = 'Othman'`;
    const after = await loadDelegateView(sql, t.token);
    expect(after.timezone_source).toBe('theirs');
    expect(after.timezone).toBe('Asia/Jerusalem');
  });
});

describe('what a delegate may do', () => {
  it('closes without a duration, and nothing is invented', async () => {
    const t = await resolveToken(sql, othmanLink);
    if (!t.ok) throw new Error('expected a live token');
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');

    const res = await delegateClose(sql, t.token, id, null);
    expect(res.ok).toBe(true);
    expect(res.minutes).toBeNull();

    const row = await sql<Array<{ actual_inferred: boolean; actual_by_person_id: string | null }>>`
      select actual_inferred, actual_by_person_id from tasks where id = ${id}`;
    // Absent means absent. The estimate is recorded as inferred, exactly as it
    // is for Tal, and no measurement is manufactured.
    expect(row[0]!.actual_inferred).toBe(true);
    expect(row[0]!.actual_by_person_id).toBe(t.token.person_id);
  });

  it('undoes a mis-tap within the window, and refuses outside it', async () => {
    const t = await resolveToken(sql, othmanLink);
    if (!t.ok) throw new Error('expected a live token');
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');

    const undone = await delegateUndo(sql, t.token, id);
    expect(undone.ok).toBe(true);
    const row = await sql<Array<{ status: string }>>`select status from tasks where id = ${id}`;
    expect(row[0]!.status).toBe('active');

    await delegateClose(sql, t.token, id, null);
    await sql`update tasks set closed_at = now() - interval '2 hours' where id = ${id}`;
    const late = await delegateUndo(sql, t.token, id);
    expect(late.ok).toBe(false);
    expect(late.message).toContain('Too late');
  });

  it('flags being stuck WITHOUT changing status', async () => {
    const t = await resolveToken(sql, othmanLink);
    if (!t.ok) throw new Error('expected a live token');
    const id = await taskIdByTitle(sql, 'Rewire the checkout redirect');
    const before = await sql<Array<{ status: string }>>`select status from tasks where id = ${id}`;

    const res = await delegateComment(sql, t.token, id, 'Blocked on the CDN vendor', true);
    expect(res.ok).toBe(true);

    const after = await sql<Array<{ status: string; needs_attention_at: Date | null }>>`
      select status, needs_attention_at from tasks where id = ${id}`;
    // `waiting` is in DEMAND_EXCLUDED_STATUSES: if being stuck changed status,
    // the minutes would leave demand while coverage still counted the task, and
    // capacity() would report a LIGHTER week because somebody got blocked.
    expect(after[0]!.status).toBe(before[0]!.status);
    expect(after[0]!.needs_attention_at).not.toBeNull();
  });

  it('rejects an empty or oversized comment', async () => {
    const t = await resolveToken(sql, othmanLink);
    if (!t.ok) throw new Error('expected a live token');
    const id = await taskIdByTitle(sql, 'Rewire the checkout redirect');
    expect((await delegateComment(sql, t.token, id, '   ', false)).ok).toBe(false);
    expect((await delegateComment(sql, t.token, id, 'x'.repeat(4001), false)).ok).toBe(false);
  });

  it("never shows one delegate another delegate's comments", async () => {
    // Threads survive reassignment, so without the author filter, handing a
    // stalled task to Saar shows him everything Othman wrote.
    const id = await taskIdByTitle(sql, 'Rewire the checkout redirect');
    await sql`update tasks set assignee_person_id =
                (select id from people where name = 'Saar') where id = ${id}`;

    const fresh = await delegateLink(sql, { person: 'Saar', rotate: true });
    const t = await resolveToken(sql, String(fresh['link']).split('/').pop()!);
    if (!t.ok) throw new Error('expected a live token');
    const view = await loadDelegateView(sql, t.token);
    const task = [...view.open, ...view.later].find((x) => x.id === id)!;
    expect(task.comments.some((c) => c.body.includes('Blocked on the CDN vendor'))).toBe(false);
  });
});

describe('telemetry honesty', () => {
  it('reports a fetch as a fetch, not as a read', async () => {
    const res = await listDelegationLinks(sql, {});
    expect(res.confidence.notes.join(' ')).toContain('a fetch count is not a read');
    expect(res.confidence.notes.join(' ')).toContain('link previews');
  });
});
