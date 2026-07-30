import type { Confidence, Task } from '@taskos/engine';
import { daysBetween } from '@taskos/engine';
import { timed, type Sql } from './db.js';
import { loadPortfolio, type Portfolio } from './load.js';
import { findReplay, isCycleRejection, isUniqueViolation, recordReceipt } from './idempotency.js';
import { envelope, LIST_CAP, narrow, plainConfidence, r1, r3, type ToolEnvelope } from './narrow.js';
import { proposeForText, type InboxProposal } from './propose.js';
import { runCapacity, runEngine } from './pipeline.js';

/**
 * The eight tools of Part 5, in the order they are listed there.
 *
 * Two rules hold across all of them:
 *   - responses are pre-narrowed, capped at 15 items with a `total` count
 *   - every response carries the D4 confidence object, via envelope()
 */

export const ACTOR = 'tal';

// ---------------------------------------------------------------------------
// 1. capture(text, idempotency_key?)
// ---------------------------------------------------------------------------

export interface CaptureInput {
  text: string;
  idempotency_key?: string;
}

/**
 * Raw text to inbox, no parsing. Multi-line input becomes one inbox item per
 * line, which is splitting rather than parsing: nothing about the content is
 * interpreted here.
 *
 * Inbox items park against the inactive `unsorted` venture, because
 * tasks.venture_id is NOT NULL and capture is not allowed to guess a venture.
 */
