import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endEngagement, listEngagements, resolveDayShape, setEngagement } from '../src/day-shape.js';
import { buildDayPlan, setWorkHours } from '../src/day-plan.js';
import { setDayAllocation } from '../src/next-actions.js';
import { getContext } from '../src/context.js';
import { forgetSchema } from '../src/schema.js';
import { resolveWorkspaceId, type Sql } from '../src/db.js';
import { freshDb, type TestDb } from './harness.js';

/**
 * Date ranges that are not the normal week.
 *
 * Tal is on a three-week chief engineer relief. The weekly allocation says his
 * Tuesday belongs to Seatop; for these particular three weeks it does not, and
 * saying so by editing the weekly shape would leave it wrong for good once the
 * relief ended. So an engagement is a range with an end date, and it expires by
 * itself.
 *
 * WHAT THESE TESTS ARE REALLY PROTECTING is that there is only ONE answer to
 * "what is today". Four call sites read the weekly shape before this change, and
 * a system where day_plan knows about the relief while next_actions does not is
 * worse than one that knows about neither -- it disagrees with itself, and
 * whichever answer Tal happens to see is the one he acts on.
 */

let db: TestDb;
let sql: Sql;
let workspaceId: string;
let today: string;

/** N days from the workspace's today, as a civil date. */
async function offset(n: number): Promise<string> {
  const rows = await sql<Array<{ d: string }>>`
    select (taskos_today(${workspaceId}) + ${n}::int)::text as d`;
  return rows[0]!.d;
}

beforeAll(async () => {
  db = await freshDb('engagement');
  sql = db.sql;
  workspaceId = await resolveWorkspaceId(sql);

  const rows = await sql<Array<{ d: string }>>`
    select taskos_today(${workspaceId})::text as d`;
  today = rows[0]!.d;

  // Every weekday belongs to Seatop, so any change of venture below is the
  // engagement talking and not an accident of which day the suite runs on.
  await setDayAllocation(sql, {
    days: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      day_of_week: d,
      venture: 'seatop',
      flex_minutes: 90,
    })),
  });
  await setWorkHours(sql, { start_hour: 9, end_hour: 17 });
});

afterAll(async () => {
  await db.drop();
});

describe('with no engagement in effect', () => {
  it('resolves the weekly shape, and says that is where it came from', async () => {
    const shape = await resolveDayShape(sql, workspaceId, today);
    expect(shape.source).toBe('weekly');
    expect(shape.primary_venture_slug).toBe('seatop');
    expect(shape.engagement).toBeNull();
    expect(shape.start_hour).toBe(9);
  });
});

describe('an engagement covering today', () => {
  let id: string;

  beforeAll(async () => {
    const res = await setEngagement(sql, {
      name: 'Miss Michelle relief',
      venture: 'foxsolutions',
      start_date: await offset(-2),
      end_date: await offset(17),
      note: 'chief engineer cover',
    });
    id = (res as unknown as { engagement_id: string }).engagement_id;
    expect((res as unknown as { created: boolean }).created).toBe(true);
  });

  it('overrides the venture that owns the day', async () => {
    const shape = await resolveDayShape(sql, workspaceId, today);
    expect(shape.source).toBe('engagement');
    expect(shape.primary_venture_slug).toBe('foxsolutions');
    expect(shape.engagement?.name).toBe('Miss Michelle relief');
  });

  it('counts the days left, so a brief can say how long this lasts', async () => {
    const shape = await resolveDayShape(sql, workspaceId, today);
    expect(shape.engagement?.days_remaining).toBe(17);
  });

  it('inherits the hours it does not state, rather than blanking them', async () => {
    // "I am covering a boat for three weeks" should not also have to restate
    // when the working day starts.
    const shape = await resolveDayShape(sql, workspaceId, today);
    expect(shape.start_hour).toBe(9);
    expect(shape.end_hour).toBe(17);
    expect(shape.flex_minutes).toBe(90);
  });

  it('stops on its own the day after it ends', async () => {
    const after = await offset(18);
    const shape = await resolveDayShape(sql, workspaceId, after);
    expect(shape.source).toBe('weekly');
    expect(shape.primary_venture_slug).toBe('seatop');
  });

  it('is reported by get_context, with when it expires', async () => {
    // The requirement this exists for: a session three days in must be able to
    // see WHY the day looks unusual, or it "fixes" the weekly allocation.
    const res = await getContext(sql, {});
    const shape = (res as unknown as { today_shape: Record<string, unknown> }).today_shape;
    expect(shape['source']).toBe('engagement');
    expect(shape['primary_venture']).toBe('foxsolutions');
    expect((shape['engagement'] as { ends: string }).ends).toBe(await offset(17));
  });

  it('can be ended early, keeping the reason', async () => {
    const res = await endEngagement(sql, {
      engagement_id: id,
      reason: 'relief ended early, captain returned',
    });
    expect((res as unknown as { ended: boolean }).ended).toBe(true);

    const shape = await resolveDayShape(sql, workspaceId, today);
    expect(shape.source).toBe('weekly');

    // Not deleted. The row is the record of why those days looked different.
    const rows = await sql<Array<{ ended_reason: string }>>`
      select ended_reason from engagements where id = ${id}`;
    expect(rows[0]!.ended_reason).toContain('captain returned');

    // And ending it twice is refused rather than silently re-ending it.
    const again = await endEngagement(sql, { engagement_id: id, reason: 'again' });
    expect((again as unknown as { ended: boolean }).ended).toBe(false);
  });
});

