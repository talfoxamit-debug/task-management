import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDayPlan, setWorkHours } from '../src/day-plan.js';
import { commitTasks, setMilestone } from '../src/tools.js';
import { createPerson } from '../src/registry.js';
import { markPrepared } from '../src/edit.js';
import { setDayAllocation } from '../src/next-actions.js';
import type { Sql } from '../src/db.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * The day laid into hours.
 *
 * TaskOS said from V1 that it does not schedule, and this is that rule being
 * changed deliberately rather than drifting. What must NOT change is where the
 * numbers come from, so the assertions here are mostly about the plan refusing
 * to invent: no hours on record means no plan, not a guessed nine-to-five; a
 * task that did not fit is reported, not dropped; and a slot booked at review
 * length says out loud that the draft has to exist first.
 *
 * The one genuinely new capability is chaining. next_actions excludes anything
 * with an open blocker, which is right for "what can I start now" and useless
 * for a plan — the answer wanted is "A at 09:00, then B, because A is what
 * unblocks it".
 */

let db: TestDb;
let sql: Sql;
let today: string;

beforeAll(async () => {
  db = await freshDb('dayplan');
  sql = db.sql;

  await sql`update settings set default_weekly_hours = 28, buffer_ratio = 0.2`;
  const rows = await sql<Array<{ d: string }>>`
    select taskos_today((select id from workspaces limit 1))::text as d`;
  today = rows[0]!.d;

  const dow = await sql<Array<{ d: number }>>`select extract(dow from ${today}::date)::int as d`;
  await setDayAllocation(sql, {
    days: [{ day_of_week: dow[0]!.d, venture: 'seatop', flex_minutes: 90 }],
  });

  await createPerson(sql, { name: 'Othman', hours_per_week: 40 });

  await commitTasks(sql, {
    tasks: [
      {
        title: 'Write the Lisa proposal',
        venture: 'seatop',
        estimate_minutes: 120,
        value: 9,
        criticality: 'blocking',
        ai_preparable: true,
        review_minutes: 20,
      },
      {
        title: 'Send the Lisa proposal',
        venture: 'seatop',
        estimate_minutes: 15,
        value: 9,
        criticality: 'blocking',
        depends_on: ['Write the Lisa proposal'],
      },
      { title: 'Reconcile the July invoices', venture: 'seatop', estimate_minutes: 60, value: 4 },
      { title: 'Rebuild the nav', venture: 'seatop', estimate_minutes: 300, value: 3 },
      // Deliberately more than a day, so the plan has something it cannot place
      // and has to say so.
      { title: 'Migrate the booking database', venture: 'seatop', estimate_minutes: 600, value: 2 },
      {
        title: 'Othman does this one',
        venture: 'seatop',
        assignee: 'Othman',
        estimate_minutes: 60,
        value: 10,
      },
    ],
    idempotency_key: 'plan-seed',
  });

  await setMilestone(sql, {
    venture: 'seatop',
    name: 'Lisa signs the contract',
    due_date: today,
    hardness: 'hard',
    cost_of_slip: 'critical: the deal moves a quarter',
  });
});

afterAll(async () => {
  await db.drop();
});

describe('without hours on record', () => {
  it('refuses to guess a working day', async () => {
    const plan = await buildDayPlan(sql, { date: today });
    expect(plan.window).toBeNull();
    expect(plan.slots).toHaveLength(0);
    // Assuming nine-to-five for 28 usable hours across six days would put work
    // in hours that are not worked and make every start time silently wrong.
    expect(plan.notes.join(' ')).toContain('not on record');
    expect(plan.notes.join(' ')).toContain('set_work_hours');
  });
});

