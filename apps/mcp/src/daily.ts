import { loadSettings, resolveWorkspaceId, type Sql } from './db.js';
import { nextActions } from './next-actions.js';

/**
 * The morning brief.
 *
 * The first thing TaskOS says without being asked. Everything else in the system
 * answers a question; this one arrives at 08:00 and has to earn the interruption
 * on its own, which sets the whole design:
 *
 *   - It is ARITHMETIC. No model writes it. Every number here is one the engine
 *     already computed and Tal can re-derive, which is the rule the rest of the
 *     system follows and the reason its numbers are worth trusting.
 *   - It leads with what is DUE and what is BLOCKED, not with a greeting. A
 *     brief whose first line is pleasant is a brief that gets swiped away.
 *   - It says what it does not know, in the same voice as every other answer.
 *   - It is SHORT. Telegram truncates at 4096 characters, and a message longer
 *     than a phone screen is one nobody reads twice.
 *
 * It does not tell Tal what hour to do anything. That limit is deliberate and
 * is stated in the connector instructions too: this system ranks, it does not
 * schedule.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface DailyBrief {
  /** The workspace-local date this brief is for. */
  date: string;
  /** False on a day the allocation says is not worked; nothing is sent. */
  working: boolean;
  text: string;
}

function hours(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return `${h}h`;
}

function human(iso: string, today: string): string {
  const days = Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 0) return `${Math.abs(days)}d overdue`;
  return `in ${days}d`;
}

/**
 * Compose the brief. Reads only; sending is the route's job.
 *
 * Split this way so the message can be built and inspected without a Telegram
 * token — which is what makes it testable at all, and what let the wording be
 * checked against real data before it was ever sent to a phone.
 */