export async function capture(sql: Sql, input: CaptureInput): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(plainConfidence(['replayed: this idempotency_key was already used, nothing was written']), {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
      originally_at: replay.at,
    });
  }

  const lines = input.text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return envelope(plainConfidence(['nothing was captured: the text was empty']), {
      created: [],
      total: 0,
    });
  }

  const holding = await sql<Array<{ id: string }>>`
    select id from ventures where slug = 'unsorted' limit 1
  `;
  const holdingId = holding[0]?.id;
  if (!holdingId) {
    return envelope(plainConfidence([]), { created: [], total: 0 }, [
      {
        code: 'no_input',
        message:
          "the 'unsorted' holding venture is missing; run migration 0004 before capturing (tasks.venture_id is NOT NULL)",
      },
    ]);
  }

  try {
    const created = await sql.begin(async (tx) => {
      const rows: Array<{ id: string; title: string }> = [];
      for (const line of lines) {
        const inserted = await tx<Array<{ id: string; title: string }>>`
          insert into tasks (venture_id, title, estimate_minutes, status, context, criticality)
          values (${holdingId}, ${line}, 15, 'inbox', 'admin', 'supporting')
          returning id, title
        `;
        rows.push(inserted[0]!);
      }
      await recordReceipt(tx, {
        key: input.idempotency_key,
        actor: ACTOR,
        verb: 'captured',
        venture_id: holdingId,
        result: { created: rows, total: rows.length },
      });
      return rows;
    });

    return envelope(
      plainConfidence([
        'captured verbatim with no interpretation: venture, context and estimate are placeholders until process_inbox proposes and you confirm',
      ]),
      { created, total: created.length },
    );
  } catch (e) {
    if (isUniqueViolation(e) && input.idempotency_key) {
      const again = await findReplay(sql, input.idempotency_key);
      if (again) {
        return envelope(plainConfidence(['replayed: a concurrent call used this key first']), {
          ...(again.result as Record<string, unknown>),
          replayed: true,
        });
      }
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// 2. process_inbox()
// ---------------------------------------------------------------------------

export interface ProcessInboxResult extends ToolEnvelope {
  proposals: InboxProposal[];
  total: number;
}

/** Unprocessed items with PROPOSED fields. Nothing is written; Tal confirms. */
export async function processInbox(sql: Sql): Promise<ToolEnvelope> {
  const [items, ventures, projects] = await Promise.all([
    sql<Array<{ id: string; title: string; notes: string | null }>>`
      select id, title, notes from tasks where status = 'inbox' order by created_at`,
    sql<Array<Record<string, unknown>>>`
      select id, name, slug, strategic_weight, floor_share, ceiling_share, active
        from ventures order by slug`,
    sql<Array<{ id: string; name: string; venture_id: string; status: string }>>`
      select id, name, venture_id, status from projects`,
  ]);

  const ventureValues = ventures.map((v) => ({
    id: String(v['id']),
    name: String(v['name']),
    slug: String(v['slug']),
    strategic_weight: Number(v['strategic_weight']),
    floor_share: Number(v['floor_share']),
    ceiling_share: Number(v['ceiling_share']),
    active: Boolean(v['active']),
  }));

  const all = items.map((t) => proposeForText(t, ventureValues, projects));
  const list = narrow(all);

  const uncertain = list.items.filter(
    (p) => !p.venture.certain || p.venture.value === null,
  ).length;

  const notes = [
    'these are PROPOSALS from keyword rules, not a parse and not a model: confirm or correct each before commit_tasks writes anything',
  ];
  if (uncertain > 0) {
    notes.push(
      `${uncertain} of ${list.items.length} shown could not be assigned a venture with any confidence`,
    );
  }
  if (all.length === 0) notes.push('the inbox is empty, so there is nothing to process');

  return envelope(plainConfidence(notes), {
    proposals: list.items,
    total: list.total,
    ...(list.truncated ? { truncated: list.truncated } : {}),
  });
}

// ---------------------------------------------------------------------------
// 3. commit_tasks(tasks[], idempotency_key?)
// ---------------------------------------------------------------------------

export interface CommitTaskInput {
  title: string;
  venture: string;
  /** Existing inbox row to convert, instead of creating a new task. */
  from_inbox_task_id?: string;
  project?: string;
  milestone?: string;
  notes?: string;
  criticality?: Task['criticality'];
  context?: Task['context'];
  energy?: Task['energy'];
  estimate_minutes?: number;
  value?: number;
  deadline_date?: string;
  deadline_time?: string;
  target_date?: string;
  lead_time_days?: number;
  status?: Task['status'];
  assignee?: string;
  is_recurring?: boolean;
  recurrence_rule?: string;
  /** Titles this task must be finished before. Dependency edges by reference. */
  blocks?: string[];
  /** Titles that must be finished before this task. */
  depends_on?: string[];
}

/**
 * Writes confirmed tasks and their dependency edges in ONE transaction. Edges are
 * given by title, resolved against this batch first and then against open tasks.
 *
 * An ambiguous title is an error rather than a best guess: silently wiring an
 * edge to the wrong task produces a critical path that looks complete and is
 * wrong, which is the failure mode the coverage guard exists to catch.
 */
export async function commitTasks(
  sql: Sql,
  input: { tasks: CommitTaskInput[]; idempotency_key?: string },
): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(plainConfidence(['replayed: this idempotency_key was already used, nothing was written']), {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
      originally_at: replay.at,
    });
  }

  if (input.tasks.length === 0) {
    return envelope(plainConfidence(['no tasks were supplied, so nothing was written']), {
      created: [],
      edges: [],
      total: 0,
    });
  }

  const errors: Array<{ code: string; message: string; subjects?: string[] }> = [];

  try {
    const result = await sql.begin(async (tx) => {
      const ventures = await tx<Array<{ id: string; slug: string; name: string }>>`
        select id, slug, name from ventures`;
      const ventureBySlug = new Map(ventures.map((v) => [v.slug.toLowerCase(), v.id]));
      const ventureByName = new Map(ventures.map((v) => [v.name.toLowerCase(), v.id]));

      const projects = await tx<Array<{ id: string; name: string; venture_id: string }>>`
        select id, name, venture_id from projects`;
      const milestones = await tx<Array<{ id: string; name: string; venture_id: string }>>`
        select id, name, venture_id from milestones`;
      const people = await tx<Array<{ id: string; name: string }>>`select id, name from people`;

      const created: Array<{ id: string; title: string; venture: string }> = [];
      const titleToId = new Map<string, string>();

      for (const t of input.tasks) {
        const ventureId =
          ventureBySlug.get(t.venture.toLowerCase()) ?? ventureByName.get(t.venture.toLowerCase());
        if (!ventureId) {
          throw new CommitError(
            `venture "${t.venture}" does not exist; known slugs are ${[...ventureBySlug.keys()].join(', ')}`,
          );
        }
        const projectId = t.project
          ? (projects.find(
              (p) => p.venture_id === ventureId && p.name.toLowerCase() === t.project!.toLowerCase(),
            )?.id ?? null)
          : null;
        if (t.project && !projectId) {
          throw new CommitError(`project "${t.project}" does not exist in venture ${t.venture}`);
        }
        const milestoneId = t.milestone
          ? (milestones.find(
              (m) =>
                m.venture_id === ventureId && m.name.toLowerCase() === t.milestone!.toLowerCase(),
            )?.id ?? null)
          : null;
        if (t.milestone && !milestoneId) {
          throw new CommitError(
            `milestone "${t.milestone}" does not exist in venture ${t.venture}; create it with set_milestone first`,
          );
        }
        const assigneeId = t.assignee
          ? (people.find((p) => p.name.toLowerCase() === t.assignee!.toLowerCase())?.id ?? null)
          : null;
        if (t.assignee && !assigneeId) {
          throw new CommitError(`person "${t.assignee}" does not exist`);
        }

        const fields = {
          project_id: projectId,
          venture_id: ventureId,
          milestone_id: milestoneId,
          title: t.title,
          notes: t.notes ?? null,
          criticality: t.criticality ?? 'supporting',
          context: t.context ?? 'admin',
          energy: t.energy ?? 'medium',
          estimate_minutes: t.estimate_minutes ?? 30,
          value: t.value ?? 5,
          deadline_date: t.deadline_date ?? null,
          deadline_time: t.deadline_time ?? null,
          target_date: t.target_date ?? null,
          lead_time_days: t.lead_time_days ?? 3,
          status: t.status ?? 'active',
          assignee_person_id: assigneeId,
          is_recurring: t.is_recurring ?? false,
          recurrence_rule: t.recurrence_rule ?? null,
        };

        if (fields.is_recurring && !fields.recurrence_rule) {
          throw new CommitError(
            `"${t.title}" is marked recurring but has no recurrence_rule; the schema requires one`,
          );
        }

        let row: { id: string; title: string };
        if (t.from_inbox_task_id) {
          const updated = await tx<Array<{ id: string; title: string }>>`
            update tasks set ${tx(fields)}, last_touched_at = now()
             where id = ${t.from_inbox_task_id} and status = 'inbox'
            returning id, title
          `;
          if (!updated[0]) {
            throw new CommitError(
              `inbox task ${t.from_inbox_task_id} was not found, or is no longer in the inbox`,
            );
          }
          row = updated[0];
        } else {
          const inserted = await tx<Array<{ id: string; title: string }>>`
            insert into tasks ${tx(fields)} returning id, title
          `;
          row = inserted[0]!;
        }

        created.push({ id: row.id, title: row.title, venture: t.venture });
        if (titleToId.has(row.title.toLowerCase())) {
          throw new CommitError(
            `two tasks in this batch are both titled "${row.title}"; dependency edges reference titles, so they must be unique within a batch`,
          );
        }
        titleToId.set(row.title.toLowerCase(), row.id);
      }

      // Resolve a title to a task id: this batch first, then open tasks.
      const openTasks = await tx<Array<{ id: string; title: string }>>`
        select id, title from tasks where status not in ('done','killed')`;

      const resolve = (title: string, forTask: string): string => {
        const key = title.toLowerCase();
        const inBatch = titleToId.get(key);
        if (inBatch) return inBatch;
        const matches = openTasks.filter((t) => t.title.toLowerCase() === key);
        if (matches.length === 1) return matches[0]!.id;
        if (matches.length === 0) {
          throw new CommitError(
            `"${forTask}" references "${title}", which matches no task in this batch and no open task`,
          );
        }
        throw new CommitError(
          `"${forTask}" references "${title}", which matches ${matches.length} open tasks (${matches.map((m) => m.id).join(', ')}); reference it by a unique title`,
        );
      };

      const edges: Array<{ task_id: string; blocks_task_id: string }> = [];
      for (const t of input.tasks) {
        const selfId = titleToId.get(t.title.toLowerCase())!;
        for (const blockedTitle of t.blocks ?? []) {
          edges.push({ task_id: selfId, blocks_task_id: resolve(blockedTitle, t.title) });
        }
        for (const blockerTitle of t.depends_on ?? []) {
          edges.push({ task_id: resolve(blockerTitle, t.title), blocks_task_id: selfId });
        }
      }

      for (const e of edges) {
        await tx`
          insert into task_dependencies (task_id, blocks_task_id)
          values (${e.task_id}, ${e.blocks_task_id})
          on conflict do nothing
        `;
      }

      await recordReceipt(tx, {
        key: input.idempotency_key,
        actor: ACTOR,
        verb: 'committed_tasks',
        result: { created, edges, total: created.length },
      });

      return { created, edges };
    });

    const notes: string[] = [];
    if (result.edges.length === 0 && input.tasks.length > 1) {
      notes.push(
        'no dependency edges were given: without them a milestone\'s coverage stays low and its slack will not be trusted for demand',
      );
    }
    return envelope(plainConfidence(notes), {
      created: result.created,
      edges: result.edges,
      total: result.created.length,
    });
  } catch (e) {
    if (isUniqueViolation(e) && input.idempotency_key) {
      const again = await findReplay(sql, input.idempotency_key);
      if (again) {
        return envelope(plainConfidence(['replayed: a concurrent call used this key first']), {
          ...(again.result as Record<string, unknown>),
          replayed: true,
        });
      }
    }
    if (isCycleRejection(e)) {
      errors.push({
        code: 'dependency_cycle',
        message: `${(e as Error).message} — nothing was written; the whole batch rolled back`,
      });
      return envelope(plainConfidence([]), { created: [], edges: [], total: 0 }, errors);
    }
    if (e instanceof CommitError) {
      errors.push({ code: 'no_input', message: `${e.message} — nothing was written` });
      return envelope(plainConfidence([]), { created: [], edges: [], total: 0 }, errors);
    }
    throw e;
  }
}

