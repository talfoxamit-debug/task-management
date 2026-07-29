import { buildConfidence, calibrationRatio } from './confidence.js';
import {
  EFFORT_EXPONENT,
  EFFORT_REFERENCE_MINUTES,
  HIGH_VALUE_THRESHOLD,
  LEVERAGE_PER_BLOCKED,
  LEVERAGE_UNBLOCKS_PERSON,
  SCORE_ANOMALY_MULTIPLE,
  SNOOZE_TRIAGE_THRESHOLD,
  TARGET_HORIZON_DAYS,
  URGENCY_BASE,
  URGENCY_DEADLINE_IN_LEAD_TIME,
  URGENCY_OVERDUE,
  URGENCY_TARGET_WITHIN_7,
  VALUE_EXPONENT,
  VALUE_INFLATION_MAX_FRACTION,
} from './constants.js';
import { daysBetween, DEFAULT_TZ } from './time.js';
import type {
  CalibrationRow,
  Confidence,
  Dependency,
  EngineError,
  Task,
  Venture,
} from './types.js';
import { CLOSED_STATUSES, OPEN_STATUSES } from './types.js';

/**
 * computeScore — what to do next.
 *
 *   U = 3.0 if overdue
 *       1.6 if a hard deadline falls within lead_time_days
 *       1.3 if target_date falls within 7 days
 *       1.0 otherwise
 *   L = 1 + 0.35 * directlyBlockedCount + (unblocksAnotherPerson ? 1.0 : 0)
 *   E = (estimate_minutes * calibration[context] / 30) ^ 0.6
 *   W = strategic_weight * balance
 *   score = (value ^ 1.2) * W * U * L / E
 *
 * `pressure` from computeDemand does NOT appear here and must never be added.
 * Deadline proximity is already the whole of U; multiplying it in a second time
 * pushes a single task to roughly 16x normal and erases four ventures from the
 * output. The two signals meet at the portfolio level, not inside one task.
 */

export type UrgencyReason = 'overdue' | 'deadline_within_lead_time' | 'target_within_7' | 'none';

export interface ScoreComponents {
  value: number;
  valueTerm: number;
  U: number;
  urgencyReason: UrgencyReason;
  L: number;
  directlyBlockedCount: number;
  unblocksAnotherPerson: boolean;
  E: number;
  calibrationRatio: number;
  calibrationApplied: boolean;
  W: number;
  strategicWeight: number;
  balance: number;
}

export interface TaskScore {
  task_id: string;
  venture_id: string;
  title: string;
  score: number;
  /** Set when the score is forced to zero, naming why. */
  zeroReason: string | null;
  components: ScoreComponents;
}

export interface ScoreContext {
  today: string;
  tz?: string;
  ventures: readonly Venture[];
  /** Every task in the portfolio: needed to see what this one unblocks. */
  tasks: readonly Task[];
  dependencies: readonly Dependency[];
  calibration?: readonly CalibrationRow[];
  /** Per-venture balance factor; 1.0 everywhere before day 14 (D4). */
  balanceByVenture?: Record<string, number>;
  daysOfEvents?: number | null;
  daysSinceStart?: number | null;
  /** True when the slack walk degraded, so the note can be carried (D7). */
  slackDegraded?: boolean;
}

/** Precomputed lookups so scoring a whole portfolio stays linear. */
interface PreparedContext extends ScoreContext {
  ventureById: Map<string, Venture>;
  taskById: Map<string, Task>;
  dependentsOf: Map<string, string[]>;
}

function prepare(ctx: ScoreContext): PreparedContext {
  const dependentsOf = new Map<string, string[]>();
  for (const d of ctx.dependencies) {
    const list = dependentsOf.get(d.task_id);
    if (list) {
      if (!list.includes(d.blocks_task_id)) list.push(d.blocks_task_id);
    } else {
      dependentsOf.set(d.task_id, [d.blocks_task_id]);
    }
  }
  return {
    ...ctx,
    ventureById: new Map(ctx.ventures.map((v) => [v.id, v])),
    taskById: new Map(ctx.tasks.map((t) => [t.id, t])),
    dependentsOf,
  };
}

/** U. Deadline first, then target date. Nothing else touches urgency. */
export function urgency(
  task: Task,
  today: string,
  tz: string,
): { U: number; reason: UrgencyReason } {
  if (task.deadline_date) {
    const days = daysBetween(today, task.deadline_date, tz);
    if (days !== null) {
      if (days < 0) return { U: URGENCY_OVERDUE, reason: 'overdue' };
      if (days <= task.lead_time_days) {
        return { U: URGENCY_DEADLINE_IN_LEAD_TIME, reason: 'deadline_within_lead_time' };
      }
    }
  }
  if (task.target_date) {
    const days = daysBetween(today, task.target_date, tz);
    // A target date already passed is still inside the horizon: a soft date does
    // not become less urgent by being missed.
    if (days !== null && days <= TARGET_HORIZON_DAYS) {
      return { U: URGENCY_TARGET_WITHIN_7, reason: 'target_within_7' };
    }
  }
  return { U: URGENCY_BASE, reason: 'none' };
}