export async function buildDailyBrief(sql: Sql, date?: string): Promise<DailyBrief> {
  const workspaceId = await resolveWorkspaceId(sql);
  const settings = await loadSettings(sql, workspaceId);

  const todayRows = await sql<Array<{ d: string; dow: number }>>`
    select taskos_today(${workspaceId})::text as d,
           extract(dow from taskos_today(${workspaceId}))::int as dow`;
  const today = date ?? todayRows[0]!.d;
  const dowRows = date
    ? await sql<Array<{ dow: number }>>`select extract(dow from ${date}::date)::int as dow`
    : [{ dow: todayRows[0]!.dow }];
  const dow = dowRows[0]!.dow;

  const allocation = await sql<
    Array<{ slug: string | null; name: string | null; flex_minutes: number; is_working_day: boolean }>
  >`
    select v.slug, v.name, a.flex_minutes, a.is_working_day
      from day_allocation a
      left join ventures v on v.id = a.primary_venture_id
     where a.workspace_id = ${workspaceId} and a.day_of_week = ${dow}`;
  const day = allocation[0] ?? null;

  if (day && !day.is_working_day) {
    // Nothing is sent, rather than a message saying there is nothing to send.
    // A notification on a day off is a notification that trains you to ignore
    // the ones on the days that matter.
    return { date: today, working: false, text: '' };
  }

  const lines: string[] = [];
  const header = [`${DAYS[dow]} ${today}`];
  if (day?.name) header.push(day.name);
  lines.push(header.join(' · '));

  // --- Due and overdue -----------------------------------------------------
  const due = await sql<
    Array<{ title: string; venture: string; deadline_date: string; estimate_minutes: number }>
  >`
    select t.title, v.name as venture, t.deadline_date::text as deadline_date,
           t.estimate_minutes
      from tasks t join ventures v on v.id = t.venture_id
     where t.workspace_id = ${workspaceId}
       and t.status not in ('done', 'killed')
       and t.assignee_person_id is null
       and t.deadline_date is not null
       and t.deadline_date <= ${today}::date
     order by t.deadline_date, t.value desc
     limit 6`;

  if (due.length > 0) {
    lines.push('', `DUE (${due.length})`);
    for (const d of due) {
      lines.push(`• ${d.title} — ${d.venture}, ${human(d.deadline_date, today)}`);
    }
  }

  // --- What to actually pick up -------------------------------------------
  //
  // The day's usable minutes come from the stored week, not from an assumption.
  // With no week on record the section is omitted entirely rather than filled
  // in from a guess, because an invented hours figure produces a confident
  // answer to a question nobody asked.
  const weeklyRows = await sql<Array<{ h: number | null }>>`
    select default_weekly_hours as h from settings where workspace_id = ${workspaceId}`;
  const weekly = weeklyRows[0]?.h == null ? null : Number(weeklyRows[0].h);
  if (weekly && weekly > 0) {
    const workingDays = await sql<Array<{ n: number }>>`
      select count(*)::int as n from day_allocation
       where workspace_id = ${workspaceId} and is_working_day`;
    const perDay = (weekly / Math.max(workingDays[0]?.n ?? 5, 1)) * (1 - settings.buffer_ratio);
    const slot = Math.round(perDay * 60);

    const next = await nextActions(sql, { available_minutes: slot, date: today, limit: 3 });
    const actions = (next['actions'] as Array<Record<string, unknown>>) ?? [];
    if (actions.length > 0) {
      lines.push('', `FIRST (${hours(slot)} usable today)`);
      for (const a of actions) {
        const why = a['why'] ? ` — ${a['why']}` : '';
        const partial = a['partial'] ? ' [bigger than the slot]' : '';
        lines.push(`• ${a['title']}${why}${partial}`);
      }
    }
    const flexLeft = (next['day'] as { flex_left?: number } | null)?.flex_left;
    if (typeof flexLeft === 'number' && day?.name) {
      lines.push(`  ${flexLeft} min of flex left for work outside ${day.name}.`);
    }
  }

  // --- Drafted, waiting on judgement --------------------------------------
  const prepared = await sql<Array<{ n: number; minutes: number | null }>>`
    select count(*)::int as n, sum(coalesce(review_minutes, 15))::int as minutes
      from tasks
     where workspace_id = ${workspaceId} and prepared_at is not null
       and status not in ('done', 'killed')`;
  if ((prepared[0]?.n ?? 0) > 0) {
    lines.push(
      '',
      `WAITING ON YOU: ${prepared[0]!.n} drafted, about ${hours(prepared[0]!.minutes ?? 0)} of review. None are sent.`,
    );
  }

  // --- The people doing the work ------------------------------------------
  //
  // Blocked first and by age. A delegate stuck for three days is the most
  // expensive silence in a system with 48 delegated hours behind a 28-hour
  // bottleneck, and it costs nothing to say so every morning until it moves.
  const blocked = await sql<Array<{ title: string; person: string | null; days: number }>>`
    select t.title, p.name as person,
           extract(day from now() - t.needs_attention_at)::int as days
      from tasks t left join people p on p.id = t.assignee_person_id
     where t.workspace_id = ${workspaceId}
       and t.needs_attention_at is not null
       and t.status not in ('done', 'killed')
     order by t.needs_attention_at
     limit 4`;
  const unread = await sql<Array<{ n: number }>>`
    select count(*)::int as n from task_comments
     where workspace_id = ${workspaceId} and author_kind = 'delegate'
       and read_by_owner_at is null`;

  if (blocked.length > 0 || (unread[0]?.n ?? 0) > 0) {
    lines.push('', 'DELEGATED');
    for (const b of blocked) {
      lines.push(
        `• BLOCKED ${b.days}d — ${b.person ?? 'unassigned'}: ${b.title}`,
      );
    }
    if ((unread[0]?.n ?? 0) > 0) {
      lines.push(`• ${unread[0]!.n} unread comment(s). Ask me for delegation_inbox.`);
    }
  }

  // --- What is closest to slipping ----------------------------------------
  const milestones = await sql<
    Array<{ name: string; venture: string; due_date: string; hardness: string }>
  >`
    select m.name, v.name as venture, m.due_date::text as due_date, m.hardness
      from milestones m join ventures v on v.id = m.venture_id
     where m.workspace_id = ${workspaceId} and m.status = 'active' and v.active
       and m.due_date <= ${today}::date + 14
     order by m.due_date
     limit 3`;
  if (milestones.length > 0) {
    lines.push('', 'NEXT 14 DAYS');
    for (const m of milestones) {
      lines.push(
        `• ${m.name} — ${m.venture}, ${human(m.due_date, today)}${m.hardness === 'hard' ? ' (hard)' : ''}`,
      );
    }
  }

  // --- What it does not know ----------------------------------------------
  const unknown: string[] = [];
  if (!weekly || weekly <= 0) {
    unknown.push('your weekly hours are not on record, so there is no "first" section');
  }
  if (!day) unknown.push(`no allocation is set for ${DAYS[dow]}`);
  if (unknown.length > 0) lines.push('', `NOT KNOWN: ${unknown.join('; ')}.`);

  if (lines.length === 1) {
    lines.push('', 'Nothing due, nothing blocked, nothing waiting. Genuinely a clear day.');
  }

  return { date: today, working: true, text: lines.join('\n') };
}
