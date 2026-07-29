import type { Task } from './types.js';

/**
 * Engine constants. Everything the spec math depends on that is not a per-row
 * value lives here, so fixtures/expected.json can be derived by hand from a
 * single visible set of numbers.
 */

/**
 * Hours of real work assumed available on a working day, used ONLY to convert a
 * task's estimate into a duration in calendar days for the critical-path walk.
 *
 * The slack walk in Part 4 subtracts a chain length in DAYS from a milestone's
 * due_date, while tasks carry estimates in MINUTES, so exactly one conversion
 * constant is unavoidable. Six hours is the deliberate choice: it is a full day
 * of real output for one person running five ventures, not an eight-hour
 * fiction. It is named and exported so slack figures can be re-derived by hand.
 */
export const CHAIN_HOURS_PER_DAY = 6;

/**
 * A task's duration in calendar days for the critical-path walk.
 * Rounded UP, floor of one day: no task on the critical path takes zero days,
 * so a chain five deep is always at least five days long.
 */
export function taskDurationDays(task: Pick<Task, 'estimate_minutes'>): number {
  const minutesPerDay = CHAIN_HOURS_PER_DAY * 60;
  return Math.max(1, Math.ceil(task.estimate_minutes / minutesPerDay));
}

/**
 * Below this coverage, a milestone's dependency graph is too incomplete for its
 * slack to be trusted, and demand falls back to a slack-free formula (Part 4).
 * An incomplete graph produces confidently wrong slack, which is the worst
 * failure mode in the design.
 */
export const COVERAGE_CONFIDENCE_THRESHOLD = 0.6;

/** D4: calibration is inert until a context has this many real samples. */
export const CALIBRATION_MIN_SAMPLES = 8;

/** D4: the balance corrector returns 1.0 until this many days of events exist. */
export const BALANCE_MIN_DAYS = 14;

/** D4: attention debt accrues from day 1 but does not release until day 21. */
export const ATTENTION_DEBT_RELEASE_DAYS = 21;

/** Part 4: this many snoozes takes a task out of scoring and into triage. */
export const SNOOZE_TRIAGE_THRESHOLD = 3;

/** Part 4: a score above this multiple of the open-set median is an anomaly. */
export const SCORE_ANOMALY_MULTIPLE = 6;

/** Part 4: at most this fraction of open tasks may hold value >= HIGH_VALUE. */
export const VALUE_INFLATION_MAX_FRACTION = 0.15;
export const HIGH_VALUE_THRESHOLD = 8;

/** D9: available hours are reduced by this before any allocation. */
export const DEFAULT_BUFFER_RATIO = 0.2;

/**
 * Part 4: the floor under weeks-remaining. Without it, demand explodes towards
 * infinity as a milestone lands and erases every other venture.
 */
export const MIN_WEEKS_REMAINING = 0.5;

/** Part 4 score exponents. */
export const VALUE_EXPONENT = 1.2;
export const EFFORT_EXPONENT = 0.6;
export const EFFORT_REFERENCE_MINUTES = 30;

/** Part 4 urgency multipliers. `pressure` is NOT among them, by design. */
export const URGENCY_OVERDUE = 3.0;
export const URGENCY_DEADLINE_IN_LEAD_TIME = 1.6;
export const URGENCY_TARGET_WITHIN_7 = 1.3;
export const URGENCY_BASE = 1.0;
export const TARGET_HORIZON_DAYS = 7;

/** Part 4 leverage weights. */
export const LEVERAGE_PER_BLOCKED = 0.35;
export const LEVERAGE_UNBLOCKS_PERSON = 1.0;

/** Part 4 pressure: slack days below zero saturate over one week. */
export const PRESSURE_SLACK_WINDOW_DAYS = 7;
export const PRESSURE_SLOPE = 2;