function leverage(
  task: Task,
  ctx: PreparedContext,
): { L: number; directlyBlockedCount: number; unblocksAnotherPerson: boolean } {
  const dependents = (ctx.dependentsOf.get(task.id) ?? [])
    .map((id) => ctx.taskById.get(id))
    .filter((t): t is Task => t !== undefined && !CLOSED_STATUSES.includes(t.status));

  const directlyBlockedCount = dependents.length;
  const unblocksAnotherPerson = dependents.some(
    (d) => d.assignee_person_id != null && d.assignee_person_id !== task.assignee_person_id,
  );

  const L =
    1 +
    LEVERAGE_PER_BLOCKED * directlyBlockedCount +
    (unblocksAnotherPerson ? LEVERAGE_UNBLOCKS_PERSON : 0);
  return { L, directlyBlockedCount, unblocksAnotherPerson };
}

/** Score one task. `ctx` may be reused across calls. */
export function computeScore(task: Task, ctx: ScoreContext): TaskScore {
  return computeScorePrepared(task, prepare(ctx));
}

function computeScorePrepared(task: Task, ctx: PreparedContext): TaskScore {
  const tz = ctx.tz ?? DEFAULT_TZ;
  const venture = ctx.ventureById.get(task.venture_id);
  const strategicWeight = venture?.strategic_weight ?? 1.0;
  const balancingOn = ctx.balanceByVenture !== undefined;
  const balance = balancingOn ? (ctx.balanceByVenture![task.venture_id] ?? 1.0) : 1.0;
  const W = strategicWeight * balance;

  const ratio = calibrationRatio(ctx.calibration, task.context);
  const applied = ratio !== 1.0;
  // The schema forbids a non-positive estimate; clamp anyway so a hand-written
  // row cannot produce Infinity here.
  const minutes = Math.max(1, task.estimate_minutes);
  const E = Math.pow((minutes * ratio) / EFFORT_REFERENCE_MINUTES, EFFORT_EXPONENT);

  const { U, reason } = urgency(task, ctx.today, tz);
  const { L, directlyBlockedCount, unblocksAnotherPerson } = leverage(task, ctx);
  const valueTerm = Math.pow(Math.max(0, task.value), VALUE_EXPONENT);

  const components: ScoreComponents = {
    value: task.value,
    valueTerm,
    U,
    urgencyReason: reason,
    L,
    directlyBlockedCount,
    unblocksAnotherPerson,
    E,
    calibrationRatio: ratio,
    calibrationApplied: applied,
    W,
    strategicWeight,
    balance,
  };

  // Blocked or waiting work scores zero: it cannot be started, so ranking it
  // against startable work is noise.
  if (task.status === 'blocked' || task.status === 'waiting') {
    return {
      task_id: task.id,
      venture_id: task.venture_id,
      title: task.title,
      score: 0,
      zeroReason: `status ${task.status}: cannot be started`,
      components,
    };
  }

  const raw = (valueTerm * W * U * L) / E;
  const score = Number.isFinite(raw) ? Math.max(0, raw) : 0;

  return {
    task_id: task.id,
    venture_id: task.venture_id,
    title: task.title,
    score,
    zeroReason: Number.isFinite(raw) ? null : 'score was not finite, forced to zero',
    components,
  };
}

export interface TriageItem {
  task_id: string;
  title: string;
  venture_id: string;
  snooze_count: number;
  reason: string;
}

export interface ScoreAnomaly {
  task_id: string;
  title: string;
  score: number;
  median: number;
  multiple: number;
}

export interface ValueInflation {
  warned: boolean;
  highValueCount: number;
  openCount: number;
  fraction: number;
  allowed: number;
  excess: number;
  /** The tasks holding value >= 8, worst offenders first. */
  highValueTasks: Array<{ task_id: string; title: string; value: number }>;
}

