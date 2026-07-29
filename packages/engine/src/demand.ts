import { buildConfidence } from './confidence.js';
import { MIN_WEEKS_REMAINING, PRESSURE_SLACK_WINDOW_DAYS, PRESSURE_SLOPE } from './constants.js';
import { computeCoverage, type CoverageResult } from './coverage.js';
import type { SlackResult } from './slack.js';
import { weeksUntil, DEFAULT_TZ } from './time.js';
import type {
  CalibrationRow,
  Confidence,
  Dependency,
  EngineError,
  Hardness,
  Milestone,
  Task,
  Venture,
} from './types.js';
import { DEMAND_EXCLUDED_STATUSES } from './types.js';

/**
 * computeDemand — how many hours a week each venture actually requires.
 *
 *   weeks       = max(0.5, weeksUntil(milestone.due_date))
 *   demandHours = (sum blockingMin + 0.5 * sum enablingMin) / weeks / 60
 *   pressure    = 1 + 2 * max(0, -minSlack / 7)
 *   hardness    = hard ? 1.5 : 1.0
 *   required[v] = demandHours * pressure * strategic_weight * hardness
 *
 * `pressure` appears HERE AND NOWHERE ELSE. Task-level urgency must not also
 * multiply by deadline proximity: the same signal applied twice, multiplicatively,
 * pushes one task to roughly 16x normal and erases four ventures from the output.
 *
 * Recurring tasks are excluded (D5) along with blocked, waiting, parked, done and
 * killed work. Outcome targets are not an argument here at all: a result someone
 * else decides never drives demand (D1).
 */

export type CostSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface MilestoneDemand {
  milestone_id: string;
  venture_id: string;
  name: string;
  due_date: string;
  hardness: Hardness;
  cost_of_slip: string;
  costSeverity: CostSeverity;
  weeks: number;
  weeksUntilRaw: number;
  weeksFloored: boolean;
  blockingMinutes: number;
  enablingMinutes: number;
  demandHours: number;
  pressure: number;
  minSlack: number | null;
  coverage: number;
  usedFallback: boolean;
  /** Hours per week this milestone contributes to its venture's requirement. */
  requiredHours: number;
  eligibleTaskCount: number;
}

export interface VentureDemand {
  venture_id: string;
  slug: string;
  requiredHours: number;
  rawShare: number;
  clampedShare: number;
  share: number;
  floor_share: number;
  ceiling_share: number;
  belowFloor: boolean;
  atCeiling: boolean;
}

export interface DemandResult {
  requiredByMilestone: Record<string, number>;
  requiredByVenture: Record<string, number>;
  totalRequired: number;
  pressureByMilestone: Record<string, number>;
  rawShareByVenture: Record<string, number>;
  clampedShareByVenture: Record<string, number>;
  shareByVenture: Record<string, number>;
  milestoneDetail: MilestoneDemand[];
  ventureDetail: VentureDemand[];
  fallbackMilestones: string[];
  venturesBelowFloor: string[];
  venturesAtCeiling: string[];
  errors: EngineError[];
  confidence: Confidence;
}

export interface DemandOptions {
  tz?: string;
  /** Reuses an existing coverage pass; computed internally when absent. */
  coverage?: CoverageResult;
  calibration?: readonly CalibrationRow[];
  daysOfEvents?: number | null;
  daysSinceStart?: number | null;
  /** Only needed when coverage is not supplied. */
  dependencies?: readonly Dependency[];
}

const SEVERITY_RANK: Record<CostSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/**
 * cost_of_slip is free text, so slip-cost ranking needs an ordering over it.
 * Highest severity wins when several words appear, and anything unrecognised is
 * treated as medium and named in a note rather than silently sorted last.
 */
export function costSeverity(text: string): CostSeverity {
  const t = text.toLowerCase();
  if (/\b(critical|severe|fatal|existential)\b/.test(t)) return 'critical';
  if (/\b(high|major|serious)\b/.test(t)) return 'high';
  if (/\b(medium|moderate)\b/.test(t)) return 'medium';
  if (/\b(low|minor|internal|cosmetic)\b/.test(t)) return 'low';
  return 'medium';
}

export function costSeverityRank(s: CostSeverity): number {
  return SEVERITY_RANK[s];
}

