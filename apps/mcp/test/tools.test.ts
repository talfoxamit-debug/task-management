import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkBearer, checkCredential } from '../src/auth.js';
import type { Sql } from '../src/db.js';
import {
  capacity,
  capture,
  close,
  commitTasks,
  listTasks,
  processInbox,
  setMilestone,
  setOutcomeTarget,
  ventureStatus,
} from '../src/tools.js';
import { ageSystem, freshDb, milestoneId, plantOldEvent, taskIdByTitle, type TestDb } from './harness.js';

let db: TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await freshDb('tools');
  sql = db.sql;
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe('bearer auth (Part 5: reject any request without it)', () => {
  it('fails closed when TASKOS_TOKEN is unset', () => {
    const saved = process.env['TASKOS_TOKEN'];
    delete process.env['TASKOS_TOKEN'];
    const r = checkBearer('Bearer anything');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(500);
    if (saved !== undefined) process.env['TASKOS_TOKEN'] = saved;
  });

  it('rejects a missing, malformed or wrong token', () => {
    process.env['TASKOS_TOKEN'] = 'correct-horse';
    expect(checkBearer(undefined).ok).toBe(false);
    expect(checkBearer('').ok).toBe(false);
    expect(checkBearer('correct-horse').ok).toBe(false); // no scheme
    expect(checkBearer('Basic correct-horse').ok).toBe(false);
    expect(checkBearer('Bearer wrong').ok).toBe(false);
    expect(checkBearer('Bearer correct-hors').ok).toBe(false); // prefix
    expect(checkBearer('Bearer correct-horsee').ok).toBe(false);
  });

  it('accepts the right token, case-insensitively on the scheme', () => {
    process.env['TASKOS_TOKEN'] = 'correct-horse';
    expect(checkBearer('Bearer correct-horse').ok).toBe(true);
    expect(checkBearer('bearer correct-horse').ok).toBe(true);
    expect(checkBearer('  Bearer   correct-horse  ').ok).toBe(true);
  });
});

describe('seed data is what Part 8 specifies', () => {
  it('has the five ventures with their weights and bounds', async () => {
    const rows = await sql<
      Array<{ slug: string; strategic_weight: string; floor_share: string; ceiling_share: string }>
    >`select slug, strategic_weight, floor_share, ceiling_share from ventures
       where slug <> 'unsorted' order by slug`;
    expect(rows.map((r) => r.slug)).toEqual([
      'foxsolutions',
      'octo',
      'seatop',
      'stackwrk',
      'yachtyhub',
    ]);
    const yh = rows.find((r) => r.slug === 'yachtyhub')!;
    expect(Number(yh.strategic_weight)).toBe(1.3);
    expect(Number(yh.floor_share)).toBe(0.1);
    expect(Number(yh.ceiling_share)).toBe(0.6);
    const octo = rows.find((r) => r.slug === 'octo')!;
    expect(Number(octo.strategic_weight)).toBe(0.5);
    expect(Number(octo.ceiling_share)).toBe(0.3);
  });

  it('has the three controllable milestones and no others', async () => {
    const rows = await sql<Array<{ name: string; due_date: string; hardness: string }>>`
      select name, due_date::text as due_date, hardness from milestones order by due_date`;
    expect(rows).toEqual([
      {
        name: 'Site sale-ready: contract, pricing, pages',
        due_date: '2026-08-08',
        hardness: 'soft',
      },
      { name: 'YachtyHub live', due_date: '2026-08-10', hardness: 'hard' },
      { name: 'Proposal delivered to warm lead', due_date: '2026-08-12', hardness: 'soft' },
    ]);
  });

  it('has the two outcome targets, linked to their milestones, and no tasks', async () => {
    const outcomes = await sql<Array<{ name: string; target_date: string }>>`
      select name, target_date::text as target_date from outcome_targets order by target_date`;
    expect(outcomes).toEqual([
      { name: 'First Stackwrk sale', target_date: '2026-08-15' },
      { name: 'First Seatop sale', target_date: '2026-08-31' },
    ]);
    const links = await sql<Array<{ n: string }>>`select count(*)::text as n from outcome_milestones`;
    expect(Number(links[0]!.n)).toBe(2);
    const tasks = await sql<Array<{ n: string }>>`select count(*)::text as n from tasks`;
    expect(Number(tasks[0]!.n)).toBe(0);
  });

  it('starts calibration inert for every context (D4)', async () => {
    const rows = await sql<Array<{ context: string; ratio: string; sample_n: number }>>`
      select context, ratio, sample_n from calibration`;
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => Number(r.ratio) === 1 && r.sample_n === 0)).toBe(true);
  });
});