class CommitError extends Error {}

// ---------------------------------------------------------------------------
// 4. set_milestone(venture, name, due_date, hardness, cost_of_slip)
// ---------------------------------------------------------------------------

export async function setMilestone(
  sql: Sql,
  input: {
    venture: string;
    name: string;
    due_date: string;
    hardness: 'hard' | 'soft';
    cost_of_slip: string;
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

  const ventures = await sql<Array<{ id: string; slug: string }>>`
    select id, slug from ventures where slug = ${input.venture} or name = ${input.venture} limit 1
  `;
  const venture = ventures[0];
  if (!venture) {
    return envelope(plainConfidence([]), { milestone: null }, [
      { code: 'missing_venture', message: `venture "${input.venture}" does not exist` },
    ]);
  }

  const result = await sql.begin(async (tx) => {
    const existing = await tx<Array<{ id: string }>>`
      select id from milestones where venture_id = ${venture.id} and name = ${input.name} limit 1
    `;
    const row = existing[0]
      ? (
          await tx<Array<Record<string, unknown>>>`
            update milestones
               set due_date = ${input.due_date}::date,
                   hardness = ${input.hardness},
                   cost_of_slip = ${input.cost_of_slip},
                   confirmed_at = now()
             where id = ${existing[0].id}
            returning id, name, due_date::text as due_date, hardness, cost_of_slip, status
          `
        )[0]!
      : (
          await tx<Array<Record<string, unknown>>>`
            insert into milestones (venture_id, name, due_date, hardness, cost_of_slip, confirmed_at)
            values (${venture.id}, ${input.name}, ${input.due_date}::date, ${input.hardness},
                    ${input.cost_of_slip}, now())
            returning id, name, due_date::text as due_date, hardness, cost_of_slip, status
          `
        )[0]!;

    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: existing[0] ? 'milestone_updated' : 'milestone_set',
      venture_id: venture.id,
      result: { milestone: row, updated: Boolean(existing[0]) },
    });
    return { row, updated: Boolean(existing[0]) };
  });

  const notes = [
    'a milestone is an event you control, so it drives demand and gets a critical path (D1)',
  ];
  const today = await sql<Array<{ d: string }>>`select taskos_today()::text as d`;
  const days = daysBetween(today[0]!.d, input.due_date);
  if (days !== null && days < 0) {
    notes.push(
      `due_date is ${Math.abs(days)} day(s) in the past: it will be flipped to missed the next time expiry runs`,
    );
  }
  return envelope(plainConfidence(notes), {
    milestone: result.row,
    updated: result.updated,
    venture: venture.slug,
  });
}

