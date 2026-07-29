import { describe, expect, it } from 'vitest';
import { taskDurationDays } from '../src/constants.js';
import { computeCoverage } from '../src/coverage.js';
import { computeSlack } from '../src/slack.js';
import type { Dependency, Milestone, Task } from '../src/types.js';
import { expected, nullableNumericEntries, numericEntries, portfolio } from './fixture.js';

const { tasks, dependencies, milestones, today, activeTz } = portfolio;
const opts = { tz: activeTz };

function task(id: string): Task {
  const t = tasks.find((x) => x.id === id);
  if (!t) throw new Error(`fixture has no task ${id}`);
  return t;
}

describe('fixture integrity — the shapes Part 6 requires must actually be present', () => {
  it('has the declared counts', () => {
    expect(portfolio.ventures).toHaveLength(5);
    expect(portfolio.milestones).toHaveLength(6);
    expect(portfolio.outcomeTargets).toHaveLength(2);
    expect(tasks).toHaveLength(expected.taskCount);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
  });

  it('contains a dependency chain five deep', () => {
    const chain = ['t_yh1', 't_yh2', 't_yh3', 't_yh4', 't_yh5'];
    for (let i = 0; i < chain.length - 1; i += 1) {
      expect(
        dependencies.some((d) => d.task_id === chain[i] && d.blocks_task_id === chain[i + 1]),
      ).toBe(true);
    }
  });

  it('contains a near-cycle that is one edge from illegal', () => {
    // The shortcut edge is present and legal.
    expect(
      dependencies.some((d) => d.task_id === 't_yh1' && d.blocks_task_id === 't_yh4'),
    ).toBe(true);
    // The declared illegal edge is NOT present, and would close a loop.
    const illegal = portfolio.nearCycleIllegalEdge;
    expect(
      dependencies.some(
        (d) => d.task_id === illegal.task_id && d.blocks_task_id === illegal.blocks_task_id,
      ),
    ).toBe(false);
    const withIllegal = [...dependencies, illegal];
    const result = computeSlack(tasks, withIllegal, milestones, today, opts);
    expect(result.cyclicTasks).toEqual(['t_yh1', 't_yh2', 't_yh3', 't_yh4', 't_yh5']);
  });

  it('contains a task snoozed three times', () => {
    expect(task('t_x1_snoozed').snooze_count).toBe(3);
  });

  it('contains a milestone whose due_date has already passed', () => {
    const past = milestones.find((m) => m.id === 'm_octo_demo')!;
    expect(past.due_date < today).toBe(true);
    expect(past.status).toBe('active');
  });

  it('contains a paused project with active children', () => {
    const paused = portfolio.projects.find((p) => p.status === 'paused')!;
    const children = tasks.filter((t) => t.project_id === paused.id);
    expect(children.length).toBeGreaterThan(0);
    expect(children.every((c) => c.status === 'active')).toBe(true);
  });

  it('every dependency edge names real tasks', () => {
    const ids = new Set(tasks.map((t) => t.id));
    for (const d of dependencies) {
      expect(ids.has(d.task_id)).toBe(true);
      expect(ids.has(d.blocks_task_id)).toBe(true);
    }
  });
});

describe('task duration in days matches the hand-computed table', () => {
  it.each(numericEntries(expected.constants.durationDays))('%s is %i days', (id, days) => {
    expect(taskDurationDays(task(id))).toBe(days);
  });
});

