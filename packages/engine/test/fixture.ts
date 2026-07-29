import expectedJson from '../fixtures/expected.json' with { type: 'json' };
import portfolioJson from '../fixtures/portfolio.json' with { type: 'json' };
import type {
  CalibrationRow,
  Dependency,
  Milestone,
  OutcomeTarget,
  Person,
  Project,
  Task,
  Venture,
} from '../src/types.js';

/**
 * Typed access to the golden fixture and to the hand-computed expectations.
 * The JSON is the source of truth; nothing here recomputes anything.
 */

export interface Portfolio {
  today: string;
  activeTz: string;
  startedAt: string;
  settings: { active_tz: string; buffer_ratio: number };
  nearCycleIllegalEdge: Dependency;
  ventures: Venture[];
  milestones: Milestone[];
  outcomeTargets: OutcomeTarget[];
  outcomeMilestones: Array<{ outcome_id: string; milestone_id: string }>;
  people: Person[];
  projects: Project[];
  tasks: Task[];
  dependencies: Dependency[];
  calibration: CalibrationRow[];
}

export const portfolio = portfolioJson as unknown as Portfolio;
export const expected = expectedJson as unknown as ExpectedShape;

export interface ExpectedShape {
  today: string;
  activeTz: string;
  taskCount: number;
  constants: { CHAIN_HOURS_PER_DAY: number; durationDays: Record<string, number> };
  slack: {
    byTask: Record<string, number | null>;
    nullReasons: Record<string, string>;
    minSlackByMilestone: Record<string, number | null>;
    negativeSlackMilestones: string[];
  };
  coverage: {
    byMilestone: Record<string, number>;
    lowConfidenceMilestones: string[];
  };
  demand: {
    requiredByMilestone: Record<string, number>;
    requiredByVenture: Record<string, number>;
    totalRequired: number;
    pressureByMilestone: Record<string, number>;
    rawShareByVenture: Record<string, number>;
    clampedShareByVenture: Record<string, number>;
    shareByVenture: Record<string, number>;
    venturesBelowFloorAfterRenormalise: string[];
    venturesAtCeiling: string[];
    outcomeTargetsContributed: number;
  };
  capacity: {
    recurringHours: number;
    bufferRatio: number;
    rankedBySlipCost: Array<{
      milestone_id: string;
      hardness: string;
      costSeverity: string;
      minSlack: number | null;
      hoursFreed: number;
    }>;
    slipCandidateOrder: string[];
    cumulativeHoursFreed: number[];
    scenarios: Array<{
      name: string;
      availableHours: number;
      usableHours: number;
      deficitHours: number;
      verdict: string;
      coversDeficitAtIndex: number | null;
    }>;
  };
  scores: {
    tolerance: number;
    byTask: Record<string, number>;
    zeroScored: Record<string, number>;
    needsTriage: string[];
    excludedFromOpenSet: string[];
    openSetSize: number;
    valueInflation: {
      warned: boolean;
      highValueCount: number;
      openCount: number;
      fraction: number;
      allowed: number;
      excess: number;
      highValueTasks: string[];
    };
  };
  confidence: {
    calibrated: boolean;
    balancingActive: boolean;
    attentionDebtReleasing: boolean;
  };
}

/**
 * Numeric keys only. The fixture files carry `$comment` / `$derivation` prose,
 * and some blocks also carry named totals (`sum`, `sumBeforeRenormalise`) that
 * document the arithmetic but are not object ids — only keys that look like an
 * id are returned.
 */
const ID_KEY = /^(v_|m_|t_|p_|o_)/;

export function numericEntries(o: Record<string, unknown>): Array<[string, number]> {
  return Object.entries(o).filter(
    (e): e is [string, number] =>
      !e[0].startsWith('$') && ID_KEY.test(e[0]) && typeof e[1] === 'number',
  );
}

export function nullableNumericEntries(
  o: Record<string, unknown>,
): Array<[string, number | null]> {
  return Object.entries(o).filter(
    (e): e is [string, number | null] =>
      !e[0].startsWith('$') &&
      ID_KEY.test(e[0]) &&
      (typeof e[1] === 'number' || e[1] === null),
  );
}
