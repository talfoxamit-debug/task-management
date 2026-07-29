import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { capacityCheck } from '../src/capacity.js';
import { computeCoverage } from '../src/coverage.js';
import { computeDemand } from '../src/demand.js';
import { nodesOnCycles, buildGraph } from '../src/graph.js';
import { recurringHoursPerWeek } from '../src/recurrence.js';
import { computeScores } from '../src/score.js';
import { computeSlack } from '../src/slack.js';
import { addDays, daysBetween } from '../src/time.js';
import type {
  Criticality,
  Dependency,
  Hardness,
  Milestone,
  Task,
  TaskContext,
  TaskStatus,
  Venture,
} from '../src/types.js';

/**
 * Property tests over randomised portfolios.
 *
 * The generator deliberately produces hostile input: acyclic graphs and cyclic
 * ones, past-due milestones, ventures whose floors cannot all be met, zero-task
 * milestones, and empty portfolios. Every invariant below must hold anyway,
 * because D7 says the engine returns partial results rather than throwing.
 */

const TZ = 'America/New_York';
const TODAY = '2026-07-29';

const CONTEXTS: TaskContext[] = [
  'deep_work',
  'calls',
  'admin',
  'errands',
  'creative',
  'review',
  'physical',
];
const STATUSES: TaskStatus[] = [
  'inbox',
  'active',
  'blocked',
  'waiting',
  'parked',
  'done',
  'killed',
];
const CRITICALITIES: Criticality[] = ['blocking', 'enabling', 'supporting', 'optional'];

interface Generated {
  ventures: Venture[];
  milestones: Milestone[];
  tasks: Task[];
  dependencies: Dependency[];
}

