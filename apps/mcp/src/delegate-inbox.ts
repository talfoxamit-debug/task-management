import { resolveWorkspaceId, type Sql } from './db.js';
import { findReplay, recordReceipt } from './idempotency.js';
import { envelope, narrow, plainConfidence, type ToolEnvelope } from './narrow.js';

/**
 * Tal's side of delegation: what came back, and how to answer it.
 *
 * The delegate pages produce the first inbound writes in TaskOS that Tal did not
 * make himself. Without somewhere to read them, a delegate saying "I am blocked
 * on the vendor" lands in a table nothing queries, and the most expensive
 * silence in the system — 48 delegated hours stalled behind a 28-hour bottleneck
 * — stays silent.
 *
 * READING DOES NOT MARK AS READ BY DEFAULT. That looks like a missing feature
 * and is the opposite: an agent that calls this, gets the rows, and then loses
 * the conversation to a context limit would have consumed the only notification
 * Tal was ever going to get. mark_read is a second, deliberate call made after
 * the agent has actually put the words in front of him.
 */

interface CommentRow {
  id: string;
  task_id: string;
  task: string;
  venture: string;
  person: string | null;
  body: string;
  blocks_progress: boolean;
  created_at: Date;
}

function ageDays(at: Date, now: number): number {
  return Math.floor((now - at.getTime()) / 86_400_000);
}

export async function delegationInbox(
  sql: Sql,
  input: { person?: string; include_read?: boolean; mark_read?: boolean } = {},
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);

  const comments = await sql<CommentRow[]>`
    select c.id, c.task_id, t.title as task, v.name as venture, p.name as person,
           c.body, c.blocks_progress, c.created_at
      from task_comments c
      join tasks t on t.id = c.task_id
      join ventures v on v.id = t.venture_id
      left join people p on p.id = c.author_person_id
     where c.workspace_id = ${workspaceId}
       and c.author_kind = 'delegate'
       ${input.include_read ? sql`` : sql`and c.read_by_owner_at is null`}
       ${input.person ? sql`and p.name = ${input.person}` : sql``}
     order by c.blocks_progress desc, c.created_at`;

  // Flagged tasks are listed separately from the comment that flagged them.
  // A comment is read once; a block persists until somebody does something
  // about it, and the two decay at completely different rates.
  const blocked = await sql<
    Array<{
      id: string;
      title: string;
      venture: string;
      person: string | null;
      needs_attention_at: Date;
      estimate_minutes: number;
      deadline_date: string | null;
    }>
  >`
    select t.id, t.title, v.name as venture, p.name as person, t.needs_attention_at,
           t.estimate_minutes, t.deadline_date::text as deadline_date
      from tasks t
      join ventures v on v.id = t.venture_id
      left join people p on p.id = t.assignee_person_id
     where t.workspace_id = ${workspaceId}
       and t.needs_attention_at is not null
       and t.status not in ('done', 'killed')
       ${input.person ? sql`and p.name = ${input.person}` : sql``}
     order by t.needs_attention_at`;

  const closures = await sql<
    Array<{ title: string; person: string | null; closed_at: Date; minutes: number | null }>
  >`
    select t.title, p.name as person, t.closed_at,
           case when t.actual_inferred then null else t.actual_minutes end as minutes
      from tasks t
      left join people p on p.id = t.actual_by_person_id
     where t.workspace_id = ${workspaceId}
       and t.actual_by_person_id is not null
       and t.status = 'done'
       and t.closed_at > now() - interval '7 days'
     order by t.closed_at desc`;

  const now = Date.now();

  if (input.mark_read && comments.length > 0) {
    await sql`
      update task_comments set read_by_owner_at = now()
       where id in ${sql(comments.map((c) => c.id))}`;
  }

  const notes: string[] = [];
  if (blocked.length > 0) {
    const worst = ageDays(blocked[0]!.needs_attention_at, now);
    notes.push(
      `${blocked.length} task(s) are flagged as blocked; the oldest has been waiting ${worst} day(s). A blocked delegate does not reduce demand — the hours are still counted, they are just not moving.`,
    );
  }
  if (!input.mark_read && comments.length > 0) {
    notes.push(
      'these are still unread: call again with mark_read:true AFTER you have shown them to Tal, not before',
    );
  }
  notes.push(
    'a delegate\'s stated duration is recorded against them and never reaches calibration, which measures Tal\'s estimating',
  );

  const commentList = narrow(
    comments.map((c) => ({
      comment_id: c.id,
      task_id: c.task_id,
      task: c.task,
      venture: c.venture,
      from: c.person ?? 'unknown',
      blocked: c.blocks_progress,
      days_ago: ageDays(c.created_at, now),
      body: c.body,
    })),
  );

  const blockedList = narrow(
    blocked.map((b) => ({
      task_id: b.id,
      task: b.title,
      venture: b.venture,
      assignee: b.person ?? 'unassigned',
      blocked_for_days: ageDays(b.needs_attention_at, now),
      estimate_minutes: b.estimate_minutes,
      deadline_date: b.deadline_date,
    })),
  );

  return envelope(plainConfidence(notes), {
    unread_comments: commentList.items,
    unread_total: commentList.total,
    blocked: blockedList.items,
    blocked_total: blockedList.total,
    closed_by_others_this_week: closures.map((c) => ({
      task: c.title,
      by: c.person ?? 'unknown',
      on: c.closed_at.toISOString().slice(0, 10),
      stated_minutes: c.minutes,
    })),
    marked_read: Boolean(input.mark_read) ? comments.length : 0,
  });
}

