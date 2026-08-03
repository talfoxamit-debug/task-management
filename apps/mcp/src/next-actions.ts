import { resolveWorkspaceId, today as todayFor, type Sql } from './db.js';
import { loadPortfolio } from './load.js';
import { runEngine } from './pipeline.js';
import { envelope, narrow, plainConfidence, r1, type ToolEnvelope } from './narrow.js';

/**
 * What to actually pick up, right now, in the slot that exists.
 *
 * Every task already carried context, energy and estimate_minutes, and nothing
 * read them. list_tasks returns one global ranking, so at 2pm with ninety
 * minutes and no energy left, the top of the list was a 720-minute deep_work
 * task — correct as a ranking and useless as an answer.
 *
 * FOUR RULES, and the reasoning matters more than the code:
 *
 * 1. A task with open blockers is never returned. Not down-ranked, excluded.
 *    Suggesting work that cannot be started is the fastest way to make a
 *    recommendation list untrustworthy.
 *
 * 2. Energy is a HARD constraint; context is a soft one. Mismatched energy
 *    produces bad work, which has to be redone; mismatched context produces
 *    slow work, which merely costs time. So low energy excludes high-energy
 *    tasks outright, while a context mismatch only lowers the ranking.
 *
 * 3. A task larger than the slot is still returned, marked partial, with a
 *    suggested chunk. The 720-minute item is often the most important thing in
 *    the system, and a naive size filter would make it permanently invisible —
 *    the more it matters, the bigger it is, the less it is ever suggested.
 *
 * 4. Every action carries a one-line `why`. A ranked list without reasoning is
 *    a list. With it, it is a recommendation somebody can disagree with.
 */

export interface NextActionsInput {
  available_minutes: number;
  context?: string;
  energy?: 'high' | 'medium' | 'low';
  date?: string;
  limit?: number;
  ignore_day_allocation?: boolean;
}

const ENERGY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

