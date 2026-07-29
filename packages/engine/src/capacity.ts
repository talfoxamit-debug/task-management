import { DEFAULT_BUFFER_RATIO } from './constants.js';
import { costSeverityRank, type CostSeverity, type DemandResult } from './demand.js';
import type { Confidence, EngineError, Hardness } from './types.js';

/**
 * capacityCheck — THE PRIMARY OUTPUT OF V1. Everything else is scaffolding.
 *
 *   usable  = (availableHours - recurringHours) * (1 - buffer_ratio)
 *   deficit = sum(required) - usable
 *
 * When there is a deficit, the answer is a ranked list of what slips. Ranking is
 * by slip cost: hardness first, then cost_of_slip, then minSlack ascending, with
 * the hours each one frees.
 *
 * The buffer is applied before any allocation and is non-negotiable (D9).
 * Recurring work is subtracted before the buffer, not after: it is overhead that
 * exists whether or not there is slack around it (D5).
 */

export interface SlipRanking {
  milestone_id: string;
  name: string;
  venture_id: string;
  hardness: Hardness;
  cost_of_slip: string;
  costSeverity: CostSeverity;
  minSlack: number | null;
  /** Hours per week freed by slipping this milestone. */
  hoursFreed: number;
}

export interface SlipCandidate extends SlipRanking {
  /** Hours freed by slipping this milestone and every cheaper one before it. */
  cumulativeHoursFreed: number;
  /** True once the running total covers the deficit. */
  clearsDeficit: boolean;
}

export interface CapacityResult {
  verdict: 'ok' | 'deficit';
  availableHours: number;
  recurringHours: number;
  bufferRatio: number;
  bufferHours: number;
  usableHours: number;
  requiredHours: number;
  deficitHours: number;
  /** Hours to spare when there is no deficit; 0 otherwise. */
  surplusHours: number;
  /** Most costly to slip first. Protect the top, spend from the bottom. */
  rankedBySlipCost: SlipRanking[];
  /** Cheapest to slip first, with a running total against the deficit. */
  slipCandidates: SlipCandidate[];
  /**
   * Index into slipCandidates at which the deficit is finally covered, or null
   * when slipping everything still is not enough.
   */
  coversDeficitAtIndex: number | null;
  shareByVenture: Record<string, number>;
  allocatedHoursByVenture: Record<string, number>;
  errors: EngineError[];
  confidence: Confidence;
}

export interface CapacityOptions {
  bufferRatio?: number;
}

