/**
 * @taskos/engine — pure functions, zero I/O.
 *
 * Nothing in this package opens a database connection, performs a fetch, or
 * reads the clock. Every function that needs to know the date takes `today` as
 * an explicit argument. That property is load-bearing for the entire test
 * strategy: it is what makes a portfolio a value, a computation reproducible,
 * and a randomised property test possible. Do not break it for convenience.
 */

export * from './types.js';
export * from './constants.js';
export * from './time.js';
export * from './graph.js';
export * from './confidence.js';
export * from './balance.js';
export * from './recurrence.js';
export { computeCoverage } from './coverage.js';
export type { CoverageResult, MilestoneCoverage } from './coverage.js';
export { computeSlack } from './slack.js';
export type { SlackResult, SlackOptions } from './slack.js';
export {
  computeDemand,
  costSeverity,
  costSeverityRank,
  isRecognisedCostOfSlip,
} from './demand.js';
export type {
  CostSeverity,
  DemandOptions,
  DemandResult,
  MilestoneDemand,
  VentureDemand,
} from './demand.js';
export { capacityCheck } from './capacity.js';
export type {
  CapacityOptions,
  CapacityResult,
  SlipCandidate,
  SlipRanking,
} from './capacity.js';
export { computeScore, computeScores, urgency } from './score.js';
export type {
  ScoreAnomaly,
  ScoreComponents,
  ScoreContext,
  ScoreSetResult,
  TaskScore,
  TriageItem,
  UrgencyReason,
  ValueInflation,
} from './score.js';