describe('with hours on record', () => {
  beforeAll(async () => {
    await setWorkHours(sql, { start_hour: 9, end_hour: 18 });
  });

  it('lays tasks into real clock times that do not overlap', async () => {
    const plan = await buildDayPlan(sql, { date: today });
    expect(plan.window).toEqual({ start_hour: 9, end_hour: 18 });
    expect(plan.slots.length).toBeGreaterThan(1);
    expect(plan.slots[0]!.start).toBe('09:00');

    for (let i = 1; i < plan.slots.length; i += 1) {
      expect(plan.slots[i]!.start).toBe(plan.slots[i - 1]!.end);
    }
    for (const s of plan.slots) expect(s.start < s.end).toBe(true);
  });

  it('CHAINS dependent work inside the day rather than hiding it', async () => {
    const plan = await buildDayPlan(sql, { date: today });
    const titles = plan.slots.map((s) => s.title);
    const write = titles.indexOf('Write the Lisa proposal');
    const send = titles.indexOf('Send the Lisa proposal');

    expect(write).toBeGreaterThanOrEqual(0);
    // next_actions would have excluded this entirely: its blocker is open.
    // In a plan, a blocker scheduled earlier today is not an obstacle, it is
    // the previous slot.
    expect(send).toBeGreaterThan(write);
    expect(plan.slots[send]!.after).toContain('Write the Lisa proposal');
  });

  it('books an AI-preparable task at REVIEW length, and says the draft must exist', async () => {
    const plan = await buildDayPlan(sql, { date: today });
    const slot = plan.slots.find((s) => s.title === 'Write the Lisa proposal')!;
    // 120 minutes of building becomes 20 minutes of reviewing. Booking the full
    // build would reserve hours that are not going to be spent.
    expect(slot.ai_can_prepare).toBe(true);
    expect(slot.minutes).toBe(30); // 20 min, rounded up to the quarter hour
    expect(plan.to_prepare.map((t) => t.title)).toContain('Write the Lisa proposal');
    expect(plan.to_prepare[0]!.by).toBe(slot.start);
    expect(plan.notes.join(' ')).toContain('only honest if the drafting actually happens');
  });

  it('costs a task Claude ALREADY drafted at its review too', async () => {
    await markPrepared(sql, {
      task_id: await taskIdByTitle(sql, 'Reconcile the July invoices'),
      summary: 'Matched 41 of 43 lines',
      review_minutes: 10,
    });
    const plan = await buildDayPlan(sql, { date: today });
    const slot = plan.slots.find((s) => s.title === 'Reconcile the July invoices')!;
    expect(slot.review_of_draft).toBe(true);
    expect(slot.minutes).toBeLessThan(60);
    expect(slot.why).toContain('Matched 41 of 43 lines');
  });

  it('never puts somebody else\'s work in Tal\'s day', async () => {
    const plan = await buildDayPlan(sql, { date: today });
    // It has the highest value in the set, so only the assignee check keeps it
    // out. It belongs in the delegated section, which is a different question.
    expect(plan.slots.map((s) => s.title)).not.toContain('Othman does this one');
  });

  it('reports what did not fit, and why, rather than going quiet', async () => {
    const plan = await buildDayPlan(sql, { date: today });
    expect(plan.unplaced.length).toBeGreaterThan(0);
    const reasons = plan.unplaced.map((u) => u.reason).join(' ');
    expect(reasons).toMatch(/no room left|waiting on/);
    // Silence here would read as "that was everything".
    expect(plan.notes.join(' ')).toContain('unplaced');
  });

  it('leaves the buffer unspent instead of filling the window', async () => {
    const plan = await buildDayPlan(sql, { date: today });
    const placed = plan.slots.reduce((s, x) => s + x.minutes, 0);
    // 9 hours of window, 20% buffer: a plan that fills every minute reads as a
    // failure by 11am.
    expect(placed).toBeLessThanOrEqual(9 * 60 * 0.8 + 15);
  });

  it('states how much of the day it actually placed', async () => {
    const plan = await buildDayPlan(sql, { date: today });
    expect(plan.notes.join(' ')).toMatch(/\dh placed of \d/);
  });
});

describe('the window itself', () => {
  it('takes a per-weekday override without disturbing the default', async () => {
    const dow = await sql<Array<{ d: number }>>`select extract(dow from ${today}::date)::int as d`;
    await setWorkHours(sql, { start_hour: 11, end_hour: 16, day_of_week: dow[0]!.d });
    const plan = await buildDayPlan(sql, { date: today });
    expect(plan.window).toEqual({ start_hour: 11, end_hour: 16 });
    expect(plan.slots[0]!.start).toBe('11:00');

    const settings = await sql<Array<{ h: number }>>`
      select work_start_hour as h from settings`;
    expect(settings[0]!.h).toBe(9);
  });

  it('refuses a window that ends before it starts', async () => {
    const res = await setWorkHours(sql, { start_hour: 18, end_hour: 9 });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.message).toContain('nothing was written');
  });

  it('sends no plan at all on a non-working day', async () => {
    const dow = await sql<Array<{ d: number }>>`select extract(dow from ${today}::date)::int as d`;
    await setDayAllocation(sql, { days: [{ day_of_week: dow[0]!.d, is_working_day: false }] });
    const plan = await buildDayPlan(sql, { date: today });
    expect(plan.working).toBe(false);
    expect(plan.slots).toHaveLength(0);
  });
});
