import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/db.js';
import { getContext } from '../src/context.js';
import { linkTasks } from '../src/edit.js';
import { commitTasks, setMilestone } from '../src/tools.js';
import { createPerson } from '../src/registry.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * The two tools that exist because of how a session actually goes.
 *
 * get_context: every number in it was already reachable, in six calls and a
 * conversation. The cost of that was that each session began by rebuilding the
 * same picture, so the person spent their time teaching the system rather than
 * being helped by it.
 *
 * link_tasks: commit_tasks resolves dependency edges only within its own call,
 * so work added after a chain existed could never join it — leaving the
 * milestone under the 60% coverage threshold with its slack suppressed, which
 * is the failure the whole engine is built to avoid.
 */

let db: TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await freshDb('contextlink');
  sql = db.sql;

  await createPerson(sql, { name: 'Othman', hours_per_week: 40 });
  await createPerson(sql, { name: 'Saar', hours_per_week: 8 });

  await setMilestone(sql, {
    venture: 'seatop',
    name: 'Discovery agreements signed',
    due_date: '2026-09-15',
    hardness: 'soft',
    cost_of_slip: 'high — two buyers ready to pay now',
    idempotency_key: 'cl-m1',
  });

  // The chain that already exists.
  await commitTasks(sql, {
    tasks: [
      {
        title: 'Draft the agreement',
        venture: 'seatop',
        milestone: 'Discovery agreements signed',
        criticality: 'blocking',
        estimate_minutes: 120,
      },
      {
        title: 'Legal review',
        venture: 'seatop',
        milestone: 'Discovery agreements signed',
        criticality: 'blocking',
        estimate_minutes: 60,
        depends_on: ['Draft the agreement'],
      },
    ],
    idempotency_key: 'cl-chain',
  });

  // The five added later, which could never be wired in before.
  await commitTasks(sql, {
    tasks: [
      { title: 'Send to Lisa', venture: 'seatop', milestone: 'Discovery agreements signed', criticality: 'blocking', estimate_minutes: 30 },
      { title: 'Send to Richard', venture: 'seatop', milestone: 'Discovery agreements signed', criticality: 'blocking', estimate_minutes: 30 },
      { title: 'Chase signatures', venture: 'seatop', milestone: 'Discovery agreements signed', criticality: 'blocking', estimate_minutes: 45, assignee: 'Saar' },
    ],
    idempotency_key: 'cl-later',
  });
});

afterAll(async () => {
  await db.drop();
});

describe('link_tasks', () => {
  it('wires tasks added later into a chain that already existed', async () => {
    const res = await linkTasks(sql, {
      links: [
        { task: 'Send to Lisa', depends_on: ['Legal review'] },
        { task: 'Send to Richard', depends_on: ['Legal review'] },
        { task: 'Chase signatures', depends_on: ['Send to Lisa', 'Send to Richard'] },
      ],
      idempotency_key: 'cl-link-1',
    });

    expect(res.ok).toBe(true);
    expect(res['written']).toBe(4);

    const edges = await sql<Array<{ n: number }>>`
      select count(*)::int as n from task_dependencies`;
    expect(edges[0]!.n).toBe(5); // 1 from the original commit + 4 here
  });

  it('reports what it did to the milestone coverage, which is the point', async () => {
    const res = await linkTasks(sql, {
      links: [{ task: 'Send to Lisa', depends_on: ['Draft the agreement'] }],
      idempotency_key: 'cl-link-2',
    });
    expect(res.confidence.notes.join(' ')).toContain('Discovery agreements signed');
    expect(res.confidence.notes.join(' ')).toMatch(/covered|trusted/);
  });

  it('accepts ids as readily as titles', async () => {
    const a = await taskIdByTitle(sql, 'Draft the agreement');
    const b = await taskIdByTitle(sql, 'Chase signatures');
    const res = await linkTasks(sql, {
      links: [{ task: a, blocks: [b] }],
      idempotency_key: 'cl-link-3',
    });
    expect(res['written']).toBe(1);
  });

  it('refuses an ambiguous title rather than guessing', async () => {
    // Two calls, because commit_tasks rightly refuses two identical titles in
    // one batch — its own edges resolve by title too.
    await commitTasks(sql, {
      tasks: [{ title: 'Ambiguous', venture: 'seatop' }],
      idempotency_key: 'cl-ambig-a',
    });
    await commitTasks(sql, {
      tasks: [{ title: 'Ambiguous', venture: 'yachtyhub' }],
      idempotency_key: 'cl-ambig-b',
    });
    const res = await linkTasks(sql, {
      links: [{ task: 'Ambiguous', depends_on: ['Legal review'] }],
      idempotency_key: 'cl-link-4',
    });
    // Picking one would wire the wrong critical path, and nothing downstream
    // would ever reveal it.
    expect(res.errors?.[0]?.code).toBe('ambiguous_task');
    expect(res['written']).toBe(0);
  });

  it('names an unknown task instead of failing the whole batch', async () => {
    const res = await linkTasks(sql, {
      links: [
        { task: 'Legal review', blocks: ['Nothing called this'] },
        { task: 'Send to Richard', depends_on: ['Draft the agreement'] },
      ],
      idempotency_key: 'cl-link-5',
    });
    expect(res.errors?.some((e) => e.code === 'unknown_task')).toBe(true);
    // The good edge still went in.
    expect(res['written']).toBe(1);
  });

  it('refuses an edge that would close a loop, naming it', async () => {
    const res = await linkTasks(sql, {
      links: [{ task: 'Draft the agreement', depends_on: ['Chase signatures'] }],
      idempotency_key: 'cl-link-6',
    });
    expect(res.errors?.[0]?.code).toBe('cycle');
    expect(res['written']).toBe(0);
  });

  it('refuses a self-edge', async () => {
    const res = await linkTasks(sql, {
      links: [{ task: 'Legal review', depends_on: ['Legal review'] }],
      idempotency_key: 'cl-link-7',
    });
    expect(res.errors?.[0]?.code).toBe('self_edge');
  });

  it('removes an edge on request', async () => {
    const before = await sql<Array<{ n: number }>>`
      select count(*)::int as n from task_dependencies`;
    const res = await linkTasks(sql, {
      links: [{ task: 'Send to Lisa', depends_on: ['Draft the agreement'] }],
      remove: true,
      idempotency_key: 'cl-link-8',
    });
    expect(res['written']).toBe(1);
    const after = await sql<Array<{ n: number }>>`
      select count(*)::int as n from task_dependencies`;
    expect(after[0]!.n).toBe(before[0]!.n - 1);
  });
});

