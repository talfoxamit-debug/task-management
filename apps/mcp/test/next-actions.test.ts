import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/db.js';
import { getDayAllocation, nextActions, setDayAllocation } from '../src/next-actions.js';
import { capacity, close, commitTasks, setMilestone } from '../src/tools.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * next_actions and the day allocation, against the acceptance criteria.
 *
 * The theme: every one of these rules exists because the obvious alternative
 * produces a list nobody can act on. A size filter hides the most important
 * work. A soft energy filter produces work that has to be redone. A flex budget
 * spent by asking is gone before the day starts. A hard day rule with no
 * exception hides a fire.
 */

let db: TestDb;
let sql: Sql;
let seatop: string;
let yathub: string;

/** A Tuesday and a Saturday, fixed, so the day rules are testable. */
const TUESDAY = '2026-08-04';
const SATURDAY = '2026-08-08';

beforeAll(async () => {
  db = await freshDb('nextactions');
  sql = db.sql;

  const v = await sql<Array<{ id: string; slug: string }>>`
    select id, slug from ventures where slug in ('seatop', 'yachtyhub')`;
  seatop = v.find((x) => x.slug === 'seatop')!.id;
  yathub = v.find((x) => x.slug === 'yachtyhub')!.id;

  await setMilestone(sql, {
    venture: 'yachtyhub',
    name: 'Day 0',
    due_date: '2026-08-20',
    hardness: 'hard',
    cost_of_slip: 'critical — the pilot window cannot move',
    idempotency_key: 'na-m',
  });

  await commitTasks(sql, {
    tasks: [
      // The big one. A naive size filter makes this permanently invisible.
      {
        title: 'Rebuild the tracking pipeline',
        venture: 'yachtyhub',
        milestone: 'Day 0',
        criticality: 'blocking',
        context: 'deep_work',
        energy: 'high',
        estimate_minutes: 720,
        value: 10,
      },
      {
        title: 'Reply to the marina',
        venture: 'yachtyhub',
        context: 'calls',
        energy: 'low',
        estimate_minutes: 20,
        value: 6,
      },
      {
        title: 'File the receipts',
        venture: 'seatop',
        context: 'admin',
        energy: 'low',
        estimate_minutes: 30,
        value: 4,
      },
      {
        title: 'Draft the Seatop deck',
        venture: 'seatop',
        context: 'creative',
        energy: 'high',
        estimate_minutes: 120,
        value: 7,
      },
      // A chain: the second must never be suggested while the first is open.
      { title: 'Get the survey back', venture: 'seatop', estimate_minutes: 60, energy: 'medium' },
      {
        title: 'Price from the survey',
        venture: 'seatop',
        estimate_minutes: 45,
        energy: 'medium',
        depends_on: ['Get the survey back'],
      },
    ],
    idempotency_key: 'na-seed',
  });
});

afterAll(async () => {
  await db.drop();
});

describe('what it will never suggest', () => {
  it('never returns a task whose blockers are still open', async () => {
    const res = await nextActions(sql, { available_minutes: 240, ignore_day_allocation: true });
    const titles = (res['actions'] as Array<{ title: string }>).map((a) => a.title);
    // Excluded, not down-ranked: suggesting work that cannot be started is the
    // fastest way to make the list untrustworthy.
    expect(titles).not.toContain('Price from the survey');
    expect(titles).toContain('Get the survey back');
    expect(res.confidence.notes.join(' ')).toContain('blockers are still open');
  });

  it('never returns a high-energy task when energy is low', async () => {
    const res = await nextActions(sql, {
      available_minutes: 240,
      energy: 'low',
      ignore_day_allocation: true,
    });
    const rows = res['actions'] as Array<{ title: string; energy: string }>;
    expect(rows.every((r) => r.energy === 'low')).toBe(true);
    expect(rows.map((r) => r.title)).not.toContain('Rebuild the tracking pipeline');
    // And it says why it is a hard filter rather than a preference.
    expect(res.confidence.notes.join(' ')).toContain('has to be redone');
  });

  it('allows a lower-energy task when energy is high', async () => {
    const res = await nextActions(sql, {
      available_minutes: 240,
      energy: 'high',
      ignore_day_allocation: true,
    });
    const titles = (res['actions'] as Array<{ title: string }>).map((a) => a.title);
    expect(titles).toContain('Rebuild the tracking pipeline');
  });
});

describe('the task that is bigger than the slot', () => {
  it('is returned anyway, marked partial, with a chunk', async () => {
    const res = await nextActions(sql, {
      available_minutes: 120,
      energy: 'high',
      ignore_day_allocation: true,
    });
    const big = (res['actions'] as Array<Record<string, unknown>>).find(
      (a) => a['title'] === 'Rebuild the tracking pipeline',
    );
    // The 720-minute item is the most important thing in the system. A size
    // filter would make it permanently invisible — the more it matters, the
    // bigger it is, the less it would ever be suggested.
    expect(big).toBeDefined();
    expect(big!['partial']).toBe(true);
    expect(big!['suggested_chunk_minutes']).toBe(120);
    expect(res.confidence.notes.join(' ')).toContain('permanently invisible');
  });
});

describe('context is a preference, not a filter', () => {
  it('prefers a matching context but still shows the rest', async () => {
    const res = await nextActions(sql, {
      available_minutes: 60,
      context: 'admin',
      ignore_day_allocation: true,
      limit: 5,
    });
    const rows = res['actions'] as Array<{ title: string; context: string }>;
    expect(rows[0]!.context).toBe('admin');
    // Mismatched context costs time, not quality, so it must not be excluded.
    expect(rows.length).toBeGreaterThan(1);
  });
});