const portfolioArb = fc
  .record({
    ventureCount: fc.integer({ min: 1, max: 5 }),
    /**
     * Share bounds are generated, not fixed, so the space includes
     * configurations whose floors sum above 1.0 and whose ceilings sum below it
     * — the cases where no set of shares can satisfy every bound. The schema
     * invariant floor < ceiling <= 1.0 is still respected.
     */
    bounds: fc.array(
      fc.record({
        // Drawn from a uniform discrete set rather than fc.double: the double
        // generator biases hard towards small and special values, so five large
        // floors never co-occurred and the floors-overspend regime went
        // unexplored across 400 runs.
        floor: fc.integer({ min: 0, max: 9 }).map((n) => n / 20),
        width: fc.integer({ min: 1, max: 11 }).map((n) => n / 20),
      }),
      { minLength: 5, maxLength: 5 },
    ),
    milestoneSpecs: fc.array(
      fc.record({
        ventureIndex: fc.nat({ max: 4 }),
        dueOffset: fc.integer({ min: -30, max: 120 }),
        hardness: fc.constantFrom<Hardness>('hard', 'soft'),
        severity: fc.constantFrom('critical', 'high', 'medium', 'low', 'unclear'),
        status: fc.constantFrom<Milestone['status']>('active', 'active', 'hit', 'missed'),
      }),
      { minLength: 0, maxLength: 6 },
    ),
    taskSpecs: fc.array(
      fc.record({
        ventureIndex: fc.nat({ max: 4 }),
        milestoneIndex: fc.option(fc.nat({ max: 5 }), { nil: null }),
        criticality: fc.constantFrom(...CRITICALITIES),
        context: fc.constantFrom(...CONTEXTS),
        status: fc.constantFrom(...STATUSES),
        estimate_minutes: fc.integer({ min: 1, max: 2400 }),
        value: fc.integer({ min: 1, max: 10 }),
        lead_time_days: fc.integer({ min: 1, max: 14 }),
        snooze_count: fc.integer({ min: 0, max: 5 }),
        deadlineOffset: fc.option(fc.integer({ min: -20, max: 60 }), { nil: null }),
        targetOffset: fc.option(fc.integer({ min: -20, max: 60 }), { nil: null }),
        // ~20% recurring, not 50%: a portfolio that is half fixed overhead
        // leaves too little participating work to exercise the graph walks.
        is_recurring: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
        assignee: fc.option(fc.constantFrom('p1', 'p2', 'p3'), { nil: null }),
      }),
      { minLength: 0, maxLength: 40 },
    ),
    /** Edge candidates as index pairs; direction is normalised per-test. */
    edgePairs: fc.array(
      fc.tuple(fc.nat({ max: 39 }), fc.nat({ max: 39 })),
      { minLength: 0, maxLength: 40 },
    ),
  })
  .map((spec) => {
    const ventures: Venture[] = [];
    for (let i = 0; i < spec.ventureCount; i += 1) {
      const b = spec.bounds[i]!;
      const floor = Math.min(0.5, Math.max(0, b.floor));
      ventures.push({
        id: `v${i}`,
        name: `Venture ${i}`,
        slug: `v${i}`,
        strategic_weight: Math.min(2.0, Math.max(0.3, 0.3 + ((i * 37) % 17) / 10)),
        floor_share: floor,
        ceiling_share: Math.min(1.0, Math.max(Math.max(0.1, floor + 1e-6), floor + b.width)),
        attention_debt_hours: 0,
        active: i % 7 !== 6,
      });
    }

    const severityText: Record<string, string> = {
      critical: 'critical - the business stops',
      high: 'high - revenue slides',
      medium: 'medium - annoying',
      low: 'low - internal only',
      unclear: 'it gets worse somehow',
    };

    const milestones: Milestone[] = spec.milestoneSpecs.map((m, i) => ({
      id: `m${i}`,
      venture_id: ventures[m.ventureIndex % ventures.length]!.id,
      name: `Milestone ${i}`,
      due_date: addDays(TODAY, m.dueOffset, TZ)!,
      hardness: m.hardness,
      cost_of_slip: severityText[m.severity]!,
      status: m.status,
    }));

    const tasks: Task[] = spec.taskSpecs.map((t, i) => ({
      id: `t${i}`,
      venture_id: ventures[t.ventureIndex % ventures.length]!.id,
      project_id: null,
      milestone_id:
        t.milestoneIndex !== null && milestones.length > 0
          ? milestones[t.milestoneIndex % milestones.length]!.id
          : null,
      title: `Task ${i}`,
      criticality: t.criticality,
      context: t.context,
      energy: 'medium',
      estimate_minutes: t.estimate_minutes,
      value: t.value,
      deadline_date: t.deadlineOffset === null ? null : addDays(TODAY, t.deadlineOffset, TZ),
      deadline_time: null,
      target_date: t.targetOffset === null ? null : addDays(TODAY, t.targetOffset, TZ),
      lead_time_days: t.lead_time_days,
      status: t.status,
      snooze_count: t.snooze_count,
      assignee_person_id: t.assignee,
      is_recurring: t.is_recurring,
      recurrence_rule: t.is_recurring ? 'FREQ=DAILY' : null,
    }));

    return { ventures, milestones, tasks, edgePairs: spec.edgePairs };
  });

