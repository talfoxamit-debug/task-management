import { close } from './tools.js';
import { buildDayPlan, type PlanSlot } from './day-plan.js';
import { stampAction, type ResolvedToken } from './delegation.js';
import type { Sql } from './db.js';

/**
 * The page Tal opens.
 *
 * Everything else in TaskOS talks TO him — a Claude conversation, a Telegram
 * message once a morning, a delegate page built for somebody else. There has
 * never been anywhere he could simply look, and a task system you cannot look at
 * is not a task system. The dashboard needs a Supabase magic link that has not
 * worked since the first deploy, so in practice the interface count was zero.
 *
 * THIS IS THE WIDEST CREDENTIAL IN THE SYSTEM and that is stated rather than
 * hidden. A delegate link reaches one person's assigned work; this reaches the
 * portfolio. The secret is the same 256 bits and only its hash is stored, so
 * what differs is not the strength but the consequence.
 *
 * Three things bound that consequence, and they are the reason the trade is
 * acceptable:
 *
 *   1. TWO MUTATIONS ONLY — close and undo. No kill, no delete, no editing, no
 *      minting of further links. A stolen link can read, and can mark something
 *      done that a fifteen-minute undo reverses. It cannot destroy.
 *   2. It is revocable in one call, like every other token here.
 *   3. The page loads nothing external and sends no referrer, so the URL cannot
 *      escape through the page itself.
 *
 * The alternative was not a safer interface. It was the status quo: no
 * interface at all.
 */

export interface OwnerTask {
  id: string;
  title: string;
  venture: string;
  estimate_minutes: number;
  deadline_date: string | null;
  days_over: number | null;
  prepared_summary: string | null;
}

export interface OwnerView {
  today: string;
  timezone: string;
  day_venture: string | null;
  plan: PlanSlot[];
  plan_note: string | null;
  overdue: OwnerTask[];
  due_soon: OwnerTask[];
  awaiting_review: OwnerTask[];
  blocked: Array<{ title: string; person: string; days: number }>;
  unread_comments: number;
  milestones: Array<{ name: string; venture: string; due: string; days: number; hard: boolean }>;
  just_closed: Array<{ id: string; title: string }>;
  counts: { open: number; inbox: number };
  rotated: boolean;
}

