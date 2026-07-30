import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from '../src/db.js';
import { capacity, capture, close, commitTasks, listTasks, ventureStatus } from '../src/tools.js';
import { freshDb, type TestDb } from './harness.js';

/**
 * Isolation between workspaces.
 *
 * The rest of the suite runs in a single workspace, so it proves nothing about
 * tenancy: every query would still pass with the scoping removed. These tests
 * exist to fail if a `where workspace_id = ...` ever goes missing, which is the
 * one bug in this layer that matters.
 */

let db: TestDb;
let sql: Sql;
let A: string; // the workspace created by the migration
let B: string; // somebody else entirely

beforeAll(async () => {
  db = await freshDb('tenancy');
  sql = db.sql;
  process.env['TASKOS_TOKEN'] = 'tenancy-test';

  A = (await sql<Array<{ id: string }>>`select id from workspaces limit 1`)[0]!.id;

  const created = await sql<Array<{ id: string }>>`
    insert into workspaces (name) values ('Someone Else') returning id`;
  B = created[0]!.id;

  // A whole little world belonging to B, including the seeded-looking parts.
  await sql`
    insert into settings (workspace_id, active_tz, buffer_ratio)
    values (${B}, 'Europe/Berlin', 0.30)`;
  const v = await sql<Array<{ id: string }>>`
    insert into ventures (workspace_id, name, slug, strategic_weight, floor_share, ceiling_share)
    values (${B}, 'Their Venture', 'yachtyhub', 1.0, 0.1, 0.5) returning id`;
  const m = await sql<Array<{ id: string }>>`
    insert into milestones (workspace_id, venture_id, name, due_date, hardness, cost_of_slip)
    values (${B}, ${v[0]!.id}, 'Their milestone', '2026-09-01', 'hard', 'critical') returning id`;
  await sql`
    insert into tasks (workspace_id, venture_id, milestone_id, title, criticality,
                       context, estimate_minutes, value, status)
    values (${B}, ${v[0]!.id}, ${m[0]!.id}, 'THEIR SECRET TASK', 'blocking',
            'deep_work', 600, 9, 'active')`;
  await sql`
    insert into calibration (workspace_id, context, ratio, sample_n)
    values (${B}, 'deep_work', 2.5, 40)`;
}, 60_000);

afterAll(async () => {
  delete process.env['TASKOS_WORKSPACE_ID'];
  await db?.drop();
});

function scopeTo(workspace: string): void {
  process.env['TASKOS_WORKSPACE_ID'] = workspace;
}

