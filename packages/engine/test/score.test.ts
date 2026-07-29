import { describe, expect, it } from 'vitest';
import { balanceFactors, releasableAttentionDebt } from '../src/balance.js';
import { computeScore, computeScores, urgency, type ScoreContext } from '../src/score.js';
import type { CalibrationRow, Task, Venture } from '../src/types.js';
import { expected, numericEntries, portfolio } from './fixture.js';

const { tasks, dependencies, ventures, today, activeTz } = portfolio;

const ctx: ScoreContext = {
  today,
  tz: activeTz,
  ventures,
  tasks,
  dependencies,
  calibration: portfolio.calibration,
  daysOfEvents: 0,
  daysSinceStart: 0,
};

function task(id: string): Task {
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new Error(`fixture has no task ${id}`);
  return t;
}

describe('computeScore against the hand-computed fixture', () => {
  // The hand-computed figures carry the precision of an exponential worked out
  // on paper: about six significant figures. expected.json declares that as its
  // tolerance, and the structural assertions below pin the formula exactly, with
  // no transcendental term computed by hand at all.
  it.each(numericEntries(expected.scores.byTask))('score(%s) === %d', (id, want) => {
    const s = computeScore(task(id), ctx);
    expect(Math.abs(s.score - want) / want).toBeLessThan(expected.scores.tolerance);
  });

  it('matches the Part 4 formula exactly, component by component', () => {
    // Each right-hand side is the spec formula with the hand-derived components
    // substituted in: value, W, U, L and E's base. No rounding anywhere.
    expect(computeScore(task('t_x8_overdue'), ctx).score).toBeCloseTo(
      (Math.pow(6, 1.2) * 1.3 * 3.0 * 1) / Math.pow(2, 0.6),
      12,
    );
    expect(computeScore(task('t_x9_leadtime'), ctx).score).toBeCloseTo(
      (Math.pow(5, 1.2) * 1.2 * 1.6 * 1) / 1,
      12,
    );
    expect(computeScore(task('t_x10_target'), ctx).score).toBeCloseTo(
      (Math.pow(4, 1.2) * 1.3 * 1.3 * 1) / Math.pow(3, 0.6),
      12,
    );
    expect(computeScore(task('t_x11_plain'), ctx).score).toBeCloseTo(
      (Math.pow(3, 1.2) * 0.5 * 1.0 * 1) / Math.pow(1.5, 0.6),
      12,
    );
    expect(computeScore(task('t_x12_leverage'), ctx).score).toBeCloseTo(
      (Math.pow(8, 1.2) * 1.0 * 1.0 * 2.7) / Math.pow(4, 0.6),
      12,
    );
  });

  it('isolates each urgency branch, as the hand computation assumed', () => {
    expect(computeScore(task('t_x8_overdue'), ctx).components.urgencyReason).toBe('overdue');
    expect(computeScore(task('t_x8_overdue'), ctx).components.U).toBe(3.0);
    expect(computeScore(task('t_x9_leadtime'), ctx).components.urgencyReason).toBe(
      'deadline_within_lead_time',
    );
    expect(computeScore(task('t_x9_leadtime'), ctx).components.U).toBe(1.6);
    expect(computeScore(task('t_x10_target'), ctx).components.urgencyReason).toBe(
      'target_within_7',
    );
    expect(computeScore(task('t_x11_plain'), ctx).components.urgencyReason).toBe('none');
    expect(computeScore(task('t_x11_plain'), ctx).components.U).toBe(1.0);
  });

  it('builds leverage from open dependents and from a second person', () => {
    const s = computeScore(task('t_x12_leverage'), ctx);
    expect(s.components.directlyBlockedCount).toBe(2);
    expect(s.components.unblocksAnotherPerson).toBe(true);
    expect(s.components.L).toBeCloseTo(2.7, 12);
  });

  it('does not count a closed dependent as leverage', () => {
    const withClosed: Task[] = tasks.map((t) =>
      t.id === 't_x3_blocked'
        ? { ...t, status: 'done' as const }
        : t,
    );
    const s = computeScore(task('t_x12_leverage'), { ...ctx, tasks: withClosed });
    expect(s.components.directlyBlockedCount).toBe(1);
    // t_x3_blocked was the one assigned to another person.
    expect(s.components.unblocksAnotherPerson).toBe(false);
    expect(s.components.L).toBeCloseTo(1.35, 12);
  });

  it('holds the calibration ratio at 1.0 below 8 samples (D4)', () => {
    const s = computeScore(task('t_x8_overdue'), ctx);
    expect(s.components.calibrationRatio).toBe(1.0);
    expect(s.components.calibrationApplied).toBe(false);
  });

  it('applies a calibration ratio once a context has 8 samples', () => {
    const calibrated: CalibrationRow[] = portfolio.calibration.map((c) =>
      c.context === 'admin' ? { ...c, ratio: 1.5, sample_n: 8 } : c,
    );
    const s = computeScore(task('t_x8_overdue'), { ...ctx, calibration: calibrated });
    expect(s.components.calibrationApplied).toBe(true);
    // E = (60 * 1.5 / 30)^0.6 = 3^0.6 = 1.93318204
    expect(s.components.E).toBeCloseTo(Math.pow(3, 0.6), 12);
    // A context that runs long makes its tasks score LOWER, being more expensive.
    expect(s.score).toBeLessThan(computeScore(task('t_x8_overdue'), ctx).score);
  });

  it('one sample short of the threshold still does not apply', () => {
    const nearly: CalibrationRow[] = portfolio.calibration.map((c) =>
      c.context === 'admin' ? { ...c, ratio: 1.5, sample_n: 7 } : c,
    );
    expect(computeScore(task('t_x8_overdue'), { ...ctx, calibration: nearly }).components.E)
      .toBeCloseTo(Math.pow(2, 0.6), 12);
  });

  it('holds balance at 1.0 when no factors are supplied (D4)', () => {
    expect(computeScore(task('t_x11_plain'), ctx).components.balance).toBe(1.0);
    expect(computeScore(task('t_x11_plain'), ctx).components.W).toBeCloseTo(0.5, 12);
  });

  it('scores blocked and waiting work at zero', () => {
    for (const [id, want] of numericEntries(expected.scores.zeroScored)) {
      const s = computeScore(task(id), ctx);
      expect(s.score).toBe(want);
      expect(s.zeroReason).toBeTruthy();
    }
  });

  it('never multiplies by deadline pressure a second time', () => {
    // The same task with a milestone at deep negative slack must score
    // identically: pressure lives in computeDemand and nowhere else.
    const onCriticalPath = computeScore(task('t_yh1'), ctx);
    const detached = computeScore({ ...task('t_yh1'), milestone_id: null }, ctx);
    expect(onCriticalPath.score).toBeCloseTo(detached.score, 12);
  });
});