export async function nextActions(sql: Sql, input: NextActionsInput): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const today = input.date ?? (await todayFor(sql, workspaceId));
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 15);

  const portfolio = await loadPortfolio(sql, workspaceId);
  const pipeline = runEngine(portfolio);

  // The day's rule, if one is set.
  const dow = await sql<Array<{ d: number }>>`
    select extract(dow from ${today}::date)::int as d`;
  const dayOfWeek = dow[0]!.d;

  const allocation = await sql<
    Array<{
      primary_venture_id: string | null;
      primary_slug: string | null;
      flex_minutes: number;
      is_working_day: boolean;
      note: string | null;
    }>
  >`
    select a.primary_venture_id, v.slug as primary_slug, a.flex_minutes,
           a.is_working_day, a.note
      from day_allocation a
      left join ventures v on v.id = a.primary_venture_id
     where a.workspace_id = ${workspaceId} and a.day_of_week = ${dayOfWeek}`;
  const day = allocation[0] ?? null;

  const notes: string[] = [];

  if (day && !day.is_working_day && !input.ignore_day_allocation) {
    return envelope(
      plainConfidence([
        `${today} is not a working day${day.note ? `: ${day.note}` : ''}`,
        'ask again with ignore_day_allocation:true if today really is being worked',
      ]),
      { actions: [], total: 0, is_working_day: false, date: today },
    );
  }

  const spent = await sql<Array<{ used: number }>>`
    select coalesce(sum(minutes), 0)::int as used from day_flex_spent
     where workspace_id = ${workspaceId} and on_date = ${today}`;
  const flexBudget = day?.flex_minutes ?? 0;
  const flexUsed = spent[0]?.used ?? 0;
  const flexLeft = Math.max(0, flexBudget - flexUsed);

  // Blocked-by is what makes a suggestion startable or not.
  const openBlockers = new Map<string, number>();
  const byId = new Map(portfolio.tasks.map((t) => [t.id, t]));
  for (const d of portfolio.dependencies) {
    const blocker = byId.get(d.task_id);
    const blocked = d.blocks_task_id;
    if (!blocker) continue;
    if (blocker.status === 'done' || blocker.status === 'killed') continue;
    openBlockers.set(blocked, (openBlockers.get(blocked) ?? 0) + 1);
  }

  // Preparation is read here rather than through the portfolio, because the
  // engine's Task type has no business knowing about it: nothing in slack,
  // coverage or demand depends on whether Claude has drafted something.
  const preparedRows = await sql<
    Array<{ id: string; prepared_summary: string | null; review_minutes: number | null }>
  >`
    select id, prepared_summary, review_minutes from tasks
     where workspace_id = ${workspaceId} and prepared_at is not null
       and status not in ('done', 'killed')`;
  const preparedById = new Map(preparedRows.map((r) => [r.id, r]));

  const scoreById = new Map(pipeline.scores.scores.map((s) => [s.task_id, s]));
  const ventureById = new Map(portfolio.ventures.map((v) => [v.id, v]));
  const milestoneById = new Map(portfolio.milestones.map((m) => [m.id, m]));

  const wantEnergy = input.energy ? (ENERGY_RANK[input.energy] ?? null) : null;

  const excluded = { blocked: 0, energy: 0, day: 0 };

  const candidates = portfolio.tasks
    .filter((t) => {
      if (t.status === 'done' || t.status === 'killed' || t.status === 'parked') return false;
      if (t.status === 'inbox') return false;
      if (t.is_recurring) return false;
      // Rule 1. Excluded, not down-ranked.
      if ((openBlockers.get(t.id) ?? 0) > 0) {
        excluded.blocked += 1;
        return false;
      }
      // Rule 2. Energy is hard.
      // energy is optional on a Task, and an unstated one must not be filtered
      // out: absent is not the same as high.
      const taskEnergy = t.energy ? (ENERGY_RANK[t.energy] ?? 1) : 1;
      if (wantEnergy !== null && taskEnergy > wantEnergy) {
        excluded.energy += 1;
        return false;
      }
      return true;
    })
    .map((t) => {
      const score = scoreById.get(t.id);
      const venture = ventureById.get(t.venture_id);
      const milestone = t.milestone_id ? milestoneById.get(t.milestone_id) : null;
      const slack = milestone ? (pipeline.slack.minSlackByMilestone[milestone.id] ?? null) : null;

      const isPrimary = day?.primary_venture_id ? t.venture_id === day.primary_venture_id : true;
      // A fire is never hidden behind a budget: negative slack surfaces even
      // when the flex for the day is gone, flagged so the exception is visible.
      const urgent = slack !== null && slack < 0;
      const usesFlex = !isPrimary && Boolean(day?.primary_venture_id);
      const flexExceeded = usesFlex && t.estimate_minutes > flexLeft;

      return {
        task: t,
        score: score?.score ?? 0,
        components: score?.components,
        venture,
        milestone,
        slack,
        isPrimary,
        usesFlex,
        flexExceeded,
        urgent,
        contextMatch: input.context ? t.context === input.context : true,
        prepared: preparedById.get(t.id) ?? null,
      };
    })
    .filter((c) => {
      if (input.ignore_day_allocation || !day?.primary_venture_id) return true;
      if (c.isPrimary) return true;
      if (c.urgent) return true; // do not hide a fire behind a budget
      if (c.flexExceeded && flexLeft <= 0) {
        excluded.day += 1;
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      // Prepared work first, always. Claude has already done the reading and
      // the drafting; what is left is minutes of judgement on something nearly
      // finished, which is the cheapest valuable time in the week. Burying it
      // under a fresh 2-hour task is the wrong trade every single time.
      const prep = Number(Boolean(b.prepared)) - Number(Boolean(a.prepared));
      if (prep !== 0) return prep;
      // Context is soft: a mismatch costs ranking, never eligibility.
      const ctx = Number(b.contextMatch) - Number(a.contextMatch);
      if (ctx !== 0) return ctx;
      return b.score - a.score;
    });

  const actions = candidates.slice(0, limit).map((c) => {
    // A prepared task costs its review, not its original estimate: the drafting
    // has happened. Falling back to the estimate would make a five-minute
    // review look like a two-hour job and it would never get picked up.
    const cost = c.prepared ? (c.prepared.review_minutes ?? 15) : c.task.estimate_minutes;
    const overSlot = cost > input.available_minutes;
    const reasons: string[] = [];
    if (c.milestone) {
      reasons.push(
        c.slack === null
          ? `feeds ${c.milestone.name}`
          : `blocks ${c.milestone.name}, ${c.slack} day${Math.abs(c.slack) === 1 ? '' : 's'} slack`,
      );
    }
    const unblocks = c.components?.directlyBlockedCount ?? 0;
    if (unblocks > 0) reasons.push(`unblocks ${unblocks}`);
    if (c.components?.urgencyReason && c.components.urgencyReason !== 'none') {
      reasons.push(c.components.urgencyReason.replace(/_/g, ' '));
    }
    if (c.prepared) {
      reasons.unshift(
        `DRAFTED and waiting on you${c.prepared.prepared_summary ? `: ${c.prepared.prepared_summary}` : ''}`,
      );
    }
    if (!c.contextMatch) reasons.push(`${c.task.context} work, not ${input.context}`);
    if (c.usesFlex) reasons.push(`off-plan for today, uses flex`);
    if (reasons.length === 0) reasons.push(`value ${c.task.value}`);

    return {
      task_id: c.task.id,
      title: c.task.title,
      venture: c.venture?.slug ?? '—',
      context: c.task.context,
      energy: c.task.energy,
      estimate_minutes: cost,
      ...(c.prepared
        ? { awaiting_review: true, full_estimate_minutes: c.task.estimate_minutes }
        : {}),
      score: Math.round(c.score * 10) / 10,
      why: reasons.join(', '),
      ...(overSlot
        ? {
            partial: true,
            suggested_chunk_minutes: input.available_minutes,
          }
        : {}),
      ...(c.usesFlex ? { uses_flex: true } : {}),
      ...(c.flexExceeded ? { flex_exceeded: true } : {}),
    };
  });

  if (day?.primary_slug) {
    notes.push(
      `${today} is a ${day.primary_slug} day; ${r1(flexLeft / 60)}h of flex remains for other ventures`,
    );
  }
  if (input.energy) {
    notes.push(
      `energy is a hard filter: ${excluded.energy} task(s) above ${input.energy} energy were excluded, because mismatched energy produces work that has to be redone`,
    );
  }
  if (excluded.blocked > 0) {
    notes.push(`${excluded.blocked} task(s) were excluded because their blockers are still open`);
  }
  if (excluded.day > 0) {
    notes.push(
      `${excluded.day} off-plan task(s) were excluded because the day's flex is spent; anything with negative slack was shown anyway`,
    );
  }
  const prepared = actions.filter((a) => 'awaiting_review' in a).length;
  if (prepared > 0) {
    notes.push(
      `${prepared} of these are already drafted and are shown first: what remains is your review, not the original estimate`,
    );
  }
  const partials = actions.filter((a) => 'partial' in a).length;
  if (partials > 0) {
    notes.push(
      `${partials} of these are larger than the slot and are shown anyway with a suggested chunk — a size filter would make the biggest and most important work permanently invisible`,
    );
  }
  if (actions.length === 0) {
    notes.push(
      'nothing matched: either everything is blocked, or the energy and day filters removed it all. Ask with ignore_day_allocation:true or a different energy to see what is behind them.',
    );
  }

  const list = narrow(actions, limit);
  return envelope(plainConfidence(notes), {
    date: today,
    slot_minutes: input.available_minutes,
    ...(input.context ? { context: input.context } : {}),
    ...(input.energy ? { energy: input.energy } : {}),
    day: day
      ? {
          primary_venture: day.primary_slug,
          flex_minutes: flexBudget,
          flex_used: flexUsed,
          flex_left: flexLeft,
        }
      : null,
    actions: list.items,
    total: candidates.length,
    is_working_day: day?.is_working_day ?? true,
  });
}

