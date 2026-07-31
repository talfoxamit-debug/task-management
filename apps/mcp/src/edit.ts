import { resolveWorkspaceId, type Queryable, type Sql } from './db.js';
import { findReplay, recordReceipt } from './idempotency.js';
import { envelope, narrow, plainConfidence, type ToolEnvelope } from './narrow.js';
import { ACTOR } from './tools.js';

/**
 * Correction.
 *
 * The system could create work and complete it, and nothing in between, so
 * every mistake was permanent: a wrong estimate, a task filed as recurring that
 * is not, a task closed by accident. That is not a missing convenience. Real
 * use of a task system is mostly correction, and one that cannot be corrected
 * is abandoned the first time it is wrong.
 *
 * THE DISTINCTION THAT RUNS THROUGH THIS FILE: absent means "leave it", and an
 * explicit null means "clear it". Collapsing the two would make it impossible to
 * remove a deadline without also rewriting everything else on the task, so every
 * nullable field is read with `in` rather than a truthiness check.
 */

/** A field was supplied at all, even as null. */
function given<T extends object, K extends string>(input: T, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

export interface TaskRow {
  id: string;
  title: string;
  venture: string;
  project: string | null;
  milestone: string | null;
  status: string;
  criticality: string;
  context: string;
  energy: string;
  estimate_minutes: number;
  value: number;
  deadline_date: string | null;
  deadline_time: string | null;
  target_date: string | null;
  lead_time_days: number;
  assignee: string | null;
  is_recurring: boolean;
  recurrence_rule: string | null;
  notes: string | null;
  snooze_count: number;
  snoozed_until: string | null;
  kill_reason: string | null;
}

/** The whole task as it now stands, so a caller never needs a second read. */
async function readTask(
  q: Queryable,
  workspaceId: string,
  taskId: string,
): Promise<TaskRow | null> {
  const rows = await q<TaskRow[]>`
    select t.id, t.title, v.slug as venture, p.name as project, m.name as milestone,
           t.status, t.criticality, t.context, t.energy, t.estimate_minutes, t.value,
           t.deadline_date::text as deadline_date, t.deadline_time::text as deadline_time,
           t.target_date::text as target_date, t.lead_time_days,
           pe.name as assignee, t.is_recurring, t.recurrence_rule, t.notes,
           t.snooze_count, t.snoozed_until::text as snoozed_until, t.kill_reason
      from tasks t
      join ventures v on v.id = t.venture_id
      left join projects p on p.id = t.project_id
      left join milestones m on m.id = t.milestone_id
      left join people pe on pe.id = t.assignee_person_id
     where t.id = ${taskId} and t.workspace_id = ${workspaceId}
     limit 1
  `;
  return rows[0] ?? null;
}

const notFound = (id: string) =>
  envelope(plainConfidence([]), { task: null }, [
    { code: 'not_found', message: `task ${id} does not exist — nothing was written` },
  ]);

// ---------------------------------------------------------------------------
// update_task
// ---------------------------------------------------------------------------

export interface UpdateTaskInput {
  task_id: string;
  title?: string;
  venture?: string;
  project?: string | null;
  status?: string;
  criticality?: string;
  context?: string;
  energy?: string;
  estimate_minutes?: number;
  value?: number;
  deadline_date?: string | null;
  deadline_time?: string | null;
  target_date?: string | null;
  lead_time_days?: number | null;
  assignee?: string | null;
  is_recurring?: boolean;
  recurrence_rule?: string | null;
  notes?: string;
  milestone?: string | null;
  kill_reason?: string | null;
  idempotency_key?: string;
}

export async function updateTask(sql: Sql, input: UpdateTaskInput): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(plainConfidence(['replayed: nothing was written']), {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
    });
  }

  const workspaceId = await resolveWorkspaceId(sql);
  const before = await readTask(sql, workspaceId, input.task_id);
  if (!before) return notFound(input.task_id);

  // Recurrence is a pair, not two independent fields. A recurring task with no
  // rule is rejected by a schema constraint, and a rule left behind on a
  // non-recurring task is a lie the next reader will believe.
  const wantsRecurring = given(input, 'is_recurring') ? input.is_recurring! : before.is_recurring;
  const ruleAfter = given(input, 'recurrence_rule')
    ? input.recurrence_rule
    : before.recurrence_rule;
  if (wantsRecurring && !ruleAfter) {
    return envelope(plainConfidence([]), { task: before }, [
      {
        code: 'recurrence_rule_required',
        message: 'is_recurring true needs a recurrence_rule — nothing was written',
      },
    ]);
  }

  // status:'killed' was reachable through the enum and impossible to satisfy.
  //
  // The tasks table carries `check (status <> 'killed' or kill_reason is not
  // null)`, and update_task had no way to set that column — so every attempt
  // failed with `violates check constraint "tasks_check"`, which does not name
  // the field it wants. A dead path with an unhelpful error is worse than no
  // path: the caller cannot tell a bug from a mistake of their own.
  const statusAfter = given(input, 'status') ? input.status! : before.status;
  const killReasonAfter = given(input, 'kill_reason') ? input.kill_reason : before.kill_reason;
  if (statusAfter === 'killed' && !killReasonAfter) {
    return envelope(plainConfidence([]), { task: before }, [
      {
        code: 'kill_reason_required',
        message:
          'killing a task needs kill_reason — nothing was written. kill_task is the tool for this and records it for you.',
      },
    ]);
  }

  const sets: Array<ReturnType<Sql>> = [];
  const notes: string[] = [];

  const resolveNamed = async (
    table: 'ventures' | 'projects' | 'milestones' | 'people',
    value: string,
  ): Promise<string | null> => {
    if (table === 'ventures') {
      const r = await sql<Array<{ id: string }>>`
        select id from ventures where workspace_id = ${workspaceId}
          and (slug = ${value} or name = ${value}) limit 1`;
      return r[0]?.id ?? null;
    }
    if (table === 'people') {
      const r = await sql<Array<{ id: string }>>`
        select id from people where workspace_id = ${workspaceId} and name = ${value} limit 1`;
      return r[0]?.id ?? null;
    }
    const r =
      table === 'projects'
        ? await sql<Array<{ id: string }>>`
            select id from projects where workspace_id = ${workspaceId} and name = ${value} limit 1`
        : await sql<Array<{ id: string }>>`
            select id from milestones where workspace_id = ${workspaceId} and name = ${value} limit 1`;
    return r[0]?.id ?? null;
  };

  if (given(input, 'title')) sets.push(sql`title = ${input.title!}`);
  if (given(input, 'notes')) sets.push(sql`notes = ${input.notes ?? null}`);
  if (given(input, 'status')) sets.push(sql`status = ${input.status!}`);
  if (given(input, 'kill_reason')) sets.push(sql`kill_reason = ${input.kill_reason ?? null}`);
  // Moving off killed takes the reason with it: a live task carrying "never
  // real work" is a sentence the next reader will believe.
  if (given(input, 'status') && before.status === 'killed' && statusAfter !== 'killed'
      && !given(input, 'kill_reason')) {
    sets.push(sql`kill_reason = ${null}`);
  }
  if (given(input, 'criticality')) sets.push(sql`criticality = ${input.criticality!}`);
  if (given(input, 'context')) sets.push(sql`context = ${input.context!}`);
  if (given(input, 'energy')) sets.push(sql`energy = ${input.energy!}`);
  if (given(input, 'estimate_minutes')) sets.push(sql`estimate_minutes = ${input.estimate_minutes!}`);
  if (given(input, 'value')) sets.push(sql`value = ${input.value!}`);
  if (given(input, 'deadline_date')) sets.push(sql`deadline_date = ${input.deadline_date ?? null}`);
  if (given(input, 'deadline_time')) sets.push(sql`deadline_time = ${input.deadline_time ?? null}`);
  if (given(input, 'target_date')) sets.push(sql`target_date = ${input.target_date ?? null}`);
  if (given(input, 'lead_time_days') && input.lead_time_days != null)
    sets.push(sql`lead_time_days = ${input.lead_time_days}`);

  if (given(input, 'is_recurring') || given(input, 'recurrence_rule')) {
    sets.push(sql`is_recurring = ${wantsRecurring}`);
    // Turning recurrence off must take the rule with it.
    sets.push(sql`recurrence_rule = ${wantsRecurring ? ruleAfter! : null}`);
  }

  if (given(input, 'venture') && input.venture) {
    const id = await resolveNamed('ventures', input.venture);
    if (!id) {
      return envelope(plainConfidence([]), { task: before }, [
        {
          code: 'unknown_venture',
          message: `venture "${input.venture}" does not exist — nothing was written`,
        },
      ]);
    }
    sets.push(sql`venture_id = ${id}`);
  }

  for (const [key, table] of [
    ['project', 'projects'],
    ['milestone', 'milestones'],
    ['assignee', 'people'],
  ] as const) {
    if (!given(input, key)) continue;
    const value = input[key];
    const column = key === 'assignee' ? 'assignee_person_id' : `${key}_id`;
    if (value === null) {
      sets.push(sql`${sql(column)} = ${null}`);
      continue;
    }
    const id = await resolveNamed(table, value as string);
    if (!id) {
      return envelope(plainConfidence([]), { task: before }, [
        {
          code: `unknown_${key}`,
          message: `${key === 'assignee' ? 'person' : key} "${value}" does not exist — nothing was written`,
        },
      ]);
    }
    sets.push(sql`${sql(column)} = ${id}`);
  }

  if (sets.length === 0) {
    return envelope(plainConfidence(['no fields were supplied, so nothing changed']), {
      task: before,
      changed: [],
    });
  }

  await sql.begin(async (tx) => {
    await tx`
      update tasks set ${sets.reduce((a, b) => tx`${a}, ${b}`)}, last_touched_at = now()
       where id = ${input.task_id} and workspace_id = ${workspaceId}
    `;
    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: 'updated_task',
      task_id: input.task_id,
      workspace_id: workspaceId,
      result: { task_id: input.task_id },
    });
  });

  const after = (await readTask(sql, workspaceId, input.task_id))!;
  const changed = (Object.keys(after) as Array<keyof TaskRow>).filter(
    (k) => String(before[k]) !== String(after[k]),
  );

  if (after.is_recurring && changed.includes('estimate_minutes')) {
    notes.push('this is recurring, so the next capacity() will show different overhead');
  }

  return envelope(plainConfidence(notes), { task: after, changed });
}