/**
 * Tal answering, in the same thread the delegate is already reading.
 *
 * Not update_task notes: notes are written wholesale, so an answer left there
 * dies on the next correction. Not an event either — taskos_dedupe_events drops
 * a second row with the same (verb, task_id, actor) inside a minute, which would
 * silently eat a rapid follow-up.
 */
export async function commentOnTask(
  sql: Sql,
  input: { task_id: string; body: string; clear_flag?: boolean; idempotency_key?: string },
): Promise<ToolEnvelope> {
  const replay = await findReplay(sql, input.idempotency_key);
  if (replay) {
    return envelope(plainConfidence(['replayed: nothing was written']), {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
    });
  }

  const workspaceId = await resolveWorkspaceId(sql);
  const body = input.body.trim();
  if (body.length === 0 || body.length > 4000) {
    return envelope(plainConfidence([]), { commented: false }, [
      { code: 'bad_body', message: 'a comment is 1 to 4000 characters — nothing was written' },
    ]);
  }

  const tasks = await sql<
    Array<{ id: string; title: string; assignee: string | null; flagged: boolean }>
  >`
    select t.id, t.title, p.name as assignee, (t.needs_attention_at is not null) as flagged
      from tasks t
      left join people p on p.id = t.assignee_person_id
     where t.id = ${input.task_id} and t.workspace_id = ${workspaceId}`;
  const task = tasks[0];
  if (!task) {
    return envelope(plainConfidence([]), { commented: false }, [
      { code: 'not_found', message: `task ${input.task_id} does not exist — nothing was written` },
    ]);
  }

  const result = await sql.begin(async (tx) => {
    const rows = await tx<Array<{ id: string }>>`
      insert into task_comments (workspace_id, task_id, author_kind, body)
      values (${workspaceId}, ${input.task_id}, 'tal', ${body})
      returning id`;

    if (input.clear_flag) {
      await tx`
        update tasks set needs_attention_at = null, last_touched_at = now()
         where id = ${input.task_id} and workspace_id = ${workspaceId}`;
    }

    await recordReceipt(tx, {
      key: input.idempotency_key,
      actor: 'tal',
      verb: 'comment',
      task_id: input.task_id,
      workspace_id: workspaceId,
      result: { comment_id: rows[0]!.id },
    });
    return rows[0]!;
  });

  const notes: string[] = [];
  if (!task.assignee) {
    // Comments are visible to the CURRENT assignee. Writing one on unassigned
    // work is writing into a room with nobody in it.
    notes.push(
      'nobody is assigned to this task, so nobody will see this comment on a delegate page',
    );
  } else {
    notes.push(
      `${task.assignee} sees this the next time they open their link; it does not notify them`,
    );
  }
  if (task.flagged && !input.clear_flag) {
    notes.push(
      'this task is still flagged as blocked — pass clear_flag:true once the blocker is actually gone',
    );
  }

  return envelope(plainConfidence(notes), {
    commented: true,
    comment_id: result.id,
    task: task.title,
    flag_cleared: Boolean(input.clear_flag && task.flagged),
  });
}
