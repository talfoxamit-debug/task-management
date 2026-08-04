import { close } from './tools.js';
import { createSignedDownloadUrl, storageConfig } from './storage.js';
import { stampAction, type ResolvedToken } from './delegation.js';
import type { Sql } from './db.js';

/**
 * Everything the delegate page is allowed to read and write.
 *
 * ONE MODULE, on purpose. Every query here is scoped by both workspace_id and
 * assignee_person_id, taken from a resolved token and never from the request.
 * Keeping them together means the scoping can be reviewed in one sitting
 * instead of being spread across a route file where one missing clause is
 * invisible.
 *
 * IT DOES NOT CALL loadPortfolio OR THE ENGINE, and that is deliberate rather
 * than incidental. Those load every task, milestone and venture in the
 * workspace into memory to compute slack and coverage. Doing that on an
 * unauthenticated request would put the whole portfolio one bug away from a
 * page built to be forwarded, and a person-scoped subset would starve
 * computeCoverage below the 60% threshold and produce confidently wrong slack
 * — the worst failure mode in the design.
 *
 * So the ordering below is deadline, then value, then size. The page makes NO
 * claim that this is Tal's priority order, because it is not: the real ranking
 * needs the engine and the engine needs the whole portfolio.
 */

export interface DelegateTask {
  id: string;
  title: string;
  venture: string;
  notes: string | null;
  estimate_minutes: number;
  deadline_date: string | null;
  status: string;
  unblocks: number;
  needs_attention: boolean;
  comments: Array<{
    id: string;
    body: string;
    author: string;
    author_kind: string;
    at: string;
    blocks_progress: boolean;
  }>;
  /** Files attached to this task, so the context arrives with the work. */
  files: Array<{ id: string; title: string; url: string | null; note: string }>;
}

export interface DelegateView {
  person: string;
  timezone: string;
  timezone_source: 'theirs' | 'workspace';
  today: string;
  open: DelegateTask[];
  later: DelegateTask[];
  finished_this_week: number;
  /**
   * A SHORT past. Two weeks, titles only, no durations and no comment threads.
   *
   * Enough that the page reads as a record of work rather than as an unending
   * demand, and little enough that it is not an archive: an assignee who can
   * scroll a year of history has a page that answers questions nobody asked and
   * buries the one that matters, which is what to do now.
   */
  finished: FinishedTask[];
  scope: 'person' | 'task';
  rotated: boolean;
}

export interface ClosedTask {
  id: string;
  title: string;
}

/** The short past: what they finished, so a page is not only a demand. */
export interface FinishedTask {
  title: string;
  on: string;
}

/**
 * What this person can see: their own open assigned work, and nothing else.
 *
 * The venture NAME ships, not the slug and not its weight or share. What a task
 * unblocks ships as a COUNT and never as titles — "2 other things are waiting
 * on this" carries the whole motivational payload, while rendering the
 * dependent titles would leak Tal's and Saar's work into a page built to be
 * forwarded, and the leak would widen with graph density.
 */
