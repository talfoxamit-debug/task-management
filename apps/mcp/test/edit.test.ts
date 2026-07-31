import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/db.js';
import { closeMany, killTask, reopenTask, snoozeTask, updateTask } from '../src/edit.js';
import {
  createPerson,
  deleteMilestone,
  deleteOutcomeTarget,
  listMilestones,
  listPeople,
  listVentures,
  setVenture,
} from '../src/registry.js';
import { capacity, close, commitTasks, listTasks, setMilestone } from '../src/tools.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * Correction, and the ability to enumerate what exists.
 *
 * These are the acceptance criteria from the gap spec, one test each. The
 * theme running through them: a system that can create and complete but not
 * correct makes every mistake permanent, and stops being trusted the first time
 * one is made.
 */

let db: TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await freshDb('edit');
  sql = db.sql;
  await commitTasks(sql, {
    tasks: [
      {
        title: 'Wire the listings import',
        venture: 'yachtyhub',
        estimate_minutes: 120,
        value: 8,
        criticality: 'blocking',
        context: 'deep_work',
        notes: 'original notes',
        deadline_date: '2026-09-01',
      },
      {
        title: 'Weekly capoeira',
        venture: 'yachtyhub',
        estimate_minutes: 90,
        is_recurring: true,
        recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      },
      { title: 'A mistake', venture: 'yachtyhub', estimate_minutes: 30 },
      { title: 'Closed by accident', venture: 'yachtyhub', estimate_minutes: 45 },
      { title: 'Keeps getting pushed', venture: 'yachtyhub', estimate_minutes: 60 },
    ],
    idempotency_key: 'edit-seed',
  });
});

afterAll(async () => {
  await db.drop();
});

describe('update_task', () => {
  it('changes one field and leaves every other field identical', async () => {
    const id = await taskIdByTitle(sql, 'Wire the listings import');
    const before = await sql<Array<Record<string, unknown>>>`select * from tasks where id = ${id}`;

    const res = await updateTask(sql, { task_id: id, estimate_minutes: 240 });
    expect(res.ok).toBe(true);

    const after = await sql<Array<Record<string, unknown>>>`select * from tasks where id = ${id}`;
    const ignored = new Set(['estimate_minutes', 'last_touched_at']);
    for (const key of Object.keys(before[0]!)) {
      if (ignored.has(key)) continue;
      expect(String(after[0]![key]), `${key} should not have changed`).toBe(
        String(before[0]![key]),
      );
    }
    expect(after[0]!['estimate_minutes']).toBe(240);
  });

  it('returns the whole task, so no second read is needed', async () => {
    const id = await taskIdByTitle(sql, 'Wire the listings import');
    const res = await updateTask(sql, { task_id: id, value: 9 });
    const task = res['task'] as { value: number; title: string; venture: string };
    expect(task.value).toBe(9);
    expect(task.title).toBe('Wire the listings import');
    expect(task.venture).toBe('yachtyhub');
  });

  it('clears a nullable field on explicit null, and leaves it alone when absent', async () => {
    const id = await taskIdByTitle(sql, 'Wire the listings import');

    // Absent: untouched.
    await updateTask(sql, { task_id: id, value: 7 });
    let row = await sql<Array<{ d: string | null }>>`
      select deadline_date::text as d from tasks where id = ${id}`;
    expect(row[0]!.d).toBe('2026-09-01');

    // Explicit null: cleared. This distinction is the whole point — without it
    // a deadline could never be removed without rewriting the task.
    await updateTask(sql, { task_id: id, deadline_date: null });
    row = await sql<Array<{ d: string | null }>>`
      select deadline_date::text as d from tasks where id = ${id}`;
    expect(row[0]!.d).toBeNull();
  });

  it('changing a recurring estimate changes recurring overhead on the next capacity call', async () => {
    const before = await capacity(sql, { available_hours: 40 });
    const overheadBefore = (before['hours'] as { recurring_overhead: number }).recurring_overhead;

    const id = await taskIdByTitle(sql, 'Weekly capoeira');
    await updateTask(sql, { task_id: id, estimate_minutes: 30 });

    const after = await capacity(sql, { available_hours: 40 });
    const overheadAfter = (after['hours'] as { recurring_overhead: number }).recurring_overhead;
    expect(overheadAfter).toBeLessThan(overheadBefore);
  });

  it('turning recurrence off takes the rule with it', async () => {
    const id = await taskIdByTitle(sql, 'Weekly capoeira');
    await updateTask(sql, { task_id: id, is_recurring: false });
    const row = await sql<Array<{ is_recurring: boolean; recurrence_rule: string | null }>>`
      select is_recurring, recurrence_rule from tasks where id = ${id}`;
    // A rule left behind on a non-recurring task is a lie the next reader
    // believes, and the schema constraint would not catch it.
    expect(row[0]!.is_recurring).toBe(false);
    expect(row[0]!.recurrence_rule).toBeNull();
  });

  it('refuses recurrence with no rule, and writes nothing', async () => {
    const id = await taskIdByTitle(sql, 'Weekly capoeira');
    const res = await updateTask(sql, { task_id: id, is_recurring: true });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.message).toContain('nothing was written');
    const row = await sql<Array<{ is_recurring: boolean }>>`
      select is_recurring from tasks where id = ${id}`;
    expect(row[0]!.is_recurring).toBe(false);
  });

  it('names the offending value and writes nothing on an unknown venture', async () => {
    const id = await taskIdByTitle(sql, 'A mistake');
    const res = await updateTask(sql, { task_id: id, venture: 'nope', value: 1 });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.message).toBe('venture "nope" does not exist — nothing was written');
    const row = await sql<Array<{ value: number }>>`select value from tasks where id = ${id}`;
    expect(row[0]!.value).toBe(5);
  });

  it('replays an idempotency key', async () => {
    const id = await taskIdByTitle(sql, 'A mistake');
    await updateTask(sql, { task_id: id, value: 3, idempotency_key: 'upd-1' });
    const again = await updateTask(sql, { task_id: id, value: 9, idempotency_key: 'upd-1' });
    expect(again['replayed']).toBe(true);
    const row = await sql<Array<{ value: number }>>`select value from tasks where id = ${id}`;
    expect(row[0]!.value).toBe(3);
  });
});

