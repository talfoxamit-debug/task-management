import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/db.js';
import { listMilestones, moveMilestone } from '../src/registry.js';
import { commitTasks, setMilestone } from '../src/tools.js';
import { freshDb, milestoneId, type TestDb } from './harness.js';

/**
 * Moving a milestone between ventures.
 *
 * This exists because of a real one: a tax milestone sitting on the `unsorted`
 * holding venture, which is inactive by design. An inactive venture contributes
 * nothing to the week, so the work was real, the deadline was real, and
 * capacity() reported a comfortable week. set_milestone could not fix it — it
 * keys on (venture, name), so pointing it at the right venture would have
 * produced a second milestone and left every task attached to the first.
 */

let db: TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await freshDb('movemilestone');
  sql = db.sql;

  await setMilestone(sql, {
    venture: 'unsorted',
    name: 'File the 2025 return',
    due_date: '2026-09-15',
    hardness: 'hard',
    cost_of_slip: 'penalties and interest',
  });
  await commitTasks(sql, {
    tasks: [
      {
        title: 'Collect the 1099s',
        venture: 'unsorted',
        milestone: 'File the 2025 return',
        estimate_minutes: 120,
      },
      {
        title: 'Reconcile the Stripe payouts',
        venture: 'unsorted',
        milestone: 'File the 2025 return',
        estimate_minutes: 240,
      },
    ],
    idempotency_key: 'tax-seed',
  });
});

afterAll(async () => {
  await db.drop();
});

describe('move_milestone', () => {
  it('takes the attached tasks with it', async () => {
    const id = await milestoneId(sql, 'File the 2025 return');
    const res = await moveMilestone(sql, {
      milestone_id: id,
      venture: 'stackwrk',
      idempotency_key: 'move-1',
    });

    expect(res.ok).toBe(true);
    expect(res['moved']).toBe(true);
    expect(res['tasks_moved']).toBe(2);

    // A task carries its own venture_id and that is what allocates its hours.
    // Leaving them behind reports demand against a venture doing none of it.
    const rows = await sql<Array<{ slug: string }>>`
      select v.slug from tasks t join ventures v on v.id = t.venture_id
       where t.milestone_id = ${id}`;
    expect(rows.every((r) => r.slug === 'stackwrk')).toBe(true);

    const milestone = await sql<Array<{ slug: string }>>`
      select v.slug from milestones m join ventures v on v.id = m.venture_id where m.id = ${id}`;
    expect(milestone[0]!.slug).toBe('stackwrk');
  });

  it('creates nothing — unlike set_milestone with a different venture', async () => {
    const rows = await sql<Array<{ n: string }>>`
      select count(*)::text as n from milestones where name = 'File the 2025 return'`;
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('replays rather than moving twice', async () => {
    const id = await milestoneId(sql, 'File the 2025 return');
    const again = await moveMilestone(sql, {
      milestone_id: id,
      venture: 'yachtyhub',
      idempotency_key: 'move-1',
    });
    expect(again['replayed']).toBe(true);
    const rows = await sql<Array<{ slug: string }>>`
      select v.slug from milestones m join ventures v on v.id = m.venture_id where m.id = ${id}`;
    expect(rows[0]!.slug).toBe('stackwrk');
  });

  it('warns loudly when the destination is inactive', async () => {
    const id = await milestoneId(sql, 'File the 2025 return');
    const res = await moveMilestone(sql, { milestone_id: id, venture: 'unsorted' });
    expect(res.ok).toBe(true);
    // The exact condition this tool exists to fix, so it cannot be silently
    // reintroduced by the tool that fixes it.
    expect(res.confidence.notes.join(' ')).toContain('INACTIVE');
    expect(res.confidence.notes.join(' ')).toContain('will not appear in capacity()');

    await moveMilestone(sql, { milestone_id: id, venture: 'stackwrk' });
  });

  it('says so rather than moving when it is already there', async () => {
    const id = await milestoneId(sql, 'File the 2025 return');
    const res = await moveMilestone(sql, { milestone_id: id, venture: 'stackwrk' });
    expect(res['moved']).toBe(false);
    expect(res.confidence.notes.join(' ')).toContain('already on');
  });

  it('refuses a name collision instead of creating an ambiguous pair', async () => {
    await setMilestone(sql, {
      venture: 'yachtyhub',
      name: 'File the 2025 return',
      due_date: '2026-09-15',
      hardness: 'soft',
      cost_of_slip: 'none',
    });
    const id = await sql<Array<{ id: string }>>`
      select m.id from milestones m join ventures v on v.id = m.venture_id
       where m.name = 'File the 2025 return' and v.slug = 'stackwrk'`;
    const res = await moveMilestone(sql, { milestone_id: id[0]!.id, venture: 'yachtyhub' });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('name_taken');
    expect(res.errors?.[0]?.message).toContain('nothing was written');
  });

  it('refuses an unknown milestone and an unknown venture, naming what exists', async () => {
    const missing = await moveMilestone(sql, {
      milestone_id: '00000000-0000-0000-0000-000000000000',
      venture: 'stackwrk',
    });
    expect(missing.errors?.[0]?.code).toBe('not_found');

    const id = await sql<Array<{ id: string }>>`
      select m.id from milestones m join ventures v on v.id = m.venture_id
       where m.name = 'File the 2025 return' and v.slug = 'stackwrk'`;
    const wrong = await moveMilestone(sql, { milestone_id: id[0]!.id, venture: 'nope' });
    expect(wrong.errors?.[0]?.code).toBe('missing_venture');
    expect(wrong.errors?.[0]?.message).toContain('stackwrk');
  });

  it('clears the flag list_milestones raises about inactive ventures', async () => {
    const listed = await listMilestones(sql, { venture: 'stackwrk' });
    const items = listed['milestones'] as Array<Record<string, unknown>>;
    const moved = items.find((m) => m['name'] === 'File the 2025 return');
    expect(moved).toBeDefined();
    // The whole point: it is no longer on an inactive venture, so its demand is
    // counted again.
    expect(moved!['venture_active']).toBe(true);
    expect(moved!['attached_tasks']).toBe(2);
    expect(listed.confidence.notes.join(' ')).not.toContain('silently not counted');
  });
});
