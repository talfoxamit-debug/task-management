import { describe, expect, it } from 'vitest';
import { capacityCheck } from '../src/capacity.js';
import { computeCoverage } from '../src/coverage.js';
import { computeDemand, costSeverity } from '../src/demand.js';
import { recurringHoursPerWeek } from '../src/recurrence.js';
import { computeSlack } from '../src/slack.js';
import type { Milestone, Task, Venture } from '../src/types.js';
import { expected, numericEntries, portfolio } from './fixture.js';

const { tasks, dependencies, milestones, ventures, today, activeTz } = portfolio;
const opts = { tz: activeTz };

const slack = computeSlack(tasks, dependencies, milestones, today, opts);
const coverage = computeCoverage(tasks, dependencies, milestones);
const demand = computeDemand(ventures, tasks, milestones, slack, today, {
  ...opts,
  coverage,
  calibration: portfolio.calibration,
  daysOfEvents: 0,
  daysSinceStart: 0,
});

describe('recurring overhead — the capacityCheck input', () => {
  it('matches the hand-computed 12.5 h/week', () => {
    const load = recurringHoursPerWeek(tasks);
    expect(load.hoursPerWeek).toBeCloseTo(expected.capacity.recurringHours, 10);
    expect(load.perTask['t_r1']).toBeCloseTo(3.5, 10); // FREQ=DAILY, 30m
    expect(load.perTask['t_r2']).toBeCloseTo(2.0, 10); // FREQ=WEEKLY;BYDAY=MO, 120m
    expect(load.perTask['t_r3']).toBeCloseTo(7.0, 10); // FREQ=DAILY, 60m
    expect(load.unparsed).toEqual([]);
  });

  it('reports an unreadable rule instead of silently reserving nothing', () => {
    const broken: Task[] = tasks.map((t) =>
      t.id === 't_r1' ? { ...t, recurrence_rule: 'every so often' } : t,
    );
    const load = recurringHoursPerWeek(broken);
    expect(load.unparsed).toHaveLength(1);
    expect(load.unparsed[0]!.reason).toContain('capacity is overstated');
    expect(load.hoursPerWeek).toBeCloseTo(9.0, 10);
  });

  it('honours INTERVAL', () => {
    const fortnightly: Task[] = [
      { ...tasks.find((t) => t.id === 't_r2')!, recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2' },
    ];
    expect(recurringHoursPerWeek(fortnightly).hoursPerWeek).toBeCloseTo(1.0, 10);
  });
});

describe('computeDemand against the hand-computed fixture', () => {
  it.each(numericEntries(expected.demand.requiredByMilestone))(
    'required(%s) === %d h/wk',
    (id, want) => {
      expect(demand.requiredByMilestone[id]).toBeCloseTo(want, 9);
    },
  );

  it.each(numericEntries(expected.demand.pressureByMilestone))(
    'pressure(%s) === %d',
    (id, want) => {
      expect(demand.pressureByMilestone[id]).toBeCloseTo(want, 12);
    },
  );

  it.each(numericEntries(expected.demand.requiredByVenture))(
    'required(%s) === %d h/wk',
    (id, want) => {
      expect(demand.requiredByVenture[id]).toBeCloseTo(want, 9);
    },
  );

  it('total required matches to full precision', () => {
    expect(demand.totalRequired).toBeCloseTo(expected.demand.totalRequired, 9);
  });

  it.each(numericEntries(expected.demand.rawShareByVenture))('rawShare(%s) === %d', (id, want) => {
    expect(demand.rawShareByVenture[id]).toBeCloseTo(want, 6);
  });

  it.each(numericEntries(expected.demand.clampedShareByVenture))(
    'clampedShare(%s) === %d',
    (id, want) => {
      expect(demand.clampedShareByVenture[id]).toBeCloseTo(want, 6);
    },
  );

  it.each(numericEntries(expected.demand.shareByVenture))('share(%s) === %d', (id, want) => {
    expect(demand.shareByVenture[id]).toBeCloseTo(want, 6);
  });

  it('shares sum to exactly 1.0', () => {
    const sum = Object.values(demand.shareByVenture).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 12);
  });

  it('used the fallback for exactly the low-coverage milestone', () => {
    expect(demand.fallbackMilestones).toEqual(['m_sw_saleready']);
    const detail = demand.milestoneDetail.find((m) => m.milestone_id === 'm_sw_saleready')!;
    expect(detail.usedFallback).toBe(true);
    // Fallback is blocking-only: the enabling t_sw6 must be dropped.
    expect(detail.enablingMinutes).toBe(480);
    expect(detail.demandHours).toBeCloseTo(28, 9);
    // And its slack must not have reached pressure, even though slack exists.
    expect(detail.minSlack).toBe(6);
    expect(detail.pressure).toBe(1);
  });

  it('applies pressure only where slack is trustworthy and negative', () => {
    const pressured = demand.milestoneDetail.filter((m) => m.pressure > 1).map((m) => m.milestone_id);
    expect(pressured.sort()).toEqual(['m_octo_demo', 'm_yh_live']);
  });

  it('floors weeks-remaining for the past-due milestone', () => {
    const octo = demand.milestoneDetail.find((m) => m.milestone_id === 'm_octo_demo')!;
    expect(octo.weeksUntilRaw).toBeCloseTo(-2 / 7, 12);
    expect(octo.weeks).toBe(0.5);
    expect(octo.weeksFloored).toBe(true);
    expect(demand.confidence.notes.join(' ')).toContain('due_date has passed');
  });

  it('names the ventures pushed below their floor by the renormalisation', () => {
    expect(demand.venturesBelowFloor.sort()).toEqual(
      [...expected.demand.venturesBelowFloorAfterRenormalise].sort(),
    );
    expect(demand.venturesAtCeiling).toEqual(expected.demand.venturesAtCeiling);
    expect(demand.confidence.notes.join(' ')).toContain('under its 7% floor');
  });

  it('excludes recurring tasks from demand (D5)', () => {
    // t_r3 is blocking, active and attached to m_yh_live: only D5 keeps its
    // 60 minutes out of the blocking sum.
    const live = demand.milestoneDetail.find((m) => m.milestone_id === 'm_yh_live')!;
    expect(live.blockingMinutes).toBe(1800);
    expect(live.eligibleTaskCount).toBe(3);
  });

  it('excludes blocked, waiting, parked, done and killed work', () => {
    const st = demand.milestoneDetail.find((m) => m.milestone_id === 'm_st_proposal')!;
    expect(st.blockingMinutes).toBe(480); // t_st2 is blocked and excluded
    const octo = demand.milestoneDetail.find((m) => m.milestone_id === 'm_octo_demo')!;
    expect(octo.blockingMinutes).toBe(600); // t_x6_killed excluded
  });

  it('counts a paused project\'s active children', () => {
    const fox = demand.milestoneDetail.find((m) => m.milestone_id === 'm_fox_phase1')!;
    expect(fox.blockingMinutes).toBe(1200);
    expect(fox.enablingMinutes).toBe(360);
    expect(fox.demandHours).toBeCloseTo(7, 9);
  });

  it('outcome targets drive no demand whatsoever (D1)', () => {
    // The two outcome targets in the fixture point at real milestones and have
    // target_dates inside the horizon. They are not an argument to computeDemand
    // and their venture requirements come only from milestones.
    expect(expected.demand.outcomeTargetsContributed).toBe(0);
    const stackwrkFromMilestones = demand.milestoneDetail
      .filter((m) => m.venture_id === 'v_stackwrk')
      .reduce((a, m) => a + m.requiredHours, 0);
    expect(demand.requiredByVenture['v_stackwrk']).toBeCloseTo(stackwrkFromMilestones, 12);
  });

  it('is deterministic for identical input', () => {
    const again = computeDemand(ventures, tasks, milestones, slack, today, {
      ...opts,
      coverage,
      calibration: portfolio.calibration,
      daysOfEvents: 0,
      daysSinceStart: 0,
    });
    expect(again.shareByVenture).toEqual(demand.shareByVenture);
    expect(again.requiredByMilestone).toEqual(demand.requiredByMilestone);
    expect(again.totalRequired).toBe(demand.totalRequired);
  });

  it('surfaces the D4 cold-start facts', () => {
    expect(demand.confidence.calibrated).toBe(expected.confidence.calibrated);
    expect(demand.confidence.balancingActive).toBe(expected.confidence.balancingActive);
    expect(Object.keys(demand.confidence.coverageByMilestone)).toHaveLength(6);
    expect(demand.confidence.notes.join(' ')).toContain('calibration not applied');
    expect(demand.confidence.notes.join(' ')).toContain('balance corrector disabled');
  });
});