describe('kill_task', () => {
  it('removes the task from capacity demand entirely', async () => {
    const id = await taskIdByTitle(sql, 'A mistake');
    await updateTask(sql, { task_id: id, milestone: 'YachtyHub live', criticality: 'blocking' });

    const before = await capacity(sql, { available_hours: 40 });
    await killTask(sql, { task_id: id, reason: 'never real work' });
    const after = await capacity(sql, { available_hours: 40 });

    const req = (r: typeof before) => (r['hours'] as { required: number }).required;
    expect(req(after)).toBeLessThanOrEqual(req(before));

    const listed = await listTasks(sql, { status: 'active' });
    const titles = (listed['tasks'] as Array<{ title: string }>).map((t) => t.title);
    expect(titles).not.toContain('A mistake');
  });

  it('never feeds calibration', async () => {
    const id = await taskIdByTitle(sql, 'A mistake');
    const row = await sql<Array<{ actual_minutes: number | null; status: string }>>`
      select actual_minutes, status from tasks where id = ${id}`;
    // close() records a duration and teaches the estimator. kill must not,
    // because the work never happened.
    expect(row[0]!.status).toBe('killed');
    expect(row[0]!.actual_minutes).toBeNull();
  });

  it('is idempotent', async () => {
    const id = await taskIdByTitle(sql, 'A mistake');
    const again = await killTask(sql, { task_id: id });
    expect(again['mutated']).toBe(false);
  });
});

describe('reopen_task', () => {
  it('clears the recorded actual so a mistaken close stops teaching calibration', async () => {
    const id = await taskIdByTitle(sql, 'Closed by accident');
    await close(sql, { task_id: id, actual_minutes: 300 });

    const res = await reopenTask(sql, { task_id: id });
    expect(res.ok).toBe(true);
    const row = await sql<Array<{ status: string; actual_minutes: number | null }>>`
      select status, actual_minutes from tasks where id = ${id}`;
    expect(row[0]!.status).toBe('active');
    expect(row[0]!.actual_minutes).toBeNull();
  });
});

describe('snooze_task', () => {
  it('increments the counter that drives triage, which nothing could reach before', async () => {
    const id = await taskIdByTitle(sql, 'Keeps getting pushed');
    await snoozeTask(sql, { task_id: id, days: 3, reason: 'waiting on Othman' });
    await snoozeTask(sql, { task_id: id, days: 3 });
    const third = await snoozeTask(sql, { task_id: id, days: 3 });

    expect(third['snooze_count']).toBe(3);
    expect(third['needs_triage']).toBe(true);
    expect(third.confidence.notes.join(' ')).toContain('needs a decision');

    const triage = await listTasks(sql, { needs_triage: true });
    expect((triage['tasks'] as Array<{ title: string }>).map((t) => t.title)).toContain(
      'Keeps getting pushed',
    );
  });

  it('records where it was pushed to', async () => {
    const id = await taskIdByTitle(sql, 'Keeps getting pushed');
    await snoozeTask(sql, { task_id: id, until: '2026-12-01' });
    const row = await sql<Array<{ d: string }>>`
      select snoozed_until::text as d from tasks where id = ${id}`;
    expect(row[0]!.d).toBe('2026-12-01');
  });
});

