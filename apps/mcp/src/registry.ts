import { resolveWorkspaceId, type Sql } from './db.js';
import { findReplay, recordReceipt } from './idempotency.js';
import { envelope, narrow, plainConfidence, type ToolEnvelope } from './narrow.js';
import { ACTOR } from './tools.js';

/**
 * The things you must be able to enumerate before you can audit anything.
 *
 * Ventures, people and milestones all existed and none could be listed. That is
 * not a small omission: three stale milestones survived at the top of the slip
 * ranking precisely because nothing could show them, and a milestone's correct
 * venture slug was only ever discoverable because an unrelated error message
 * happened to print the known slugs in passing.
 */

// ---------------------------------------------------------------------------
// People — because delegation is the real lever
// ---------------------------------------------------------------------------

export async function createPerson(
  sql: Sql,
  input: {
    name: string;
    role?: string;
    hours_per_week?: number;
    active?: boolean;
    idempotency_key?: string;
  },
): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(plainConfidence(['replayed: nothing was written']), {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
    });
  }

  const workspaceId = await resolveWorkspaceId(sql);
  const existing = await sql<Array<{ id: string }>>`
    select id from people where workspace_id = ${workspaceId} and name = ${input.name} limit 1`;

  if (existing[0]) {
    await sql`
      update people
         set role = coalesce(${input.role ?? null}, role),
             hours_per_week = coalesce(${input.hours_per_week ?? null}, hours_per_week),
             active = coalesce(${input.active ?? null}, active)
       where id = ${existing[0].id}`;
    return envelope(plainConfidence(['this person already existed and was updated']), {
      person: { id: existing[0].id, name: input.name },
      created: false,
    });
  }

  const rows = await sql<Array<{ id: string }>>`
    insert into people (workspace_id, name, role, hours_per_week, active)
    values (${workspaceId}, ${input.name}, ${input.role ?? null},
            ${input.hours_per_week ?? null}, ${input.active ?? true})
    returning id`;

  await recordReceipt(sql, {
    key: input.idempotency_key,
    actor: ACTOR,
    verb: 'created_person',
    workspace_id: workspaceId,
    result: { id: rows[0]!.id, name: input.name },
  });

  return envelope(
    plainConfidence(
      input.hours_per_week === undefined
        ? ['hours_per_week was not given, so delegated load cannot be reported for them']
        : [],
    ),
    { person: { id: rows[0]!.id, name: input.name }, created: true },
  );
}

export async function listPeople(sql: Sql, input: { active?: boolean }): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const rows = await sql<
    Array<{
      id: string;
      name: string;
      role: string | null;
      hours_per_week: string | null;
      active: boolean;
      open_tasks: number;
      assigned_minutes: number;
    }>
  >`
    select p.id, p.name, p.role, p.hours_per_week::text as hours_per_week, p.active,
           count(t.id) filter (where t.status not in ('done','killed'))::int as open_tasks,
           coalesce(sum(t.estimate_minutes) filter
             (where t.status not in ('done','killed')), 0)::int as assigned_minutes
      from people p
      left join tasks t on t.assignee_person_id = p.id and t.workspace_id = p.workspace_id
     where p.workspace_id = ${workspaceId}
       ${input.active === undefined ? sql`` : sql`and p.active = ${input.active}`}
     group by p.id, p.name, p.role, p.hours_per_week, p.active
     order by p.active desc, p.name
  `;

  const list = narrow(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      hours_per_week: r.hours_per_week === null ? null : Number(r.hours_per_week),
      active: r.active,
      open_tasks: r.open_tasks,
      // The number that matters: what has actually been moved onto them.
      assigned_hours: Math.round((r.assigned_minutes / 60) * 10) / 10,
    })),
  );

  return envelope(plainConfidence(rows.length === 0 ? ['nobody is recorded yet'] : []), {
    people: list.items,
    total: list.total,
  });
}

// ---------------------------------------------------------------------------
// Ventures
// ---------------------------------------------------------------------------