describe('every action explains itself', () => {
  it('carries a one-line why', async () => {
    const res = await nextActions(sql, { available_minutes: 240, ignore_day_allocation: true });
    const rows = res['actions'] as Array<{ why: string; title: string }>;
    expect(rows.every((r) => r.why.length > 0)).toBe(true);
    const big = rows.find((r) => r.title === 'Rebuild the tracking pipeline');
    if (big) expect(big.why).toContain('Day 0');
  });
});

describe('day allocation', () => {
  beforeAll(async () => {
    await setDayAllocation(sql, {
      days: [
        { day_of_week: 0, venture: 'seatop' },
        { day_of_week: 1, venture: 'seatop' },
        { day_of_week: 2, venture: 'yachtyhub', flex_minutes: 90 },
        { day_of_week: 3, venture: 'seatop' },
        { day_of_week: 4, venture: 'yachtyhub' },
        { day_of_week: 5, venture: 'seatop' },
        { day_of_week: 6, is_working_day: false, note: 'not a working day' },
      ],
    });
  });

  it('reads back the weekly shape', async () => {
    const res = await getDayAllocation(sql, {});
    const days = res['days'] as Array<{ day: string; primary_venture: string | null }>;
    expect(days).toHaveLength(7);
    expect(days.find((d) => d.day === 'Tuesday')!.primary_venture).toBe('yachtyhub');
  });

  it('returns no work on a non-working day, and says so', async () => {
    const res = await nextActions(sql, { available_minutes: 120, date: SATURDAY });
    expect(res['actions']).toHaveLength(0);
    expect(res['is_working_day']).toBe(false);
    expect(res.confidence.notes.join(' ')).toContain('not a working day');
  });

  it('shows the primary venture, and other work marked as flex', async () => {
    const res = await nextActions(sql, { available_minutes: 60, date: TUESDAY, limit: 15 });
    const rows = res['actions'] as Array<{ title: string; venture: string; uses_flex?: boolean }>;
    const offPlan = rows.filter((r) => r.venture === 'seatop');
    expect(offPlan.length).toBeGreaterThan(0);
    // A rule with no give gets abandoned the first time it is inconvenient.
    expect(offPlan.every((r) => r.uses_flex === true)).toBe(true);
    expect(rows.filter((r) => r.venture === 'yachtyhub').every((r) => !r.uses_flex)).toBe(true);
  });

  it('reports the day and its remaining flex', async () => {
    const res = await nextActions(sql, { available_minutes: 60, date: TUESDAY });
    const day = res['day'] as { primary_venture: string; flex_left: number };
    expect(day.primary_venture).toBe('yachtyhub');
    expect(day.flex_left).toBe(90);
  });

  it('does not spend flex by being asked what to do', async () => {
    await nextActions(sql, { available_minutes: 60, date: TUESDAY });
    await nextActions(sql, { available_minutes: 60, date: TUESDAY });
    const res = await nextActions(sql, { available_minutes: 60, date: TUESDAY });
    // If asking spent the budget, the day would be gone before it began.
    expect((res['day'] as { flex_left: number }).flex_left).toBe(90);
    const rows = await sql`select * from day_flex_spent`;
    expect(rows).toHaveLength(0);
  });

  it('spends flex when off-plan work is closed', async () => {
    // The workspace's today is whatever it is; the allocation for that weekday
    // decides whether a close is off-plan, so set the whole week to yachtyhub
    // and close a seatop task.
    await setDayAllocation(sql, {
      days: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ day_of_week: d, venture: 'yachtyhub', flex_minutes: 90 })),
    });

    const id = await taskIdByTitle(sql, 'File the receipts');
    await close(sql, { task_id: id, actual_minutes: 25, idempotency_key: 'na-close-1' });

    const rows = await sql<Array<{ minutes: number }>>`select minutes from day_flex_spent`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.minutes).toBe(25);
  });

  it('does not spend flex when on-plan work is closed', async () => {
    const before = await sql`select task_id from day_flex_spent`;
    const id = await taskIdByTitle(sql, 'Reply to the marina');
    await close(sql, { task_id: id, actual_minutes: 15, idempotency_key: 'na-close-2' });
    const after = await sql`select task_id from day_flex_spent`;
    expect(after).toHaveLength(before.length);
  });
});

describe('capacity reports the ingredients, not only the rate', () => {
  it('returns the total and the horizon beside the weekly rate', async () => {
    const res = await capacity(sql, { available_hours: 28 });
    const hours = res['hours'] as Record<string, number>;
    expect(hours['required']).toBeDefined();
    // The rate is arithmetically right and hard to act on; these two are what a
    // person can actually reason about.
    expect(hours['required_hours_total']).toBeGreaterThan(0);
    expect(hours['horizon_days']).toBeGreaterThan(0);
    expect(hours['deficit_hours_total']).toBeGreaterThanOrEqual(0);
  });

  it('does not cap the rate at usable, because that would hide a real deficit', async () => {
    const res = await capacity(sql, { available_hours: 1 });
    const hours = res['hours'] as Record<string, number>;
    // Capping required at usable would drive the deficit to zero and report a
    // comfortable week during a fire.
    expect(hours['required']).toBeGreaterThan(hours['usable']!);
    expect(hours['deficit']).toBeGreaterThan(0);
  });

  it('gives each slip candidate a total as well as a rate', async () => {
    const res = await capacity(sql, { available_hours: 28 });
    const slips = res['slip_order'] as Array<Record<string, number>>;
    if (slips.length > 0) {
      expect(slips[0]!['hours_freed_total']).toBeDefined();
      expect(slips[0]!['hours_freed_per_week']).toBeDefined();
    }
  });
});
