/**
 * Engine domain types. These mirror the Part 3 schema, narrowed to the columns
 * the engine actually reads. The engine never sees a database connection: the
 * MCP layer loads rows and hands them in.
 */

export type Hardness = 'hard' | 'soft';
export type MilestoneStatus = 'active' | 'hit' | 'missed' | 'dropped';
export type Criticality = 'blocking' | 'enabling' | 'supporting' | 'optional';
export type TaskContext =
  | 'deep_work'
  | 'calls'
  | 'admin'
  | 'errands'
  | 'creative'
  | 'review'
  | 'physical';
export type Energy = 'high' | 'medium' | 'low';
export type TaskStatus =
  | 'inbox'
  | 'active'
  | 'blocked'
  | 'waiting'
  | 'parked'
  | 'done'
  | 'killed';
export type OutcomeStatus = 'open' | 'achieved' | 'abandoned';

export interface Venture {
  id: string;
  name: string;
  slug: string;
  strategic_weight: number;
  floor_share: number;
  ceiling_share: number;
  attention_debt_hours?: number;
  active: boolean;
}

export interface Milestone {
  id: string;
  venture_id: string;
  name: string;
  /** Calendar date in active_tz, `YYYY-MM-DD`. Never a midnight timestamp. */
  due_date: string;
  hardness: Hardness;
  cost_of_slip: string;
  status: MilestoneStatus;
}

/**
 * An outcome target is a result someone else decides (D1). It is declared here
 * so it can be carried through the MCP layer, but NO engine function accepts
 * it: outcome targets never drive demand and never get slack computed.
 */
export interface OutcomeTarget {
  id: string;
  venture_id: string;
  name: string;
  target_date: string | null;
  status: OutcomeStatus;
  indicator_config: Record<string, unknown>;
}

export interface Project {
  id: string;
  venture_id: string;
  milestone_id: string | null;
  name: string;
  status: 'active' | 'paused' | 'done' | 'killed';
}

export interface Person {
  id: string;
  name: string;
}

export interface Task {
  id: string;
  venture_id: string;
  project_id?: string | null;
  milestone_id?: string | null;
  title: string;
  criticality: Criticality;
  context: TaskContext;
  energy?: Energy;
  estimate_minutes: number;
  value: number;
  deadline_date?: string | null;
  deadline_time?: string | null;
  target_date?: string | null;
  lead_time_days: number;
  status: TaskStatus;
  snooze_count: number;
  assignee_person_id?: string | null;
  is_recurring: boolean;
  recurrence_rule?: string | null;
}

/** Edge semantics: `task_id` must close before `blocks_task_id` can proceed. */
export interface Dependency {
  task_id: string;
  blocks_task_id: string;
}

export interface CalibrationRow {
  context: TaskContext | string;
  ratio: number;
  sample_n: number;
}

/**
 * D4. Every engine output carries this. The system states its own uncertainty
 * rather than presenting guesses as facts.
 */
export interface Confidence {
  calibrated: boolean;
  balancingActive: boolean;
  coverageByMilestone: Record<string, number>;
  notes: string[];
}

/** D7. Engine functions return partial results with these, they do not throw. */
export interface EngineError {
  code:
    | 'dependency_cycle'
    | 'bad_date'
    | 'missing_venture'
    | 'missing_milestone'
    | 'no_input'
    | 'degraded_slack'
    | 'bounds_unsatisfiable';
  message: string;
  /** Ids of the objects involved, for the MCP layer to name in its response. */
  subjects?: string[];
}

/** Shared shape: every engine result is partial-able and self-describing. */
export interface EngineResult {
  errors: EngineError[];
  confidence: Confidence;
}

export const ALL_CONTEXTS: TaskContext[] = [
  'deep_work',
  'calls',
  'admin',
  'errands',
  'creative',
  'review',
  'physical',
];

/** Statuses that mean the task no longer needs doing. */
export const CLOSED_STATUSES: readonly TaskStatus[] = ['done', 'killed'];

/**
 * Statuses excluded from DEMAND (Part 4, computeDemand). Blocked and waiting
 * work is real but not schedulable this week, parked work is deliberately set
 * down, and closed work is finished.
 */
export const DEMAND_EXCLUDED_STATUSES: readonly TaskStatus[] = [
  'blocked',
  'waiting',
  'parked',
  'done',
  'killed',
];

/**
 * Statuses that count as "open" for scoring and for the value-inflation and
 * anomaly assertions.
 */
export const OPEN_STATUSES: readonly TaskStatus[] = ['inbox', 'active'];

/** Criticalities that participate in the critical path. */
export const PATH_CRITICALITIES: readonly Criticality[] = ['blocking', 'enabling'];

export function isClosed(t: Task): boolean {
  return CLOSED_STATUSES.includes(t.status);
}

export function isOnPath(t: Task): boolean {
  return PATH_CRITICALITIES.includes(t.criticality);
}