describe('urgency edge cases', () => {
  const base = task('t_x11_plain');

  it('treats a deadline exactly lead_time_days out as inside the window', () => {
    const t: Task = { ...base, deadline_date: '2026-08-01', lead_time_days: 3 };
    expect(urgency(t, today, activeTz)).toEqual({ U: 1.6, reason: 'deadline_within_lead_time' });
  });

  it('treats one day beyond lead_time_days as not urgent', () => {
    const t: Task = { ...base, deadline_date: '2026-08-02', lead_time_days: 3 };
    expect(urgency(t, today, activeTz).reason).toBe('none');
  });

  it('treats a deadline today as inside the window, not overdue', () => {
    const t: Task = { ...base, deadline_date: today, lead_time_days: 1 };
    expect(urgency(t, today, activeTz)).toEqual({ U: 1.6, reason: 'deadline_within_lead_time' });
  });

  it('treats yesterday as overdue', () => {
    const t: Task = { ...base, deadline_date: '2026-07-28' };
    expect(urgency(t, today, activeTz).U).toBe(3.0);
  });

  it('prefers an overdue deadline over a near target date', () => {
    const t: Task = { ...base, deadline_date: '2026-07-01', target_date: '2026-07-30' };
    expect(urgency(t, today, activeTz).reason).toBe('overdue');
  });

  it('falls through to the target date when the deadline is far off', () => {
    const t: Task = { ...base, deadline_date: '2026-12-01', target_date: '2026-08-02' };
    expect(urgency(t, today, activeTz).reason).toBe('target_within_7');
  });

  it('treats a target date exactly seven days out as inside the horizon', () => {
    expect(urgency({ ...base, target_date: '2026-08-05' }, today, activeTz).reason).toBe(
      'target_within_7',
    );
    expect(urgency({ ...base, target_date: '2026-08-06' }, today, activeTz).reason).toBe('none');
  });

  it('ignores an unparseable date rather than throwing', () => {
    const t: Task = { ...base, deadline_date: 'soon', target_date: 'later' };
    expect(urgency(t, today, activeTz)).toEqual({ U: 1.0, reason: 'none' });
  });
});

