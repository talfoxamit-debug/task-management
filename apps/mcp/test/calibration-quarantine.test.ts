import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/db.js';
import { close, commitTasks } from '../src/tools.js';
import { reopenTask } from '../src/edit.js';
import { createPerson } from '../src/registry.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * A delegate's volunteered duration must never reach the calibration table.
 *
 * This is the one change in the delegation work that can silently corrupt data
 * already in the system, and it is silent in both directions: nothing fails,
 * no error is raised, the ratio simply drifts toward somebody else's pace and
 * every estimate downstream shifts with it.
 *
 * calibration is keyed (workspace_id, context) and exists to correct TAL's
 * estimating. Othman taking 120 minutes on a 90-minute task is evidence about
 * Othman, or about Tal estimating FOR Othman. It is not evidence that Tal's
 * deep_work runs long.
 *
 * The minutes are still recorded and still reported. They are excluded from one
 * specific calculation, and this file is what keeps that true.
 */

let db: TestDb;
let sql: Sql;
let othman: string;

const ratioFor = async (context: string) => {
  const rows = await sql<Array<{ ratio: string; sample_n: number }>>`
    select ratio::text, sample_n from calibration where context = ${context}`;
  return rows[0] ? { ratio: Number(rows[0].ratio), n: rows[0].sample_n } : null;
};

beforeAll(async () => {
  db = await freshDb('calquarantine');
  sql = db.sql;

  const person = await createPerson(sql, { name: 'Othman', hours_per_week: 40 });
  othman = (person['person'] as { id: string }).id;

  await commitTasks(sql, {
    tasks: [
      { title: 'Tal does this one', venture: 'yachtyhub', context: 'deep_work', estimate_minutes: 60 },
      { title: 'Othman does this one', venture: 'yachtyhub', context: 'deep_work', estimate_minutes: 90, assignee: 'Othman' },
      { title: 'Othman does another', venture: 'yachtyhub', context: 'deep_work', estimate_minutes: 60, assignee: 'Othman' },
      { title: 'Someone else entirely', venture: 'yachtyhub', context: 'deep_work', estimate_minutes: 30, assignee: 'Othman' },
    ],
    idempotency_key: 'quarantine-seed',
  });
});

afterAll(async () => {
  await db.drop();
});

describe("a delegate's actual", () => {
  it('leaves calibration completely untouched', async () => {
    // Tal closes one himself: this one MAY teach the estimator.
    await close(sql, {
      task_id: await taskIdByTitle(sql, 'Tal does this one'),
      actual_minutes: 60,
      idempotency_key: 'q-tal-1',
    });
    const afterTal = await ratioFor('deep_work');
    expect(afterTal).not.toBeNull();
    expect(afterTal!.ratio).toBeCloseTo(1.0, 5);
    expect(afterTal!.n).toBe(1);

    // Othman closes one at 2x his estimate. If this reached calibration the
    // ratio would jump and every deep_work estimate would inflate with it.
    await close(sql, {
      task_id: await taskIdByTitle(sql, 'Othman does this one'),
      actual_minutes: 180,
      by_person_id: othman,
      actor: `person:${othman}`,
      idempotency_key: 'q-othman-1',
    });

    const afterOthman = await ratioFor('deep_work');
    expect(afterOthman!.ratio).toBeCloseTo(afterTal!.ratio, 10);
    expect(afterOthman!.n).toBe(afterTal!.n);
  });

  it('is still recorded, and attributed', async () => {
    const rows = await sql<
      Array<{ actual_minutes: number; actual_inferred: boolean; actual_by_person_id: string }>
    >`
      select actual_minutes, actual_inferred, actual_by_person_id from tasks
       where title = 'Othman does this one'`;
    // Excluded from one calculation, not thrown away.
    expect(rows[0]!.actual_minutes).toBe(180);
    expect(rows[0]!.actual_inferred).toBe(false);
    expect(rows[0]!.actual_by_person_id).toBe(othman);
  });

  it('does not accumulate over many delegate closes', async () => {
    const before = await ratioFor('deep_work');
    await close(sql, {
      task_id: await taskIdByTitle(sql, 'Othman does another'),
      actual_minutes: 240,
      by_person_id: othman,
      idempotency_key: 'q-othman-2',
    });
    const after = await ratioFor('deep_work');
    expect(after!.ratio).toBeCloseTo(before!.ratio, 10);
    expect(after!.n).toBe(before!.n);
  });

  it('is never offered back as a task to ask Tal about', async () => {
    // The "how long did that take?" prompt picks an inferred close to ask
    // about. Asking Tal how long a task took that Othman did would collect an
    // answer that is not a measurement of anything.
    const res = await close(sql, {
      task_id: await taskIdByTitle(sql, 'Someone else entirely'),
      by_person_id: othman,
      idempotency_key: 'q-othman-3',
    });
    const ask = res['ask_about'] as { title?: string } | null | undefined;
    if (ask?.title) expect(ask.title).not.toContain('Othman does');
  });
});

describe('the assignee guard', () => {
  it('refuses a close for a task assigned to someone else', async () => {
    const other = await createPerson(sql, { name: 'Saar', hours_per_week: 8 });
    const saar = (other['person'] as { id: string }).id;
    await commitTasks(sql, {
      tasks: [{ title: 'Only Othman may close this', venture: 'yachtyhub', assignee: 'Othman' }],
      idempotency_key: 'guard-seed',
    });

    const res = await close(sql, {
      task_id: await taskIdByTitle(sql, 'Only Othman may close this'),
      require_assignee: saar,
      by_person_id: saar,
      idempotency_key: 'guard-1',
    });

    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('not_yours');
    const row = await sql<Array<{ status: string }>>`
      select status from tasks where title = 'Only Othman may close this'`;
    expect(row[0]!.status).not.toBe('done');
  });

  it('allows it for the right person', async () => {
    const res = await close(sql, {
      task_id: await taskIdByTitle(sql, 'Only Othman may close this'),
      require_assignee: othman,
      by_person_id: othman,
      idempotency_key: 'guard-2',
    });
    expect(res.ok).toBe(true);
  });
});

describe('reopening a delegate close', () => {
  it('clears the attribution along with the duration', async () => {
    const id = await taskIdByTitle(sql, 'Othman does this one');
    await reopenTask(sql, { task_id: id });
    const row = await sql<Array<{ actual_minutes: number | null; actual_by_person_id: string | null }>>`
      select actual_minutes, actual_by_person_id from tasks where id = ${id}`;
    // Otherwise the next close inherits an attribution that is no longer true,
    // and a duration Tal states himself gets quarantined as somebody else's.
    expect(row[0]!.actual_minutes).toBeNull();
    expect(row[0]!.actual_by_person_id).toBeNull();
  });
});