export async function listVentures(sql: Sql, input: { active?: boolean }): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const rows = await sql<
    Array<{
      id: string;
      slug: string;
      name: string;
      strategic_weight: string;
      floor_share: string;
      ceiling_share: string;
      active: boolean;
      open_tasks: number;
      milestones: number;
    }>
  >`
    select v.id, v.slug, v.name, v.strategic_weight::text, v.floor_share::text,
           v.ceiling_share::text, v.active,
           count(distinct t.id) filter (where t.status not in ('done','killed'))::int as open_tasks,
           count(distinct m.id) filter (where m.status = 'active')::int as milestones
      from ventures v
      left join tasks t on t.venture_id = v.id
      left join milestones m on m.venture_id = v.id
     where v.workspace_id = ${workspaceId}
       ${input.active === undefined ? sql`` : sql`and v.active = ${input.active}`}
     group by v.id
     order by v.active desc, v.strategic_weight desc, v.slug
  `;

  return envelope(plainConfidence([]), {
    ventures: rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      weight: Number(r.strategic_weight),
      floor: Number(r.floor_share),
      ceiling: Number(r.ceiling_share),
      active: r.active,
      open_tasks: r.open_tasks,
      active_milestones: r.milestones,
    })),
    total: rows.length,
  });
}

export interface SetVentureInput {
  slug: string;
  name?: string;
  new_slug?: string;
  weight?: number;
  floor?: number;
  ceiling?: number;
  active?: boolean;
  create?: boolean;
  idempotency_key?: string;
}

/**
 * Create, rename or retune a venture.
 *
 * The slug rename is the delicate part. Tasks, milestones and outcome targets
 * all reference the venture by id, so a rename is a single-row update and
 * cascades by construction — but it happens inside a transaction anyway,
 * because a half-applied rename would leave a slug nobody can resolve, and that
 * is exactly the failure that made `venture "YatHub" does not exist` so hard to
 * act on.
 */
