import {
  balanceFactors,
  capacityCheck,
  computeCoverage,
  computeDemand,
  computeScores,
  computeSlack,
  recurringHoursPerWeek,
  type CapacityResult,
  type CoverageResult,
  type DemandResult,
  type ScoreSetResult,
  type SlackResult,
} from '@taskos/engine';
import type { Portfolio } from './load.js';

/**
 * The engine pipeline, in the one order it runs: slack -> coverage -> demand ->
 * capacityCheck. capacity() and venture_status() both go through here so they
 * can never disagree with each other about the same portfolio.
 */

export interface PipelineResult {
  slack: SlackResult;
  coverage: CoverageResult;
  demand: DemandResult;
  scores: ScoreSetResult;
  recurringHours: number;
  unparsedRecurrences: Array<{ task_id: string; reason: string }>;
}

export function runEngine(p: Portfolio): PipelineResult {
  const tz = p.settings.active_tz;

  const slack = computeSlack(p.tasks, p.dependencies, p.milestones, p.today, { tz });
  const coverage = computeCoverage(p.tasks, p.dependencies, p.milestones);
  const demand = computeDemand(p.ventures, p.tasks, p.milestones, slack, p.today, {
    tz,
    coverage,
    calibration: p.calibration,
    daysOfEvents: p.daysOfEvents,
    daysSinceStart: p.daysSinceStart,
  });

  // The balance corrector needs hours actually spent per venture. V1 records
  // actuals on tasks, so that is the source; it stays inert below 14 days of
  // events regardless (D4).
  const actualHoursByVenture: Record<string, number> = {};
  for (const t of p.tasks) {
    if (t.status !== 'done') continue;
    actualHoursByVenture[t.venture_id] =
      (actualHoursByVenture[t.venture_id] ?? 0) + t.estimate_minutes / 60;
  }
  const balance = balanceFactors({
    targetShares: demand.shareByVenture,
    actualHoursByVenture,
    daysOfEvents: p.daysOfEvents,
  });

  const scores = computeScores(p.tasks, {
    today: p.today,
    tz,
    ventures: p.ventures,
    tasks: p.tasks,
    dependencies: p.dependencies,
    calibration: p.calibration,
    balanceByVenture: balance,
    daysOfEvents: p.daysOfEvents,
    daysSinceStart: p.daysSinceStart,
    slackDegraded: slack.degraded,
  });

  const recurring = recurringHoursPerWeek(p.tasks);

  return {
    slack,
    coverage,
    demand,
    scores,
    recurringHours: recurring.hoursPerWeek,
    unparsedRecurrences: recurring.unparsed.map((u) => ({ task_id: u.task_id, reason: u.reason })),
  };
}

export function runCapacity(
  p: Portfolio,
  pipeline: PipelineResult,
  availableHours: number,
): CapacityResult {
  return capacityCheck(pipeline.demand, availableHours, pipeline.recurringHours, {
    bufferRatio: p.settings.buffer_ratio,
  });
}