// ---------------------------------------------------------------------------
// 5. set_outcome_target(venture, name, target_date, milestone_ids[])
// ---------------------------------------------------------------------------

export async function setOutcomeTarget(
  sql: Sql,
  input: {
    venture: string;
    name: string;
    target_date?: string | null;
    milestone_ids?: string[];
    indicators?: string[];
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

  const ventures = await sql<Array<{ id: string; slug: string }>>`
    select id, slug from ventures where slug = ${input.venture} or name = ${input.venture} limit 1
  `;
  const venture = ventures[0];
  if (!venture) {
    return envelope(plainConfidence([]), { outcome: null }, [
      { code: 'missing_venture', message: `venture "${input.venture}" does not exist` },
    ]);
  }

  const indicators = input.indicators ?? [
    'proposals_sent',
    'demos_booked',
    'follow_ups_open',
    'pipeline_count',
  ];

  const result = await sql.begin(async (tx) => {
    const existing = await tx<Array<{ id: string }>>`
      select id from outcome_targets
       where venture_id = ${venture.id} and name = ${input.name} limit 1
    `;
    const row = existing[0]
      ? (
          await tx<Array<Record<string, unknown>>>`
            update outcome_targets
               set target_date = ${input.target_date ?? null}::date,
                   indicator_config = ${tx.json({ indicators } as never)}
             where id = ${existing[0].id}
            returning id, name, target_date::text as target_date, status, indicator_config
          `
        )[0]!
      : (
          await tx<Array<Record<string, unknown>>>`
            insert into outcome_targets (venture_id, name, target_date, indicator_config)
            values (${venture.id}, ${input.name}, ${input.target_date ?? null}::date,
                    ${tx.json({ indicators } as never)})
            returning id, name, target_date::text as target_date, status, indicator_config
          `
        )[0]!;

    const outcomeId = String(row['id']);
    const linked: string[] = [];
    const unknown: string[] = [];
    for (const mid of input.milestone_ids ?? []) {
      const found = await tx<Array<{ id: string }>>`
        select id from milestones where id = ${mid} limit 1
      `;
      if (!found[0]) {
        unknown.push(mid);
        continue;
      }
      await tx`
        insert into outcome_milestones (outcome_id, milestone_id)
        values (${outcomeId}, ${mid}) on conflict do nothing
      `;
      linked.push(mid);
    }

    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: existing[0] ? 'outcome_updated' : 'outcome_set',
      venture_id: venture.id,
      result: { outcome: row, linked_milestones: linked },
    });

    return { row, linked, unknown, updated: Boolean(existing[0]) };
  });

  const notes = [
    'an outcome target is a result someone else decides: it drives NO demand, gets no slack, and is tracked only by its leading indicators (D1)',
  ];
  if (result.linked.length === 0) {
    notes.push(
      'no milestones are linked, so nothing you control is recorded as the cause of this outcome',
    );
  }
  const errors = result.unknown.length
    ? [
        {
          code: 'missing_milestone',
          message: `these milestone ids do not exist and were not linked: ${result.unknown.join(', ')}`,
          subjects: result.unknown,
        },
      ]
    : [];

  return envelope(
    plainConfidence(notes),
    {
      outcome: result.row,
      linked_milestones: result.linked,
      updated: result.updated,
      venture: venture.slug,
    },
    errors,
  );
}