export async function setVenture(sql: Sql, input: SetVentureInput): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(plainConfidence(['replayed: nothing was written']), {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
    });
  }

  const workspaceId = await resolveWorkspaceId(sql);
  const found = await sql<Array<{ id: string; slug: string }>>`
    select id, slug from ventures
     where workspace_id = ${workspaceId} and (slug = ${input.slug} or name = ${input.slug})
     limit 1`;

  if (!found[0]) {
    if (!input.create) {
      const known = await sql<Array<{ slug: string }>>`
        select slug from ventures where workspace_id = ${workspaceId} order by slug`;
      return envelope(plainConfidence([]), { venture: null }, [
        {
          code: 'unknown_venture',
          message: `venture "${input.slug}" does not exist — nothing was written. Known slugs: ${known
            .map((k) => k.slug)
            .join(', ')}. Pass create:true to make it.`,
        },
      ]);
    }
    const created = await sql<Array<{ id: string; slug: string }>>`
      insert into ventures (workspace_id, name, slug, strategic_weight, floor_share,
                            ceiling_share, active)
      values (${workspaceId}, ${input.name ?? input.slug}, ${input.new_slug ?? input.slug},
              ${input.weight ?? 1.0}, ${input.floor ?? 0.05}, ${input.ceiling ?? 0.6},
              ${input.active ?? true})
      returning id, slug`;
    await recordReceipt(sql, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: 'created_venture',
      workspace_id: workspaceId,
      venture_id: created[0]!.id,
      result: { id: created[0]!.id, slug: created[0]!.slug },
    });
    return envelope(plainConfidence([]), {
      venture: { id: created[0]!.id, slug: created[0]!.slug },
      created: true,
    });
  }

  const id = found[0].id;
  const renamed = input.new_slug && input.new_slug !== found[0].slug;

  try {
    await sql.begin(async (tx) => {
      await tx`
        update ventures
           set name = coalesce(${input.name ?? null}, name),
               slug = coalesce(${input.new_slug ?? null}, slug),
               strategic_weight = coalesce(${input.weight ?? null}, strategic_weight),
               floor_share = coalesce(${input.floor ?? null}, floor_share),
               ceiling_share = coalesce(${input.ceiling ?? null}, ceiling_share),
               active = coalesce(${input.active ?? null}, active)
         where id = ${id}`;
      await recordReceipt(tx, {
        key: input.idempotency_key,
        actor: ACTOR,
        verb: 'updated_venture',
        workspace_id: workspaceId,
        venture_id: id,
        result: { id, slug: input.new_slug ?? found[0]!.slug },
      });
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return envelope(plainConfidence([]), { venture: null }, [
      { code: 'rejected', message: `${message} — nothing was written` },
    ]);
  }

  const after = await sql<Array<{ slug: string; name: string; active: boolean }>>`
    select slug, name, active from ventures where id = ${id}`;

  const counts = await sql<Array<{ tasks: number; milestones: number; outcomes: number }>>`
    select (select count(*) from tasks where venture_id = ${id})::int as tasks,
           (select count(*) from milestones where venture_id = ${id})::int as milestones,
           (select count(*) from outcome_targets where venture_id = ${id})::int as outcomes`;

  return envelope(
    plainConfidence(
      renamed
        ? [
            `renamed to "${after[0]!.slug}"; ${counts[0]!.tasks} tasks, ${counts[0]!.milestones} milestones and ${counts[0]!.outcomes} outcome targets reference it by id and moved with it`,
          ]
        : [],
    ),
    { venture: { id, ...after[0]! }, ...counts[0]!, created: false },
  );
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

export async function listMilestones(
  sql: Sql,
  input: { venture?: string; status?: string; include_outcome_targets?: boolean },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);

  const rows = await sql<
    Array<{
      id: string;
      name: string;
      venture: string;
      venture_active: boolean;
      due_date: string;
      hardness: string;
      cost_of_slip: string;
      status: string;
      attached: number;
      open_attached: number;
    }>
  >`
    select m.id, m.name, v.slug as venture, v.active as venture_active,
           m.due_date::text as due_date, m.hardness, m.cost_of_slip, m.status,
           count(t.id)::int as attached,
           count(t.id) filter (where t.status not in ('done','killed'))::int as open_attached
      from milestones m
      join ventures v on v.id = m.venture_id
      left join tasks t on t.milestone_id = m.id
     where m.workspace_id = ${workspaceId}
       ${input.venture ? sql`and (v.slug = ${input.venture} or v.name = ${input.venture})` : sql``}
       ${input.status ? sql`and m.status = ${input.status}` : sql``}
     group by m.id, v.slug, v.active
     order by m.due_date
  `;

  const notes: string[] = [];
  const unattached = rows.filter((r) => r.status === 'active' && r.attached === 0);
  if (unattached.length > 0) {
    // These are the rows that sit at the top of a slip ranking freeing zero
    // hours, which is what makes the ranking read as nonsense.
    notes.push(
      `${unattached.length} active milestone(s) have no tasks attached, so they have no critical path and free nothing when slipped: ${unattached
        .map((r) => r.name)
        .join('; ')}`,
    );
  }
  const orphaned = rows.filter((r) => !r.venture_active && r.status === 'active');
  if (orphaned.length > 0) {
    notes.push(
      `${orphaned.length} active milestone(s) belong to an inactive venture, so their demand is silently not counted: ${orphaned
        .map((r) => r.name)
        .join('; ')}`,
    );
  }

  const body: Record<string, unknown> = {
    milestones: rows.map((r) => ({
      id: r.id,
      name: r.name,
      venture: r.venture,
      venture_active: r.venture_active,
      due_date: r.due_date,
      hardness: r.hardness,
      cost_of_slip: r.cost_of_slip,
      status: r.status,
      attached_tasks: r.attached,
      open_tasks: r.open_attached,
    })),
    total: rows.length,
  };

  if (input.include_outcome_targets) {
    const outcomes = await sql<
      Array<{ id: string; name: string; venture: string; target_date: string | null }>
    >`
      select o.id, o.name, v.slug as venture, o.target_date::text as target_date
        from outcome_targets o join ventures v on v.id = o.venture_id
       where o.workspace_id = ${workspaceId}
         ${input.venture ? sql`and (v.slug = ${input.venture} or v.name = ${input.venture})` : sql``}
       order by o.name`;
    body['outcome_targets'] = outcomes;
    body['outcome_targets_total'] = outcomes.length;
  }

  return envelope(plainConfidence(notes), body);
}

/**
 * Delete a milestone, refusing by default when work hangs off it.
 *
 * Refusing rather than cascading is the right default because detaching tasks
 * silently is how a critical path disappears without anyone noticing. The count
 * and the ids come back so the caller can decide rather than guess.
 */
export async function deleteMilestone(
  sql: Sql,
  input: { milestone_id: string; force?: boolean; idempotency_key?: string },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const found = await sql<Array<{ id: string; name: string }>>`
    select id, name from milestones
     where id = ${input.milestone_id} and workspace_id = ${workspaceId}`;
  if (!found[0]) {
    return envelope(plainConfidence([]), { deleted: false }, [
      {
        code: 'not_found',
        message: `milestone ${input.milestone_id} does not exist — nothing was written`,
      },
    ]);
  }

  const attached = await sql<Array<{ id: string; title: string }>>`
    select id, title from tasks
     where milestone_id = ${input.milestone_id} and workspace_id = ${workspaceId}`;

  if (attached.length > 0 && !input.force) {
    return envelope(
      plainConfidence([
        'refused rather than detaching silently: a critical path that disappears without anyone noticing is worse than a stale milestone',
      ]),
      {
        deleted: false,
        milestone: found[0],
        attached_tasks: attached.length,
        attached: narrow(attached).items,
      },
      [
        {
          code: 'has_tasks',
          message: `${attached.length} task(s) are attached — nothing was written. Pass force:true to detach them and delete anyway.`,
          subjects: attached.map((a) => a.id),
        },
      ],
    );
  }

  await sql.begin(async (tx) => {
    if (attached.length > 0) {
      await tx`update tasks set milestone_id = null, last_touched_at = now()
                where milestone_id = ${input.milestone_id}`;
    }
    await tx`delete from milestones where id = ${input.milestone_id}`;
    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: 'deleted_milestone',
      workspace_id: workspaceId,
      result: { id: input.milestone_id, name: found[0]!.name, detached: attached.length },
    });
  });

  return envelope(
    plainConfidence(
      attached.length > 0
        ? [`${attached.length} task(s) were detached and still exist; they now belong to no milestone`]
        : [],
    ),
    { deleted: true, milestone: found[0], detached_tasks: attached.length },
  );
}

