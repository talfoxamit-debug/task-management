import { resolveWorkspaceId, type Sql } from './db.js';
import { envelope, plainConfidence, type ToolEnvelope } from './narrow.js';
import { hasColumn } from './schema.js';

/**
 * What shape a given day actually has, once overrides are applied.
 *
 * THIS EXISTS AS ONE FUNCTION BECAUSE FOUR PLACES READ THE WEEKLY SHAPE:
 * context.ts, daily.ts, day-plan.ts and next-actions.ts each ran their own
 * `select ... from day_allocation`. Teaching one of them about engagements and
 * leaving the other three would produce a system that disagrees with itself
 * about what today is — day_plan showing the relief while next_actions still
 * offered Seatop work, which is worse than either answer alone.
 *
 * So the rule is: nothing reads day_allocation directly any more. Everything
 * asks here.
 *
 * RESOLUTION WHEN SEVERAL ENGAGEMENTS COVER A DATE: the SHORTEST wins. A
 * one-day holiday inside a three-week relief is the more specific fact about
 * that day, and "most specific wins" is a rule somebody can predict. Picking by
 * creation order would mean the answer depended on data-entry sequence, which
 * nobody can reason about. Every covering engagement is reported either way, so
 * an ambiguity is visible rather than silently resolved.
 */

export interface DayShape {
  date: string;
  day_of_week: number;
  is_working_day: boolean;
  primary_venture_id: string | null;
  primary_venture_name: string | null;
  primary_venture_slug: string | null;
  flex_minutes: number;
  start_hour: number | null;
  end_hour: number | null;
  /** Where this shape came from, so a session can say why the day looks odd. */
  source: 'weekly' | 'engagement';
  engagement: {
    id: string;
    name: string;
    start_date: string;
    end_date: string;
    days_remaining: number;
    note: string | null;
  } | null;
  /** Named when more than one engagement covers this date. */
  also_covering: string[];
}

/** Weekly defaults, and the settings-level work window. */
async function weeklyShape(
  sql: Sql,
  workspaceId: string,
  date: string,
  dow: number,
): Promise<DayShape> {
  const hasHours = await hasColumn(sql, 'settings', 'work_start_hour');

  const rows = await sql<
    Array<{
      venture_id: string | null;
      name: string | null;
      slug: string | null;
      flex_minutes: number | null;
      is_working_day: boolean | null;
      day_start: number | null;
      day_end: number | null;
      set_start: number | null;
      set_end: number | null;
    }>
  >`
    select a.primary_venture_id as venture_id, v.name, v.slug,
           a.flex_minutes, a.is_working_day,
           ${hasHours ? sql`a.start_hour` : sql`null::int`} as day_start,
           ${hasHours ? sql`a.end_hour` : sql`null::int`} as day_end,
           ${hasHours ? sql`s.work_start_hour` : sql`null::int`} as set_start,
           ${hasHours ? sql`s.work_end_hour` : sql`null::int`} as set_end
      from settings s
      left join day_allocation a
        on a.workspace_id = s.workspace_id and a.day_of_week = ${dow}
      left join ventures v on v.id = a.primary_venture_id
     where s.workspace_id = ${workspaceId}`;

  const r = rows[0];
  return {
    date,
    day_of_week: dow,
    is_working_day: r?.is_working_day ?? true,
    primary_venture_id: r?.venture_id ?? null,
    primary_venture_name: r?.name ?? null,
    primary_venture_slug: r?.slug ?? null,
    flex_minutes: r?.flex_minutes ?? 0,
    start_hour: r?.day_start ?? r?.set_start ?? null,
    end_hour: r?.day_end ?? r?.set_end ?? null,
    source: 'weekly',
    engagement: null,
    also_covering: [],
  };
}