// ---------------------------------------------------------------------------
// kill_task
// ---------------------------------------------------------------------------

export async function killTask(
  sql: Sql,
  input: { task_id: string; reason?: string; idempotency_key?: string },
): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(plainConfidence(['replayed: nothing was written']), {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
    });
  }

  const workspaceId = await resolveWorkspaceId(sql);
  const task = await readTask(sql, workspaceId, input.task_id);
  if (!task) return notFound(input.task_id);

  if (task.status === 'killed') {
    return envelope(plainConfidence(['already killed: nothing was changed']), {
      task,
      mutated: false,
    });
  }

  // The schema requires a reason, and rightly: a killed task with no reason is
  // indistinguishable next month from one that was lost.
  const reason = input.reason?.trim() || 'no longer relevant';

  await sql.begin(async (tx) => {
    await tx`
      update tasks
         set status = 'killed', kill_reason = ${reason},
             -- Deliberately NOT setting actual_minutes. close() records how long
             -- something took and feeds calibration; kill means it never should
             -- have been here, and teaching the estimator from a task that was
             -- never done would corrupt every future estimate in its context.
             last_touched_at = now()
       where id = ${input.task_id} and workspace_id = ${workspaceId}
    `;
    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: 'killed_task',
      task_id: input.task_id,
      workspace_id: workspaceId,
      result: { task_id: input.task_id, reason },
    });
  });

  return envelope(
    plainConfidence([
      'killed, not done: it contributes no demand and does not feed calibration',
    ]),
    { task: (await readTask(sql, workspaceId, input.task_id))!, mutated: true },
  );
}