// ---------------------------------------------------------------------------
// Day allocation
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function setDayAllocation(
  sql: Sql,
  input: {
    days: Array<{
      day_of_week: number;
      venture?: string | null;
      flex_minutes?: number;
      is_working_day?: boolean;
      note?: string;
    }>;
  },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const errors: Array<{ code: string; message: string }> = [];
  const written: string[] = [];

  for (const d of input.days) {
    let ventureId: string | null = null;
    if (d.venture) {
      const rows = await sql<Array<{ id: string }>>`
        select id from ventures where workspace_id = ${workspaceId}
          and (slug = ${d.venture} or name = ${d.venture}) limit 1`;
      if (!rows[0]) {
        errors.push({
          code: 'unknown_venture',
          message: `venture "${d.venture}" does not exist — ${DAY_NAMES[d.day_of_week]} was not set`,
        });
        continue;
      }
      ventureId = rows[0].id;
    }

    await sql`
      insert into day_allocation (workspace_id, day_of_week, primary_venture_id,
                                  flex_minutes, is_working_day, note)
      values (${workspaceId}, ${d.day_of_week}, ${ventureId},
              ${d.flex_minutes ?? 90}, ${d.is_working_day ?? true}, ${d.note ?? null})
      on conflict (workspace_id, day_of_week) do update
        set primary_venture_id = excluded.primary_venture_id,
            flex_minutes = excluded.flex_minutes,
            is_working_day = excluded.is_working_day,
            note = excluded.note`;
    written.push(DAY_NAMES[d.day_of_week]!);
  }

  return envelope(
    plainConfidence([
      'flex is spent by CLOSING off-plan work, never by asking what to do — otherwise asking the question would spend the day',
      'flex does not roll over: each day starts at its own budget',
    ]),
    { set: written },
    errors,
  );
}