describe('1. capture', () => {
  it('writes raw text to the inbox with no interpretation', async () => {
    const r = await capture(sql, { text: 'Call the marina about slip pricing' });
    expect(r.ok).toBe(true);
    const created = r['created'] as Array<{ id: string; title: string }>;
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe('Call the marina about slip pricing');

    const row = await sql<Array<{ status: string; venture_slug: string }>>`
      select t.status, v.slug as venture_slug from tasks t
        join ventures v on v.id = t.venture_id where t.id = ${created[0]!.id}`;
    expect(row[0]!.status).toBe('inbox');
    // Parked against the inactive holding venture, not guessed at.
    expect(row[0]!.venture_slug).toBe('unsorted');
    expect(r.confidence.notes.join(' ')).toContain('no interpretation');
  });

  it('splits lines and strips bullets, but parses nothing', async () => {
    const r = await capture(sql, {
      text: '- Wire Stripe live keys\n* Draft the MSA\n\n  Renew the insurance certificate  ',
    });
    const created = r['created'] as Array<{ title: string }>;
    expect(created.map((c) => c.title)).toEqual([
      'Wire Stripe live keys',
      'Draft the MSA',
      'Renew the insurance certificate',
    ]);
  });

  it('is idempotent: a repeat key returns the original and writes nothing (D3)', async () => {
    const before = await sql<Array<{ n: string }>>`select count(*)::text as n from tasks`;
    const first = await capture(sql, { text: 'Book the survey', idempotency_key: 'cap-1' });
    const mid = await sql<Array<{ n: string }>>`select count(*)::text as n from tasks`;
    const second = await capture(sql, { text: 'Book the survey', idempotency_key: 'cap-1' });
    const after = await sql<Array<{ n: string }>>`select count(*)::text as n from tasks`;

    expect(Number(mid[0]!.n)).toBe(Number(before[0]!.n) + 1);
    expect(Number(after[0]!.n)).toBe(Number(mid[0]!.n)); // nothing new
    expect(second['replayed']).toBe(true);
    expect(second['created']).toEqual(first['created']);
  });

  it('a different key with the same text does write again', async () => {
    const r = await capture(sql, { text: 'Book the survey', idempotency_key: 'cap-2' });
    expect(r['replayed']).toBeUndefined();
    expect((r['created'] as unknown[]).length).toBe(1);
  });

  it('reports an empty capture rather than pretending to succeed', async () => {
    const r = await capture(sql, { text: '   \n\n  ' });
    expect(r['total']).toBe(0);
    expect(r.confidence.notes.join(' ')).toContain('empty');
  });
});

describe('2. process_inbox', () => {
  it('proposes fields and writes nothing', async () => {
    const before = await sql<Array<{ n: string }>>`select count(*)::text as n from tasks`;
    const r = await processInbox(sql);
    const after = await sql<Array<{ n: string }>>`select count(*)::text as n from tasks`;
    expect(after[0]!.n).toBe(before[0]!.n);

    const proposals = r['proposals'] as Array<Record<string, any>>;
    expect(proposals.length).toBeGreaterThan(0);
    expect(r.confidence.notes.join(' ')).toContain('PROPOSALS');
    expect(r.confidence.notes.join(' ')).toContain('not a model');
  });

  it('proposes a venture from the words actually present, with the reason', async () => {
    const r = await processInbox(sql);
    const proposals = r['proposals'] as Array<Record<string, any>>;
    const marina = proposals.find((p) => p['text'].includes('marina'))!;
    expect(marina['venture'].value.slug).toBe('yachtyhub');
    expect(marina['venture'].reason).toContain('marina');
    expect(marina['context'].value).toBe('calls');
    expect(marina['context'].reason).toContain('Call');
  });

  it('proposes nothing rather than guessing when no venture is implied', async () => {
    const r = await processInbox(sql);
    const proposals = r['proposals'] as Array<Record<string, any>>;
    const insurance = proposals.find((p) => p['text'].includes('insurance'))!;
    expect(insurance['venture'].value).toBeNull();
    expect(insurance['venture'].certain).toBe(false);
    expect(insurance['context'].value).toBe('admin');
  });

  it('caps at 15 with a total (Part 5)', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `Inbox filler item ${i}`).join('\n');
    await capture(sql, { text: many });
    const r = await processInbox(sql);
    expect((r['proposals'] as unknown[]).length).toBe(15);
    expect(r['total'] as number).toBeGreaterThan(15);
    expect((r['truncated'] as { omitted: number }).omitted).toBeGreaterThan(0);
  });
});