export async function resolveDayShape(
  sql: Sql,
  workspaceId: string,
  date: string,
): Promise<DayShape> {
  const dowRows = await sql<Array<{ d: number }>>`
    select extract(dow from ${date}::date)::int as d`;
  const dow = dowRows[0]!.d;

  const base = await weeklyShape(sql, workspaceId, date, dow);

  // Migration 0017 may not have been run. An absent table must cost the
  // override and nothing else -- the weekly shape still answers.
  if (!(await hasColumn(sql, 'engagements', 'id'))) return base;

  const covering = await sql<
    Array<{
      id: string;
      name: string;
      venture_id: string | null;
      venture_name: string | null;
      venture_slug: string | null;
      is_working_day: boolean;
      start_date: string;
      end_date: string;
      days_remaining: number;
      span: number;
      flex_minutes: number | null;
      start_hour: number | null;
      end_hour: number | null;
      note: string | null;
    }>
  >`
    select e.id, e.name, e.venture_id, v.name as venture_name, v.slug as venture_slug,
           e.is_working_day, e.start_date::text as start_date, e.end_date::text as end_date,
           (e.end_date - ${date}::date) as days_remaining,
           (e.end_date - e.start_date) as span,
           e.flex_minutes, e.start_hour, e.end_hour, e.note
      from engagements e
      left join ventures v on v.id = e.venture_id
     where e.workspace_id = ${workspaceId}
       and e.ended_early_at is null
       and ${date}::date between e.start_date and e.end_date
     order by (e.end_date - e.start_date), e.start_date`;

  const winner = covering[0];
  if (!winner) return base;

  return {
    date,
    day_of_week: dow,
    is_working_day: winner.is_working_day,
    primary_venture_id: winner.venture_id,
    primary_venture_name: winner.venture_name,
    primary_venture_slug: winner.venture_slug,
    // An engagement that states nothing about hours inherits the weekly ones,
    // so "I am on a boat for three weeks" does not also have to restate the
    // working day.
    flex_minutes: winner.flex_minutes ?? base.flex_minutes,
    start_hour: winner.start_hour ?? base.start_hour,
    end_hour: winner.end_hour ?? base.end_hour,
    source: 'engagement',
    engagement: {
      id: winner.id,
      name: winner.name,
      start_date: winner.start_date,
      end_date: winner.end_date,
      days_remaining: winner.days_remaining,
      note: winner.note,
    },
    also_covering: covering.slice(1).map((c) => c.name),
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface SetEngagementInput {
  name: string;
  start_date: string;
  end_date: string;
  venture?: string;
  is_working_day?: boolean;
  flex_minutes?: number;
  start_hour?: number;
  end_hour?: number;
  note?: string;
  idempotency_key?: string;
}

export async function setEngagement(
  sql: Sql,
  input: SetEngagementInput,
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);

  if (!(await hasColumn(sql, 'engagements', 'id'))) {
    return envelope(plainConfidence([]), { created: false }, [
      {
        code: 'migration_pending',
        message:
          'migration 0017 has not been applied to this database yet, so there is nowhere to store an engagement — nothing was written',
      },
    ]);
  }

  if (input.end_date < input.start_date) {
    return envelope(plainConfidence([]), { created: false }, [
      { code: 'bad_range', message: 'end_date is before start_date — nothing was written' },
    ]);
  }

  const working = input.is_working_day ?? true;
  let ventureId: string | null = null;
  if (input.venture) {
    const rows = await sql<Array<{ id: string }>>`
      select id from ventures
       where workspace_id = ${workspaceId}
         and (slug = ${input.venture} or name = ${input.venture}) limit 1`;
    if (!rows[0]) {
      const known = await sql<Array<{ slug: string }>>`
        select slug from ventures where workspace_id = ${workspaceId} order by slug`;
      return envelope(plainConfidence([]), { created: false }, [
        {
          code: 'missing_venture',
          message: `venture "${input.venture}" does not exist — nothing was written. Known: ${known
            .map((k) => k.slug)
            .join(', ')}`,
        },
      ]);
    }
    ventureId = rows[0].id;
  }

  if (working && !ventureId) {
    return envelope(plainConfidence([]), { created: false }, [
      {
        code: 'venture_required',
        message:
          'a working engagement must name the venture that owns those days — nothing was written. For time off, pass is_working_day:false instead.',
      },
    ]);
  }

  const rows = await sql<Array<{ id: string; span: number }>>`
    insert into engagements (workspace_id, name, venture_id, is_working_day,
                             start_date, end_date, flex_minutes, start_hour, end_hour, note)
    values (${workspaceId}, ${input.name}, ${ventureId}, ${working},
            ${input.start_date}::date, ${input.end_date}::date,
            ${input.flex_minutes ?? null}, ${input.start_hour ?? null},
            ${input.end_hour ?? null}, ${input.note ?? null})
    returning id, (end_date - start_date) as span`;

  const overlapping = await sql<Array<{ name: string; span: number }>>`
    select name, (end_date - start_date) as span from engagements
     where workspace_id = ${workspaceId} and id <> ${rows[0]!.id}
       and ended_early_at is null
       and daterange(start_date, end_date, '[]') && daterange(${input.start_date}::date, ${input.end_date}::date, '[]')`;

  const notes: string[] = [
    `in effect ${input.start_date} to ${input.end_date} inclusive; the weekly allocation resumes by itself afterwards`,
  ];
  if (!working) {
    notes.push('these days are not worked at all: next_actions and day_plan will offer nothing');
  }
  if (overlapping.length > 0) {
    notes.push(
      `overlaps ${overlapping.length} other engagement(s): ${overlapping
        .map((o) => o.name)
        .join(', ')}. On a shared date the SHORTEST wins, so a one-day exception inside a longer engagement takes precedence.`,
    );
  }

  return envelope(plainConfidence(notes), {
    created: true,
    engagement_id: rows[0]!.id,
    name: input.name,
    start_date: input.start_date,
    end_date: input.end_date,
    venture: input.venture ?? null,
    is_working_day: working,
  });
}

export async function listEngagements(
  sql: Sql,
  input: { include_past?: boolean } = {},
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  if (!(await hasColumn(sql, 'engagements', 'id'))) {
    return envelope(
      plainConfidence(['migration 0017 has not been applied, so no engagement can exist yet']),
      { engagements: [], total: 0 },
    );
  }

  const today = await sql<Array<{ d: string }>>`
    select taskos_today(${workspaceId})::text as d`;
  const rows = await sql<
    Array<{
      id: string;
      name: string;
      venture: string | null;
      is_working_day: boolean;
      start_date: string;
      end_date: string;
      note: string | null;
      ended_early_at: Date | null;
      active: boolean;
    }>
  >`
    select e.id, e.name, v.slug as venture, e.is_working_day,
           e.start_date::text as start_date, e.end_date::text as end_date, e.note,
           e.ended_early_at,
           (e.ended_early_at is null and taskos_today(${workspaceId}) between e.start_date and e.end_date) as active
      from engagements e
      left join ventures v on v.id = e.venture_id
     where e.workspace_id = ${workspaceId}
       ${input.include_past ? sql`` : sql`and e.end_date >= taskos_today(${workspaceId}) and e.ended_early_at is null`}
     order by e.start_date`;

  return envelope(
    plainConfidence([`today is ${today[0]?.d}; an engagement expires on its own end_date`]),
    { engagements: rows, total: rows.length },
  );
}

/**
 * End one before its end_date, with a reason.
 *
 * Not a delete. The reason a week looked different for eleven days is exactly
 * the thing a future session needs when it reads the closed history and finds a
 * gap, and deleting the row destroys it -- the same argument that makes
 * kill_task carry a kill_reason.
 */
export async function endEngagement(
  sql: Sql,
  input: { engagement_id: string; reason: string },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const rows = await sql<Array<{ name: string }>>`
    update engagements set ended_early_at = now(), ended_reason = ${input.reason}
     where id = ${input.engagement_id} and workspace_id = ${workspaceId}
       and ended_early_at is null
    returning name`;
  if (rows.length === 0) {
    return envelope(plainConfidence([]), { ended: false }, [
      {
        code: 'not_found',
        message: 'no such engagement, or it has already been ended — nothing was written',
      },
    ]);
  }
  return envelope(
    plainConfidence(['the weekly allocation applies again from today']),
    { ended: true, name: rows[0]!.name, reason: input.reason },
  );
}