describe('computeSlack against the hand-computed fixture', () => {
  const result = computeSlack(tasks, dependencies, milestones, today, opts);

  it('produced no errors on a clean portfolio', () => {
    expect(result.errors).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(result.cyclicTasks).toEqual([]);
  });

  it('returns a total map: every input task appears exactly once', () => {
    expect(result.slack.size).toBe(tasks.length);
    for (const t of tasks) expect(result.slack.has(t.id)).toBe(true);
  });

  it.each(nullableNumericEntries(expected.slack.byTask))('slack(%s) === %s', (id, want) => {
    expect(result.slack.get(id)).toBe(want);
  });

  it('every null carries a reason (D7)', () => {
    for (const [id, value] of result.slack) {
      if (value === null) {
        expect(result.nullReasons.get(id), `no reason recorded for ${id}`).toBeTruthy();
      }
    }
  });

  it.each(nullableNumericEntries(expected.slack.minSlackByMilestone))(
    'minSlack(%s) === %s',
    (id, want) => {
      expect(result.minSlackByMilestone[id]).toBe(want);
    },
  );

  it('names the milestones at negative slack', () => {
    const negative = Object.entries(result.minSlackByMilestone)
      .filter(([, v]) => v !== null && v < 0)
      .map(([k]) => k)
      .sort();
    expect(negative).toEqual([...expected.slack.negativeSlackMilestones].sort());
  });

  it('the five-deep chain is exactly 16 days long, shortcut included', () => {
    expect(result.chainDaysByMilestone['m_yh_live']!['t_yh1']).toBe(16);
    expect(result.chainDaysByMilestone['m_yh_live']!['t_yh2']).toBe(12);
    expect(result.chainDaysByMilestone['m_yh_live']!['t_yh5']).toBe(3);
    // The shortcut t_yh1 -> t_yh4 must not shorten the path through t_yh2.
    expect(result.latestStartByMilestone['m_yh_live']!['t_yh1']).toBe('2026-07-25');
  });

  it('recurring tasks never appear on a critical path (D5)', () => {
    for (const t of tasks.filter((x) => x.is_recurring)) {
      expect(result.slack.get(t.id)).toBeNull();
      expect(result.nullReasons.get(t.id)).toBeTruthy();
    }
    // t_r3 is the case that isolates the rule: it is recurring AND blocking AND
    // attached to m_yh_live, so only D5 keeps it off the path.
    expect(task('t_r3').criticality).toBe('blocking');
    expect(task('t_r3').milestone_id).toBe('m_yh_live');
    expect(result.nullReasons.get('t_r3')).toContain('recurring');
  });

  it('outcome targets contribute nothing: slack is identical without them (D1)', () => {
    // Outcome targets are not even an argument to computeSlack. Prove the two
    // in the fixture cannot influence it by checking the milestone-only walk
    // covers every non-null task.
    const nonNull = [...result.slack.entries()].filter(([, v]) => v !== null).map(([k]) => k);
    for (const id of nonNull) {
      expect(task(id).milestone_id ?? '').not.toBe('');
    }
  });
});

describe('computeSlack takes the tightest milestone when a task feeds two', () => {
  it('uses the minimum, not the first or the last', () => {
    const shared: Task = { ...task('t_yh8'), id: 't_shared', milestone_id: 'm_yh_live' };
    // t_shared is attached to the near milestone and also blocks work on the far one.
    const extraDeps: Dependency[] = [
      ...dependencies,
      { task_id: 't_shared', blocks_task_id: 't_yh9' },
    ];
    const result = computeSlack([...tasks, shared], extraDeps, milestones, today, opts);
    // Via m_yh_live (due 08-10): chain 1 -> latestStart 08-09 -> slack 11.
    // Via m_yh_import (due 08-31): chain 1 + chain(t_yh9)=2 -> 3 -> 08-28 -> 30.
    expect(result.slackByMilestone['m_yh_live']!['t_shared']).toBe(11);
    expect(result.slackByMilestone['m_yh_import']!['t_shared']).toBe(30);
    expect(result.slack.get('t_shared')).toBe(11);
  });

  it('gives slack to an upstream task carrying no milestone_id of its own', () => {
    const upstream: Task = {
      ...task('t_yh6'),
      id: 't_upstream',
      milestone_id: null,
      estimate_minutes: 360,
    };
    const extraDeps: Dependency[] = [
      ...dependencies,
      { task_id: 't_upstream', blocks_task_id: 't_yh1' },
    ];
    const result = computeSlack([...tasks, upstream], extraDeps, milestones, today, opts);
    // chain = 1 + chain(t_yh1)=16 -> 17 -> 08-10 minus 17d = 07-24 -> slack -5.
    expect(result.slack.get('t_upstream')).toBe(-5);
  });
});