export interface ScoreSetResult {
  /** Highest first. Includes blocked and waiting work at score 0. */
  scores: TaskScore[];
  /** Snoozed past the threshold: not scored, needs a decision instead. */
  needsTriage: TriageItem[];
  excluded: Array<{ task_id: string; reason: string }>;
  median: number;
  anomalies: ScoreAnomaly[];
  valueInflation: ValueInflation;
  errors: EngineError[];
  confidence: Confidence;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Score a whole portfolio and run the Part 4 assertions, which need the open set
 * as a whole rather than one task at a time.
 */
export function computeScores(tasks: readonly Task[], ctx: ScoreContext): ScoreSetResult {
  const prepared = prepare({ ...ctx, tasks: ctx.tasks.length > 0 ? ctx.tasks : tasks });
  const errors: EngineError[] = [];
  const notes: string[] = [];

  const scores: TaskScore[] = [];
  const needsTriage: TriageItem[] = [];
  const excluded: Array<{ task_id: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const t of tasks) {
    if (seen.has(t.id)) continue; // no task may appear twice in a returned list
    seen.add(t.id);

    if (!prepared.ventureById.has(t.venture_id)) {
      errors.push({
        code: 'missing_venture',
        message: `task ${t.id} belongs to venture ${t.venture_id}, which was not supplied; strategic weight defaulted to 1.0`,
        subjects: [t.id, t.venture_id],
      });
    }

    if (CLOSED_STATUSES.includes(t.status)) {
      excluded.push({ task_id: t.id, reason: `status ${t.status}: closed` });
      continue;
    }
    if (t.status === 'parked') {
      excluded.push({ task_id: t.id, reason: 'status parked: deliberately set down' });
      continue;
    }
    if (t.snooze_count >= SNOOZE_TRIAGE_THRESHOLD) {
      needsTriage.push({
        task_id: t.id,
        title: t.title,
        venture_id: t.venture_id,
        snooze_count: t.snooze_count,
        reason: `snoozed ${t.snooze_count} times: it needs a decision, not another ranking`,
      });
      excluded.push({ task_id: t.id, reason: `snoozed ${t.snooze_count} times` });
      continue;
    }

    scores.push(computeScorePrepared(t, prepared));
  }

  scores.sort((a, b) => (b.score - a.score) || (a.task_id < b.task_id ? -1 : 1));

  // The open set for the assertions below: startable work only. Including the
  // forced zeros from blocked and waiting tasks would drag the median down and
  // make every real score look like an anomaly.
  const openScores = scores.filter((s) => {
    const t = prepared.taskById.get(s.task_id);
    return t !== undefined && OPEN_STATUSES.includes(t.status);
  });
  const med = median(openScores.map((s) => s.score));

  const anomalies: ScoreAnomaly[] = [];
  if (med > 0) {
    for (const s of openScores) {
      if (s.score > SCORE_ANOMALY_MULTIPLE * med) {
        const multiple = s.score / med;
        anomalies.push({
          task_id: s.task_id,
          title: s.title,
          score: s.score,
          median: med,
          multiple,
        });
        notes.push(
          `anomaly: "${s.title}" scores ${s.score.toFixed(1)}, ${multiple.toFixed(1)}x the open-set median of ${med.toFixed(1)} — check its value and estimate before trusting the ranking`,
        );
      }
    }
  } else if (openScores.length > 0) {
    notes.push('open-set median score is zero, so the anomaly check could not run');
  }

  const highValue = openScores
    .map((s) => prepared.taskById.get(s.task_id)!)
    .filter((t) => t.value >= HIGH_VALUE_THRESHOLD);
  const openCount = openScores.length;
  const allowed = Math.floor(VALUE_INFLATION_MAX_FRACTION * openCount);
  const warned = highValue.length > allowed;
  const valueInflation: ValueInflation = {
    warned,
    highValueCount: highValue.length,
    openCount,
    fraction: openCount === 0 ? 0 : highValue.length / openCount,
    allowed,
    excess: Math.max(0, highValue.length - allowed),
    highValueTasks: [...highValue]
      .sort((a, b) => b.value - a.value || (a.id < b.id ? -1 : 1))
      .map((t) => ({ task_id: t.id, title: t.title, value: t.value })),
  };
  if (warned) {
    notes.push(
      `value inflation: ${highValue.length} of ${openCount} open tasks hold value ${HIGH_VALUE_THRESHOLD} or above (${(valueInflation.fraction * 100).toFixed(1)}%, ceiling ${(VALUE_INFLATION_MAX_FRACTION * 100).toFixed(0)}%) — ${valueInflation.excess} too many, so the ranking between them is not meaningful`,
    );
  }

  if (ctx.slackDegraded) {
    notes.push(
      'the slack walk degraded, so task urgency here is deadline-only: it carries no critical-path information (D7)',
    );
  }
  if (scores.length === 0) {
    notes.push(
      tasks.length === 0
        ? 'no tasks were supplied, so there is nothing to rank'
        : 'every task supplied is closed, parked or snoozed past the triage threshold, so nothing is rankable',
    );
  }
  if (ctx.balanceByVenture === undefined) {
    notes.push('balance factors were not supplied, strategic weight is being used unmodified');
  }

  const confidence = buildConfidence({
    calibration: ctx.calibration,
    contextsInUse: [...new Set(tasks.map((t) => t.context))],
    daysOfEvents: ctx.daysOfEvents ?? null,
    daysSinceStart: ctx.daysSinceStart ?? null,
    coverageByMilestone: {},
    notes,
  });

  return { scores, needsTriage, excluded, median: med, anomalies, valueInflation, errors, confidence };
}