describe('people', () => {
  it('makes the assignee field usable at all', async () => {
    const made = await createPerson(sql, { name: 'Saar', role: 'ops', hours_per_week: 8 });
    expect(made.ok).toBe(true);

    // Before create_person existed, commit_tasks correctly refused every
    // assignee and there was no way to satisfy it.
    const res = await commitTasks(sql, {
      tasks: [{ title: 'Delegated thing', venture: 'yachtyhub', assignee: 'Saar' }],
      idempotency_key: 'delegated-1',
    });
    expect(res.ok).toBe(true);

    const row = await sql<Array<{ name: string }>>`
      select p.name from tasks t join people p on p.id = t.assignee_person_id
       where t.title = 'Delegated thing'`;
    expect(row[0]!.name).toBe('Saar');
  });

  it('reports how loaded each person is', async () => {
    await createPerson(sql, { name: 'Othman', hours_per_week: 40 });
    const res = await listPeople(sql, {});
    const people = res['people'] as Array<{ name: string; hours_per_week: number | null; assigned_hours: number }>;
    const saar = people.find((p) => p.name === 'Saar')!;
    expect(saar.hours_per_week).toBe(8);
    expect(saar.assigned_hours).toBeGreaterThan(0);
  });

  it('updates rather than duplicating on the same name', async () => {
    await createPerson(sql, { name: 'Saar', hours_per_week: 12 });
    const rows = await sql`select id from people where name = 'Saar'`;
    expect(rows).toHaveLength(1);
  });

  it('says when hours were not stated rather than assuming a week', async () => {
    const res = await createPerson(sql, { name: 'Unknown Hours' });
    expect(res.confidence.notes.join(' ')).toContain('delegated load cannot be reported');
  });
});

describe('ventures', () => {
  it('can be enumerated, which is how a slug is meant to be discovered', async () => {
    const res = await listVentures(sql, {});
    const slugs = (res['ventures'] as Array<{ slug: string }>).map((v) => v.slug);
    expect(slugs).toContain('yachtyhub');
  });

  it('renames a slug and carries tasks, milestones and outcome targets with it', async () => {
    const tasksBefore = await sql<Array<{ n: number }>>`
      select count(*)::int as n from tasks t join ventures v on v.id = t.venture_id
       where v.slug = 'yachtyhub'`;

    const res = await setVenture(sql, { slug: 'yachtyhub', new_slug: 'yathub', name: 'YatHub' });
    expect(res.ok).toBe(true);

    const tasksAfter = await sql<Array<{ n: number }>>`
      select count(*)::int as n from tasks t join ventures v on v.id = t.venture_id
       where v.slug = 'yathub'`;
    expect(tasksAfter[0]!.n).toBe(tasksBefore[0]!.n);
    expect(res.confidence.notes.join(' ')).toContain('moved with it');

    // And the new slug resolves where the old one did.
    const commit = await commitTasks(sql, {
      tasks: [{ title: 'Under the new slug', venture: 'yathub' }],
      idempotency_key: 'renamed-1',
    });
    expect(commit.ok).toBe(true);
  });

  it('lists the known slugs when asked for one that does not exist', async () => {
    const res = await setVenture(sql, { slug: 'FoxStays', weight: 1 });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.message).toContain('Known slugs:');
    expect(res.errors?.[0]?.message).toContain('nothing was written');
  });

  it('creates one on request', async () => {
    const res = await setVenture(sql, {
      slug: 'foxstays',
      create: true,
      name: 'FoxStays Docks',
      weight: 1.2,
    });
    expect(res['created']).toBe(true);
    const list = await listVentures(sql, {});
    expect((list['ventures'] as Array<{ slug: string }>).map((v) => v.slug)).toContain('foxstays');
  });
});