export async function deleteOutcomeTarget(
  sql: Sql,
  input: { outcome_id: string; idempotency_key?: string },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const found = await sql<Array<{ id: string; name: string }>>`
    select id, name from outcome_targets
     where id = ${input.outcome_id} and workspace_id = ${workspaceId}`;
  if (!found[0]) {
    return envelope(plainConfidence([]), { deleted: false }, [
      {
        code: 'not_found',
        message: `outcome target ${input.outcome_id} does not exist — nothing was written`,
      },
    ]);
  }

  await sql.begin(async (tx) => {
    // An outcome target drives no demand and owns no tasks, so there is nothing
    // to orphan: only its milestone links go with it.
    await tx`delete from outcome_milestones where outcome_id = ${input.outcome_id}`;
    await tx`delete from outcome_targets where id = ${input.outcome_id}`;
    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: 'deleted_outcome_target',
      workspace_id: workspaceId,
      result: { id: input.outcome_id, name: found[0]!.name },
    });
  });

  return envelope(plainConfidence([]), { deleted: true, outcome_target: found[0] });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * Projects existed in the schema and were unreachable.
 *
 * commit_tasks accepts a `project` and correctly refuses an unknown one, but
 * nothing could create or list them — so the field was permanently unusable and
 * "what are my projects?" had no answer at all. The same shape of hole
 * create_person filled for assignees.
 */