/** Edges oriented low index -> high index: acyclic by construction. */
function acyclicEdges(
  tasks: Task[],
  pairs: ReadonlyArray<readonly [number, number]>,
): Dependency[] {
  const out: Dependency[] = [];
  const seen = new Set<string>();
  for (const [a, b] of pairs) {
    if (tasks.length < 2) break;
    const i = a % tasks.length;
    const j = b % tasks.length;
    if (i === j) continue;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const key = `${lo}-${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ task_id: tasks[lo]!.id, blocks_task_id: tasks[hi]!.id });
  }
  return out;
}

/**
 * The acyclic set plus deliberate back-edges, so a cycle is guaranteed whenever
 * there is an edge to reverse. Letting the generator pick edge directions freely
 * produced a cycle in only 2 of 400 runs — far too rare to be testing the
 * degraded path at all.
 */
function cyclicEdges(
  tasks: Task[],
  pairs: ReadonlyArray<readonly [number, number]>,
): Dependency[] {
  const forward = acyclicEdges(tasks, pairs);
  // Every forward edge is reversed, not just the first few: a back-edge only
  // creates a cycle the slack walk can see when BOTH its endpoints participate
  // (blocking or enabling, not recurring, not closed), which is a ~3% chance per
  // edge. Reversing three of them found a cycle in 6 of 400 runs; reversing all
  // of them makes the degraded path near-certain whenever edges exist.
  const back: Dependency[] = forward.map((d) => ({
    task_id: d.blocks_task_id,
    blocks_task_id: d.task_id,
  }));
  return [...forward, ...back];
}

function runPipeline(g: Generated, availableHours: number) {
  const slack = computeSlack(g.tasks, g.dependencies, g.milestones, TODAY, { tz: TZ });
  const coverage = computeCoverage(g.tasks, g.dependencies, g.milestones);
  const demand = computeDemand(g.ventures, g.tasks, g.milestones, slack, TODAY, {
    tz: TZ,
    coverage,
    daysOfEvents: 0,
    daysSinceStart: 0,
  });
  const recurring = recurringHoursPerWeek(g.tasks).hoursPerWeek;
  const capacity = capacityCheck(demand, availableHours, recurring, { bufferRatio: 0.2 });
  return { slack, coverage, demand, capacity };
}

const RUNS = { numRuns: 300 };

describe('property: shares sum to 1.0', () => {
  it('holds for any acyclic portfolio', () => {
    fc.assert(
      fc.property(portfolioArb, (spec) => {
        const g: Generated = {
          ...spec,
          dependencies: acyclicEdges(spec.tasks, spec.edgePairs),
        };
        const { demand } = runPipeline(g, 40);
        const shares = Object.values(demand.shareByVenture);
        if (shares.length === 0) {
          // Only legitimate when every venture is inactive.
          expect(g.ventures.every((v) => !v.active)).toBe(true);
          return;
        }
        const sum = shares.reduce((a, b) => a + b, 0);
        expect(Math.abs(sum - 1)).toBeLessThan(0.001);
      }),
      RUNS,
    );
  });

  it('holds for cyclic portfolios too, where slack degrades', () => {
    fc.assert(
      fc.property(portfolioArb, (spec) => {
        const g: Generated = { ...spec, dependencies: cyclicEdges(spec.tasks, spec.edgePairs) };
        const { demand } = runPipeline(g, 40);
        const shares = Object.values(demand.shareByVenture);
        if (shares.length === 0) return;
        expect(Math.abs(shares.reduce((a, b) => a + b, 0) - 1)).toBeLessThan(0.001);
      }),
      RUNS,
    );
  });
});

describe('property: no score is NaN, Infinity or negative', () => {
  it('holds across every generated portfolio', () => {
    fc.assert(
      fc.property(portfolioArb, fc.boolean(), (spec, cyclic) => {
        const deps = cyclic
          ? cyclicEdges(spec.tasks, spec.edgePairs)
          : acyclicEdges(spec.tasks, spec.edgePairs);
        const result = computeScores(spec.tasks, {
          today: TODAY,
          tz: TZ,
          ventures: spec.ventures,
          tasks: spec.tasks,
          dependencies: deps,
          daysOfEvents: 0,
          daysSinceStart: 0,
        });
        for (const s of result.scores) {
          expect(Number.isFinite(s.score)).toBe(true);
          expect(s.score).toBeGreaterThanOrEqual(0);
          for (const [key, value] of Object.entries(s.components)) {
            if (typeof value === 'number') {
              expect(Number.isFinite(value), `${s.task_id}.${key} was ${value}`).toBe(true);
            }
          }
        }
        expect(Number.isFinite(result.median)).toBe(true);
        expect(Number.isFinite(result.valueInflation.fraction)).toBe(true);
      }),
      RUNS,
    );
  });

  it('holds for extreme values and estimates', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 100000 }),
        fc.double({ min: 0.3, max: 2.0, noNaN: true }),
        (value, minutes, weight) => {
          const venture: Venture = {
            id: 'v',
            name: 'v',
            slug: 'v',
            strategic_weight: weight,
            floor_share: 0.05,
            ceiling_share: 0.6,
            active: true,
          };
          const t: Task = {
            id: 't',
            venture_id: 'v',
            title: 't',
            criticality: 'blocking',
            context: 'deep_work',
            estimate_minutes: minutes,
            value,
            lead_time_days: 3,
            status: 'active',
            snooze_count: 0,
            is_recurring: false,
          };
          const r = computeScores([t], {
            today: TODAY,
            tz: TZ,
            ventures: [venture],
            tasks: [t],
            dependencies: [],
          });
          expect(Number.isFinite(r.scores[0]!.score)).toBe(true);
          expect(r.scores[0]!.score).toBeGreaterThan(0);
        },
      ),
      RUNS,
    );
  });
});

describe('property: slack is finite for every task in an acyclic graph', () => {
  it('never yields NaN or Infinity, and null only with a reason', () => {
    fc.assert(
      fc.property(portfolioArb, (spec) => {
        const deps = acyclicEdges(spec.tasks, spec.edgePairs);
        const g: Generated = { ...spec, dependencies: deps };
        const graph = buildGraph(
          spec.tasks.map((t) => t.id),
          deps,
        );
        expect(nodesOnCycles(graph).size).toBe(0); // the generator's own guarantee

        const { slack } = runPipeline(g, 40);
        expect(slack.cyclicTasks).toEqual([]);
        for (const [id, value] of slack.slack) {
          if (value === null) {
            expect(slack.nullReasons.get(id), `${id} null with no reason`).toBeTruthy();
          } else {
            expect(Number.isFinite(value), `${id} slack was ${value}`).toBe(true);
            expect(Number.isInteger(value)).toBe(true);
          }
        }
      }),
      RUNS,
    );
  });

  it('gives every participating task a number when an active milestone is reachable', () => {
    fc.assert(
      fc.property(portfolioArb, (spec) => {
        if (spec.tasks.length === 0) return;
        const activeMilestones = spec.milestones.filter((m) => m.status === 'active');
        if (activeMilestones.length === 0) return;
        const deps = acyclicEdges(spec.tasks, spec.edgePairs);
        const { slack } = runPipeline({ ...spec, dependencies: deps }, 40);

        for (const t of spec.tasks) {
          const participates =
            (t.criticality === 'blocking' || t.criticality === 'enabling') &&
            !t.is_recurring &&
            t.status !== 'done' &&
            t.status !== 'killed';
          const anchored = activeMilestones.some((m) => m.id === t.milestone_id);
          if (participates && anchored) {
            expect(typeof slack.slack.get(t.id), `${t.id} should have slack`).toBe('number');
          }
        }
      }),
      RUNS,
    );
  });
});

describe('property: floor and ceiling are never both violated', () => {
  it('holds, and unsatisfiable bounds are reported rather than hidden', () => {
    fc.assert(
      fc.property(portfolioArb, (spec) => {
        const g: Generated = {
          ...spec,
          dependencies: acyclicEdges(spec.tasks, spec.edgePairs),
        };
        const { demand } = runPipeline(g, 40);
        const bothViolated =
          demand.venturesBelowFloor.length > 0 && demand.venturesAtCeiling.length > 0;
        if (bothViolated) {
          // Permitted only when the configuration itself admits no solution, and
          // only when that is stated in errors[].
          expect(demand.errors.some((e) => e.code === 'bounds_unsatisfiable')).toBe(true);
        }
        // A violation of either side is always named.
        for (const id of [...demand.venturesBelowFloor, ...demand.venturesAtCeiling]) {
          expect(demand.confidence.notes.some((n) => n.includes(id.replace('v', 'v')))).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it('respects both bounds exactly when the configuration is satisfiable', () => {
    fc.assert(
      fc.property(portfolioArb, (spec) => {
        // Bounds that always admit a solution: equal, wide, and summing past 1.
        const ventures = spec.ventures.map((v) => ({
          ...v,
          active: true,
          floor_share: 0.0,
          ceiling_share: 1.0,
        }));
        const g: Generated = {
          ...spec,
          ventures,
          dependencies: acyclicEdges(spec.tasks, spec.edgePairs),
        };
        const { demand } = runPipeline(g, 40);
        for (const d of demand.ventureDetail) {
          expect(d.share).toBeGreaterThanOrEqual(-1e-12);
          expect(d.share).toBeLessThanOrEqual(1 + 1e-12);
        }
        expect(demand.venturesBelowFloor).toEqual([]);
        expect(demand.venturesAtCeiling).toEqual([]);
      }),
      RUNS,
    );
  });
});

describe('property: no task appears twice in any returned list', () => {
  it('holds for every list the engine returns', () => {
    fc.assert(
      fc.property(portfolioArb, fc.boolean(), (spec, cyclic) => {
        const deps = cyclic
          ? cyclicEdges(spec.tasks, spec.edgePairs)
          : acyclicEdges(spec.tasks, spec.edgePairs);
        const g: Generated = { ...spec, dependencies: deps };
        const { slack, capacity } = runPipeline(g, 40);
        const scores = computeScores(spec.tasks, {
          today: TODAY,
          tz: TZ,
          ventures: spec.ventures,
          tasks: spec.tasks,
          dependencies: deps,
        });

        const noDupes = (ids: string[], label: string) => {
          expect(new Set(ids).size, `${label} contained a duplicate`).toBe(ids.length);
        };
        noDupes(scores.scores.map((s) => s.task_id), 'scores');
        noDupes(scores.needsTriage.map((s) => s.task_id), 'needsTriage');
        noDupes(scores.excluded.map((s) => s.task_id), 'excluded');
        noDupes(slack.cyclicTasks, 'cyclicTasks');
        noDupes(capacity.rankedBySlipCost.map((m) => m.milestone_id), 'rankedBySlipCost');
        noDupes(capacity.slipCandidates.map((m) => m.milestone_id), 'slipCandidates');

        // A task is scored or excluded, never both.
        const scored = new Set(scores.scores.map((s) => s.task_id));
        for (const e of scores.excluded) expect(scored.has(e.task_id)).toBe(false);
      }),
      RUNS,
    );
  });
});

describe('property: computeDemand is deterministic for identical input', () => {
  it('returns byte-identical results on a second call', () => {
    fc.assert(
      fc.property(portfolioArb, (spec) => {
        const g: Generated = {
          ...spec,
          dependencies: acyclicEdges(spec.tasks, spec.edgePairs),
        };
        const a = runPipeline(g, 40);
        const b = runPipeline(g, 40);
        expect(JSON.stringify(b.demand)).toBe(JSON.stringify(a.demand));
        expect(JSON.stringify(b.capacity)).toBe(JSON.stringify(a.capacity));
        expect(JSON.stringify(b.coverage)).toBe(JSON.stringify(a.coverage));
      }),
      RUNS,
    );
  });

  it('does not depend on the order rows arrive in', () => {
    fc.assert(
      fc.property(portfolioArb, (spec) => {
        const deps = acyclicEdges(spec.tasks, spec.edgePairs);
        const forward = runPipeline({ ...spec, dependencies: deps }, 40);
        const reversed = runPipeline(
          {
            ventures: [...spec.ventures].reverse(),
            milestones: [...spec.milestones].reverse(),
            tasks: [...spec.tasks].reverse(),
            dependencies: [...deps].reverse(),
          },
          40,
        );
        expect(reversed.demand.totalRequired).toBeCloseTo(forward.demand.totalRequired, 9);
        for (const v of spec.ventures) {
          if (!v.active) continue;
          expect(reversed.demand.shareByVenture[v.id]).toBeCloseTo(
            forward.demand.shareByVenture[v.id]!,
            9,
          );
        }
        expect(reversed.capacity.verdict).toBe(forward.capacity.verdict);
        expect(reversed.capacity.rankedBySlipCost.map((m) => m.milestone_id)).toEqual(
          forward.capacity.rankedBySlipCost.map((m) => m.milestone_id),
        );
      }),
      RUNS,
    );
  });
});

describe('property: the engine never throws, and never answers emptily in silence', () => {
  it('survives every generated portfolio, cyclic or not', () => {
    fc.assert(
      fc.property(
        portfolioArb,
        fc.boolean(),
        fc.double({ min: 0, max: 400, noNaN: true }),
        (spec, cyclic, hours) => {
          const deps = cyclic
            ? cyclicEdges(spec.tasks, spec.edgePairs)
            : acyclicEdges(spec.tasks, spec.edgePairs);
          const g: Generated = { ...spec, dependencies: deps };
          expect(() => runPipeline(g, hours)).not.toThrow();
          const { slack, demand, capacity } = runPipeline(g, hours);

          // Every empty answer carries a reason (D7).
          if (Object.keys(slack.minSlackByMilestone).length === 0) {
            expect(slack.errors.length + slack.notes.length).toBeGreaterThan(0);
          }
          if (demand.totalRequired === 0) {
            expect(demand.errors.length + demand.confidence.notes.length).toBeGreaterThan(0);
          }
          expect(Number.isFinite(capacity.deficitHours)).toBe(true);
          expect(Number.isFinite(capacity.usableHours)).toBe(true);
          expect(capacity.usableHours).toBeGreaterThanOrEqual(0);
          expect(['ok', 'deficit']).toContain(capacity.verdict);
        },
      ),
      RUNS,
    );
  });

  it('keeps the buffer non-negotiable at every hours figure (D9)', () => {
    fc.assert(
      fc.property(
        portfolioArb,
        fc.double({ min: 0, max: 400, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (spec, hours, recurring) => {
          const g: Generated = {
            ...spec,
            dependencies: acyclicEdges(spec.tasks, spec.edgePairs),
          };
          const slack = computeSlack(g.tasks, g.dependencies, g.milestones, TODAY, { tz: TZ });
          const demand = computeDemand(g.ventures, g.tasks, g.milestones, slack, TODAY, {
            tz: TZ,
            dependencies: g.dependencies,
          });
          const c = capacityCheck(demand, hours, recurring, { bufferRatio: 0.2 });
          const net = Math.max(0, Math.min(hours, hours - recurring));
          expect(c.usableHours).toBeCloseTo(net * 0.8, 9);
          expect(c.usableHours).toBeLessThanOrEqual(hours);
        },
      ),
      RUNS,
    );
  });

  it('closes the deficit at the first index whose running total covers it', () => {
    fc.assert(
      fc.property(
        portfolioArb,
        fc.double({ min: 0, max: 200, noNaN: true }),
        (spec, hours) => {
          const g: Generated = {
            ...spec,
            dependencies: acyclicEdges(spec.tasks, spec.edgePairs),
          };
          const { capacity } = runPipeline(g, hours);
          if (capacity.verdict === 'ok') {
            expect(capacity.coversDeficitAtIndex).toBeNull();
            expect(capacity.slipCandidates.every((c) => !c.clearsDeficit)).toBe(true);
            return;
          }
          const idx = capacity.coversDeficitAtIndex;
          if (idx === null) {
            const total =
              capacity.slipCandidates.at(-1)?.cumulativeHoursFreed ?? 0;
            expect(total).toBeLessThan(capacity.deficitHours);
            return;
          }
          expect(capacity.slipCandidates[idx]!.cumulativeHoursFreed).toBeGreaterThanOrEqual(
            capacity.deficitHours - 1e-9,
          );
          if (idx > 0) {
            expect(capacity.slipCandidates[idx - 1]!.cumulativeHoursFreed).toBeLessThan(
              capacity.deficitHours,
            );
          }
        },
      ),
      RUNS,
    );
  });
});

describe('property: the time utilities underneath', () => {
  it('daysBetween is antisymmetric and additive', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -3000, max: 3000 }),
        fc.integer({ min: -3000, max: 3000 }),
        (a, b) => {
          const da = addDays('2020-01-01', a, TZ)!;
          const db = addDays('2020-01-01', b, TZ)!;
          expect(daysBetween(da, db, TZ)).toBe(b - a);
          expect(daysBetween(db, da, TZ)).toBe(a - b);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('addDays inverts daysBetween across every DST transition in range', () => {
    fc.assert(
      fc.property(fc.integer({ min: -4000, max: 4000 }), fc.integer({ min: -400, max: 400 }), (base, shift) => {
        const start = addDays('2020-01-01', base, TZ)!;
        const moved = addDays(start, shift, TZ)!;
        expect(daysBetween(start, moved, TZ)).toBe(shift);
        expect(addDays(moved, -shift, TZ)).toBe(start);
      }),
      { numRuns: 500 },
    );
  });
});

describe('meta: the generator actually produces the hostile cases', () => {
  // A property test that never sees a cycle, a deficit or an unsatisfiable
  // bound proves nothing. This measures the generated space directly, so a
  // future change to the generator cannot quietly make everything vacuous.
  it('covers cycles, deficits, surpluses, past-due milestones and bad bounds', () => {
    const seen = {
      cycles: 0,
      deficits: 0,
      surpluses: 0,
      pastDue: 0,
      floorsOverspend: 0,
      ceilingsUnderfill: 0,
      belowFloor: 0,
      lowCoverage: 0,
      degradedSlack: 0,
      unclearSlipCost: 0,
      emptyTaskSets: 0,
      snoozedOut: 0,
      samples: 0,
    };

    fc.assert(
      fc.property(portfolioArb, fc.boolean(), (spec, cyclic) => {
        seen.samples += 1;
        const deps = cyclic
          ? cyclicEdges(spec.tasks, spec.edgePairs)
          : acyclicEdges(spec.tasks, spec.edgePairs);
        const g: Generated = { ...spec, dependencies: deps };
        const { slack, coverage, demand, capacity } = runPipeline(g, 40);

        if (slack.cyclicTasks.length > 0) seen.cycles += 1;
        if (slack.degraded) seen.degradedSlack += 1;
        if (capacity.verdict === 'deficit') seen.deficits += 1;
        else seen.surpluses += 1;
        if (spec.milestones.some((m) => m.status === 'active' && m.due_date < TODAY)) {
          seen.pastDue += 1;
        }
        const active = spec.ventures.filter((v) => v.active);
        if (active.reduce((a, v) => a + v.floor_share, 0) > 1) seen.floorsOverspend += 1;
        if (active.length > 0 && active.reduce((a, v) => a + v.ceiling_share, 0) < 1) {
          seen.ceilingsUnderfill += 1;
        }
        if (demand.venturesBelowFloor.length > 0) seen.belowFloor += 1;
        if (coverage.lowConfidence.length > 0) seen.lowCoverage += 1;
        if (spec.milestones.some((m) => m.cost_of_slip.includes('somehow'))) {
          seen.unclearSlipCost += 1;
        }
        if (spec.tasks.length === 0) seen.emptyTaskSets += 1;
        if (spec.tasks.some((t) => t.snooze_count >= 3)) seen.snoozedOut += 1;
      }),
      { numRuns: 400 },
    );

    // Every hostile shape must have been exercised at least a few times.
    for (const [name, count] of Object.entries(seen)) {
      expect(count, `generator never produced: ${name}`).toBeGreaterThan(0);
    }
    expect(seen.cycles).toBeGreaterThan(10);
    expect(seen.deficits).toBeGreaterThan(10);
    expect(seen.lowCoverage).toBeGreaterThan(10);
  });
});
