import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDayPlan } from '../src/day-plan.js';
import { updateTask } from '../src/edit.js';
import { commitTasks } from '../src/tools.js';
import { forgetSchema, schemaDrift } from '../src/schema.js';
import type { Sql } from '../src/db.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * A database one migration behind the code.
 *
 * THIS IS A REGRESSION TEST FOR A REAL OUTAGE. A deploy put `ai_preparable` into
 * the commit_tasks INSERT while migration 0014 had not been run, so every task
 * write failed with "column does not exist" and a whole planning session was
 * lost. It typechecked. The entire suite passed — because the harness applies
 * every migration in the directory and production does not.
 *
 * The gap is structural and not going away: migrations here are run by hand, in
 * a SQL editor, by the person who also runs five businesses, and code always
 * ships first. So the suite has to contain at least one database that is
 * deliberately behind, or the same class of bug ships again.
 *
 * The rule being asserted is not "0014 is optional". It is that a missing column
 * costs the FEATURE THAT NEEDS IT and nothing else. Losing "Claude can draft
 * this" is a small loss. Losing the ability to write down a task is the system
 * failing at the only job it has.
 */

let db: TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await freshDb('drift');
  sql = db.sql;

  // Roll 0014 back off, leaving exactly the production shape at the moment of
  // the outage: the code expects these, the database does not have them.
  await sql`alter table tasks drop column if exists ai_preparable`;
  await sql`alter table settings drop column if exists work_start_hour`;
  await sql`alter table settings drop column if exists work_end_hour`;
  await sql`alter table day_allocation drop column if exists start_hour`;
  await sql`alter table day_allocation drop column if exists end_hour`;
  forgetSchema();
});

afterAll(async () => {
  await db.drop();
});

describe('a database one migration behind', () => {
  it('STILL ACCEPTS TASKS — the failure that started this', async () => {
    const res = await commitTasks(sql, {
      tasks: [
        { title: 'Lisa Tuesday', venture: 'seatop', estimate_minutes: 60 },
        { title: 'Something else entirely', venture: 'stackwrk', estimate_minutes: 30 },
      ],
      idempotency_key: 'drift-1',
    });

    expect(res.ok).toBe(true);
    expect((res['created'] as unknown[]).length).toBe(2);
    const rows = await sql<Array<{ title: string }>>`
      select title from tasks where title = 'Lisa Tuesday'`;
    expect(rows).toHaveLength(1);
  });

  it('accepts a task that ASKS for the missing flag, dropping only the flag', async () => {
    const res = await commitTasks(sql, {
      tasks: [
        {
          title: 'Draft the onboarding doc',
          venture: 'seatop',
          estimate_minutes: 90,
          ai_preparable: true,
          review_minutes: 15,
        },
      ],
      idempotency_key: 'drift-2',
    });
    expect(res.ok).toBe(true);
    // review_minutes lives in 0013 and IS present, so the part that can be kept
    // is kept.
    const rows = await sql<Array<{ review_minutes: number | null }>>`
      select review_minutes from tasks where title = 'Draft the onboarding doc'`;
    expect(rows[0]!.review_minutes).toBe(15);
  });

  it('lets update_task change everything else', async () => {
    const id = await taskIdByTitle(sql, 'Lisa Tuesday');
    const res = await updateTask(sql, {
      task_id: id,
      estimate_minutes: 45,
      ai_preparable: true,
      idempotency_key: 'drift-3',
    });
    expect(res.ok).toBe(true);
    const rows = await sql<Array<{ estimate_minutes: number }>>`
      select estimate_minutes from tasks where id = ${id}`;
    expect(rows[0]!.estimate_minutes).toBe(45);
  });

  it('returns a plan-shaped answer rather than a 500', async () => {
    const plan = await buildDayPlan(sql, {});
    expect(plan.window).toBeNull();
    expect(plan.slots).toEqual([]);
    // And it names the cause, so the fix is one migration rather than a hunt.
    expect(plan.notes.join(' ')).toContain('0014');
  });

  it('catches a migration that RELAXES a column rather than adding one', async () => {
    // 0015 adds no column at all -- it makes delegation_tokens.person_id
    // nullable. A checker that only looked for missing columns would report
    // "current" while owner_link failed on a not-null violation, which is the
    // exact silent drift this file exists to end.
    await sql`update delegation_tokens set person_id =
                (select id from people limit 1) where person_id is null`;
    await sql`alter table delegation_tokens alter column person_id set not null`;
    forgetSchema();

    const drift = await schemaDrift(sql);
    expect(drift.ok).toBe(false);
    expect(drift.missing.some((m) => m.migration === '0015')).toBe(true);

    await sql`alter table delegation_tokens alter column person_id drop not null`;
    forgetSchema();
  });

  it('names exactly what is missing, and which migration to run', async () => {
    const drift = await schemaDrift(sql);
    expect(drift.ok).toBe(false);
    expect(drift.next_migration).toBe('0014');
    expect(drift.missing.map((m) => `${m.table}.${m.column}`)).toContain('tasks.ai_preparable');
    // The feature name is what makes the report readable to somebody deciding
    // whether the migration is urgent.
    expect(drift.missing[0]!.feature.length).toBeGreaterThan(0);
  });
});

describe('a database that is up to date', () => {
  it('reports no drift at all', async () => {
    const fresh = await freshDb('nodrift');
    forgetSchema();
    try {
      const drift = await schemaDrift(fresh.sql);
      // If this fails, EXPECTED_COLUMNS has drifted from the migrations — which
      // would make /health lie in the reassuring direction.
      expect(drift.missing).toEqual([]);
      expect(drift.ok).toBe(true);
    } finally {
      await fresh.drop();
      forgetSchema();
    }
  });
});