describe('get_context', () => {
  it('answers the whole situation in one call', async () => {
    const res = await getContext(sql, { available_hours: 28 });
    expect(res.ok).toBe(true);

    expect((res['ventures'] as unknown[]).length).toBeGreaterThan(0);
    expect((res['people'] as unknown[]).length).toBe(2);
    expect((res['milestones'] as unknown[]).length).toBeGreaterThan(0);
    expect(res['today']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((res['week'] as { verdict: string }).verdict).toBeDefined();
  });

  it('reports the delegated capacity behind the bottleneck', async () => {
    const res = await getContext(sql, { available_hours: 28 });
    // 48 hours of execution capacity against 28 usable is the single most
    // important number that was previously unreachable in one call.
    expect(res['delegated_capacity_hours']).toBe(48);
  });

  it('asks for the hours rather than assuming a week', async () => {
    const res = await getContext(sql, {});
    expect((res['week'] as { available_hours: number | null }).available_hours).toBeNull();
    expect((res['week'] as { source: string }).source).toContain('unknown');
    expect((res['unknown'] as string[]).join(' ')).toContain('how many hours');
  });

  it('uses a normal week on record when there is one, and says so', async () => {
    await sql`update settings set default_weekly_hours = 28`;
    const res = await getContext(sql, {});
    expect((res['week'] as { available_hours: number }).available_hours).toBe(28);
    expect((res['week'] as { source: string }).source).toContain('on record');
  });

  it('lists what it has NOT been told rather than filling it in', async () => {
    await createPerson(sql, { name: 'Unstated' });
    const res = await getContext(sql, { available_hours: 28 });
    const unknown = (res['unknown'] as string[]).join(' ');
    expect(unknown).toContain("Unstated's working week is unstated");
  });

  it('flags a milestone with no attached tasks', async () => {
    await setMilestone(sql, {
      venture: 'seatop',
      name: 'Bare milestone',
      due_date: '2026-10-01',
      hardness: 'soft',
      cost_of_slip: 'low — nothing',
      idempotency_key: 'cl-bare',
    });
    const res = await getContext(sql, { available_hours: 28 });
    // These are the rows that sit at the top of a slip ranking freeing zero
    // hours, which is what makes a ranking read as nonsense.
    expect((res['unknown'] as string[]).join(' ')).toContain('Bare milestone');
    expect((res['unknown'] as string[]).join(' ')).toContain('no critical path');
  });

  it('leads its notes with what the object is', async () => {
    const res = await getContext(sql, { available_hours: 28 });
    expect(res.confidence.notes[0]).toContain('must not be assumed');
  });
});

describe('projects', () => {
  /**
   * Projects existed in the schema and were unreachable: commit_tasks accepts a
   * project and refuses an unknown one, but nothing could create or list them,
   * so "what are my projects?" had no answer and the field was dead.
   */
  it('creates one and makes the commit_tasks field usable', async () => {
    const { listProjects, setProject } = await import('../src/registry.js');
    const made = await setProject(sql, {
      name: 'Discovery pipeline',
      venture: 'seatop',
      outcome: 'A buyer can go from first call to signed agreement without me chasing',
      idempotency_key: 'pr-1',
    });
    expect(made.ok).toBe(true);
    expect(made['created']).toBe(true);

    const res = await commitTasks(sql, {
      tasks: [{ title: 'Inside a project', venture: 'seatop', project: 'Discovery pipeline' }],
      idempotency_key: 'pr-task',
    });
    expect(res.ok).toBe(true);

    const listed = await listProjects(sql, {});
    const p = (listed['projects'] as Array<{ name: string; open_tasks: number }>).find(
      (x) => x.name === 'Discovery pipeline',
    )!;
    expect(p.open_tasks).toBe(1);
  });

  it('says when a project has no outcome, because then it is only a folder', async () => {
    const { setProject } = await import('../src/registry.js');
    const res = await setProject(sql, {
      name: 'Vague thing',
      venture: 'seatop',
      idempotency_key: 'pr-2',
    });
    expect(res.confidence.notes.join(' ')).toContain('a folder cannot be finished');
  });

  it('flags an active project with no open tasks', async () => {
    const { listProjects } = await import('../src/registry.js');
    const res = await listProjects(sql, {});
    // Nothing is going to happen in a project with nothing in it, and that is
    // invisible unless something says so.
    expect(res.confidence.notes.join(' ')).toContain('no open tasks');
    expect(res.confidence.notes.join(' ')).toContain('Vague thing');
  });

  it('names the known ventures when the venture is wrong', async () => {
    const { setProject } = await import('../src/registry.js');
    const res = await setProject(sql, { name: 'x', venture: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.message).toContain('nothing was written');
    expect(res.errors?.[0]?.message).toContain('seatop');
  });
});
