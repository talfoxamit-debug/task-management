import { resolveWorkspaceId, today as todayFor, type Sql } from './db.js';
import { loadPortfolio } from './load.js';
import { runEngine } from './pipeline.js';
import { envelope, plainConfidence, type ToolEnvelope } from './narrow.js';

/**
 * The day, laid into hours.
 *
 * next_actions answers "what now" and returns a ranking. This answers "what
 * does today look like" and returns an ORDER with times against it, which is a
 * different and strictly harder question: a ranking can ignore that finishing A
 * is what makes B startable, and a plan cannot.
 *
 * THE ONE THING THIS DOES THAT next_actions CANNOT is chain dependent work
 * inside a single day. next_actions excludes any task with an open blocker,
 * full stop — correct for "what can I start right now", wrong for a plan, where
 * "do A at 09:00, then B at 10:30 because A is what unblocks it" is exactly the
 * answer wanted. So the scheduler below places a task whose blockers are either
 * finished OR already placed earlier the same day.
 *
 * IT STILL INVENTS NOTHING. The scores come from the engine, the durations from
 * the estimates, the hours from settings. Where an input is missing the plan
 * says so and stops, rather than assuming a nine-to-five that would put work in
 * hours nobody works.
 */

export interface PlanSlot {
  start: string;
  end: string;
  task_id: string;
  title: string;
  venture: string;
  minutes: number;
  /** Set when this is a review of something Claude drafted, not the work itself. */
  review_of_draft?: boolean;
  /** Set when Claude COULD draft it but has not yet. */
  ai_can_prepare?: boolean;
  /** Titles of same-day tasks that had to finish first. */
  after?: string[];
  unblocks?: number;
  uses_flex?: boolean;
  why: string;
}