describe('computeSlack degrades instead of throwing (D7)', () => {
  it('survives a cycle, and says which tasks it could not trust', () => {
    const cyclic = [...dependencies, portfolio.nearCycleIllegalEdge];
    const result = computeSlack(tasks, cyclic, milestones, today, opts);
    expect(result.degraded).toBe(true);
    expect(result.errors.some((e) => e.code === 'dependency_cycle')).toBe(true);
    expect(result.notes.join(' ')).toContain('deadline-only urgency');
    // The rest of the portfolio still gets real answers.
    expect(result.slack.get('t_st1')).toBe(11);
    expect(result.slack.get('t_oc1')).toBe(-4);
    // The cyclic milestone is skipped, with a reason.
    expect(result.minSlackByMilestone['m_yh_live']).toBeNull();
    expect(result.nullReasons.get('t_yh1')).toBeTruthy();
  });

  it('survives an unparseable milestone due_date', () => {
    const broken: Milestone[] = milestones.map((m) =>
      m.id === 'm_st_proposal' ? { ...m, due_date: 'not-a-date' } : m,
    );
    const result = computeSlack(tasks, dependencies, broken, today, opts);
    expect(result.degraded).toBe(true);
    expect(result.errors.some((e) => e.code === 'bad_date')).toBe(true);
    expect(result.slack.get('t_st1')).toBeNull();
    expect(result.slack.get('t_yh1')).toBe(-4); // untouched
  });

  it('survives an unparseable today', () => {
    const result = computeSlack(tasks, dependencies, milestones, 'yesterday', opts);
    expect(result.errors[0]!.code).toBe('bad_date');
    expect([...result.slack.values()].every((v) => v === null)).toBe(true);
  });

  it('never returns an empty result silently', () => {
    const noMilestones = computeSlack(tasks, dependencies, [], today, opts);
    expect(noMilestones.errors.some((e) => e.code === 'no_input')).toBe(true);

    const allInactive: Milestone[] = milestones.map((m) => ({ ...m, status: 'hit' as const }));
    const inactive = computeSlack(tasks, dependencies, allInactive, today, opts);
    expect(inactive.errors.some((e) => e.code === 'no_input')).toBe(true);
    expect(inactive.errors[0]!.message).toContain('ACTIVE');

    const noTasks = computeSlack([], [], milestones, today, opts);
    expect(noTasks.notes.length).toBeGreaterThan(0);
  });

  it('tolerates a duplicate dependency edge without double-counting', () => {
    const dup = [...dependencies, { task_id: 't_yh1', blocks_task_id: 't_yh2' }];
    const result = computeSlack(tasks, dup, milestones, today, opts);
    expect(result.slack.get('t_yh1')).toBe(-4);
  });
});

describe('computeCoverage against the hand-computed fixture', () => {
  const result = computeCoverage(tasks, dependencies, milestones);

  it.each(numericEntries(expected.coverage.byMilestone))('coverage(%s) === %d', (id, want) => {
    expect(result.byMilestone[id]).toBeCloseTo(want, 12);
  });

  it('flags exactly the milestones below the 60% threshold', () => {
    expect(result.lowConfidence.sort()).toEqual(
      [...expected.coverage.lowConfidenceMilestones].sort(),
    );
  });

  it('explains the low-confidence milestone in a note', () => {
    const note = result.notes.find((n) => n.includes('Site sale-ready'));
    expect(note).toBeTruthy();
    expect(note).toContain('40%');
    expect(note).toContain('2 of 5');
    expect(note).toContain('did not feed demand');
  });

  it('excludes closed and recurring tasks from the denominator', () => {
    // m_yh_live has 6 open non-recurring blockers; t_r3 (recurring) and
    // t_x5_done (closed) are attached to it and must not count.
    expect(result.detail['m_yh_live']!.totalBlocking).toBe(6);
    expect(result.detail['m_yh_live']!.blockingWithEdge).toBe(5);
    // m_octo_demo has a killed blocker that must not count.
    expect(result.detail['m_octo_demo']!.totalBlocking).toBe(2);
    expect(result.detail['m_octo_demo']!.coverage).toBe(1);
  });

  it('treats a milestone with no blocking tasks as vacuously covered', () => {
    const enablingOnly: Task[] = tasks.map((t) =>
      t.milestone_id === 'm_st_proposal' && t.criticality === 'blocking'
        ? { ...t, criticality: 'enabling' as const }
        : t,
    );
    const r = computeCoverage(enablingOnly, dependencies, milestones);
    expect(r.detail['m_st_proposal']!.vacuous).toBe(true);
    expect(r.detail['m_st_proposal']!.coverage).toBe(1);
    expect(r.lowConfidence).not.toContain('m_st_proposal');
    expect(r.notes.join(' ')).toContain('vacuously');
  });

  it('reports a reason rather than an empty object when there is nothing to cover', () => {
    const r = computeCoverage(tasks, dependencies, []);
    expect(r.byMilestone).toEqual({});
    expect(r.errors.some((e) => e.code === 'no_input')).toBe(true);
  });

  it('notices a task pointing at a milestone that was not supplied', () => {
    const orphan: Task = { ...task('t_yh6'), id: 't_orphan', milestone_id: 'm_ghost' };
    const r = computeCoverage([...tasks, orphan], dependencies, milestones);
    expect(r.errors.some((e) => e.code === 'missing_milestone')).toBe(true);
  });
});