describe('computeScores — the set-level guards', () => {
  const result = computeScores(tasks, ctx);

  it('puts the snoozed task in needsTriage and not in the ranking', () => {
    expect(result.needsTriage.map((t) => t.task_id)).toEqual(expected.scores.needsTriage);
    expect(result.needsTriage[0]!.reason).toContain('needs a decision');
    expect(result.scores.some((s) => s.task_id === 't_x1_snoozed')).toBe(false);
  });

  it('excludes closed, parked and snoozed work from the ranking', () => {
    const excludedIds = result.excluded.map((e) => e.task_id).sort();
    expect(excludedIds).toEqual([...expected.scores.excludedFromOpenSet].sort());
  });

  it('has the hand-counted open set of 28', () => {
    expect(result.valueInflation.openCount).toBe(expected.scores.openSetSize);
  });

  it('warns about value inflation, naming the excess', () => {
    const want = expected.scores.valueInflation;
    expect(result.valueInflation.warned).toBe(want.warned);
    expect(result.valueInflation.highValueCount).toBe(want.highValueCount);
    expect(result.valueInflation.fraction).toBeCloseTo(want.fraction, 12);
    expect(result.valueInflation.allowed).toBe(want.allowed);
    expect(result.valueInflation.excess).toBe(want.excess);
    expect(result.valueInflation.highValueTasks.map((t) => t.task_id).sort()).toEqual(
      [...want.highValueTasks].sort(),
    );
    expect(result.confidence.notes.join(' ')).toContain('value inflation');
    expect(result.confidence.notes.join(' ')).toContain('1 too many');
  });

  it('does not warn when high-value tasks stay inside 15%', () => {
    const modest: Task[] = tasks.map((t) => (t.value >= 8 ? { ...t, value: 7 } : t));
    const r = computeScores(modest, { ...ctx, tasks: modest });
    expect(r.valueInflation.warned).toBe(false);
    expect(r.valueInflation.highValueCount).toBe(0);
    expect(r.confidence.notes.join(' ')).not.toContain('value inflation');
  });

  it('lists no task twice, and sorts highest first', () => {
    const ids = result.scores.map((s) => s.task_id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < result.scores.length; i += 1) {
      expect(result.scores[i - 1]!.score).toBeGreaterThanOrEqual(result.scores[i]!.score);
    }
  });

  it('produces no NaN, Infinity or negative score', () => {
    for (const s of result.scores) {
      expect(Number.isFinite(s.score)).toBe(true);
      expect(s.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('takes the median over startable work only', () => {
    // Blocked and waiting tasks score 0. If they counted, the median would
    // collapse and ordinary tasks would be reported as anomalies.
    expect(result.median).toBeGreaterThan(0);
    const zeros = result.scores.filter((s) => s.score === 0).length;
    expect(zeros).toBeGreaterThan(0);
  });

  it('emits an anomaly rather than silently returning an outlier', () => {
    const outlier: Task = {
      ...task('t_x11_plain'),
      id: 't_outlier',
      value: 10,
      estimate_minutes: 5,
      deadline_date: '2026-07-01',
      venture_id: 'v_yachtyhub',
    };
    const withOutlier = [...tasks, outlier];
    const r = computeScores(withOutlier, { ...ctx, tasks: withOutlier });
    expect(r.anomalies.map((a) => a.task_id)).toContain('t_outlier');
    const note = r.confidence.notes.find((n) => n.includes('anomaly'));
    expect(note).toContain('the open-set median');
    // It is still returned: the caller is told, not silently protected.
    expect(r.scores.some((s) => s.task_id === 't_outlier')).toBe(true);
  });

  it('flags the fixture\'s own outlier: overdue plus cheap beats the pack by 8x', () => {
    // Not a defect. t_x8_overdue carries U=3.0 on a 60-minute admin task, which
    // is genuinely what should be done first — and is also exactly the shape the
    // guard exists to surface, so the ranking is not taken on trust.
    expect(result.anomalies.map((a) => a.task_id)).toEqual(['t_x8_overdue']);
    const anomaly = result.anomalies[0]!;
    expect(anomaly.multiple).toBeGreaterThan(6);
    expect(anomaly.score).toBe(result.scores[0]!.score); // it is the top-ranked task
    // Removing the overdue deadline removes the anomaly, which shows U=3.0 is
    // the whole cause.
    const notOverdue: Task[] = tasks.map((t) =>
      t.id === 't_x8_overdue' ? { ...t, deadline_date: null } : t,
    );
    expect(computeScores(notOverdue, { ...ctx, tasks: notOverdue }).anomalies).toEqual([]);
  });

  it('never returns an empty ranking without a reason (D7)', () => {
    const empty = computeScores([], { ...ctx, tasks: [] });
    expect(empty.scores).toEqual([]);
    expect(empty.confidence.notes.join(' ')).toContain('nothing to rank');

    const allDone: Task[] = tasks.map((t) => ({
      ...t,
      status: 'done' as const,
    }));
    const r = computeScores(allDone, { ...ctx, tasks: allDone });
    expect(r.scores).toEqual([]);
    expect(r.confidence.notes.join(' ')).toContain('nothing is rankable');
  });

  it('carries the degraded-slack note into scoring (D7)', () => {
    const r = computeScores(tasks, { ...ctx, slackDegraded: true });
    expect(r.confidence.notes.join(' ')).toContain('deadline-only');
  });

  it('reports a task whose venture is missing instead of dropping it', () => {
    const orphan: Task = { ...task('t_x11_plain'), id: 't_orphan', venture_id: 'v_ghost' };
    const withOrphan = [...tasks, orphan];
    const r = computeScores(withOrphan, { ...ctx, tasks: withOrphan });
    expect(r.errors.some((e) => e.code === 'missing_venture')).toBe(true);
    const scored = r.scores.find((s) => s.task_id === 't_orphan')!;
    expect(scored.components.strategicWeight).toBe(1.0);
  });

  it('drops a duplicated task id rather than ranking it twice', () => {
    const dupes = [...tasks, task('t_x11_plain')];
    const r = computeScores(dupes, { ...ctx, tasks: dupes });
    expect(r.scores.filter((s) => s.task_id === 't_x11_plain')).toHaveLength(1);
  });
});

describe('the balance corrector and attention debt (D4)', () => {
  const targetShares = { v_yachtyhub: 0.5, v_octo: 0.5 };

  it('returns 1.0 for every venture before day 14', () => {
    for (const days of [0, 1, 7, 13]) {
      const f = balanceFactors({
        targetShares,
        actualHoursByVenture: { v_yachtyhub: 40, v_octo: 0 },
        daysOfEvents: days,
      });
      expect(f).toEqual({ v_yachtyhub: 1.0, v_octo: 1.0 });
    }
  });

  it('switches on at exactly day 14 and corrects towards the target', () => {
    const f = balanceFactors({
      targetShares,
      actualHoursByVenture: { v_yachtyhub: 30, v_octo: 10 },
      daysOfEvents: 14,
    });
    // yachtyhub got 75% of a 50% target -> factor 0.5/0.75 = 0.667
    expect(f['v_yachtyhub']).toBeCloseTo(2 / 3, 10);
    // octo got 25% of a 50% target -> factor 2.0, at the cap
    expect(f['v_octo']).toBe(2.0);
  });

  it('is bounded, so a starved venture cannot dominate everything', () => {
    const f = balanceFactors({
      targetShares,
      actualHoursByVenture: { v_yachtyhub: 100, v_octo: 0 },
      daysOfEvents: 60,
    });
    expect(f['v_octo']).toBe(2.0);
    expect(f['v_yachtyhub']).toBe(0.5);
  });

  it('does not release attention debt before day 21', () => {
    const indebted: Venture[] = ventures.map((v) => ({ ...v, attention_debt_hours: 6 }));
    for (const days of [0, 13, 20]) {
      const r = releasableAttentionDebt(indebted, days);
      expect(Object.values(r).every((h) => h === 0)).toBe(true);
    }
    const released = releasableAttentionDebt(indebted, 21);
    expect(released['v_octo']).toBe(6);
  });
});