export async function setProject(
  sql: Sql,
  input: {
    name: string;
    venture: string;
    outcome?: string;
    milestone?: string | null;
    status?: 'active' | 'paused' | 'done' | 'killed';
    new_name?: string;
    idempotency_key?: string;
  },
): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(plainConfidence(['replayed: nothing was written']), {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
    });
  }

  const workspaceId = await resolveWorkspaceId(sql);
  const ventures = await sql<Array<{ id: string; slug: string }>>`
    select id, slug from ventures where workspace_id = ${workspaceId}
      and (slug = ${input.venture} or name = ${input.venture}) limit 1`;
  if (!ventures[0]) {
    const known = await sql<Array<{ slug: string }>>`
      select slug from ventures where workspace_id = ${workspaceId} order by slug`;
    return envelope(plainConfidence([]), { project: null }, [
      {
        code: 'unknown_venture',
        message: `venture "${input.venture}" does not exist — nothing was written. Known: ${known
          .map((k) => k.slug)
          .join(', ')}`,
      },
    ]);
  }
  const ventureId = ventures[0].id;

  let milestoneId: string | null = null;
  if (input.milestone) {
    const rows = await sql<Array<{ id: string }>>`
      select id from milestones where workspace_id = ${workspaceId}
        and venture_id = ${ventureId} and name = ${input.milestone} limit 1`;
    if (!rows[0]) {
      return envelope(plainConfidence([]), { project: null }, [
        {
          code: 'unknown_milestone',
          message: `milestone "${input.milestone}" does not exist in ${ventures[0].slug} — nothing was written`,
        },
      ]);
    }
    milestoneId = rows[0].id;
  }

  const existing = await sql<Array<{ id: string }>>`
    select id from projects where workspace_id = ${workspaceId}
      and venture_id = ${ventureId} and name = ${input.name} limit 1`;

  // outcome is NOT NULL and is the field that makes a project mean something:
  // a project with no stated outcome is a folder, and a folder cannot be
  // finished. Defaulted rather than refused, but the note says so.
  const outcome = input.outcome ?? `(outcome not stated for "${input.name}")`;

  const rows = existing[0]
    ? await sql<Array<{ id: string; name: string }>>`
        update projects
           set name = coalesce(${input.new_name ?? null}, name),
               outcome = coalesce(${input.outcome ?? null}, outcome),
               milestone_id = ${input.milestone === null ? null : (milestoneId ?? sql`milestone_id`)},
               status = coalesce(${input.status ?? null}, status)
         where id = ${existing[0].id}
         returning id, name`
    : await sql<Array<{ id: string; name: string }>>`
        insert into projects (workspace_id, venture_id, milestone_id, name, outcome, status)
        values (${workspaceId}, ${ventureId}, ${milestoneId}, ${input.new_name ?? input.name},
                ${outcome}, ${input.status ?? 'active'})
        returning id, name`;

  await recordReceipt(sql, {
    key: input.idempotency_key,
    actor: ACTOR,
    verb: existing[0] ? 'updated_project' : 'created_project',
    workspace_id: workspaceId,
    venture_id: ventureId,
    result: { id: rows[0]!.id, name: rows[0]!.name },
  });

  return envelope(
    plainConfidence(
      input.outcome === undefined && !existing[0]
        ? [
            'no outcome was stated, so one was placeholdered: a project without an outcome is a folder, and a folder cannot be finished',
          ]
        : [],
    ),
    {
      project: { id: rows[0]!.id, name: rows[0]!.name, venture: ventures[0].slug },
      created: !existing[0],
    },
  );
}

export async function listProjects(
  sql: Sql,
  input: { venture?: string; status?: string },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const rows = await sql<
    Array<{
      id: string;
      name: string;
      outcome: string;
      status: string;
      venture: string;
      milestone: string | null;
      open_tasks: number;
      open_minutes: number;
      done_tasks: number;
      last_movement_at: Date | null;
    }>
  >`
    select p.id, p.name, p.outcome, p.status, v.slug as venture, m.name as milestone,
           count(t.id) filter (where t.status not in ('done','killed'))::int as open_tasks,
           coalesce(sum(t.estimate_minutes) filter
             (where t.status not in ('done','killed')), 0)::int as open_minutes,
           count(t.id) filter (where t.status = 'done')::int as done_tasks,
           p.last_movement_at
      from projects p
      join ventures v on v.id = p.venture_id
      left join milestones m on m.id = p.milestone_id
      left join tasks t on t.project_id = p.id
     where p.workspace_id = ${workspaceId}
       ${input.venture ? sql`and (v.slug = ${input.venture} or v.name = ${input.venture})` : sql``}
       ${input.status ? sql`and p.status = ${input.status}` : sql``}
     group by p.id, v.slug, m.name
     order by v.slug, p.name`;

  const notes: string[] = [];
  const stale = rows.filter(
    (r) =>
      r.status === 'active' &&
      r.last_movement_at !== null &&
      Date.now() - r.last_movement_at.getTime() > 14 * 24 * 3600 * 1000,
  );
  if (stale.length > 0) {
    notes.push(
      `${stale.length} active project(s) have not moved in over two weeks: ${stale.map((s) => s.name).join('; ')}`,
    );
  }
  const empty = rows.filter((r) => r.status === 'active' && r.open_tasks === 0);
  if (empty.length > 0) {
    notes.push(
      `${empty.length} active project(s) have no open tasks, so nothing is going to happen in them: ${empty.map((e) => e.name).join('; ')}`,
    );
  }

  const list = narrow(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      venture: r.venture,
      outcome: r.outcome,
      milestone: r.milestone,
      status: r.status,
      open_tasks: r.open_tasks,
      open_hours: Math.round((r.open_minutes / 60) * 10) / 10,
      done_tasks: r.done_tasks,
      last_movement: r.last_movement_at ? r.last_movement_at.toISOString().slice(0, 10) : null,
    })),
  );

  return envelope(plainConfidence(notes), {
    projects: list.items,
    total: list.total,
    ...(list.truncated ? { truncated: list.truncated } : {}),
  });
}