export function isRecognisedCostOfSlip(text: string): boolean {
  return /\b(critical|severe|fatal|existential|high|major|serious|medium|moderate|low|minor|internal|cosmetic)\b/.test(
    text.toLowerCase(),
  );
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function computeDemand(
  ventures: readonly Venture[],
  tasks: readonly Task[],
  milestones: readonly Milestone[],
  slack: SlackResult,
  today: string,
  options: DemandOptions = {},
): DemandResult {
  const tz = options.tz ?? DEFAULT_TZ;
  const errors: EngineError[] = [];
  const notes: string[] = [];

  const coverage =
    options.coverage ?? computeCoverage(tasks, options.dependencies ?? [], milestones);
  for (const n of coverage.notes) notes.push(n);
  for (const e of coverage.errors) if (e.code !== 'no_input') errors.push(e);

  const activeVentures = ventures.filter((v) => v.active);
  const ventureById = new Map(activeVentures.map((v) => [v.id, v]));
  const requiredByVenture = new Map<string, number>();
  for (const v of activeVentures) requiredByVenture.set(v.id, 0);

  const requiredByMilestone: Record<string, number> = {};
  const pressureByMilestone: Record<string, number> = {};
  const milestoneDetail: MilestoneDemand[] = [];
  const fallbackMilestones: string[] = [];

  const activeMilestones = milestones.filter((m) => m.status === 'active');
  if (activeMilestones.length === 0) {
    errors.push({
      code: 'no_input',
      message:
        milestones.length === 0
          ? 'no milestones: nothing controllable exists to demand hours, so every share falls back to floors'
          : 'no ACTIVE milestones: nothing is currently driving demand',
    });
  }

  for (const m of activeMilestones) {
    const venture = ventureById.get(m.venture_id);
    if (!venture) {
      errors.push({
        code: 'missing_venture',
        message: `${m.name}: venture ${m.venture_id} is missing or inactive, its demand is not counted`,
        subjects: [m.id, m.venture_id],
      });
      continue;
    }

    const weeksRaw = weeksUntil(m.due_date, today, tz);
    if (weeksRaw === null) {
      errors.push({
        code: 'bad_date',
        message: `${m.name}: due_date "${m.due_date}" is not a calendar date, its demand is not counted`,
        subjects: [m.id],
      });
      continue;
    }

    // The floor is what stops demand exploding towards infinity as a milestone
    // lands and erasing every other venture from the output.
    const weeks = Math.max(MIN_WEEKS_REMAINING, weeksRaw);
    const weeksFloored = weeks !== weeksRaw;
    if (weeksFloored) {
      notes.push(
        weeksRaw < 0
          ? `${m.name}: due_date has passed (${m.due_date}), weeks-remaining floored at ${MIN_WEEKS_REMAINING} — it is spending demand it cannot repay`
          : `${m.name}: lands within days, weeks-remaining floored at ${MIN_WEEKS_REMAINING}`,
      );
    }

    const eligible = tasks.filter(
      (t) =>
        t.milestone_id === m.id &&
        !t.is_recurring &&
        !DEMAND_EXCLUDED_STATUSES.includes(t.status),
    );
    let blockingMinutes = 0;
    let enablingMinutes = 0;
    for (const t of eligible) {
      if (t.criticality === 'blocking') blockingMinutes += t.estimate_minutes;
      else if (t.criticality === 'enabling') enablingMinutes += t.estimate_minutes;
    }

    const cov = coverage.byMilestone[m.id] ?? 0;
    const lowConfidence = coverage.lowConfidence.includes(m.id);
    const minSlack = slack.minSlackByMilestone[m.id] ?? null;

    let demandHours: number;
    let pressure: number;
    if (lowConfidence) {
      // The dependency graph is too incomplete for its slack to be believed, so
      // slack must not feed demand in any form — neither the 0.5 * enabling
      // term's critical-path assumption nor the pressure multiplier.
      demandHours = blockingMinutes / weeks / 60;
      pressure = 1;
      fallbackMilestones.push(m.id);
    } else {
      demandHours = (blockingMinutes + 0.5 * enablingMinutes) / weeks / 60;
      if (minSlack === null) {
        pressure = 1;
        if (eligible.length > 0) {
          notes.push(
            `${m.name}: no slack figure available, pressure held at 1.0 rather than assumed`,
          );
        }
      } else {
        pressure =
          1 + PRESSURE_SLOPE * Math.max(0, -minSlack / PRESSURE_SLACK_WINDOW_DAYS);
      }
    }

    if (!isRecognisedCostOfSlip(m.cost_of_slip)) {
      notes.push(
        `${m.name}: cost_of_slip "${m.cost_of_slip}" names no severity, treated as medium when ranking what to slip`,
      );
    }

    const hardnessFactor = m.hardness === 'hard' ? 1.5 : 1.0;
    const required = demandHours * pressure * venture.strategic_weight * hardnessFactor;

    requiredByMilestone[m.id] = required;
    pressureByMilestone[m.id] = pressure;
    requiredByVenture.set(m.venture_id, (requiredByVenture.get(m.venture_id) ?? 0) + required);

    milestoneDetail.push({
      milestone_id: m.id,
      venture_id: m.venture_id,
      name: m.name,
      due_date: m.due_date,
      hardness: m.hardness,
      cost_of_slip: m.cost_of_slip,
      costSeverity: costSeverity(m.cost_of_slip),
      weeks,
      weeksUntilRaw: weeksRaw,
      weeksFloored,
      blockingMinutes,
      enablingMinutes,
      demandHours,
      pressure,
      minSlack,
      coverage: cov,
      usedFallback: lowConfidence,
      requiredHours: required,
      eligibleTaskCount: eligible.length,
    });
  }

  const totalRequired = [...requiredByVenture.values()].reduce((a, b) => a + b, 0);

  // ---- shares: rawShare, clamp to [floor, ceiling], then renormalise to 1.0 --
  const rawShareByVenture: Record<string, number> = {};
  const clampedShareByVenture: Record<string, number> = {};
  const shareByVenture: Record<string, number> = {};

  const noDemand = totalRequired <= 0;
  if (noDemand && activeVentures.length > 0) {
    notes.push(
      'no venture requires any hours: every milestone is unattached, closed or past — shares fall back to floors, they are not a recommendation',
    );
  }

  for (const v of activeVentures) {
    const req = requiredByVenture.get(v.id) ?? 0;
    rawShareByVenture[v.id] = noDemand ? 0 : req / totalRequired;
  }

  let clampedSum = 0;
  for (const v of activeVentures) {
    const c = clamp(rawShareByVenture[v.id]!, v.floor_share, v.ceiling_share);
    clampedShareByVenture[v.id] = c;
    clampedSum += c;
  }

  const venturesBelowFloor: string[] = [];
  const venturesAtCeiling: string[] = [];
  const ventureDetail: VentureDemand[] = [];

  for (const v of activeVentures) {
    // Spec-literal: clamp once, renormalise once. Renormalising after a
    // floor-raise can push a venture back below its floor; that is reported
    // rather than iterated away, because the procedure is what was specified.
    const share =
      clampedSum > 0 ? clampedShareByVenture[v.id]! / clampedSum : 1 / activeVentures.length;
    shareByVenture[v.id] = share;

    const belowFloor = share < v.floor_share - 1e-12;
    const atCeiling = share > v.ceiling_share + 1e-12;
    if (belowFloor) venturesBelowFloor.push(v.id);
    if (atCeiling) venturesAtCeiling.push(v.id);

    ventureDetail.push({
      venture_id: v.id,
      slug: v.slug,
      requiredHours: requiredByVenture.get(v.id) ?? 0,
      rawShare: rawShareByVenture[v.id]!,
      clampedShare: clampedShareByVenture[v.id]!,
      share,
      floor_share: v.floor_share,
      ceiling_share: v.ceiling_share,
      belowFloor,
      atCeiling,
    });
  }

  for (const id of venturesBelowFloor) {
    const d = ventureDetail.find((x) => x.venture_id === id)!;
    notes.push(
      `${d.slug}: share ${(d.share * 100).toFixed(1)}% sits under its ${(d.floor_share * 100).toFixed(0)}% floor after renormalisation — other ventures' floors are consuming the budget`,
    );
  }
  for (const id of venturesAtCeiling) {
    const d = ventureDetail.find((x) => x.venture_id === id)!;
    notes.push(
      `${d.slug}: share ${(d.share * 100).toFixed(1)}% sits above its ${(d.ceiling_share * 100).toFixed(0)}% ceiling after renormalisation`,
    );
  }
  // Bounds can be unsatisfiable before any share is computed: floors that sum
  // above 1.0 cannot all be met, and ceilings that sum below 1.0 cannot fill the
  // budget. Diagnose that from the configuration itself rather than inferring it
  // from the outcome, which only shows the symptom when both sides are violated.
  const sumFloors = activeVentures.reduce((a, v) => a + v.floor_share, 0);
  const sumCeilings = activeVentures.reduce((a, v) => a + v.ceiling_share, 0);
  if (sumFloors > 1 + 1e-9) {
    errors.push({
      code: 'bounds_unsatisfiable',
      message: `floor_share values sum to ${sumFloors.toFixed(3)}, above the whole budget: they cannot all be honoured and every share lands under its floor`,
      subjects: activeVentures.map((v) => v.id),
    });
  }
  if (sumCeilings < 1 - 1e-9) {
    errors.push({
      code: 'bounds_unsatisfiable',
      message: `ceiling_share values sum to ${sumCeilings.toFixed(3)}, below the whole budget: the shares cannot both respect the ceilings and sum to 1.0`,
      subjects: activeVentures.map((v) => v.id),
    });
  }
  if (venturesBelowFloor.length > 0 && venturesAtCeiling.length > 0) {
    errors.push({
      code: 'bounds_unsatisfiable',
      message:
        'floors and ceilings are being violated simultaneously: the configured bounds do not admit a solution summing to 1.0',
      subjects: [...venturesBelowFloor, ...venturesAtCeiling],
    });
  }

  for (const n of slack.notes) if (!notes.includes(n)) notes.push(n);
  for (const e of slack.errors) errors.push(e);

  const contextsInUse = [...new Set(tasks.map((t) => t.context))];
  const confidence = buildConfidence({
    calibration: options.calibration,
    contextsInUse,
    daysOfEvents: options.daysOfEvents ?? null,
    daysSinceStart: options.daysSinceStart ?? null,
    coverageByMilestone: coverage.byMilestone,
    notes,
  });

  return {
    requiredByMilestone,
    requiredByVenture: Object.fromEntries(requiredByVenture),
    totalRequired,
    pressureByMilestone,
    rawShareByVenture,
    clampedShareByVenture,
    shareByVenture,
    milestoneDetail,
    ventureDetail,
    fallbackMilestones,
    venturesBelowFloor,
    venturesAtCeiling,
    errors,
    confidence,
  };
}