describe('computeDemand degrades instead of throwing (D7)', () => {
  it('reports a milestone whose venture is missing', () => {
    const orphan: Milestone[] = [
      ...milestones,
      {
        id: 'm_orphan',
        venture_id: 'v_ghost',
        name: 'Orphan',
        due_date: '2026-09-01',
        hardness: 'soft',
        cost_of_slip: 'low',
        status: 'active',
      },
    ];
    const r = computeDemand(ventures, tasks, orphan, slack, today, { ...opts, coverage });
    expect(r.errors.some((e) => e.code === 'missing_venture')).toBe(true);
    expect(r.requiredByMilestone['m_orphan']).toBeUndefined();
  });

  it('skips an inactive venture entirely', () => {
    const paused: Venture[] = ventures.map((v) =>
      v.id === 'v_octo' ? { ...v, active: false } : v,
    );
    const r = computeDemand(paused, tasks, milestones, slack, today, { ...opts, coverage });
    expect(r.shareByVenture['v_octo']).toBeUndefined();
    expect(r.errors.some((e) => e.code === 'missing_venture')).toBe(true);
    const sum = Object.values(r.shareByVenture).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 12);
  });

  it('falls back to floors when nothing demands anything, and says so', () => {
    const r = computeDemand(ventures, [], milestones, slack, today, { ...opts });
    expect(r.totalRequired).toBe(0);
    const sum = Object.values(r.shareByVenture).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 12);
    expect(r.confidence.notes.join(' ')).toContain('not a recommendation');
  });

  it('reports bounds that cannot all be honoured', () => {
    // Five ventures with 0.30 floors need 1.5 of a 1.0 budget.
    const greedy: Venture[] = ventures.map((v) => ({
      ...v,
      floor_share: 0.3,
      ceiling_share: 0.35,
    }));
    const r = computeDemand(greedy, tasks, milestones, slack, today, { ...opts, coverage });
    expect(r.errors.some((e) => e.code === 'bounds_unsatisfiable')).toBe(true);
    const sum = Object.values(r.shareByVenture).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 12);
  });

  it('never lets a single landing milestone erase the other ventures', () => {
    // Everything due tomorrow: without the max(0.5, ...) floor this diverges.
    const imminent: Milestone[] = milestones.map((m) => ({ ...m, due_date: '2026-07-30' }));
    const s = computeSlack(tasks, dependencies, imminent, today, opts);
    const c = computeCoverage(tasks, dependencies, imminent);
    const r = computeDemand(ventures, tasks, imminent, s, today, { ...opts, coverage: c });
    for (const v of ventures) {
      expect(Number.isFinite(r.requiredByVenture[v.id]!)).toBe(true);
      expect(r.shareByVenture[v.id]!).toBeGreaterThan(0);
    }
    expect(Object.values(r.shareByVenture).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
});

describe('cost_of_slip severity ordering', () => {
  it('reads the fixture strings the way the ranking needs', () => {
    expect(costSeverity('high - launch window and the paid listings pipeline')).toBe('high');
    expect(costSeverity('low - internal only, no one outside is waiting on it')).toBe('low');
    expect(costSeverity('medium - the lead cools and has to be re-warmed')).toBe('medium');
  });

  it('takes the highest severity mentioned', () => {
    expect(costSeverity('low risk now but critical by September')).toBe('critical');
  });

  it('treats an unrecognised string as medium rather than sorting it last', () => {
    expect(costSeverity('the vibes get worse')).toBe('medium');
  });

  it('is not fooled by substrings', () => {
    expect(costSeverity('the follow-up window closes')).toBe('medium');
  });
});

describe('capacityCheck — the primary output of V1', () => {
  const recurringHours = expected.capacity.recurringHours;

  it('ranks milestones by slip cost exactly as hand-computed', () => {
    const r = capacityCheck(demand, 40, recurringHours, { bufferRatio: 0.2 });
    expect(r.rankedBySlipCost.map((x) => x.milestone_id)).toEqual(
      expected.capacity.rankedBySlipCost.map((x) => x.milestone_id),
    );
    for (const want of expected.capacity.rankedBySlipCost) {
      const got = r.rankedBySlipCost.find((x) => x.milestone_id === want.milestone_id)!;
      expect(got.hardness).toBe(want.hardness);
      expect(got.costSeverity).toBe(want.costSeverity);
      expect(got.minSlack).toBe(want.minSlack);
      expect(got.hoursFreed).toBeCloseTo(want.hoursFreed, 9);
    }
  });

  it('orders slip candidates cheapest first with the hand-computed running total', () => {
    const r = capacityCheck(demand, 40, recurringHours, { bufferRatio: 0.2 });
    expect(r.slipCandidates.map((x) => x.milestone_id)).toEqual(
      expected.capacity.slipCandidateOrder,
    );
    r.slipCandidates.forEach((c, i) => {
      expect(c.cumulativeHoursFreed).toBeCloseTo(expected.capacity.cumulativeHoursFreed[i]!, 9);
    });
  });

  it.each(expected.capacity.scenarios)(
    'scenario "$name": $availableHours available h/wk',
    (scenario) => {
      const r = capacityCheck(demand, scenario.availableHours, recurringHours, {
        bufferRatio: 0.2,
      });
      expect(r.usableHours).toBeCloseTo(scenario.usableHours, 9);
      expect(r.deficitHours).toBeCloseTo(scenario.deficitHours, 9);
      expect(r.verdict).toBe(scenario.verdict);
      expect(r.coversDeficitAtIndex).toBe(scenario.coversDeficitAtIndex);
    },
  );

  it('applies the 20% buffer before any allocation (D9)', () => {
    const r = capacityCheck(demand, 40, recurringHours, { bufferRatio: 0.2 });
    // (40 - 12.5) = 27.5 net of recurring; buffer takes 5.5; 22.0 usable.
    expect(r.bufferHours).toBeCloseTo(5.5, 9);
    expect(r.usableHours).toBeCloseTo(22.0, 9);
    expect(r.usableHours + r.bufferHours + r.recurringHours).toBeCloseTo(40, 9);
  });

  it('says plainly when the deficit cannot be closed by slipping anything', () => {
    const r = capacityCheck(demand, 40, recurringHours, { bufferRatio: 0.2 });
    expect(r.coversDeficitAtIndex).toBe(5);
    const hardSlips = r.slipCandidates.filter((c) => c.clearsDeficit && c.hardness === 'hard');
    expect(hardSlips).toHaveLength(1);
    expect(r.confidence.notes.join(' ')).toContain('HARD milestone');
  });

  it('turns shares into hours against the usable figure, not the raw one', () => {
    const r = capacityCheck(demand, 40, recurringHours, { bufferRatio: 0.2 });
    const total = Object.values(r.allocatedHoursByVenture).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(r.usableHours, 9);
  });

  it('carries the confidence object through to the primary output (D4)', () => {
    const r = capacityCheck(demand, 40, recurringHours, { bufferRatio: 0.2 });
    expect(r.confidence.calibrated).toBe(false);
    expect(r.confidence.balancingActive).toBe(false);
    expect(r.confidence.coverageByMilestone['m_sw_saleready']).toBeCloseTo(0.4, 12);
    expect(r.confidence.notes.length).toBeGreaterThan(3);
  });

  it('handles recurring overhead swallowing the whole week', () => {
    const r = capacityCheck(demand, 10, 20, { bufferRatio: 0.2 });
    expect(r.usableHours).toBe(0);
    expect(r.verdict).toBe('deficit');
    expect(r.confidence.notes.join(' ')).toContain('no capacity for project work');
  });

  it('reports non-finite inputs rather than propagating NaN', () => {
    const r = capacityCheck(demand, Number.NaN, recurringHours, { bufferRatio: 0.2 });
    expect(r.errors.some((e) => e.code === 'no_input')).toBe(true);
    expect(Number.isFinite(r.deficitHours)).toBe(true);
    expect(Number.isFinite(r.usableHours)).toBe(true);
  });

  it('reports a surplus when capacity exceeds demand', () => {
    const r = capacityCheck(demand, 220, recurringHours, { bufferRatio: 0.2 });
    expect(r.verdict).toBe('ok');
    expect(r.surplusHours).toBeCloseTo(7.195292207792196, 9);
    expect(r.confidence.notes.join(' ')).toContain('to spare');
  });
});