export async function loadDelegateView(
  sql: Sql,
  token: ResolvedToken,
): Promise<DelegateView> {
  const settings = await sql<Array<{ tz: string; today: string }>>`
    select active_tz as tz, taskos_today(${token.workspace_id})::text as today
      from settings where workspace_id = ${token.workspace_id}`;
  const person = await sql<Array<{ timezone: string | null }>>`
    select timezone from people where id = ${token.person_id}`;

  const workspaceTz = settings[0]?.tz ?? 'UTC';
  const theirTz = person[0]?.timezone ?? null;

  const rows = await sql<
    Array<{
      id: string;
      title: string;
      venture: string;
      notes: string | null;
      estimate_minutes: number;
      deadline_date: string | null;
      status: string;
      unblocks: number;
      needs_attention: boolean;
    }>
  >`
    select t.id, t.title, v.name as venture, t.notes, t.estimate_minutes,
           t.deadline_date::text as deadline_date, t.status,
           (select count(*)::int from task_dependencies d
             join tasks b on b.id = d.blocks_task_id
            where d.task_id = t.id and b.status not in ('done', 'killed')) as unblocks,
           (t.needs_attention_at is not null) as needs_attention
      from tasks t
      join ventures v on v.id = t.venture_id
     where t.workspace_id = ${token.workspace_id}
       and t.assignee_person_id = ${token.person_id}
       and t.status not in ('done', 'killed')
       ${token.scope === 'task' ? sql`and t.id = ${token.task_id!}` : sql``}
     order by t.deadline_date nulls last, t.value desc, t.estimate_minutes
     limit 60
  `;

  const ids = rows.map((r) => r.id);
  // The comment thread shows Tal's and the CURRENT assignee's comments only.
  // Threads survive reassignment, so without this filter handing a stalled task
  // to Saar would show him everything Othman wrote and everything Tal wrote to
  // Othman.
  const comments = ids.length
    ? await sql<
        Array<{
          id: string;
          task_id: string;
          body: string;
          author: string | null;
          author_kind: string;
          created_at: Date;
          blocks_progress: boolean;
        }>
      >`
        select c.id, c.task_id, c.body, p.name as author, c.author_kind,
               c.created_at, c.blocks_progress
          from task_comments c
          left join people p on p.id = c.author_person_id
         where c.workspace_id = ${token.workspace_id}
           and c.task_id in ${sql(ids)}
           and (c.author_kind <> 'delegate' or c.author_person_id = ${token.person_id})
         order by c.created_at`
    : [];

  const byTask = new Map<string, DelegateTask['comments']>();
  for (const c of comments) {
    const list = byTask.get(c.task_id) ?? [];
    list.push({
      id: c.id,
      body: c.body,
      author: c.author_kind === 'tal' ? 'Tal' : (c.author ?? 'system'),
      author_kind: c.author_kind,
      at: c.created_at.toISOString(),
      blocks_progress: c.blocks_progress,
    });
    byTask.set(c.task_id, list);
  }

  const today = settings[0]?.today ?? new Date().toISOString().slice(0, 10);
  const soon = (d: string | null) => d === null || d <= addDays(today, 7);

  // Files attached to THEIR tasks, and to nothing else.
  //
  // Scoped through the task ids already filtered above rather than by a fresh
  // query on documents, so there is exactly one place the assignee check
  // happens. A document attached to the venture or the milestone is deliberately
  // NOT included: those belong to work far wider than this person's, and the
  // whole reach of this page is one person's own tasks.
  const byTaskFiles = new Map<string, DelegateTask['files']>();
  if (ids.length > 0) {
    const docs = await sql<
      Array<{
        id: string;
        task_id: string;
        title: string;
        storage_path: string;
        status: string;
        mime_type: string | null;
      }>
    >`
      select id, task_id, title, storage_path, status, mime_type
        from documents
       where workspace_id = ${token.workspace_id} and task_id in ${sql(ids)}
       order by created_at`;

    const storage = storageConfig();
    for (const d of docs) {
      const list = byTaskFiles.get(d.task_id) ?? [];
      let url: string | null = null;
      let note = '';
      if (d.status !== 'stored') {
        // A pending document is a link that was issued and never used. Saying
        // "filed" here would send somebody looking for a file that is not there.
        note = d.status === 'pending' ? 'not uploaded yet' : d.status;
      } else if (!storage.configured) {
        note = 'file storage is not configured';
      } else {
        try {
          // Short-lived and minted per page load. A permanent URL in a page
          // built to be forwarded is a file handed to whoever it reaches, long
          // after the link that showed it has expired.
          url = await createSignedDownloadUrl(storage.config, d.storage_path, 900);
          note = 'expires in 15 minutes';
        } catch {
          note = 'could not be opened';
        }
      }
      list.push({ id: d.id, title: d.title, url, note });
      byTaskFiles.set(d.task_id, list);
    }
  }

  const all: DelegateTask[] = rows.map((r) => ({
    ...r,
    comments: byTask.get(r.id) ?? [],
    files: byTaskFiles.get(r.id) ?? [],
  }));

  const finished = await sql<Array<{ n: number }>>`
    select count(*)::int as n from tasks
     where workspace_id = ${token.workspace_id}
       and assignee_person_id = ${token.person_id}
       and status = 'done' and closed_at > now() - interval '7 days'`;

  // The short past. Titles and dates only — no durations, no threads, no
  // archive. Two weeks is enough to read as a record of work and short enough
  // that it cannot bury the question the page exists to answer.
  const recent = await sql<Array<{ title: string; on: string }>>`
    select title, closed_at::date::text as on from tasks
     where workspace_id = ${token.workspace_id}
       and assignee_person_id = ${token.person_id}
       and status = 'done' and closed_at > now() - interval '14 days'
     order by closed_at desc
     limit 8`;

  return {
    person: token.person_name,
    timezone: theirTz ?? workspaceTz,
    timezone_source: theirTz ? 'theirs' : 'workspace',
    today,
    open: all.filter((t) => soon(t.deadline_date)),
    later: all.filter((t) => !soon(t.deadline_date)),
    finished_this_week: finished[0]?.n ?? 0,
    finished: recent,
    scope: token.scope === 'task' ? 'task' : 'person',
    rotated: Boolean(token.superseded_link),
  };
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const t = Date.UTC(y!, m! - 1, d! + n);
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * What this person closed in the last fifteen minutes, so Undo has something to
 * attach itself to.
 *
 * Driven by the database rather than by a `?done=<id>` on the redirect, and that
 * is worth the extra query: a page that renders its state from the query string
 * is a page whose state can be forged by editing the URL, and it loses the undo
 * button on the first refresh — which is exactly when a mis-tap gets noticed.
 */
export async function recentlyClosed(
  sql: Sql,
  token: ResolvedToken,
): Promise<ClosedTask[]> {
  return sql<Array<{ id: string; title: string }>>`
    select id, title from tasks
     where workspace_id = ${token.workspace_id}
       and assignee_person_id = ${token.person_id}
       and status = 'done'
       and closed_at > now() - interval '15 minutes'
       ${token.scope === 'task' ? sql`and id = ${token.task_id!}` : sql``}
     order by closed_at desc
     limit 5`;
}

/** Assert this token may act on this task, before anything is written. */
export async function ownsTask(
  sql: Sql,
  token: ResolvedToken,
  taskId: string,
): Promise<boolean> {
  if (token.scope === 'task' && token.task_id !== taskId) return false;
  const rows = await sql<Array<{ n: number }>>`
    select count(*)::int as n from tasks
     where id = ${taskId} and workspace_id = ${token.workspace_id}
       and assignee_person_id = ${token.person_id}`;
  return (rows[0]?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// The three things a delegate may do
// ---------------------------------------------------------------------------

/**
 * Close, with an OPTIONAL duration.
 *
 * The field is never pre-filled with the estimate. Pre-filling manufactures a
 * measurement out of a guess, and that guess would then be indistinguishable
 * from a real one forever. Absent means absent: close() records the estimate
 * with actual_inferred = true, exactly as it does for Tal.
 */
export async function delegateClose(
  sql: Sql,
  token: ResolvedToken,
  taskId: string,
  actualMinutesRaw: string | null,
): Promise<{ ok: boolean; message: string; minutes: number | null }> {
  if (!(await ownsTask(sql, token, taskId))) {
    return { ok: false, message: 'That task is not yours.', minutes: null };
  }

  const parsed = actualMinutesRaw ? Number.parseInt(actualMinutesRaw.trim(), 10) : NaN;
  const volunteered = Number.isInteger(parsed) && parsed > 0 && parsed <= 60 * 24;

  // A reopened task must not replay the original close receipt, so the key
  // carries the task's current last_touched_at.
  const stamp = await sql<Array<{ v: string }>>`
    select extract(epoch from last_touched_at)::bigint::text as v from tasks where id = ${taskId}`;

  const res = await close(sql, {
    task_id: taskId,
    require_assignee: token.person_id,
    by_person_id: token.person_id,
    actor: `person:${token.person_id}`,
    ...(volunteered ? { actual_minutes: parsed } : {}),
    idempotency_key: `delegate:${token.token_id}:${taskId}:close:${stamp[0]?.v ?? '0'}`,
  });

  if (!res.ok) {
    return { ok: false, message: 'That could not be closed.', minutes: null };
  }

  await sql`
    insert into task_comments (workspace_id, task_id, token_id, author_person_id,
                               author_kind, body)
    values (${token.workspace_id}, ${taskId}, ${token.token_id}, ${token.person_id}, 'system',
            ${
              volunteered
                ? `${token.person_name} marked this done — ${parsed} min (stated)`
                : `${token.person_name} marked this done`
            })`;
  await stampAction(sql, token.token_id);

  return { ok: true, message: 'Done.', minutes: volunteered ? parsed : null };
}

export async function delegateComment(
  sql: Sql,
  token: ResolvedToken,
  taskId: string,
  body: string,
  blocksProgress: boolean,
): Promise<{ ok: boolean; message: string }> {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, message: 'Nothing to say.' };
  if (trimmed.length > 4000) return { ok: false, message: 'That is too long.' };
  if (!(await ownsTask(sql, token, taskId))) {
    return { ok: false, message: 'That task is not yours.' };
  }

  await sql.begin(async (tx) => {
    await tx`
      insert into task_comments (workspace_id, task_id, token_id, author_person_id,
                                 author_kind, body, blocks_progress)
      values (${token.workspace_id}, ${taskId}, ${token.token_id}, ${token.person_id},
              'delegate', ${trimmed}, ${blocksProgress})`;

    if (blocksProgress) {
      // A flag, NOT a status change. `waiting` is in DEMAND_EXCLUDED_STATUSES,
      // so a delegate marking themselves blocked would drop the minutes out of
      // demand while coverage still counted the task — and capacity() would
      // report a lighter week because somebody got stuck.
      await tx`
        update tasks set needs_attention_at = now(), last_touched_at = now()
         where id = ${taskId} and workspace_id = ${token.workspace_id}`;
    }
    await stampAction(tx, token.token_id);
  });

  return {
    ok: true,
    message: blocksProgress ? 'Flagged for Tal.' : 'Sent to Tal.',
  };
}

/**
 * Undo, within a short window.
 *
 * A mis-tap on a phone is the single likeliest error on this page, and without
 * an undo the only remedy is messaging Tal — which is exactly the interruption
 * the whole feature exists to remove.
 */
export async function delegateUndo(
  sql: Sql,
  token: ResolvedToken,
  taskId: string,
): Promise<{ ok: boolean; message: string }> {
  if (!(await ownsTask(sql, token, taskId))) {
    return { ok: false, message: 'That task is not yours.' };
  }
  const rows = await sql<Array<{ id: string }>>`
    update tasks
       set status = 'active', closed_at = null, actual_minutes = null,
           actual_inferred = true, actual_by_person_id = null, last_touched_at = now()
     where id = ${taskId} and workspace_id = ${token.workspace_id}
       and assignee_person_id = ${token.person_id}
       and status = 'done' and closed_at > now() - interval '15 minutes'
     returning id`;

  if (rows.length === 0) {
    return { ok: false, message: 'Too late to undo that one — tell Tal.' };
  }

  await sql`
    insert into task_comments (workspace_id, task_id, token_id, author_person_id,
                               author_kind, body)
    values (${token.workspace_id}, ${taskId}, ${token.token_id}, ${token.person_id}, 'system',
            ${`${token.person_name} undid the completion`})`;
  await stampAction(sql, token.token_id);
  return { ok: true, message: 'Put back.' };
}