export interface DayPlan {
  date: string;
  working: boolean;
  day_venture: string | null;
  window: { start_hour: number; end_hour: number } | null;
  slots: PlanSlot[];
  unplaced: Array<{ title: string; minutes: number; reason: string }>;
  to_prepare: Array<{ task_id: string; title: string; by: string; review_minutes: number }>;
  notes: string[];
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function clock(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = Math.round(minutesFromMidnight % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Round up to the next quarter hour, so slots read like a calendar. */
function toQuarter(minutes: number): number {
  return Math.ceil(minutes / 15) * 15;
}

export async function buildDayPlan(
  sql: Sql,
  input: { date?: string; start_hour?: number; end_hour?: number } = {},
): Promise<DayPlan> {
  const workspaceId = await resolveWorkspaceId(sql);
  const date = input.date ?? (await todayFor(sql, workspaceId));
  const notes: string[] = [];

  const dowRows = await sql<Array<{ d: number }>>`
    select extract(dow from ${date}::date)::int as d`;
  const dow = dowRows[0]!.d;

  const cfg = await sql<
    Array<{
      primary_venture_id: string | null;
      primary_name: string | null;
      flex_minutes: number | null;
      is_working_day: boolean | null;
      day_start: number | null;
      day_end: number | null;
      set_start: number | null;
      set_end: number | null;
      buffer_ratio: string;
      weekly: string | null;
    }>
  >`
    select a.primary_venture_id, v.name as primary_name, a.flex_minutes, a.is_working_day,
           a.start_hour as day_start, a.end_hour as day_end,
           s.work_start_hour as set_start, s.work_end_hour as set_end,
           s.buffer_ratio, s.default_weekly_hours as weekly
      from settings s
      left join day_allocation a
        on a.workspace_id = s.workspace_id and a.day_of_week = ${dow}
      left join ventures v on v.id = a.primary_venture_id
     where s.workspace_id = ${workspaceId}`;
  const c = cfg[0]!;

  if (c.is_working_day === false) {
    return {
      date,
      working: false,
      day_venture: c.primary_name,
      window: null,
      slots: [],
      unplaced: [],
      to_prepare: [],
      notes: [`${DAYS[dow]} is not a working day`],
    };
  }

  const startHour = input.start_hour ?? c.day_start ?? c.set_start;
  const endHour = input.end_hour ?? c.day_end ?? c.set_end;

  if (startHour == null || endHour == null || endHour <= startHour) {
    // Assuming nine-to-five for somebody with 28 usable hours across six days
    // would put work in hours that are not worked and make every start time in
    // the plan wrong, silently.
    return {
      date,
      working: true,
      day_venture: c.primary_name,
      window: null,
      slots: [],
      unplaced: [],
      to_prepare: [],
      notes: [
        'the hours of your day are not on record, so there is nothing to lay a plan against',
        'set them with set_work_hours(start_hour, end_hour); a per-day override is available too',
      ],
    };
  }

  // ---------------------------------------------------------------------
  // Candidates, scored by the engine — never re-ranked here
  // ---------------------------------------------------------------------
  const portfolio = await loadPortfolio(sql, workspaceId);
  const pipeline = runEngine(portfolio);
  const scoreById = new Map(pipeline.scores.scores.map((s) => [s.task_id, s]));
  const ventureById = new Map(portfolio.ventures.map((v) => [v.id, v]));
  const milestoneById = new Map(portfolio.milestones.map((m) => [m.id, m]));
  const byId = new Map(portfolio.tasks.map((t) => [t.id, t]));

  /** taskId -> the ids that must finish before it. */
  const blockedBy = new Map<string, string[]>();
  const unblocksCount = new Map<string, number>();
  for (const d of portfolio.dependencies) {
    const list = blockedBy.get(d.blocks_task_id) ?? [];
    list.push(d.task_id);
    blockedBy.set(d.blocks_task_id, list);
    const blocker = byId.get(d.task_id);
    if (blocker && blocker.status !== 'done' && blocker.status !== 'killed') {
      unblocksCount.set(d.task_id, (unblocksCount.get(d.task_id) ?? 0) + 1);
    }
  }

  const prep = await sql<
    Array<{
      id: string;
      ai_preparable: boolean;
      prepared_at: Date | null;
      prepared_summary: string | null;
      review_minutes: number | null;
    }>
  >`
    select id, ai_preparable, prepared_at, prepared_summary, review_minutes
      from tasks where workspace_id = ${workspaceId} and status not in ('done', 'killed')`;
  const prepById = new Map(prep.map((p) => [p.id, p]));

  const spent = await sql<Array<{ used: number }>>`
    select coalesce(sum(minutes), 0)::int as used from day_flex_spent
     where workspace_id = ${workspaceId} and on_date = ${date}`;
  let flexLeft = Math.max(0, (c.flex_minutes ?? 0) - (spent[0]?.used ?? 0));

  const eligible = portfolio.tasks
    .filter(
      (t) =>
        !['done', 'killed', 'parked', 'inbox'].includes(t.status) &&
        !t.is_recurring &&
        // Somebody else's work is not part of Tal's day. It appears in the
        // delegated section of the brief, which is a different question.
        !t.assignee_person_id,
    )
    .map((t) => {
      const p = prepById.get(t.id);
      const milestone = t.milestone_id ? milestoneById.get(t.milestone_id) : null;
      const slack = milestone ? (pipeline.slack.minSlackByMilestone[milestone.id] ?? null) : null;
      const drafted = Boolean(p?.prepared_at);
      // A drafted task costs its review. An ai_preparable one WILL cost its
      // review, because the drafting is booked before Tal reaches it — booking
      // the full build would reserve hours that are not going to be spent.
      const cost =
        drafted || p?.ai_preparable ? (p?.review_minutes ?? 15) : t.estimate_minutes;
      return {
        task: t,
        score: scoreById.get(t.id)?.score ?? 0,
        venture: ventureById.get(t.venture_id),
        milestone,
        slack,
        drafted,
        preparable: Boolean(p?.ai_preparable) && !drafted,
        summary: p?.prepared_summary ?? null,
        cost: Math.max(5, cost),
        usesFlex: Boolean(c.primary_venture_id) && t.venture_id !== c.primary_venture_id,
      };
    });

  const eligibleIds = new Set(eligible.map((e) => e.task.id));
  const placed = new Set<string>();
  const placedTitles = new Map<string, string>();

  /**
   * Ready means: every blocker is finished, or is already placed EARLIER TODAY.
   *
   * The second half is the whole point of this module. A blocker that is itself
   * on today's plan is not an obstacle, it is the previous slot.
   */
  const ready = (id: string): { ok: true; after: string[] } | { ok: false; waiting: string[] } => {
    const blockers = blockedBy.get(id) ?? [];
    const waiting: string[] = [];
    const after: string[] = [];
    for (const b of blockers) {
      const t = byId.get(b);
      if (!t || t.status === 'done' || t.status === 'killed') continue;
      if (placed.has(b)) {
        after.push(placedTitles.get(b)!);
        continue;
      }
      waiting.push(t.title);
    }
    return waiting.length > 0 ? { ok: false, waiting } : { ok: true, after };
  };

  // ---------------------------------------------------------------------
  // Lay it out
  // ---------------------------------------------------------------------
  const windowStart = startHour * 60;
  const windowEnd = endHour * 60;
  let cursor = windowStart;

  // Time actually available is the window minus the buffer, so the plan does
  // not fill every minute of the day and then read as a failure by 11am.
  const buffer = Number(c.buffer_ratio);
  const usable = Math.floor((windowEnd - windowStart) * (1 - buffer));
  let used = 0;

  const slots: PlanSlot[] = [];
  const unplaced: Array<{ title: string; minutes: number; reason: string }> = [];
  const remaining = [...eligible].sort((a, b) => b.score - a.score);

  while (used < usable) {
    // Highest-scoring task that is startable given what is already placed.
    let pickIndex = -1;
    let pickAfter: string[] = [];
    for (let i = 0; i < remaining.length; i += 1) {
      const r = ready(remaining[i]!.task.id);
      if (!r.ok) continue;
      const cand = remaining[i]!;
      if (cand.usesFlex && cand.cost > flexLeft && !(cand.slack !== null && cand.slack < 0)) {
        continue;
      }
      if (used + cand.cost > usable && slots.length > 0) continue;
      pickIndex = i;
      pickAfter = r.after;
      break;
    }
    if (pickIndex === -1) break;

    const chosen = remaining.splice(pickIndex, 1)[0]!;
    const minutes = Math.min(toQuarter(chosen.cost), usable - used || chosen.cost);

    const reasons: string[] = [];
    if (chosen.drafted) {
      reasons.push(`review of a draft${chosen.summary ? `: ${chosen.summary}` : ''}`);
    } else if (chosen.preparable) {
      reasons.push('Claude drafts this first — this slot is your review');
    }
    if (chosen.milestone) {
      reasons.push(
        chosen.slack === null
          ? `feeds ${chosen.milestone.name}`
          : `blocks ${chosen.milestone.name}, ${chosen.slack}d slack`,
      );
    }
    const unblocks = unblocksCount.get(chosen.task.id) ?? 0;
    if (unblocks > 0) reasons.push(`unblocks ${unblocks}`);
    if (reasons.length === 0) reasons.push(`value ${chosen.task.value}`);

    slots.push({
      start: clock(cursor),
      end: clock(cursor + minutes),
      task_id: chosen.task.id,
      title: chosen.task.title,
      venture: chosen.venture?.name ?? '—',
      minutes,
      ...(chosen.drafted ? { review_of_draft: true } : {}),
      ...(chosen.preparable ? { ai_can_prepare: true } : {}),
      ...(pickAfter.length > 0 ? { after: pickAfter } : {}),
      ...(unblocks > 0 ? { unblocks } : {}),
      ...(chosen.usesFlex ? { uses_flex: true } : {}),
      why: reasons.join(', '),
    });

    placed.add(chosen.task.id);
    placedTitles.set(chosen.task.id, chosen.task.title);
    if (chosen.usesFlex) flexLeft = Math.max(0, flexLeft - minutes);
    cursor += minutes;
    used += minutes;
  }

  // What did not fit, and honestly why. Silence here would read as "that was
  // everything", which is the failure mode this whole system exists to avoid.
  for (const r of remaining.slice(0, 5)) {
    const check = ready(r.task.id);
    unplaced.push({
      title: r.task.title,
      minutes: r.cost,
      reason: check.ok
        ? 'no room left in the day'
        : `waiting on ${check.waiting.slice(0, 2).join(' and ')}`,
    });
  }

  // What Claude has to draft, and by when, for the plan above to be real.
  const toPrepare = slots
    .filter((s) => s.ai_can_prepare)
    .map((s) => ({
      task_id: s.task_id,
      title: s.title,
      by: s.start,
      review_minutes: s.minutes,
    }));

  if (toPrepare.length > 0) {
    notes.push(
      `${toPrepare.length} slot(s) are REVIEWS of work Claude has not drafted yet. They are booked at review length, so the plan is only honest if the drafting actually happens before the slot.`,
    );
  }
  const chained = slots.filter((s) => s.after && s.after.length > 0).length;
  if (chained > 0) {
    notes.push(
      `${chained} slot(s) are placed after work earlier in the same day that unblocks them — that ordering is the plan, not a suggestion`,
    );
  }
  notes.push(
    `${Math.round((used / 60) * 10) / 10}h placed of ${Math.round((usable / 60) * 10) / 10}h usable; the rest of the window is the ${Math.round(buffer * 100)}% buffer and whatever the day actually does to you`,
  );
  if (unplaced.length > 0) {
    notes.push(`${unplaced.length} shown as unplaced; there may be more behind them`);
  }

  return {
    date,
    working: true,
    day_venture: c.primary_name,
    window: { start_hour: startHour, end_hour: endHour },
    slots,
    unplaced,
    to_prepare: toPrepare,
    notes,
  };
}

/** The MCP tool wrapper. */
export async function dayPlan(
  sql: Sql,
  input: { date?: string; start_hour?: number; end_hour?: number } = {},
): Promise<ToolEnvelope> {
  const plan = await buildDayPlan(sql, input);
  return envelope(plainConfidence(plan.notes), {
    date: plan.date,
    is_working_day: plan.working,
    day_venture: plan.day_venture,
    window: plan.window,
    slots: plan.slots,
    unplaced: plan.unplaced,
    to_prepare: plan.to_prepare,
  });
}

/** Set the hours the day runs, globally or for one weekday. */
export async function setWorkHours(
  sql: Sql,
  input: { start_hour: number; end_hour: number; day_of_week?: number },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  if (input.end_hour <= input.start_hour) {
    return envelope(plainConfidence([]), { set: false }, [
      {
        code: 'bad_window',
        message: 'end_hour must be after start_hour — nothing was written',
      },
    ]);
  }

  if (input.day_of_week === undefined) {
    await sql`
      update settings set work_start_hour = ${input.start_hour}, work_end_hour = ${input.end_hour}
       where workspace_id = ${workspaceId}`;
    return envelope(
      plainConfidence(['this is the default; a weekday can override it with day_of_week']),
      { set: true, scope: 'all days', start_hour: input.start_hour, end_hour: input.end_hour },
    );
  }

  await sql`
    insert into day_allocation (workspace_id, day_of_week, start_hour, end_hour)
    values (${workspaceId}, ${input.day_of_week}, ${input.start_hour}, ${input.end_hour})
    on conflict (workspace_id, day_of_week)
    do update set start_hour = excluded.start_hour, end_hour = excluded.end_hour`;
  return envelope(plainConfidence([]), {
    set: true,
    scope: DAYS[input.day_of_week],
    start_hour: input.start_hour,
    end_hour: input.end_hour,
  });
}