// ---------------------------------------------------------------------------
// reopen_task
// ---------------------------------------------------------------------------

export async function reopenTask(
  sql: Sql,
  input: { task_id: string; clear_actual?: boolean; idempotency_key?: string },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const task = await readTask(sql, workspaceId, input.task_id);
  if (!task) return notFound(input.task_id);

  if (task.status !== 'done' && task.status !== 'killed') {
    return envelope(plainConfidence(['not closed: nothing was changed']), {
      task,
      mutated: false,
    });
  }

  const clear = input.clear_actual !== false;
  await sql.begin(async (tx) => {
    await tx`
      update tasks
         set status = 'active', closed_at = null, kill_reason = null,
             actual_minutes = case when ${clear} then null else actual_minutes end,
             actual_inferred = case when ${clear} then true else actual_inferred end,
             -- Clearing the duration must clear who stated it, or the next
             -- close inherits an attribution that is no longer true.
             actual_by_person_id = case when ${clear} then null else actual_by_person_id end,
             last_touched_at = now()
       where id = ${input.task_id} and workspace_id = ${workspaceId}
    `;
    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: 'reopened_task',
      task_id: input.task_id,
      workspace_id: workspaceId,
      result: { task_id: input.task_id },
    });
  });

  return envelope(
    plainConfidence(
      clear
        ? ['the recorded actual was cleared, so a mistaken close no longer teaches calibration']
        : ['the recorded actual was kept'],
    ),
    { task: (await readTask(sql, workspaceId, input.task_id))!, mutated: true },
  );
}