export async function loadOwnerView(sql: Sql, token: ResolvedToken): Promise<OwnerView> {
  const ws = token.workspace_id;

  const settings = await sql<Array<{ tz: string; today: string }>>`
    select active_tz as tz, taskos_today(${ws})::text as today
      from settings where workspace_id = ${ws}`;
  const today = settings[0]?.today ?? new Date().toISOString().slice(0, 10);

  const plan = await buildDayPlan(sql, { date: today });

  // Tal's own work only. Anything assigned to somebody else appears in the
  // delegated section, which answers a different question.
  const tasks = await sql<
    Array<{
      id: string;
      title: string;
      venture: string;
      estimate_minutes: number;
      deadline_date: string | null;
      days_over: number | null;
      prepared_summary: string | null;
      prepared: boolean;
    }>
  >`
    select t.id, t.title, v.name as venture, t.estimate_minutes,
           t.deadline_date::text as deadline_date,
           case when t.deadline_date is not null
                then (${today}::date - t.deadline_date) end as days_over,
           t.prepared_summary, (t.prepared_at is not null) as prepared
      from tasks t join ventures v on v.id = t.venture_id
     where t.workspace_id = ${ws}
       and t.status not in ('done', 'killed', 'inbox')
       and t.assignee_person_id is null
     order by t.deadline_date nulls last, t.value desc
     limit 200`;

  const overdue = tasks.filter((t) => (t.days_over ?? -1) > 0);
  const dueSoon = tasks.filter(
    (t) => t.deadline_date !== null && (t.days_over ?? -99) <= 0 && (t.days_over ?? -99) >= -7,
  );
  const awaiting = tasks.filter((t) => t.prepared);

  const blocked = await sql<Array<{ title: string; person: string | null; days: number }>>`
    select t.title, p.name as person,
           extract(day from now() - t.needs_attention_at)::int as days
      from tasks t left join people p on p.id = t.assignee_person_id
     where t.workspace_id = ${ws} and t.needs_attention_at is not null
       and t.status not in ('done', 'killed')
     order by t.needs_attention_at
     limit 6`;

  const unread = await sql<Array<{ n: number }>>`
    select count(*)::int as n from task_comments
     where workspace_id = ${ws} and author_kind = 'delegate' and read_by_owner_at is null`;

  const milestones = await sql<
    Array<{ name: string; venture: string; due: string; days: number; hard: boolean }>
  >`
    select m.name, v.name as venture, m.due_date::text as due,
           (m.due_date - ${today}::date) as days, (m.hardness = 'hard') as hard
      from milestones m join ventures v on v.id = m.venture_id
     where m.workspace_id = ${ws} and m.status = 'active' and v.active
       and m.due_date <= ${today}::date + 21
     order by m.due_date limit 6`;

  const justClosed = await sql<Array<{ id: string; title: string }>>`
    select id, title from tasks
     where workspace_id = ${ws} and status = 'done'
       and actual_by_person_id is null
       and closed_at > now() - interval '15 minutes'
     order by closed_at desc limit 5`;

  const counts = await sql<Array<{ open: number; inbox: number }>>`
    select count(*) filter (where status not in ('done','killed','inbox'))::int as open,
           count(*) filter (where status = 'inbox')::int as inbox
      from tasks where workspace_id = ${ws}`;

  const shape = (t: (typeof tasks)[number]): OwnerTask => ({
    id: t.id,
    title: t.title,
    venture: t.venture,
    estimate_minutes: t.estimate_minutes,
    deadline_date: t.deadline_date,
    days_over: t.days_over,
    prepared_summary: t.prepared_summary,
  });

  return {
    today,
    timezone: settings[0]?.tz ?? 'UTC',
    day_venture: plan.day_venture,
    plan: plan.slots,
    // The plan's own reason for being empty, surfaced rather than swallowed —
    // an empty schedule with no explanation reads as "nothing to do today".
    plan_note: plan.slots.length === 0 ? (plan.notes[0] ?? null) : null,
    overdue: overdue.map(shape),
    due_soon: dueSoon.map(shape),
    awaiting_review: awaiting.map(shape),
    blocked: blocked.map((b) => ({ title: b.title, person: b.person ?? 'someone', days: b.days })),
    unread_comments: unread[0]?.n ?? 0,
    milestones,
    just_closed: justClosed,
    counts: counts[0] ?? { open: 0, inbox: 0 },
    rotated: Boolean(token.superseded_link),
  };
}

/**
 * Close, from the page.
 *
 * No actual_minutes field, deliberately. D6 says a duration is a measurement
 * only when volunteered in conversation; a number typed into a box because a box
 * was there is a guess that becomes indistinguishable from a measurement the
 * moment it is saved, and it would feed calibration forever. Closing here
 * records the estimate as inferred, exactly as close() has always done.
 */
export async function ownerClose(
  sql: Sql,
  token: ResolvedToken,
  taskId: string,
): Promise<{ ok: boolean }> {
  const owns = await sql<Array<{ n: number }>>`
    select count(*)::int as n from tasks
     where id = ${taskId} and workspace_id = ${token.workspace_id}`;
  if ((owns[0]?.n ?? 0) === 0) return { ok: false };

  const stamp = await sql<Array<{ v: string }>>`
    select extract(epoch from last_touched_at)::bigint::text as v
      from tasks where id = ${taskId}`;

  const res = await close(sql, {
    task_id: taskId,
    actor: 'tal:page',
    idempotency_key: `owner:${token.token_id}:${taskId}:${stamp[0]?.v ?? '0'}`,
  });
  if (res.ok) await stampAction(sql, token.token_id);
  return { ok: res.ok };
}

export async function ownerUndo(
  sql: Sql,
  token: ResolvedToken,
  taskId: string,
): Promise<{ ok: boolean }> {
  const rows = await sql<Array<{ id: string }>>`
    update tasks
       set status = 'active', closed_at = null, actual_minutes = null,
           actual_inferred = true, last_touched_at = now()
     where id = ${taskId} and workspace_id = ${token.workspace_id}
       and status = 'done' and actual_by_person_id is null
       and closed_at > now() - interval '15 minutes'
     returning id`;
  if (rows.length > 0) await stampAction(sql, token.token_id);
  return { ok: rows.length > 0 };
}