// ---------------------------------------------------------------------------
// 6. capacity(available_hours) — THE MAIN TOOL
// ---------------------------------------------------------------------------

export async function capacity(
  sql: Sql,
  input: { available_hours: number },
): Promise<ToolEnvelope> {
  // Every database stage is timed and deadlined. capacity() is the tool most
  // likely to stall - it runs a function, then a dozen reads - and a stall here
  // is invisible without this: the platform logs nothing for a request that
  // never finishes.
  const expired = await timed('capacity.expire_milestones', 10_000, () =>
    sql<Array<{ n: number }>>`select taskos_expire_milestones() as n`,
  );
  const expiredCount = Number(expired[0]?.n ?? 0);

  const portfolio = await timed('capacity.load_portfolio', 15_000, () => loadPortfolio(sql));
  const pipeline = runEngine(portfolio);
  const result = runCapacity(portfolio, pipeline, input.available_hours);

  const ventureBySlug = new Map(portfolio.ventures.map((v) => [v.id, v.slug]));
  const shares = portfolio.ventures
    .filter((v) => v.active)
    .map((v) => ({
      venture: v.slug,
      share: r3(result.shareByVenture[v.id] ?? 0),
      hours_per_week: r1(result.allocatedHoursByVenture[v.id] ?? 0),
      required_hours_per_week: r1(pipeline.demand.requiredByVenture[v.id] ?? 0),
      floor: v.floor_share,
      ceiling: v.ceiling_share,
      below_floor: pipeline.demand.venturesBelowFloor.includes(v.id),
      at_ceiling: pipeline.demand.venturesAtCeiling.includes(v.id),
    }))
    .sort((a, b) => b.share - a.share);

  const slipList = narrow(
    result.slipCandidates.map((c, i) => ({
      rank_to_slip: i + 1,
      milestone: c.name,
      milestone_id: c.milestone_id,
      venture: ventureBySlug.get(c.venture_id) ?? c.venture_id,
      hardness: c.hardness,
      cost_of_slip: c.cost_of_slip,
      min_slack_days: c.minSlack,
      hours_freed_per_week: r1(c.hoursFreed),
      cumulative_hours_freed: r1(c.cumulativeHoursFreed),
      clears_deficit: c.clearsDeficit,
    })),
  );

  const notes = [...result.confidence.notes];
  if (expiredCount > 0) {
    notes.unshift(
      `${expiredCount} milestone(s) were past due and have just been flipped to missed`,
    );
  }
  for (const u of pipeline.unparsedRecurrences) notes.push(u.reason);

  const confidence: Confidence = { ...result.confidence, notes };

  return envelope(
    confidence,
    {
      question: 'given these hours and these milestones, what is going to slip?',
      verdict: result.verdict,
      hours: {
        available: r1(result.availableHours),
        recurring_overhead: r1(result.recurringHours),
        buffer: r1(result.bufferHours),
        buffer_ratio: result.bufferRatio,
        usable: r1(result.usableHours),
        required: r1(result.requiredHours),
        deficit: r1(result.deficitHours),
        surplus: r1(result.surplusHours),
      },
      shares,
      slip_order: slipList.items,
      slip_order_total: slipList.total,
      ...(slipList.truncated ? { slip_order_truncated: slipList.truncated } : {}),
      protect_first: result.rankedBySlipCost.slice(0, 3).map((m) => ({
        milestone: m.name,
        hardness: m.hardness,
        cost_of_slip: m.cost_of_slip,
        min_slack_days: m.minSlack,
      })),
      deficit_closes_after_slipping:
        result.coversDeficitAtIndex === null
          ? null
          : result.slipCandidates
              .slice(0, result.coversDeficitAtIndex + 1)
              .map((c) => c.name),
    },
    [...pipeline.demand.errors, ...pipeline.slack.errors].map((e) => ({
      code: e.code,
      message: e.message,
      ...(e.subjects ? { subjects: e.subjects } : {}),
    })),
  );
}

