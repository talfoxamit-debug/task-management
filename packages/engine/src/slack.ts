import { taskDurationDays } from './constants.js';
import { ancestorsOf, buildGraph, nodesOnCycles, topoOrder } from './graph.js';
import { addDays, daysBetween, DEFAULT_TZ } from './time.js';
import type { Dependency, EngineError, Milestone, Task } from './types.js';
import { isClosed, isOnPath } from './types.js';

/**
 * computeSlack — a backward walk from each milestone through the dependency
 * graph.
 *
 *   latestStart[t] = milestone.due_date - longestRemainingChainThrough(t)
 *   slack[t]       = daysBetween(today, latestStart[t])
 *
 * longestRemainingChainThrough(t) is the longest chain of work from t forward to
 * a sink inside the milestone's set, counting t's own duration. It is the work
 * that still has to happen after t starts, so it is what pushes the milestone.
 *
 * Only blocking and enabling tasks participate. Recurring tasks never do (D5):
 * they are fixed overhead, not critical path. Closed tasks never do either.
 *
 * A task feeding more than one active milestone takes the MINIMUM slack: the
 * tightest milestone is the one that governs it.
 *
 * Returns null for a task when no active milestone can be reached from it,
 * including tasks that do not participate at all. `nullReasons` says why, so an
 * empty answer always carries a reason (D7).
 */

export interface SlackResult {
  /** Total map: every task id in the input appears. */
  slack: Map<string, number | null>;
  /** Why a given task's slack is null. */
  nullReasons: Map<string, string>;
  /** Longest remaining chain in days, per task, per milestone. */
  chainDaysByMilestone: Record<string, Record<string, number>>;
  latestStartByMilestone: Record<string, Record<string, string>>;
  slackByMilestone: Record<string, Record<string, number>>;
  minSlackByMilestone: Record<string, number | null>;
  /** Tasks the walk could not trust because they sit on a cycle. */
  cyclicTasks: string[];
  /**
   * True when any milestone could not be walked. Callers fall back to
   * deadline-only urgency for the affected tasks and say so (D7).
   */
  degraded: boolean;
  errors: EngineError[];
  notes: string[];
}

export interface SlackOptions {
  tz?: string;
}