describe('a workspace never sees another workspace', () => {
  it('list_tasks shows only its own tasks', async () => {
    scopeTo(A);
    const mine = await listTasks(sql, {});
    const titles = (mine['tasks'] as Array<{ title: string }>).map((t) => t.title);
    expect(titles).not.toContain('THEIR SECRET TASK');

    scopeTo(B);
    const theirs = await listTasks(sql, {});
    expect((theirs['tasks'] as Array<{ title: string }>).map((t) => t.title)).toContain(
      'THEIR SECRET TASK',
    );
  });

  it('capacity computes over its own portfolio only', async () => {
    scopeTo(A);
    const a = await capacity(sql, { available_hours: 40 });
    // B's milestone is hard, critical and carries 10 hours of blocking work.
    expect(JSON.stringify(a['slip_order'])).not.toContain('Their milestone');

    scopeTo(B);
    const b = await capacity(sql, { available_hours: 40 });
    expect(JSON.stringify(b['slip_order'])).toContain('Their milestone');
    // And it used B's own buffer_ratio of 0.30, not A's 0.20.
    expect((b['hours'] as { buffer_ratio: number }).buffer_ratio).toBe(0.3);
  });

  it('resolves a slug within its own workspace, though both use it', async () => {
    // Both workspaces have a venture slugged 'yachtyhub'. Each must get its own.
    scopeTo(A);
    const a = await ventureStatus(sql, { slug: 'yachtyhub' });
    expect((a['venture'] as { name: string }).name).toBe('FoxStays / YachtyHub');

    scopeTo(B);
    const b = await ventureStatus(sql, { slug: 'yachtyhub' });
    expect((b['venture'] as { name: string }).name).toBe('Their Venture');
  });

  it('refuses to close a task belonging to another workspace', async () => {
    const theirs = await sql<Array<{ id: string }>>`
      select id from tasks where title = 'THEIR SECRET TASK'`;
    scopeTo(A);
    const r = await close(sql, { task_id: theirs[0]!.id });
    expect(r.ok).toBe(false);
    expect(r.errors?.[0]!.message).toContain('does not exist');

    const still = await sql<Array<{ status: string }>>`
      select status from tasks where id = ${theirs[0]!.id}`;
    expect(still[0]!.status).toBe('active');
  });

  it('tenants everything it writes', async () => {
    scopeTo(B);
    await capture(sql, { text: 'a thought belonging to B' });
    const row = await sql<Array<{ workspace_id: string }>>`
      select workspace_id from tasks where title = 'a thought belonging to B'`;
    expect(row[0]!.workspace_id).toBe(B);

    scopeTo(A);
    const committed = await commitTasks(sql, {
      tasks: [{ title: 'a task belonging to A', venture: 'octo', estimate_minutes: 30 }],
    });
    expect(committed.ok).toBe(true);
    const t = await sql<Array<{ workspace_id: string }>>`
      select workspace_id from tasks where title = 'a task belonging to A'`;
    expect(t[0]!.workspace_id).toBe(A);
  });

  it('keeps calibration separate: B is calibrated, A is not', async () => {
    // B has 40 deep_work samples at ratio 2.5; A has none. If calibration
    // leaked, A's estimates would silently be inflated by 150%.
    scopeTo(A);
    const a = await capacity(sql, { available_hours: 40 });
    expect(a.confidence.calibrated).toBe(false);

    const rows = await sql<Array<{ n: number }>>`
      select sample_n as n from calibration
       where workspace_id = ${A} and context = 'deep_work'`;
    expect(rows[0]!.n).toBe(0);
  });

  it('provisions a new workspace with everything it needs to function', async () => {
    const made = await sql<Array<{ ws: string }>>`
      select taskos_provision_workspace('Provisioned', 'Asia/Tokyo', 0.25) as ws`;
    const C = made[0]!.ws;

    const settings = await sql<Array<{ active_tz: string; buffer_ratio: string }>>`
      select active_tz, buffer_ratio from settings where workspace_id = ${C}`;
    expect(settings[0]!.active_tz).toBe('Asia/Tokyo');
    expect(Number(settings[0]!.buffer_ratio)).toBe(0.25);

    const holding = await sql<Array<{ active: boolean }>>`
      select active from ventures where workspace_id = ${C} and slug = 'unsorted'`;
    expect(holding[0]!.active).toBe(false);

    const calib = await sql<Array<{ n: string }>>`
      select count(*)::text as n from calibration where workspace_id = ${C}`;
    expect(Number(calib[0]!.n)).toBe(7);

    // And it is immediately usable, which is the actual claim.
    scopeTo(C);
    const captured = await capture(sql, { text: 'first thought in a new workspace' });
    expect(captured.ok).toBe(true);
    const cap = await capacity(sql, { available_hours: 10 });
    expect(cap.ok).toBe(true);
    expect((cap['hours'] as { buffer_ratio: number }).buffer_ratio).toBe(0.25);
  });

  it('refuses to guess when a caller maps to no particular workspace', async () => {
    delete process.env['TASKOS_WORKSPACE_ID'];
    // Two workspaces now exist, so there is no "the" workspace to fall back to.
    const r = await listTasks(sql, {}).catch((e: Error) => e);
    expect(r).toBeInstanceOf(Error);
    expect((r as Error).message).toMatch(/\d+ workspaces exist/);
    scopeTo(A);
  });
});
