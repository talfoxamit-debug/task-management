import { ATTENTION_DEBT_RELEASE_DAYS, BALANCE_MIN_DAYS } from './constants.js';
import type { Venture } from './types.js';

/**
 * The balance corrector and attention debt (D4).
 *
 * Both are deliberately inert at the start of the system's life. A corrector fed
 * three days of history does not correct anything, it just amplifies noise, so
 * the gates here are hard gates rather than confidence weightings.
 */

export interface BalanceInput {
  /** Target share per venture, from computeDemand. */
  targetShares: Record<string, number>;
  /** Hours actually spent per venture over the observation window. */
  actualHoursByVenture: Record<string, number>;
  /** Whole days of event history that exist. */
  daysOfEvents: number | null | undefined;
}

/** Widest correction the balance factor is allowed to apply. */
export const BALANCE_MIN_FACTOR = 0.5;
export const BALANCE_MAX_FACTOR = 2.0;

/**
 * Per-venture correction applied to strategic_weight inside computeScore.
 *
 * Returns 1.0 for every venture until BALANCE_MIN_DAYS of events exist (D4).
 * After that it is the ratio of intended to actual attention, bounded, so a
 * venture that has been starved relative to its share gets nudged up and one
 * that has been over-served gets nudged down.
 */
export function balanceFactors(input: BalanceInput): Record<string, number> {
  const factors: Record<string, number> = {};
  const active = typeof input.daysOfEvents === 'number' && input.daysOfEvents >= BALANCE_MIN_DAYS;

  const totalActual = Object.values(input.actualHoursByVenture).reduce(
    (a, b) => a + (Number.isFinite(b) ? b : 0),
    0,
  );

  for (const ventureId of Object.keys(input.targetShares)) {
    if (!active || totalActual <= 0) {
      factors[ventureId] = 1.0;
      continue;
    }
    const target = input.targetShares[ventureId] ?? 0;
    const actualShare = (input.actualHoursByVenture[ventureId] ?? 0) / totalActual;
    if (target <= 0) {
      factors[ventureId] = 1.0;
      continue;
    }
    if (actualShare <= 0) {
      // Completely starved: correct by the maximum rather than dividing by zero.
      factors[ventureId] = BALANCE_MAX_FACTOR;
      continue;
    }
    factors[ventureId] = Math.min(
      BALANCE_MAX_FACTOR,
      Math.max(BALANCE_MIN_FACTOR, target / actualShare),
    );
  }

  return factors;
}

/**
 * Attention debt accrues from day 1 but does not release until day 21 (D4).
 * Before then this returns zero for every venture: the debt is being recorded,
 * not yet acted on.
 */
export function releasableAttentionDebt(
  ventures: readonly Venture[],
  daysSinceStart: number | null | undefined,
): Record<string, number> {
  const releasing =
    typeof daysSinceStart === 'number' && daysSinceStart >= ATTENTION_DEBT_RELEASE_DAYS;
  const out: Record<string, number> = {};
  for (const v of ventures) {
    out[v.id] = releasing ? Math.max(0, v.attention_debt_hours ?? 0) : 0;
  }
  return out;
}