// ---------------------------------------------------------------------------
// 7. venture_status(slug)
// ---------------------------------------------------------------------------

export async function ventureStatus(sql: Sql, input: { slug: string }): Promise<ToolEnvelope> {
  const portfolio = await loadPortfolio(sql);
  const venture = portfolio.ventures.find(
    (v) => v.slug === input.slug || v.name.toLowerCase() === input.slug.toLowerCase(),
  );
  if (!venture) {
    return envelope(
      plainConfidence([`known slugs: ${portfolio.ventures.map((v) => v.slug).join(', ')}`]),
      { venture: null },
      [{ code: 'missing_venture', message: `venture "${input.slug}" does not exist` }],
    );
  }

  const pipeline = runEngine(portfolio);
  const milestones = portfolio.milestones.filter((m) => m.venture_id === venture.id);

  const milestoneRows = milestones.map((m) => {
    const detail = pipeline.demand.milestoneDetail.find((d) => d.milestone_id === m.id);
    return {
      milestone: m.name,
      milestone_id: m.id,
      due_date: m.due_date,
      status: m.status,
      hardness: m.hardness,
      days_until_due: daysBetween(portfolio.today, m.due_date, portfolio.settings.active_tz),
      min_slack_days: pipeline.slack.minSlackByMilestone[m.id] ?? null,
      coverage: pipeline.coverage.byMilestone[m.id] ?? null,
      coverage_trusted: !pipeline.coverage.lowConfidence.includes(m.id),
      required_hours_per_week: detail ? r1(detail.requiredHours) : null,
      pressure: detail ? r3(detail.pressure) : null,
      demand_used_fallback: detail?.usedFallback ?? null,
    };
  });

  const blockingAll = portfolio.tasks
    .filter(
      (t) =>
        t.venture_id === venture.id &&
        t.criticality === 'blocking' &&
        t.status !== 'done' &&
        t.status !== 'killed',
    )
    .map((t) => ({
      task_id: t.id,
      title: t.title,
      status: t.status,
      estimate_minutes: t.estimate_minutes,
      slack_days: pipeline.slack.slack.get(t.id) ?? null,
      slack_unknown_because: pipeline.slack.nullReasons.get(t.id) ?? null,
      milestone_id: t.milestone_id ?? null,
    }))
    .sort((a, b) => {
      if (a.slack_days === null) return 1;
      if (b.slack_days === null) return -1;
      return a.slack_days - b.slack_days;
    });
  const blocking = narrow(blockingAll);

  // Leading indicators for outcome targets. V1 has no verification integrations,
  // so an indicator's count comes from events recorded under that verb — and a
  // zero is reported as "nothing recorded", not as evidence of zero activity.
  const outcomes = portfolio.outcomeTargets.filter((o) => o.venture_id === venture.id);
  const indicatorRows: Array<Record<string, unknown>> = [];
  for (const o of outcomes) {
    const names = Array.isArray((o.indicator_config as { indicators?: unknown }).indicators)
      ? ((o.indicator_config as { indicators: string[] }).indicators)
      : [];
    const counts: Record<string, number | null> = {};
    for (const name of names) {
      const rows = await sql<Array<{ n: string }>>`
        select count(*)::text as n from events
         where verb = ${name} and venture_id = ${venture.id}
      `;
      const n = Number(rows[0]?.n ?? 0);
      counts[name] = n === 0 ? null : n;
    }
    indicatorRows.push({
      outcome: o.name,
      outcome_id: o.id,
      target_date: o.target_date,
      status: o.status,
      caused_by_milestones: portfolio.outcomeMilestones
        .filter((l) => l.outcome_id === o.id)
        .map((l) => portfolio.milestones.find((m) => m.id === l.milestone_id)?.name ?? l.milestone_id),
      indicators: counts,
      note: 'an outcome target drives no demand and has no slack: only these indicators move it (D1). A null count means nothing has been recorded, not that the answer is zero.',
    });
  }

  const top5 = pipeline.scores.scores
    .filter((s) => s.venture_id === venture.id && s.score > 0)
    .slice(0, 5)
    .map((s) => ({
      task_id: s.task_id,
      title: s.title,
      score: r3(s.score),
      why: {
        value: s.components.value,
        urgency: s.components.urgencyReason,
        blocks_others: s.components.directlyBlockedCount,
        unblocks_another_person: s.components.unblocksAnotherPerson,
      },
    }));

  const notes = [...pipeline.demand.confidence.notes];
  if (!venture.active) notes.push(`${venture.slug} is inactive: it takes no share of the week`);
  const debt = venture.attention_debt_hours ?? 0;
  if (debt > 0) {
    notes.push(
      `attention debt on ${venture.slug} stands at ${r1(debt)} h${
        (portfolio.daysSinceStart ?? 0) >= 21 ? '' : ', and cannot be released until day 21 (D4)'
      }`,
    );
  }

  return envelope({ ...pipeline.demand.confidence, notes }, {
    venture: {
      slug: venture.slug,
      name: venture.name,
      strategic_weight: venture.strategic_weight,
      share: r3(pipeline.demand.shareByVenture[venture.id] ?? 0),
      required_hours_per_week: r1(pipeline.demand.requiredByVenture[venture.id] ?? 0),
      active: venture.active,
    },
    milestones: milestoneRows,
    blocking_tasks: blocking.items,
    blocking_tasks_total: blocking.total,
    ...(blocking.truncated ? { blocking_tasks_truncated: blocking.truncated } : {}),
    outcome_targets: indicatorRows,
    top_tasks: top5,
    needs_triage: pipeline.scores.needsTriage.filter((t) => t.venture_id === venture.id),
  });
}