// ---------------------------------------------------------------------------
// snooze_task
// ---------------------------------------------------------------------------

export async function snoozeTask(
  sql: Sql,
  input: { task_id: string; until?: string; days?: number; reason?: string },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const task = await readTask(sql, workspaceId, input.task_id);
  if (!task) return notFound(input.task_id);

  const rows = await sql<Array<{ snooze_count: number; snoozed_until: string | null }>>`
    update tasks
       set snooze_count = snooze_count + 1,
           snooze_reason = coalesce(${input.reason ?? null}, snooze_reason),
           snoozed_until = ${
             input.until
               ? sql`${input.until}::date`
               : input.days
                 ? sql`taskos_today(${workspaceId}) + ${input.days}::int`
                 : sql`snoozed_until`
           },
           last_touched_at = now()
     where id = ${input.task_id} and workspace_id = ${workspaceId}
     returning snooze_count, snoozed_until::text as snoozed_until
  `;

  const count = rows[0]!.snooze_count;
  const notes = [
    // The repeatedly-deferred task is the highest-signal object in any task
    // system, which is the whole reason this counter exists.
    count >= 3
      ? `snoozed ${count} times: it is now out of scoring and into triage — it needs a decision, not another deferral`
      : `snoozed ${count} time(s); at 3 it leaves the ranking and needs a decision`,
  ];

  return envelope(plainConfidence(notes), {
    task: (await readTask(sql, workspaceId, input.task_id))!,
    snooze_count: count,
    needs_triage: count >= 3,
  });
}

// ---------------------------------------------------------------------------
// close_many
// ---------------------------------------------------------------------------

export interface CloseManyInput {
  closures: Array<{ task_id: string; actual_minutes?: number; evidence?: string }>;
  idempotency_key?: string;
}

/**
 * An evening's worth of closes in one call.
 *
 * Calibration needs eight volunteered actuals per context before it will trust
 * an estimate ratio, and one call per task is exactly the friction that stops
 * actuals being volunteered at all — which is what keeps calibration
 * permanently off. The rule it must not break: an actual is only ever recorded
 * because it was stated. Nothing here infers one.
 */
export async function closeMany(sql: Sql, input: CloseManyInput): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(plainConfidence(['replayed: nothing was written']), {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
    });
  }

  const { close } = await import('./tools.js');
  const closed: Array<{ task_id: string; title: string; status: string }> = [];
  const errors: Array<{ code: string; message: string; subjects?: string[] }> = [];
  let volunteered = 0;

  // Sequential, not Promise.all: concurrent queries on a one-connection pool
  // serialise anyway and pipeline badly against a transaction pooler.
  for (const c of input.closures) {
    const res = await close(sql, c);
    if (res.ok) {
      const one = res['closed'] as { task_id: string; title: string; status: string } | null;
      if (one) closed.push(one);
      if (typeof c.actual_minutes === 'number') volunteered += 1;
    } else {
      for (const e of res.errors ?? []) errors.push({ ...e, subjects: [c.task_id] });
    }
  }

  const workspaceId = await resolveWorkspaceId(sql);
  await recordReceipt(sql, {
    key: input.idempotency_key,
    actor: ACTOR,
    verb: 'closed_many',
    workspace_id: workspaceId,
    result: { closed, total: closed.length },
  });

  const list = narrow(closed);
  return envelope(
    plainConfidence([
      `${volunteered} of ${input.closures.length} carried a volunteered duration; only those feed calibration`,
      ...(errors.length > 0 ? ['some closes failed; the rest still happened'] : []),
    ]),
    { closed: list.items, total: list.total, ...(list.truncated ? { truncated: list.truncated } : {}) },
    errors,
  );
}
