import { ATTENTION_DEBT_RELEASE_DAYS, BALANCE_MIN_DAYS, CALIBRATION_MIN_SAMPLES } from './constants.js';
import type { CalibrationRow, Confidence } from './types.js';

/**
 * D4 cold start. The system states its own uncertainty rather than presenting
 * guesses as facts, so every engine output carries a Confidence object and the
 * MCP layer surfaces it verbatim.
 */

export interface ConfidenceInput {
  calibration?: readonly CalibrationRow[];
  /** Contexts actually used by the tasks in this computation. */
  contextsInUse?: readonly string[];
  /** Whole days of event history that exist. Null when unknown. */
  daysOfEvents?: number | null;
  /** Whole days since settings.started_at. Null when unknown. */
  daysSinceStart?: number | null;
  coverageByMilestone?: Record<string, number>;
  notes?: readonly string[];
}

/** The calibration ratio to actually apply for a context (D4). */
export function calibrationRatio(
  calibration: readonly CalibrationRow[] | undefined,
  context: string,
): number {
  const row = calibration?.find((c) => c.context === context);
  if (!row) return 1.0;
  if (row.sample_n < CALIBRATION_MIN_SAMPLES) return 1.0;
  if (!Number.isFinite(row.ratio) || row.ratio <= 0) return 1.0;
  return row.ratio;
}

/**
 * True only when every context in use has enough real samples. One calibrated
 * context out of seven is not a calibrated system.
 */
export function isCalibrated(
  calibration: readonly CalibrationRow[] | undefined,
  contextsInUse: readonly string[] | undefined,
): boolean {
  if (!calibration || calibration.length === 0) return false;
  const contexts = contextsInUse && contextsInUse.length > 0 ? contextsInUse : undefined;
  if (!contexts) return false;
  return contexts.every((ctx) => {
    const row = calibration.find((c) => c.context === ctx);
    return row !== undefined && row.sample_n >= CALIBRATION_MIN_SAMPLES;
  });
}

/** D4: the balance corrector is disabled until 14 days of events exist. */
export function isBalancingActive(daysOfEvents: number | null | undefined): boolean {
  return typeof daysOfEvents === 'number' && daysOfEvents >= BALANCE_MIN_DAYS;
}

/** D4: attention debt accrues from day 1 but does not release until day 21. */
export function isAttentionDebtReleasing(daysSinceStart: number | null | undefined): boolean {
  return typeof daysSinceStart === 'number' && daysSinceStart >= ATTENTION_DEBT_RELEASE_DAYS;
}

export function buildConfidence(input: ConfidenceInput): Confidence {
  const notes = [...(input.notes ?? [])];
  const calibrated = isCalibrated(input.calibration, input.contextsInUse);
  const balancingActive = isBalancingActive(input.daysOfEvents);

  if (!calibrated) {
    notes.push(
      `calibration not applied: a context needs ${CALIBRATION_MIN_SAMPLES} volunteered actuals before its ratio is used, estimates are being taken at face value`,
    );
  }
  if (!balancingActive) {
    const have = typeof input.daysOfEvents === 'number' ? `${input.daysOfEvents}` : 'unknown';
    notes.push(
      `balance corrector disabled: needs ${BALANCE_MIN_DAYS} days of event history, have ${have}`,
    );
  }
  if (!isAttentionDebtReleasing(input.daysSinceStart)) {
    notes.push(
      `attention debt is accruing but cannot release until day ${ATTENTION_DEBT_RELEASE_DAYS}`,
    );
  }

  return {
    calibrated,
    balancingActive,
    coverageByMilestone: input.coverageByMilestone ?? {},
    notes,
  };
}

/** Merge confidence objects as a computation passes through stages. */
export function mergeConfidence(a: Confidence, b: Confidence): Confidence {
  const notes = [...a.notes];
  for (const n of b.notes) if (!notes.includes(n)) notes.push(n);
  return {
    calibrated: a.calibrated && b.calibrated,
    balancingActive: a.balancingActive && b.balancingActive,
    coverageByMilestone: { ...a.coverageByMilestone, ...b.coverageByMilestone },
    notes,
  };
}