// ---------------------------------------------------------------------------
// 8. list_tasks(filter)
// ---------------------------------------------------------------------------

export interface ListFilter {
  venture?: string;
  status?: Task['status'];
  criticality?: Task['criticality'];
  needs_triage?: boolean;
  milestone?: string;
}

export async function listTasks(sql: Sql, filter: ListFilter): Promise<ToolEnvelope> {
  const portfolio = await loadPortfolio(sql);
  const pipeline = runEngine(portfolio);

  let venture = null as null | (typeof portfolio.ventures)[number];
  if (filter.venture) {
    venture =
      portfolio.ventures.find(
        (v) => v.slug === filter.venture || v.name.toLowerCase() === filter.venture!.toLowerCase(),
      ) ?? null;
    if (!venture) {
      return envelope(plainConfidence([]), { tasks: [], total: 0 }, [
        { code: 'missing_venture', message: `venture "${filter.venture}" does not exist` },
      ]);
    }
  }

  const triageIds = new Set(pipeline.scores.needsTriage.map((t) => t.task_id));
  const scoreById = new Map(pipeline.scores.scores.map((s) => [s.task_id, s.score]));

  const matched = portfolio.tasks.filter((t) => {
    if (venture && t.venture_id !== venture.id) return false;
    if (filter.status && t.status !== filter.status) return false;
    if (filter.criticality && t.criticality !== filter.criticality) return false;
    if (filter.milestone) {
      const m = portfolio.milestones.find(
        (x) => x.id === filter.milestone || x.name === filter.milestone,
      );
      if (!m || t.milestone_id !== m.id) return false;
    }
    if (filter.needs_triage === true && !triageIds.has(t.id)) return false;
    if (filter.needs_triage === false && triageIds.has(t.id)) return false;
    // Closed work is not listed unless it was asked for by status.
    if (!filter.status && (t.status === 'done' || t.status === 'killed')) return false;
    return true;
  });

  const ventureBySlug = new Map(portfolio.ventures.map((v) => [v.id, v.slug]));
  const rows = matched
    .map((t) => ({
      task_id: t.id,
      title: t.title,
      venture: ventureBySlug.get(t.venture_id) ?? t.venture_id,
      status: t.status,
      criticality: t.criticality,
      context: t.context,
      estimate_minutes: t.estimate_minutes,
      value: t.value,
      deadline_date: t.deadline_date ?? null,
      slack_days: pipeline.slack.slack.get(t.id) ?? null,
      score: r3(scoreById.get(t.id) ?? 0),
      snooze_count: t.snooze_count,
      needs_triage: triageIds.has(t.id),
    }))
    .sort((a, b) => b.score - a.score || (a.task_id < b.task_id ? -1 : 1));

  const list = narrow(rows);
  const notes: string[] = [];
  if (list.total === 0) {
    notes.push(
      `nothing matched that filter (${JSON.stringify(filter)}) — the filter is the reason, not an empty system`,
    );
  }
  if (filter.needs_triage) {
    notes.push('these have been snoozed three times or more: they need a decision, not a ranking');
  }

  return envelope(plainConfidence(notes), {
    filter,
    tasks: list.items,
    total: list.total,
    cap: LIST_CAP,
    ...(list.truncated ? { truncated: list.truncated } : {}),
  });
}

// ---------------------------------------------------------------------------
// 9. close(task_id, actual_minutes?, evidence?, idempotency_key?)
// ---------------------------------------------------------------------------

/**
 * D6. Never prompts on every close.
 *   1. the estimate is recorded as a provisional actual, inferred = true
 *   2. a volunteered duration is recorded with inferred = false
 *   3. at most once a day, the response asks about ONE completed task,
 *      preferring deep_work
 * Only inferred = false rows feed calibration.
 */