export function computeSlack(
  tasks: readonly Task[],
  deps: readonly Dependency[],
  milestones: readonly Milestone[],
  today: string,
  options: SlackOptions = {},
): SlackResult {
  const tz = options.tz ?? DEFAULT_TZ;
  const errors: EngineError[] = [];
  const notes: string[] = [];
  const slack = new Map<string, number | null>();
  const nullReasons = new Map<string, string>();
  const chainDaysByMilestone: Record<string, Record<string, number>> = {};
  const latestStartByMilestone: Record<string, Record<string, string>> = {};
  const slackByMilestone: Record<string, Record<string, number>> = {};
  const minSlackByMilestone: Record<string, number | null> = {};
  let degraded = false;

  for (const t of tasks) slack.set(t.id, null);

  // `today` is an explicit argument and must be usable; without it nothing can
  // be computed, so this is the one case that returns an empty result — with a
  // reason attached.
  if (daysBetween(today, today, tz) === null) {
    errors.push({
      code: 'bad_date',
      message: `today "${today}" is not a calendar date, no slack can be computed`,
    });
    for (const t of tasks) nullReasons.set(t.id, 'today is unparseable');
    return {
      slack,
      nullReasons,
      chainDaysByMilestone,
      latestStartByMilestone,
      slackByMilestone,
      minSlackByMilestone,
      cyclicTasks: [],
      degraded: true,
      errors,
      notes,
    };
  }

  const participants = new Set<string>();
  for (const t of tasks) {
    if (!isOnPath(t)) {
      nullReasons.set(t.id, `criticality ${t.criticality}: not on the critical path`);
      continue;
    }
    if (t.is_recurring) {
      nullReasons.set(t.id, 'recurring: fixed overhead, never on the critical path (D5)');
      continue;
    }
    if (isClosed(t)) {
      nullReasons.set(t.id, `status ${t.status}: already closed`);
      continue;
    }
    participants.add(t.id);
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const graph = buildGraph(participants, deps);
  const cyclic = nodesOnCycles(graph);
  if (cyclic.size > 0) {
    degraded = true;
    const listed = [...cyclic].sort();
    errors.push({
      code: 'dependency_cycle',
      message: `${listed.length} task(s) sit on a dependency cycle; their slack cannot be computed`,
      subjects: listed,
    });
    notes.push(
      `slack walk degraded: a dependency cycle involves ${listed.length} task(s) — fall back to deadline-only urgency for them`,
    );
  }

  const activeMilestones = milestones.filter((m) => m.status === 'active');
  if (activeMilestones.length === 0) {
    errors.push({
      code: 'no_input',
      message:
        milestones.length === 0
          ? 'no milestones supplied: slack is meaningless without a date to work back from'
          : 'no ACTIVE milestones: every milestone is hit, missed or dropped',
    });
    for (const id of participants) {
      if (!nullReasons.has(id)) nullReasons.set(id, 'no active milestone exists');
    }
    return {
      slack,
      nullReasons,
      chainDaysByMilestone,
      latestStartByMilestone,
      slackByMilestone,
      minSlackByMilestone,
      cyclicTasks: [...cyclic].sort(),
      degraded,
      errors,
      notes,
    };
  }

  for (const m of activeMilestones) {
    // Anchors: participating tasks explicitly attached to this milestone.
    // Members: the anchors plus everything upstream of them, so a task that
    // carries no milestone_id but blocks one that does still gets slack.
    const anchors = tasks
      .filter((t) => t.milestone_id === m.id && participants.has(t.id))
      .map((t) => t.id);
    const members = ancestorsOf(graph, anchors, participants);

    if (members.size === 0) {
      minSlackByMilestone[m.id] = null;
      notes.push(
        `${m.name}: no open blocking or enabling tasks are attached to it, so it has no critical path and no slack`,
      );
      continue;
    }

    if ([...members].some((id) => cyclic.has(id))) {
      minSlackByMilestone[m.id] = null;
      const involved = [...members].filter((id) => cyclic.has(id)).sort();
      errors.push({
        code: 'degraded_slack',
        message: `${m.name}: dependency cycle in its task set, slack skipped for this milestone`,
        subjects: involved,
      });
      for (const id of members) {
        if (!nullReasons.has(id)) {
          nullReasons.set(id, `on or behind a dependency cycle feeding ${m.name}`);
        }
      }
      continue;
    }

    const order = topoOrder(graph, members);
    if (order === null) {
      // Unreachable given the cycle check above; kept so a future change to the
      // cycle handling degrades instead of hanging.
      degraded = true;
      minSlackByMilestone[m.id] = null;
      errors.push({
        code: 'degraded_slack',
        message: `${m.name}: could not order its task set, slack skipped`,
        subjects: [...members].sort(),
      });
      continue;
    }

    // Longest remaining chain, computed in reverse topological order so every
    // successor is already known when a node is visited.
    const chain = new Map<string, number>();
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const id = order[i]!;
      const task = byId.get(id)!;
      let longestAfter = 0;
      for (const s of graph.successors.get(id) ?? []) {
        if (!members.has(s)) continue;
        longestAfter = Math.max(longestAfter, chain.get(s) ?? 0);
      }
      chain.set(id, taskDurationDays(task) + longestAfter);
    }

    const chainOut: Record<string, number> = {};
    const latestOut: Record<string, string> = {};
    const slackOut: Record<string, number> = {};
    let minSlack: number | null = null;
    let dateFailed = false;

    for (const id of order) {
      const chainDays = chain.get(id)!;
      const latestStart = addDays(m.due_date, -chainDays, tz);
      const s = latestStart === null ? null : daysBetween(today, latestStart, tz);
      if (latestStart === null || s === null) {
        dateFailed = true;
        continue;
      }
      chainOut[id] = chainDays;
      latestOut[id] = latestStart;
      slackOut[id] = s;
      minSlack = minSlack === null ? s : Math.min(minSlack, s);

      // A task feeding several milestones takes the tightest one.
      const existing = slack.get(id);
      slack.set(id, existing === null || existing === undefined ? s : Math.min(existing, s));
      nullReasons.delete(id);
    }

    if (dateFailed) {
      degraded = true;
      errors.push({
        code: 'bad_date',
        message: `${m.name}: due_date "${m.due_date}" is not a calendar date, its slack is incomplete`,
        subjects: [m.id],
      });
      notes.push(
        `${m.name}: unusable due_date, slack for its tasks fell back to deadline-only urgency`,
      );
    }

    chainDaysByMilestone[m.id] = chainOut;
    latestStartByMilestone[m.id] = latestOut;
    slackByMilestone[m.id] = slackOut;
    minSlackByMilestone[m.id] = minSlack;

    if (minSlack !== null && minSlack < 0) {
      notes.push(
        `${m.name}: negative slack — its critical path already needed to start ${Math.abs(minSlack)} day(s) ago`,
      );
    }
  }

  for (const id of participants) {
    if (slack.get(id) === null && !nullReasons.has(id)) {
      nullReasons.set(id, 'no active milestone is reachable from this task');
    }
  }

  return {
    slack,
    nullReasons,
    chainDaysByMilestone,
    latestStartByMilestone,
    slackByMilestone,
    minSlackByMilestone,
    cyclicTasks: [...cyclic].sort(),
    degraded,
    errors,
    notes,
  };
}
