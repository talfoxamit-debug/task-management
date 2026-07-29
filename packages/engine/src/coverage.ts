import { COVERAGE_CONFIDENCE_THRESHOLD } from './constants.js';
import { buildGraph, hasAnyEdge } from './graph.js';
import type { Dependency, EngineError, Milestone, Task } from './types.js';
import { isClosed } from './types.js';

/**
 * computeCoverage — how much of a milestone's critical path has actually been
 * drawn.
 *
 *   coverage[m] = blocking tasks of m with at least one dependency edge
 *                 / total blocking tasks of m
 *
 * Below COVERAGE_CONFIDENCE_THRESHOLD the milestone's slack is LOW CONFIDENCE
 * and must not feed demand. This guard exists because an incomplete dependency
 * graph produces confidently wrong slack, which is the worst failure mode in the
 * design: a milestone with three of its ten blockers wired up will report
 * comfortable slack right up until it misses.
 */

export interface MilestoneCoverage {
  milestone_id: string;
  coverage: number;
  totalBlocking: number;
  blockingWithEdge: number;
  lowConfidence: boolean;
  /** True when the milestone has no blocking tasks at all. */
  vacuous: boolean;
}

export interface CoverageResult {
  byMilestone: Record<string, number>;
  detail: Record<string, MilestoneCoverage>;
  lowConfidence: string[];
  errors: EngineError[];
  notes: string[];
}

/**
 * A task counts toward its milestone's coverage when it is a blocker that still
 * needs doing. Closed tasks need no edges, and recurring tasks are fixed
 * overhead that never sits on a critical path (D5) — counting either would
 * quietly move coverage without changing how well the path is actually mapped.
 */
function countsTowardCoverage(t: Task): boolean {
  return t.criticality === 'blocking' && !t.is_recurring && !isClosed(t);
}

export function computeCoverage(
  tasks: readonly Task[],
  deps: readonly Dependency[],
  milestones: readonly Milestone[],
): CoverageResult {
  const errors: EngineError[] = [];
  const notes: string[] = [];
  const byMilestone: Record<string, number> = {};
  const detail: Record<string, MilestoneCoverage> = {};
  const lowConfidence: string[] = [];

  const graph = buildGraph(
    tasks.map((t) => t.id),
    deps,
  );

  const active = milestones.filter((m) => m.status === 'active');
  if (active.length === 0) {
    errors.push({
      code: 'no_input',
      message:
        milestones.length === 0
          ? 'no milestones at all: coverage is undefined until at least one controllable milestone exists'
          : 'no ACTIVE milestones: every milestone is hit, missed or dropped, so there is no critical path to cover',
    });
    return { byMilestone, detail, lowConfidence, errors, notes };
  }

  const known = new Set(milestones.map((m) => m.id));
  for (const t of tasks) {
    if (t.milestone_id && !known.has(t.milestone_id)) {
      errors.push({
        code: 'missing_milestone',
        message: `task ${t.id} points at milestone ${t.milestone_id}, which was not supplied`,
        subjects: [t.id, t.milestone_id],
      });
    }
  }

  for (const m of active) {
    const blockers = tasks.filter((t) => t.milestone_id === m.id && countsTowardCoverage(t));
    const withEdge = blockers.filter((t) => hasAnyEdge(graph, t.id));

    // Vacuous truth: a milestone with nothing blocking it has nothing to cover.
    // Reporting 0.0 here would push it onto the low-confidence fallback, which
    // drops the 0.5 * enabling term and would understate its demand to zero.
    const vacuous = blockers.length === 0;
    const coverage = vacuous ? 1 : withEdge.length / blockers.length;
    const low = !vacuous && coverage < COVERAGE_CONFIDENCE_THRESHOLD;

    byMilestone[m.id] = coverage;
    detail[m.id] = {
      milestone_id: m.id,
      coverage,
      totalBlocking: blockers.length,
      blockingWithEdge: withEdge.length,
      lowConfidence: low,
      vacuous,
    };

    if (vacuous) {
      notes.push(
        `${m.name}: no blocking tasks, so coverage is vacuously 1.0 — its slack rests on enabling work only`,
      );
    }
    if (low) {
      lowConfidence.push(m.id);
      notes.push(
        `${m.name}: dependency coverage ${(coverage * 100).toFixed(0)}% (${withEdge.length} of ${blockers.length} blockers wired up) is below the ${(COVERAGE_CONFIDENCE_THRESHOLD * 100).toFixed(0)}% threshold — its slack is not trustworthy and did not feed demand`,
      );
    }
  }

  return { byMilestone, detail, lowConfidence, errors, notes };
}