describe('milestones', () => {
  it('lists them all, including stale ones nothing else surfaces', async () => {
    const res = await listMilestones(sql, {});
    const names = (res['milestones'] as Array<{ name: string }>).map((m) => m.name);
    expect(names).toContain('YachtyHub live');
    expect(res['total']).toBeGreaterThanOrEqual(3);
  });

  it('flags an active milestone with no attached tasks', async () => {
    // This is the row that sits at the top of a slip ranking freeing zero
    // hours, which is what makes the ranking read as nonsense.
    const res = await listMilestones(sql, {});
    expect(res.confidence.notes.join(' ')).toContain('no tasks attached');
  });

  it('refuses to delete one with tasks attached, and reports which', async () => {
    const m = await sql<Array<{ id: string }>>`
      select m.id from milestones m
       join tasks t on t.milestone_id = m.id group by m.id limit 1`;
    const res = await deleteMilestone(sql, { milestone_id: m[0]!.id });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('has_tasks');
    expect(res.errors?.[0]?.subjects?.length).toBeGreaterThan(0);
    const still = await sql`select id from milestones where id = ${m[0]!.id}`;
    expect(still).toHaveLength(1);
  });

  it('deletes an unattached one outright', async () => {
    await setMilestone(sql, {
      venture: 'yathub',
      name: 'Stale duplicate',
      due_date: '2026-10-01',
      hardness: 'soft',
      cost_of_slip: 'low — nothing',
      idempotency_key: 'stale-1',
    });
    const m = await sql<Array<{ id: string }>>`
      select id from milestones where name = 'Stale duplicate'`;
    const res = await deleteMilestone(sql, { milestone_id: m[0]!.id });
    expect(res['deleted']).toBe(true);
    const gone = await sql`select id from milestones where name = 'Stale duplicate'`;
    expect(gone).toHaveLength(0);
  });

  it('detaches rather than destroying tasks under force', async () => {
    const m = await sql<Array<{ id: string }>>`
      select m.id from milestones m join tasks t on t.milestone_id = m.id group by m.id limit 1`;
    const attached = await sql<Array<{ n: number }>>`
      select count(*)::int as n from tasks where milestone_id = ${m[0]!.id}`;

    const res = await deleteMilestone(sql, { milestone_id: m[0]!.id, force: true });
    expect(res['deleted']).toBe(true);
    expect(res['detached_tasks']).toBe(attached[0]!.n);

    // The work survives. Only its milestone is gone.
    const orphans = await sql<Array<{ n: number }>>`
      select count(*)::int as n from tasks where milestone_id is null`;
    expect(orphans[0]!.n).toBeGreaterThanOrEqual(attached[0]!.n);
  });
});

describe('close_many', () => {
  it('closes several and records only the volunteered durations', async () => {
    const a = await taskIdByTitle(sql, 'Delegated thing');
    const b = await taskIdByTitle(sql, 'Under the new slug');

    const res = await closeMany(sql, {
      closures: [{ task_id: a, actual_minutes: 25 }, { task_id: b }],
      idempotency_key: 'bulk-1',
    });
    expect(res.ok).toBe(true);
    expect(res['total']).toBe(2);

    const rows = await sql<Array<{ id: string; actual_inferred: boolean }>>`
      select id, actual_inferred from tasks where id in (${a}, ${b})`;
    const volunteered = rows.filter((r) => !r.actual_inferred);
    // Exactly one duration was stated, so exactly one may teach calibration.
    expect(volunteered).toHaveLength(1);
    expect(volunteered[0]!.id).toBe(a);
  });

  it('reports per-task failure without abandoning the rest', async () => {
    const good = await taskIdByTitle(sql, 'Keeps getting pushed');
    const res = await closeMany(sql, {
      closures: [
        { task_id: '00000000-0000-0000-0000-000000000000' },
        { task_id: good, actual_minutes: 40 },
      ],
      idempotency_key: 'bulk-2',
    });
    expect(res['total']).toBe(1);
    expect(res.errors?.length).toBe(1);
  });
});

describe('duplicate dependency edges', () => {
  it('writes and reports exactly one row when both sides declare it', async () => {
    const res = await commitTasks(sql, {
      tasks: [
        { title: 'Edge A', venture: 'yathub', blocks: ['Edge C'] },
        { title: 'Edge C', venture: 'yathub', depends_on: ['Edge A'] },
      ],
      idempotency_key: 'edges-1',
    });

    const edges = res['edges'] as Array<{ task_id: string; blocks_task_id: string }>;
    expect(edges).toHaveLength(1);

    const a = await taskIdByTitle(sql, 'Edge A');
    const c = await taskIdByTitle(sql, 'Edge C');
    const rows = await sql`
      select 1 from task_dependencies where task_id = ${a} and blocks_task_id = ${c}`;
    expect(rows).toHaveLength(1);
  });
});