describe('when several engagements cover the same date', () => {
  beforeAll(async () => {
    await setEngagement(sql, {
      name: 'Long refit',
      venture: 'foxsolutions',
      start_date: await offset(-5),
      end_date: await offset(20),
    });
    await setEngagement(sql, {
      name: 'One day off',
      is_working_day: false,
      start_date: today,
      end_date: today,
    });
  });

  it('the shortest wins, because it is the more specific fact', async () => {
    const shape = await resolveDayShape(sql, workspaceId, today);
    expect(shape.engagement?.name).toBe('One day off');
    expect(shape.is_working_day).toBe(false);
  });

  it('names the ones it did not apply, so the ambiguity is visible', async () => {
    const shape = await resolveDayShape(sql, workspaceId, today);
    expect(shape.also_covering).toContain('Long refit');
  });

  it('a non-working day produces no plan at all', async () => {
    const plan = await buildDayPlan(sql, { date: today });
    expect(plan.working).toBe(false);
    expect(plan.slots).toHaveLength(0);
  });

  it('get_context reports the unresolved overlap as unknown', async () => {
    const res = await getContext(sql, {});
    const unknown = (res as unknown as { unknown: string[] }).unknown;
    expect(unknown.some((u) => u.includes('engagements cover today'))).toBe(true);
  });

  it('list_engagements shows which one is active today', async () => {
    const res = await listEngagements(sql, {});
    const rows = (res as unknown as { engagements: Array<{ name: string; active: boolean }> }).engagements;
    // The one ended early is gone; both live ones are here and both are active.
    expect(rows.map((r) => r.name).sort()).toEqual(['Long refit', 'One day off']);
    expect(rows.every((r) => r.active)).toBe(true);
  });
});

describe('a working engagement with no venture', () => {
  it('is refused rather than producing days that belong to nobody', async () => {
    const res = await setEngagement(sql, {
      name: 'somewhere',
      start_date: today,
      end_date: today,
    });
    expect((res as unknown as { created: boolean }).created).toBe(false);
    expect(res.errors?.[0]?.code).toBe('venture_required');
  });

  it('refuses a range that runs backwards', async () => {
    const res = await setEngagement(sql, {
      name: 'backwards',
      venture: 'seatop',
      start_date: await offset(5),
      end_date: await offset(1),
    });
    expect((res as unknown as { created: boolean }).created).toBe(false);
    expect(res.errors?.[0]?.code).toBe('bad_range');
  });
});

describe('a database that has not been given 0017', () => {
  /**
   * Migrations here are run by hand, in a SQL editor, by the person who also
   * runs five businesses -- so the code always ships first. The rule is the one
   * the outage taught: a missing table costs the FEATURE and nothing else.
   */
  let behind: TestDb;

  beforeAll(async () => {
    behind = await freshDb('engagement_behind');
    await behind.sql`drop table if exists engagements`;
    forgetSchema();
  });

  afterAll(async () => {
    await behind.drop();
    forgetSchema();
  });

  it('still answers with the weekly shape', async () => {
    const ws = await resolveWorkspaceId(behind.sql);
    const rows = await behind.sql<Array<{ d: string }>>`
      select taskos_today(${ws})::text as d`;
    const shape = await resolveDayShape(behind.sql, ws, rows[0]!.d);
    expect(shape.source).toBe('weekly');
    expect(shape.engagement).toBeNull();
  });

  it('says so plainly instead of failing the write', async () => {
    const res = await setEngagement(behind.sql, {
      name: 'x',
      venture: 'seatop',
      start_date: await offset(1),
      end_date: await offset(2),
    });
    expect((res as unknown as { created: boolean }).created).toBe(false);
    expect(res.errors?.[0]?.code).toBe('migration_pending');
  });
});