export async function getDayAllocation(sql: Sql, _input: object): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const rows = await sql<
    Array<{
      day_of_week: number;
      slug: string | null;
      flex_minutes: number;
      is_working_day: boolean;
      note: string | null;
    }>
  >`
    select a.day_of_week, v.slug, a.flex_minutes, a.is_working_day, a.note
      from day_allocation a
      left join ventures v on v.id = a.primary_venture_id
     where a.workspace_id = ${workspaceId}
     order by a.day_of_week`;

  return envelope(
    plainConfidence(
      rows.length === 0
        ? ['no day allocation is set, so every day treats every venture equally']
        : [],
    ),
    {
      days: rows.map((r) => ({
        day_of_week: r.day_of_week,
        day: DAY_NAMES[r.day_of_week],
        primary_venture: r.slug,
        flex_minutes: r.flex_minutes,
        is_working_day: r.is_working_day,
        note: r.note,
      })),
      total: rows.length,
    },
  );
}

/**
 * Record flex spent by closing an off-plan task.
 *
 * Called from close(), not from next_actions: a budget consumed by asking what
 * to do would be gone before any of it was worked.
 */
export async function recordFlexSpend(
  sql: Sql,
  workspaceId: string,
  taskId: string,
  minutes: number,
): Promise<void> {
  const rows = await sql<Array<{ off_plan: boolean; on_date: string }>>`
    select taskos_today(${workspaceId})::text as on_date,
           coalesce(a.primary_venture_id is not null and a.primary_venture_id <> t.venture_id,
                    false) as off_plan
      from tasks t
      left join day_allocation a
        on a.workspace_id = t.workspace_id
       and a.day_of_week = extract(dow from taskos_today(${workspaceId}))::int
     where t.id = ${taskId} and t.workspace_id = ${workspaceId}`;

  const row = rows[0];
  if (!row || !row.off_plan) return;

  await sql`
    insert into day_flex_spent (workspace_id, on_date, task_id, minutes, venture_id)
    select ${workspaceId}, ${row.on_date}::date, ${taskId}, ${minutes}, t.venture_id
      from tasks t where t.id = ${taskId}
    on conflict (workspace_id, on_date, task_id) do update set minutes = excluded.minutes`;
}