export async function close(
  sql: Sql,
  input: {
    task_id: string;
    actual_minutes?: number;
    evidence?: string;
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

  const existing = await sql<
    Array<{ id: string; status: string; title: string; context: string; estimate_minutes: number }>
  >`
    select id, status, title, context, estimate_minutes from tasks where id = ${input.task_id}
  `;
  const task = existing[0];
  if (!task) {
    return envelope(plainConfidence([]), { closed: null }, [
      { code: 'no_input', message: `task ${input.task_id} does not exist` },
    ]);
  }

  // D3: closing an already-done task returns success and mutates nothing.
  if (task.status === 'done') {
    return envelope(
      plainConfidence(['already done: nothing was changed']),
      { closed: { task_id: task.id, title: task.title, status: 'done' }, mutated: false },
    );
  }
  if (task.status === 'killed') {
    return envelope(plainConfidence(['this task was killed, not done: nothing was changed']), {
      closed: { task_id: task.id, title: task.title, status: 'killed' },
      mutated: false,
    });
  }

  const volunteered =
    typeof input.actual_minutes === 'number' &&
    Number.isFinite(input.actual_minutes) &&
    input.actual_minutes > 0;
  const actual = volunteered ? Math.round(input.actual_minutes!) : task.estimate_minutes;

  const result = await sql.begin(async (tx) => {
    await tx`
      update tasks
         set status = 'done',
             actual_minutes = ${actual},
             actual_inferred = ${!volunteered},
             last_touched_at = now()
       where id = ${task.id}
    `;

    if (input.evidence) {
      await tx`
        insert into events (actor, verb, task_id, payload)
        values (${ACTOR}, 'evidence', ${task.id}, ${tx.json({ evidence: input.evidence } as never)})
      `;
    }

    // Only inferred = false rows feed calibration, so recompute from those alone.
    let calibration: { ratio: number; sample_n: number } | null = null;
    if (volunteered) {
      const rows = await tx<Array<{ ratio: string; n: string }>>`
        select coalesce(sum(actual_minutes)::numeric / nullif(sum(estimate_minutes), 0), 1.0)::text as ratio,
               count(*)::text as n
          from tasks
         where context = ${task.context}
           and actual_inferred = false
           and actual_minutes is not null
           and status = 'done'
      `;
      const ratio = Number(rows[0]?.ratio ?? 1);
      const n = Number(rows[0]?.n ?? 0);
      await tx`
        insert into calibration (context, ratio, sample_n)
        values (${task.context}, ${ratio}, ${n})
        on conflict (context) do update set ratio = excluded.ratio, sample_n = excluded.sample_n
      `;
      calibration = { ratio, sample_n: n };
    }

    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: ACTOR,
      verb: 'closed',
      task_id: task.id,
      result: {
        closed: { task_id: task.id, title: task.title, status: 'done' },
        actual_minutes: actual,
        actual_inferred: !volunteered,
      },
    });

    return { calibration };
  });

  // D6 rule 3: at most one question a day, preferring deep_work.
  const askedToday = await sql<Array<{ n: string }>>`
    select count(*)::text as n from events
     where verb = 'asked_actual'
       and at >= (taskos_today()::timestamptz)
  `;
  let askAbout: { task_id: string; title: string; estimate_minutes: number } | null = null;
  if (Number(askedToday[0]?.n ?? 0) === 0) {
    const candidates = await sql<
      Array<{ id: string; title: string; estimate_minutes: number }>
    >`
      select id, title, estimate_minutes from tasks
       where status = 'done' and actual_inferred = true
       order by (context = 'deep_work') desc, closed_at desc nulls last
       limit 1
    `;
    const c = candidates[0];
    if (c) {
      askAbout = { task_id: c.id, title: c.title, estimate_minutes: c.estimate_minutes };
      await sql`
        insert into events (actor, verb, task_id, payload)
        values ('system', 'asked_actual', ${c.id}, ${sql.json({ reason: 'daily single question (D6)' } as never)})
      `;
    }
  }

  const notes: string[] = [];
  if (volunteered) {
    notes.push(
      `recorded ${actual} minutes as a real measurement; calibration for ${task.context} is now ratio ${r3(result.calibration?.ratio ?? 1)} over ${result.calibration?.sample_n ?? 0} sample(s)`,
    );
    if ((result.calibration?.sample_n ?? 0) < 8) {
      notes.push(
        `that context still has fewer than 8 samples, so its ratio is not being applied yet (D4)`,
      );
    }
  } else {
    notes.push(
      `no duration was volunteered, so the ${task.estimate_minutes}-minute estimate was recorded as a provisional actual and marked inferred; it will NOT feed calibration (D6)`,
    );
  }

  return envelope(plainConfidence(notes), {
    closed: { task_id: task.id, title: task.title, status: 'done' },
    mutated: true,
    actual_minutes: actual,
    actual_inferred: !volunteered,
    calibration: result.calibration,
    ask_about: askAbout,
    ...(askAbout
      ? {
          ask_about_note:
            'one question a day, no more: how long did this actually take? Answer it and the estimate becomes a measurement.',
        }
      : {}),
  });
}

export type { Portfolio };