describe('3. commit_tasks', () => {
  it('writes tasks and resolves dependency edges by title, in one transaction', async () => {
    const r = await commitTasks(sql, {
      tasks: [
        {
          title: 'Rebuild booking flow',
          venture: 'yachtyhub',
          milestone: 'YachtyHub live',
          criticality: 'blocking',
          context: 'deep_work',
          estimate_minutes: 1440,
          value: 9,
          blocks: ['Wire Stripe live keys and payout'],
        },
        {
          title: 'Wire Stripe live keys and payout',
          venture: 'yachtyhub',
          milestone: 'YachtyHub live',
          criticality: 'blocking',
          context: 'deep_work',
          estimate_minutes: 1080,
          value: 9,
          status: 'blocked',
        },
      ],
      idempotency_key: 'commit-1',
    });

    expect(r.ok).toBe(true);
    expect((r['created'] as unknown[]).length).toBe(2);
    expect((r['edges'] as unknown[]).length).toBe(1);

    const edges = await sql<Array<{ a: string; b: string }>>`
      select t1.title as a, t2.title as b from task_dependencies d
        join tasks t1 on t1.id = d.task_id join tasks t2 on t2.id = d.blocks_task_id`;
    expect(edges).toEqual([
      { a: 'Rebuild booking flow', b: 'Wire Stripe live keys and payout' },
    ]);
  });

  it('is idempotent (D3)', async () => {
    const again = await commitTasks(sql, {
      tasks: [{ title: 'Rebuild booking flow', venture: 'yachtyhub' }],
      idempotency_key: 'commit-1',
    });
    expect(again['replayed']).toBe(true);
    const count = await sql<Array<{ n: string }>>`
      select count(*)::text as n from tasks where title = 'Rebuild booking flow'`;
    expect(Number(count[0]!.n)).toBe(1);
  });

  it('resolves depends_on against tasks that already exist', async () => {
    const r = await commitTasks(sql, {
      tasks: [
        {
          title: 'Cut over DNS and announce',
          venture: 'yachtyhub',
          milestone: 'YachtyHub live',
          criticality: 'blocking',
          estimate_minutes: 1080,
          depends_on: ['Wire Stripe live keys and payout'],
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect((r['edges'] as Array<{ task_id: string }>).length).toBe(1);
  });

  it('rolls the whole batch back when the cycle trigger fires', async () => {
    const before = await sql<Array<{ n: string }>>`select count(*)::text as n from tasks`;
    const r = await commitTasks(sql, {
      tasks: [
        {
          title: 'Closes a loop',
          venture: 'yachtyhub',
          criticality: 'blocking',
          estimate_minutes: 60,
          // Depends on the last task in the chain while being blocked by the first.
          depends_on: ['Cut over DNS and announce'],
          blocks: ['Rebuild booking flow'],
        },
      ],
    });
    const after = await sql<Array<{ n: string }>>`select count(*)::text as n from tasks`;

    expect(r.ok).toBe(false);
    expect(r.errors?.[0]!.code).toBe('dependency_cycle');
    expect(r.errors?.[0]!.message).toContain('rolled back');
    expect(after[0]!.n).toBe(before[0]!.n); // the task itself is gone too
  });

  it('refuses an ambiguous title rather than wiring the wrong edge', async () => {
    await commitTasks(sql, {
      tasks: [
        { title: 'Ambiguous', venture: 'octo', estimate_minutes: 30 },
      ],
    });
    await commitTasks(sql, {
      tasks: [{ title: 'Ambiguous', venture: 'stackwrk', estimate_minutes: 30 }],
    });
    const r = await commitTasks(sql, {
      tasks: [
        {
          title: 'Points at both',
          venture: 'octo',
          estimate_minutes: 30,
          depends_on: ['Ambiguous'],
        },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]!.message).toContain('matches 2 open tasks');
  });

  it('refuses a title that matches nothing', async () => {
    const r = await commitTasks(sql, {
      tasks: [
        { title: 'Dangling', venture: 'octo', estimate_minutes: 30, depends_on: ['Nope'] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]!.message).toContain('matches no task');
  });

  it('refuses an unknown venture, project, milestone or person', async () => {
    const v = await commitTasks(sql, { tasks: [{ title: 'x', venture: 'nope' }] });
    expect(v.errors?.[0]!.message).toContain('does not exist');
    const m = await commitTasks(sql, {
      tasks: [{ title: 'y', venture: 'octo', milestone: 'not a milestone' }],
    });
    expect(m.errors?.[0]!.message).toContain('set_milestone first');
  });

  it('refuses a recurring task with no rule, as the schema requires', async () => {
    const r = await commitTasks(sql, {
      tasks: [{ title: 'Recurring but ruleless', venture: 'octo', is_recurring: true }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]!.message).toContain('recurrence_rule');
  });

  it('converts an inbox item in place instead of duplicating it', async () => {
    const inboxId = await taskIdByTitle(sql, 'Call the marina about slip pricing');
    const r = await commitTasks(sql, {
      tasks: [
        {
          title: 'Call the marina about slip pricing',
          venture: 'yachtyhub',
          from_inbox_task_id: inboxId,
          criticality: 'enabling',
          context: 'calls',
          estimate_minutes: 30,
          value: 6,
        },
      ],
    });
    expect(r.ok).toBe(true);
    const rows = await sql<Array<{ id: string; status: string; slug: string }>>`
      select t.id, t.status, v.slug from tasks t join ventures v on v.id = t.venture_id
       where t.title = 'Call the marina about slip pricing'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(inboxId);
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.slug).toBe('yachtyhub');
  });

  it('warns when a multi-task batch carries no dependency edges', async () => {
    const r = await commitTasks(sql, {
      tasks: [
        { title: 'Loose one', venture: 'octo', estimate_minutes: 30 },
        { title: 'Loose two', venture: 'octo', estimate_minutes: 30 },
      ],
    });
    expect(r.confidence.notes.join(' ')).toContain('coverage stays low');
  });
});

describe('4. set_milestone', () => {
  it('creates a milestone and marks it confirmed', async () => {
    const r = await setMilestone(sql, {
      venture: 'octo',
      name: 'Octo prototype demo',
      due_date: '2026-08-20',
      hardness: 'soft',
      cost_of_slip: 'low - internal only',
    });
    expect(r.ok).toBe(true);
    expect((r['milestone'] as { due_date: string }).due_date).toBe('2026-08-20');
    expect(r['updated']).toBe(false);
    expect(r.confidence.notes.join(' ')).toContain('drives demand');
  });

  it('updates in place on a second call with the same name', async () => {
    const r = await setMilestone(sql, {
      venture: 'octo',
      name: 'Octo prototype demo',
      due_date: '2026-09-01',
      hardness: 'hard',
      cost_of_slip: 'high - the investor call depends on it',
    });
    expect(r['updated']).toBe(true);
    const rows = await sql<Array<{ n: string }>>`
      select count(*)::text as n from milestones where name = 'Octo prototype demo'`;
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('warns when the due date is already in the past', async () => {
    const r = await setMilestone(sql, {
      venture: 'octo',
      name: 'Already gone',
      due_date: '2020-01-01',
      hardness: 'soft',
      cost_of_slip: 'low',
    });
    expect(r.confidence.notes.join(' ')).toContain('in the past');
  });

  it('refuses an unknown venture', async () => {
    const r = await setMilestone(sql, {
      venture: 'nope',
      name: 'x',
      due_date: '2026-08-01',
      hardness: 'soft',
      cost_of_slip: 'low',
    });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]!.code).toBe('missing_venture');
  });
});

describe('5. set_outcome_target (D1: never drives demand)', () => {
  it('creates an outcome target linked to the milestone believed to cause it', async () => {
    const mid = await milestoneId(sql, 'Octo prototype demo');
    const r = await setOutcomeTarget(sql, {
      venture: 'octo',
      name: 'First Octo pilot customer',
      target_date: '2026-10-01',
      milestone_ids: [mid],
    });
    expect(r.ok).toBe(true);
    expect(r['linked_milestones']).toEqual([mid]);
    expect(r.confidence.notes.join(' ')).toContain('drives NO demand');
    expect(r.confidence.notes.join(' ')).toContain('leading indicators');
  });

  it('reports milestone ids that do not exist instead of silently dropping them', async () => {
    const r = await setOutcomeTarget(sql, {
      venture: 'octo',
      name: 'First Octo pilot customer',
      milestone_ids: ['00000000-0000-0000-0000-000000000000'],
    });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]!.code).toBe('missing_milestone');
  });

  it('says so when nothing controllable is linked', async () => {
    const r = await setOutcomeTarget(sql, {
      venture: 'seatop',
      name: 'Referral from the first buyer',
      target_date: '2026-12-01',
    });
    expect(r.confidence.notes.join(' ')).toContain('nothing you control');
  });

  it('does not add to demand: an outcome target changes no capacity number', async () => {
    const before = await capacity(sql, { available_hours: 40 });
    await setOutcomeTarget(sql, {
      venture: 'yachtyhub',
      name: 'Ten paid bookings',
      target_date: '2026-09-30',
    });
    const after = await capacity(sql, { available_hours: 40 });
    expect((after['hours'] as { required: number }).required).toBe(
      (before['hours'] as { required: number }).required,
    );
    expect(after['shares']).toEqual(before['shares']);
  });
});

describe('6. capacity — the main tool', () => {
  it('answers the one question, with the full hours breakdown', async () => {
    const r = await capacity(sql, { available_hours: 40 });
    expect(r['question']).toContain('what is going to slip');
    const hours = r['hours'] as Record<string, number>;
    // The 20% buffer is applied after recurring overhead, before allocation (D9).
    expect(hours['buffer_ratio']).toBe(0.2);
    expect(hours['usable']).toBeCloseTo((40 - hours['recurring_overhead']!) * 0.8, 1);
    expect(['ok', 'deficit']).toContain(r['verdict']);
  });

  it('returns shares that sum to 1.0 across active ventures', async () => {
    const r = await capacity(sql, { available_hours: 40 });
    const shares = r['shares'] as Array<{ venture: string; share: number }>;
    expect(shares.some((s) => s.venture === 'unsorted')).toBe(false);
    const sum = shares.reduce((a, s) => a + s.share, 0);
    expect(Math.abs(sum - 1)).toBeLessThan
      ? expect(Math.abs(sum - 1)).toBeLessThan(0.01)
      : undefined;
  });

  it('ranks what to slip, cheapest first, with a running total', async () => {
    const r = await capacity(sql, { available_hours: 4 });
    expect(r['verdict']).toBe('deficit');
    const slip = r['slip_order'] as Array<{
      rank_to_slip: number;
      cumulative_hours_freed: number;
      hours_freed_per_week: number;
    }>;
    expect(slip.length).toBeGreaterThan(0);
    for (let i = 1; i < slip.length; i += 1) {
      expect(slip[i]!.cumulative_hours_freed).toBeGreaterThanOrEqual(
        slip[i - 1]!.cumulative_hours_freed,
      );
    }
    expect(r['protect_first']).toBeTruthy();
  });

  it('surfaces the D4 confidence object, cold-start notes and all', async () => {
    const r = await capacity(sql, { available_hours: 40 });
    expect(r.confidence.calibrated).toBe(false);
    expect(r.confidence.balancingActive).toBe(false);
    expect(r.confidence.notes.join(' ')).toContain('calibration not applied');
    expect(r.confidence.notes.join(' ')).toContain('balance corrector disabled');
    expect(Object.keys(r.confidence.coverageByMilestone).length).toBeGreaterThan(0);
  });

  it('names a milestone whose dependency coverage is too low to trust', async () => {
    // Five blockers on the Stackwrk milestone, none of them wired to each other:
    // coverage 0/5, well under the 60% threshold.
    await commitTasks(sql, {
      tasks: [1, 2, 3, 4, 5].map((i) => ({
        title: `Sale-ready blocker ${i}`,
        venture: 'stackwrk',
        milestone: 'Site sale-ready: contract, pricing, pages',
        criticality: 'blocking' as const,
        estimate_minutes: 240,
      })),
    });

    const r = await capacity(sql, { available_hours: 40 });
    const notes = r.confidence.notes.join(' ');
    expect(notes).toContain('below the 60% threshold');
    expect(notes).toContain('did not feed demand');
    expect(notes).toContain('0 of 5 blockers wired up');

    const mid = await milestoneId(sql, 'Site sale-ready: contract, pricing, pages');
    expect(r.confidence.coverageByMilestone[mid]).toBe(0);
  });

  it('expires a past-due milestone before computing, and says it did', async () => {
    await setMilestone(sql, {
      venture: 'seatop',
      name: 'Expired on purpose',
      due_date: '2020-06-01',
      hardness: 'soft',
      cost_of_slip: 'low',
    });
    const r = await capacity(sql, { available_hours: 40 });
    expect(r.confidence.notes.join(' ')).toContain('flipped to missed');
    const rows = await sql<Array<{ status: string }>>`
      select status from milestones where name = 'Expired on purpose'`;
    expect(rows[0]!.status).toBe('missed');
  });

  it('reports a surplus when the hours are there', async () => {
    const r = await capacity(sql, { available_hours: 500 });
    expect(r['verdict']).toBe('ok');
    expect((r['hours'] as { surplus: number }).surplus).toBeGreaterThan(0);
    expect(r['deficit_closes_after_slipping']).toBeNull();
  });

  it('handles zero available hours without dividing by anything', async () => {
    const r = await capacity(sql, { available_hours: 0 });
    expect(r['verdict']).toBe('deficit');
    expect((r['hours'] as { usable: number }).usable).toBe(0);
  });
});

describe('7. venture_status', () => {
  it('reports milestones with slack and coverage, and the top tasks', async () => {
    const r = await ventureStatus(sql, { slug: 'yachtyhub' });
    expect(r.ok).toBe(true);
    const v = r['venture'] as { slug: string; share: number };
    expect(v.slug).toBe('yachtyhub');

    const milestones = r['milestones'] as Array<Record<string, unknown>>;
    const live = milestones.find((m) => m['milestone'] === 'YachtyHub live')!;
    expect(live['coverage']).not.toBeNull();
    expect(typeof live['days_until_due']).toBe('number');

    const top = r['top_tasks'] as Array<{ score: number; why: unknown }>;
    expect(top.length).toBeGreaterThan(0);
    expect(top[0]!.why).toBeTruthy();
    for (let i = 1; i < top.length; i += 1) {
      expect(top[i - 1]!.score).toBeGreaterThanOrEqual(top[i]!.score);
    }
    expect(top.length).toBeLessThanOrEqual(5);
  });

  it('orders blocking tasks by slack, tightest first', async () => {
    const r = await ventureStatus(sql, { slug: 'yachtyhub' });
    const blocking = r['blocking_tasks'] as Array<{ slack_days: number | null }>;
    const withSlack = blocking.filter((b) => b.slack_days !== null).map((b) => b.slack_days!);
    for (let i = 1; i < withSlack.length; i += 1) {
      expect(withSlack[i - 1]!).toBeLessThanOrEqual(withSlack[i]!);
    }
  });

  it('explains a null slack rather than leaving a blank', async () => {
    const r = await ventureStatus(sql, { slug: 'octo' });
    const blocking = r['blocking_tasks'] as Array<{
      slack_days: number | null;
      slack_unknown_because: string | null;
    }>;
    for (const b of blocking) {
      if (b.slack_days === null) expect(b.slack_unknown_because).toBeTruthy();
    }
  });

  it('reports outcome indicators as unrecorded rather than zero', async () => {
    const r = await ventureStatus(sql, { slug: 'stackwrk' });
    const outcomes = r['outcome_targets'] as Array<{
      outcome: string;
      indicators: Record<string, number | null>;
      caused_by_milestones: string[];
      note: string;
    }>;
    const sale = outcomes.find((o) => o.outcome === 'First Stackwrk sale')!;
    expect(sale.caused_by_milestones).toContain('Site sale-ready: contract, pricing, pages');
    expect(Object.keys(sale.indicators)).toContain('proposals_sent');
    expect(sale.indicators['proposals_sent']).toBeNull();
    expect(sale.note).toContain('drives no demand');
    expect(sale.note).toContain('not that the answer is zero');
  });

  it('refuses an unknown slug and lists the real ones', async () => {
    const r = await ventureStatus(sql, { slug: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.confidence.notes.join(' ')).toContain('yachtyhub');
  });
});

describe('8. list_tasks', () => {
  it('caps at 15 and reports the true total', async () => {
    const r = await listTasks(sql, {});
    expect((r['tasks'] as unknown[]).length).toBeLessThanOrEqual(15);
    expect(r['cap']).toBe(15);
    if ((r['total'] as number) > 15) {
      expect((r['truncated'] as { omitted: number }).omitted).toBeGreaterThan(0);
    }
  });

  it('filters by venture, status and criticality', async () => {
    const byVenture = await listTasks(sql, { venture: 'yachtyhub' });
    expect(
      (byVenture['tasks'] as Array<{ venture: string }>).every((t) => t.venture === 'yachtyhub'),
    ).toBe(true);

    const blocked = await listTasks(sql, { status: 'blocked' });
    expect(
      (blocked['tasks'] as Array<{ status: string }>).every((t) => t.status === 'blocked'),
    ).toBe(true);

    const blocking = await listTasks(sql, { criticality: 'blocking' });
    expect(
      (blocking['tasks'] as Array<{ criticality: string }>).every(
        (t) => t.criticality === 'blocking',
      ),
    ).toBe(true);
  });

  it('lists nothing twice', async () => {
    const r = await listTasks(sql, {});
    const ids = (r['tasks'] as Array<{ task_id: string }>).map((t) => t.task_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('finds work snoozed past the triage threshold', async () => {
    const id = await taskIdByTitle(sql, 'Loose one');
    await sql`update tasks set snooze_count = 3, snooze_reason = 'keeps sliding' where id = ${id}`;
    const r = await listTasks(sql, { needs_triage: true });
    const ids = (r['tasks'] as Array<{ task_id: string; needs_triage: boolean }>);
    expect(ids.some((t) => t.task_id === id)).toBe(true);
    expect(ids.every((t) => t.needs_triage)).toBe(true);
    expect(r.confidence.notes.join(' ')).toContain('need a decision');
  });

  it('says the filter is the reason for an empty list, not an empty system', async () => {
    const r = await listTasks(sql, { venture: 'octo', criticality: 'blocking', status: 'waiting' });
    expect(r['total']).toBe(0);
    expect(r.confidence.notes.join(' ')).toContain('the filter is the reason');
  });

  it('hides closed work unless it is asked for by status', async () => {
    const plain = await listTasks(sql, {});
    expect(
      (plain['tasks'] as Array<{ status: string }>).some(
        (t) => t.status === 'done' || t.status === 'killed',
      ),
    ).toBe(false);
  });
});

describe('9. close (D6 actual-time capture)', () => {
  it('records the estimate as a provisional actual when nothing was volunteered', async () => {
    const id = await taskIdByTitle(sql, 'Loose two');
    const r = await close(sql, { task_id: id });
    expect(r.ok).toBe(true);
    expect(r['actual_inferred']).toBe(true);
    expect(r.confidence.notes.join(' ')).toContain('will NOT feed calibration');

    const rows = await sql<Array<{ actual_minutes: number; actual_inferred: boolean; status: string }>>`
      select actual_minutes, actual_inferred, status from tasks where id = ${id}`;
    expect(rows[0]!.status).toBe('done');
    expect(rows[0]!.actual_inferred).toBe(true);
    expect(rows[0]!.actual_minutes).toBe(30);
  });

  it('records a volunteered duration as a measurement and feeds calibration', async () => {
    const id = await taskIdByTitle(sql, 'Ambiguous');
    const r = await close(sql, { task_id: id, actual_minutes: 45 });
    expect(r['actual_inferred']).toBe(false);
    const cal = r['calibration'] as { ratio: number; sample_n: number };
    expect(cal.sample_n).toBe(1);
    expect(cal.ratio).toBeCloseTo(45 / 30, 6);
    // Below 8 samples it is recorded but not applied (D4).
    expect(r.confidence.notes.join(' ')).toContain('fewer than 8 samples');
  });

  it('leaves calibration untouched for an inferred close', async () => {
    const before = await sql<Array<{ sample_n: number }>>`
      select sample_n from calibration where context = 'deep_work'`;
    const id = await taskIdByTitle(sql, 'Cut over DNS and announce');
    await close(sql, { task_id: id });
    const after = await sql<Array<{ sample_n: number }>>`
      select sample_n from calibration where context = 'deep_work'`;
    expect(after[0]!.sample_n).toBe(before[0]!.sample_n);
  });

  it('succeeds and mutates nothing on an already-closed task (D3)', async () => {
    const id = await taskIdByTitle(sql, 'Loose two');
    const first = await sql<Array<{ actual_minutes: number }>>`
      select actual_minutes from tasks where id = ${id}`;
    const r = await close(sql, { task_id: id, actual_minutes: 999 });
    expect(r.ok).toBe(true);
    expect(r['mutated']).toBe(false);
    const second = await sql<Array<{ actual_minutes: number }>>`
      select actual_minutes from tasks where id = ${id}`;
    expect(second[0]!.actual_minutes).toBe(first[0]!.actual_minutes);
  });

  it('is idempotent by key', async () => {
    const made = await commitTasks(sql, {
      tasks: [{ title: 'Closed twice by key', venture: 'octo', estimate_minutes: 30 }],
    });
    const id = (made['created'] as Array<{ id: string }>)[0]!.id;
    const a = await close(sql, { task_id: id, actual_minutes: 20, idempotency_key: 'close-1' });
    const b = await close(sql, { task_id: id, actual_minutes: 20, idempotency_key: 'close-1' });
    expect(b['replayed']).toBe(true);
    expect(b['closed']).toEqual(a['closed']);
  });

  it('asks about exactly one completed task, at most once a day (D6)', async () => {
    // The earlier closes already used today's single question.
    const asked = await sql<Array<{ n: string }>>`
      select count(*)::text as n from events where verb = 'asked_actual'`;
    expect(Number(asked[0]!.n)).toBe(1);

    const created = await commitTasks(sql, {
      tasks: [{ title: 'Another to close', venture: 'octo', estimate_minutes: 30 }],
    });
    const newId = (created['created'] as Array<{ id: string }>)[0]!.id;
    const r = await close(sql, { task_id: newId });
    expect(r['ask_about']).toBeNull();

    const stillOne = await sql<Array<{ n: string }>>`
      select count(*)::text as n from events where verb = 'asked_actual'`;
    expect(Number(stillOne[0]!.n)).toBe(1);
  });

  it('records evidence when given', async () => {
    const created = await commitTasks(sql, {
      tasks: [{ title: 'With evidence', venture: 'octo', estimate_minutes: 30 }],
    });
    const id = (created['created'] as Array<{ id: string }>)[0]!.id;
    await close(sql, { task_id: id, evidence: 'https://example.com/pr/1' });
    const rows = await sql<Array<{ payload: { evidence: string } }>>`
      select payload from events where verb = 'evidence' and task_id = ${id}`;
    expect(rows[0]!.payload.evidence).toBe('https://example.com/pr/1');
  });

  it('reports a task that does not exist', async () => {
    const r = await close(sql, { task_id: '00000000-0000-0000-0000-000000000000' });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]!.message).toContain('does not exist');
  });

  it('fires auto-unblock through the trigger, not application code', async () => {
    const blockerId = await taskIdByTitle(sql, 'Rebuild booking flow');
    const dependentId = await taskIdByTitle(sql, 'Wire Stripe live keys and payout');
    const before = await sql<Array<{ status: string }>>`
      select status from tasks where id = ${dependentId}`;
    expect(before[0]!.status).toBe('blocked');

    await close(sql, { task_id: blockerId });

    const after = await sql<Array<{ status: string }>>`
      select status from tasks where id = ${dependentId}`;
    expect(after[0]!.status).toBe('active');
  });
});

describe('the D4 cold-start gates open on schedule', () => {
  it('turns the balance corrector on once 14 days of events exist', async () => {
    const cold = await capacity(sql, { available_hours: 40 });
    expect(cold.confidence.balancingActive).toBe(false);

    await plantOldEvent(sql, 15);
    const warm = await capacity(sql, { available_hours: 40 });
    expect(warm.confidence.balancingActive).toBe(true);
    expect(warm.confidence.notes.join(' ')).not.toContain('balance corrector disabled');
  });

  it('holds attention debt until day 21', async () => {
    await sql`update ventures set attention_debt_hours = 5 where slug = 'octo'`;
    await ageSystem(sql, 10);
    const early = await ventureStatus(sql, { slug: 'octo' });
    expect(early.confidence.notes.join(' ')).toContain('cannot be released until day 21');

    await ageSystem(sql, 25);
    const later = await ventureStatus(sql, { slug: 'octo' });
    expect(later.confidence.notes.join(' ')).not.toContain('cannot be released until day 21');
  });
});
