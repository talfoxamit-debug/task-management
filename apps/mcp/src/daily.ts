import { resolveWorkspaceId, type Sql } from './db.js';
import { buildDayPlan } from './day-plan.js';

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

  // --- The day, in hours ---------------------------------------------------
  //
  // A ranking still leaves the whole allocation problem to the person reading
  // it, every morning. The plan below is the same ranking laid against the
  // hours actually on record — and it chains dependent work, so "do A, then B
  // which A unblocks" appears as two slots rather than as one suggestion and
  // one silence.
  const plan = await buildDayPlan(sql, { date: today });
  if (plan.slots.length > 0) {
    lines.push('', 'THE DAY');
    for (const slot of plan.slots) {
      const marks: string[] = [];
      if (slot.review_of_draft) marks.push('REVIEW');
      if (slot.ai_can_prepare) marks.push('AI DRAFTS FIRST');
      if (slot.uses_flex) marks.push('flex');
      const tag = marks.length > 0 ? ` [${marks.join(' · ')}]` : '';
      lines.push(`${slot.start}-${slot.end} ${slot.title}${tag}`);
      const detail: string[] = [slot.venture];
      if (slot.after && slot.after.length > 0) detail.push(`after ${slot.after.join(', ')}`);
      if (slot.unblocks) detail.push(`unblocks ${slot.unblocks}`);
      lines.push(`   ${detail.join(' · ')}`);
    }
  } else if (plan.window === null) {
    lines.push(
      '',
      'THE DAY: the hours of your day are not on record, so there is no plan to lay out.',
      'Ask me to set them and this becomes a schedule.',
    );
  }

  if (plan.to_prepare.length > 0) {
    lines.push('', 'CLAUDE DRAFTS BEFORE THOSE SLOTS');
    for (const t of plan.to_prepare) {
      lines.push(`• ${t.title} — needed by ${t.by}`);
    }
  }

  if (plan.unplaced.length > 0) {
    lines.push('', `DID NOT FIT (${plan.unplaced.length})`);
    for (const u of plan.unplaced.slice(0, 3)) {
      lines.push(`• ${u.title} — ${u.reason}`);
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

  // What they actually finished. Without this the delegated section is a list
  // of problems, which is a misleading picture of people who are mostly doing
  // the work.
  const finished = await sql<Array<{ person: string; n: number }>>`
    select p.name as person, count(*)::int as n
      from tasks t join people p on p.id = t.actual_by_person_id
     where t.workspace_id = ${workspaceId} and t.status = 'done'
       and t.closed_at > now() - interval '24 hours'
     group by p.name order by n desc`;

  if (blocked.length > 0 || (unread[0]?.n ?? 0) > 0 || finished.length > 0) {
    lines.push('', 'DELEGATED');
    for (const f of finished) {
      lines.push(`• ${f.person} finished ${f.n} since yesterday`);
    }
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
  if (plan.window === null && plan.working) {
    unknown.push('the hours your day runs are not set, so nothing can be laid into a schedule');
  }
  if (!day) unknown.push(`no allocation is set for ${DAYS[dow]}`);
  if (unknown.length > 0) lines.push('', `NOT KNOWN: ${unknown.join('; ')}.`);

  if (lines.length === 1) {
    lines.push('', 'Nothing due, nothing blocked, nothing waiting. Genuinely a clear day.');
  }

  return { date: today, working: true, text: lines.join('\n') };
}