export function capacityCheck(
  demand: DemandResult,
  availableHours: number,
  recurringHours: number,
  options: CapacityOptions = {},
): CapacityResult {
  const errors: EngineError[] = [...demand.errors];
  const notes: string[] = [];
  const bufferRatio = options.bufferRatio ?? DEFAULT_BUFFER_RATIO;

  const badInputs =
    !Number.isFinite(availableHours) ||
    !Number.isFinite(recurringHours) ||
    !Number.isFinite(bufferRatio);
  if (badInputs) {
    errors.push({
      code: 'no_input',
      message: `capacity inputs are not finite (available ${availableHours}, recurring ${recurringHours}, buffer ${bufferRatio}); treated as zero capacity`,
    });
  }

  const available = Number.isFinite(availableHours) ? Math.max(0, availableHours) : 0;
  const recurring = Number.isFinite(recurringHours) ? Math.max(0, recurringHours) : 0;
  const ratio = Number.isFinite(bufferRatio) ? Math.min(1, Math.max(0, bufferRatio)) : DEFAULT_BUFFER_RATIO;

  if (recurring > available) {
    notes.push(
      `recurring overhead (${recurring.toFixed(1)} h/wk) exceeds the hours available (${available.toFixed(1)} h/wk): there is no capacity for project work at all before anything is cut`,
    );
  }

  const netOfRecurring = Math.max(0, available - recurring);
  const bufferHours = netOfRecurring * ratio;
  const usableHours = netOfRecurring - bufferHours;
  const requiredHours = demand.totalRequired;
  const deficitHours = requiredHours - usableHours;
  const verdict: 'ok' | 'deficit' = deficitHours > 0 ? 'deficit' : 'ok';

  // Ranked by slip cost, most costly first: hardness, then cost_of_slip
  // severity, then minSlack ascending. A milestone with no slack figure sorts
  // last inside its bucket — unknown urgency is not urgency.
  const ranked: SlipRanking[] = demand.milestoneDetail
    .map((m) => ({
      milestone_id: m.milestone_id,
      name: m.name,
      venture_id: m.venture_id,
      hardness: m.hardness,
      cost_of_slip: m.cost_of_slip,
      costSeverity: m.costSeverity,
      minSlack: m.minSlack,
      hoursFreed: m.requiredHours,
    }))
    .sort((a, b) => {
      const hardnessDiff =
        (b.hardness === 'hard' ? 1 : 0) - (a.hardness === 'hard' ? 1 : 0);
      if (hardnessDiff !== 0) return hardnessDiff;
      const sev = costSeverityRank(b.costSeverity) - costSeverityRank(a.costSeverity);
      if (sev !== 0) return sev;
      if (a.minSlack !== b.minSlack) {
        if (a.minSlack === null) return 1;
        if (b.minSlack === null) return -1;
        return a.minSlack - b.minSlack;
      }
      return a.milestone_id < b.milestone_id ? -1 : a.milestone_id > b.milestone_id ? 1 : 0;
    });

  // Cheapest first: this is the order things actually get given up in.
  const slipCandidates: SlipCandidate[] = [];
  let coversDeficitAtIndex: number | null = null;
  let cumulative = 0;
  const cheapestFirst = [...ranked].reverse();
  for (let i = 0; i < cheapestFirst.length; i += 1) {
    const entry = cheapestFirst[i]!;
    cumulative += entry.hoursFreed;
    const clears = verdict === 'deficit' && cumulative >= deficitHours;
    if (clears && coversDeficitAtIndex === null) coversDeficitAtIndex = i;
    slipCandidates.push({ ...entry, cumulativeHoursFreed: cumulative, clearsDeficit: clears });
  }

  if (verdict === 'deficit') {
    if (coversDeficitAtIndex === null) {
      notes.push(
        `deficit ${deficitHours.toFixed(1)} h/wk cannot be closed by slipping milestones: even giving up all ${ranked.length} of them frees only ${cumulative.toFixed(1)} h/wk — the estimates, the milestone set or the hours have to change`,
      );
    } else {
      const through = slipCandidates
        .slice(0, coversDeficitAtIndex + 1)
        .map((c) => c.name)
        .join(', ');
      notes.push(
        `deficit ${deficitHours.toFixed(1)} h/wk closes after slipping: ${through}`,
      );
      const hard = slipCandidates
        .slice(0, coversDeficitAtIndex + 1)
        .filter((c) => c.hardness === 'hard');
      if (hard.length > 0) {
        notes.push(
          `closing the deficit requires slipping ${hard.length} HARD milestone(s): ${hard.map((h) => h.name).join(', ')}`,
        );
      }
    }
  } else {
    notes.push(
      `no deficit: ${usableHours.toFixed(1)} usable h/wk against ${requiredHours.toFixed(1)} required, ${(usableHours - requiredHours).toFixed(1)} h/wk to spare after the ${(ratio * 100).toFixed(0)}% buffer`,
    );
  }

  // What each venture's share is worth in hours, once the buffer is off.
  const allocatedHoursByVenture: Record<string, number> = {};
  for (const [ventureId, share] of Object.entries(demand.shareByVenture)) {
    allocatedHoursByVenture[ventureId] = share * usableHours;
  }

  // capacityCheck learns nothing new about calibration or balancing; it only
  // adds notes. Carry the demand pass's confidence through unchanged.
  const confidence: Confidence = {
    ...demand.confidence,
    notes: [
      ...demand.confidence.notes,
      ...notes.filter((n) => !demand.confidence.notes.includes(n)),
    ],
  };

  return {
    verdict,
    availableHours: available,
    recurringHours: recurring,
    bufferRatio: ratio,
    bufferHours,
    usableHours,
    requiredHours,
    deficitHours,
    surplusHours: verdict === 'ok' ? -deficitHours : 0,
    rankedBySlipCost: ranked,
    slipCandidates,
    coversDeficitAtIndex,
    shareByVenture: { ...demand.shareByVenture },
    allocatedHoursByVenture,
    errors,
    confidence,
  };
}
