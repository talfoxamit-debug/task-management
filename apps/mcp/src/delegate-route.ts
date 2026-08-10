import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSql, withDeadline } from './db.js';
import {
  delegateClose,
  delegateComment,
  delegateUndo,
  loadDelegateView,
  recentlyClosed,
} from './delegate-data.js';
import { renderDelegatePage, renderGone } from './delegate-html.js';
import { renderOwnerPage } from './owner-html.js';
import { loadOwnerView, ownerClose, ownerUndo } from './owner-page.js';
import { buildCalendar, icsFilename } from './ics.js';
import { resolveToken, stampFetch, type ResolvedToken } from './delegation.js';
import { notifyOwner } from './telegram.js';

/**
 * The unauthenticated half of TaskOS.
 *
 * Everything else in this server sits behind a bearer token that only Tal and
 * his connector hold. These routes are open to anyone who has a link, which is
 * the entire point and also the entire risk, so the rules are narrow and stated
 * once here:
 *
 *   1. THE TOKEN IS THE ONLY INPUT THAT SELECTS DATA. Nothing is ever scoped by
 *      a query parameter, a header or a form field; the workspace and the person
 *      come from the resolved token and from nowhere else.
 *   2. GET NEVER MUTATES. WhatsApp, Telegram, Slack, iMessage and every mail
 *      scanner fetch a URL the moment it is pasted, so a GET that closed a task
 *      would mean the act of sending the link completed the work.
 *   3. EVERY MUTATION IS POST AND ANSWERS 303. Post/Redirect/Get, so a refresh
 *      or a back button cannot re-submit, and so the browser's back stack does
 *      not fill with form posts.
 *   4. NOTHING FROM THE REQUEST IS ECHOED. Flash messages are codes looked up in
 *      a fixed table (delegate-html.ts), which removes reflected XSS as a
 *      category rather than as a bug.
 */

const TOKEN = '[A-Za-z0-9_-]{43}';
/** `/p/<token>` and `/d/<token>`, with an optional action. */
const PAGE = new RegExp(`^/(p|d)/(td[ptc]_${TOKEN})(?:/(close|comment|undo))?$`);
/** `/p/<token>/task/<uuid>.ics` — the single-task download. */
const TASK_ICS = new RegExp(
  `^/(p|d)/(td[ptc]_${TOKEN})/task/([0-9a-fA-F-]{36})\\.ics$`,
);
/** `/c/<token>.ics` — the subscribable feed. */
const FEED = new RegExp(`^/c/(td[ptc]_${TOKEN})\\.ics$`);
/** `/me/<token>` — Tal's own page, and its two POSTs. */
const OWNER = new RegExp(`^/me/(tdo_${TOKEN})(?:/(close|undo))?$`);

/** A comment is capped at 4000 characters; nothing legitimate approaches this. */
const MAX_BODY_BYTES = 64_000;

export function isDelegatePath(path: string): boolean {
  return PAGE.test(path) || TASK_ICS.test(path) || FEED.test(path) || OWNER.test(path);
}

/**
 * Headers every response here carries.
 *
 * The Referer one is not decoration. This page's own URL contains a live
 * credential, so any outbound request — a stylesheet, an image, a link the
 * person taps — would hand the token to a third party in a header nobody looks
 * at. `no-referrer` plus a content policy that forbids loading anything external
 * at all means there is no outbound request to leak it in.
 */
function harden(res: ServerResponse): void {
  res.setHeader('cache-control', 'no-store, private');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

function html(res: ServerResponse, status: number, body: string, head = false): void {
  harden(res);
  res.statusCode = status;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(head ? undefined : body);
}

function redirect(res: ServerResponse, to: string): void {
  harden(res);
  // 303 rather than 302: it is the status that says "GET the next one", which is
  // what makes a refresh after a close harmless.
  res.statusCode = 303;
  res.setHeader('location', to);
  res.end();
}

/**
 * Form bodies, by hand.
 *
 * There is no framework in this repo and adding one for three POSTs would be a
 * dependency with a security surface far larger than the code it replaces.
 * telegram-route.ts parses its own body the same way and for the same reason.
 */
async function readForm(
  req: IncomingMessage & { body?: unknown },
): Promise<URLSearchParams> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return new URLSearchParams(req.body);
    if (Buffer.isBuffer(req.body)) return new URLSearchParams(req.body.toString('utf8'));
    if (typeof req.body === 'object') {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      return params;
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/** Tal hears about it, or he does not. Either way the delegate's write stands. */
async function tell(text: string): Promise<void> {
  try {
    await notifyOwner(text);
  } catch {
    // A Telegram outage must never turn a successful close into an error page.
    // The comment and the status change are already committed; the notification
    // is the only thing that can be lost, and the inbox still has it.
  }
}

export default async function delegateRoute(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  path: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const head = method === 'HEAD';

  const feed = FEED.exec(path);
  const taskIcs = TASK_ICS.exec(path);
  const owner = OWNER.exec(path);
  const page = PAGE.exec(path);

  const rawToken = feed?.[1] ?? taskIcs?.[2] ?? owner?.[1] ?? page?.[2];
  if (!rawToken) {
    const gone = renderGone('unknown');
    html(res, gone.status, gone.html, head);
    return;
  }

  const action = page?.[3] ?? owner?.[2];
  if (action && method !== 'POST') {
    // The whole undo/close/comment surface is POST-only, and saying so with 405
    // rather than 404 makes a mis-typed link diagnosable.
    harden(res);
    res.statusCode = 405;
    res.setHeader('allow', 'POST');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Use the buttons on your task page.');
    return;
  }
  if (!action && method !== 'GET' && !head) {
    harden(res);
    res.statusCode = 405;
    res.setHeader('allow', 'GET');
    res.end();
    return;
  }

  const sql = getSql();
  const resolution = await resolveToken(sql, rawToken);
  if (!resolution.ok) {
    const gone = renderGone(resolution.reason);
    html(res, gone.status, gone.html, head);
    return;
  }
  const token = resolution.token;

  // A calendar feed URL lives forever in Google's servers and in a settings
  // screen nobody audits. It is a separate row from the person link precisely so
  // it cannot close anything, and that separation only holds if the scopes
  // cannot be used at each other's paths.
  // The scopes are separate rows precisely so they cannot be used at each
  // other's paths. An owner token is the widest credential here and must reach
  // only its own page; a delegate token must never reach the owner page.
  if (owner && token.scope !== 'owner') {
    const gone = renderGone('unknown');
    html(res, gone.status, gone.html, head);
    return;
  }
  if (!owner && token.scope === 'owner') {
    const gone = renderGone('unknown');
    html(res, gone.status, gone.html, head);
    return;
  }

  if (feed && token.scope !== 'calendar') {
    const gone = renderGone('unknown');
    html(res, gone.status, gone.html, head);
    return;
  }
  if (!feed && token.scope === 'calendar') {
    const gone = renderGone('unknown');
    html(res, gone.status, gone.html, head);
    return;
  }

  const base =
    token.scope === 'owner'
      ? `/me/${rawToken}`
      : `/${token.scope === 'task' ? 'd' : 'p'}/${rawToken}`;

  if (owner) {
    await handleOwner(req, res, token, base, action, head);
    return;
  }

  if (feed) {
    await handleFeed(res, token, head);
    return;
  }

  if (taskIcs) {
    await handleTaskIcs(res, token, taskIcs[3]!, head);
    return;
  }

  if (action) {
    await handleAction(req, res, token, action, base);
    return;
  }

  // A GET, and the only thing it writes is telemetry that is never reported as a
  // read: link previews fetch this URL too.
  await stampFetch(sql, token.token_id);

  const [view, closed] = await withDeadline('delegate.page', 15_000, async () => {
    const v = await loadDelegateView(sql, token);
    const c = await recentlyClosed(sql, token);
    return [v, c] as const;
  });

  const url = new URL(req.url ?? '/', 'http://localhost');
  html(
    res,
    200,
    renderDelegatePage(view, closed, { base, flash: url.searchParams.get('m') }),
    head,
  );
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

function calendar(res: ServerResponse, body: string, filename: string | null, head: boolean): void {
  harden(res);
  res.statusCode = 200;
  res.setHeader('content-type', 'text/calendar; charset=utf-8');
  if (filename) res.setHeader('content-disposition', `attachment; filename="${filename}"`);
  res.end(head ? undefined : body);
}

async function handleFeed(
  res: ServerResponse,
  token: ResolvedToken,
  head: boolean,
): Promise<void> {
  const sql = getSql();
  await stampFetch(sql, token.token_id);
  const view = await loadDelegateView(sql, token);
  calendar(
    res,
    buildCalendar([...view.open, ...view.later], {
      calendarName: `TaskOS — ${token.person_name}`,
      feed: true,
    }),
    null,
    head,
  );
}

async function handleTaskIcs(
  res: ServerResponse,
  token: ResolvedToken,
  taskId: string,
  head: boolean,
): Promise<void> {
  const sql = getSql();
  const view = await loadDelegateView(sql, token);
  const task = [...view.open, ...view.later].find((t) => t.id === taskId);
  if (!task || !task.deadline_date) {
    // No deadline means no day to put it on, and inventing one would put a date
    // nobody chose onto somebody's phone.
    const gone = renderGone('unknown');
    html(res, gone.status, gone.html, head);
    return;
  }

  // Deliberately no URL property on the event. Linking back would mean writing
  // the live token into a calendar entry that syncs to Google, sits in an
  // exported .ics on a laptop, and is shared with whoever the event is shared
  // with — turning a credential the person holds into one their calendar
  // provider holds too.
  calendar(
    res,
    buildCalendar([task], { calendarName: `TaskOS — ${token.person_name}` }),
    icsFilename(task.title),
    head,
  );
}

// ---------------------------------------------------------------------------
// The three things a delegate may do
// ---------------------------------------------------------------------------

async function handleAction(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  token: ResolvedToken,
  action: string,
  base: string,
): Promise<void> {
  const sql = getSql();

  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch {
    redirect(res, `${base}?m=failed`);
    return;
  }

  const taskId = (form.get('task_id') ?? '').trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(taskId)) {
    redirect(res, `${base}?m=notyours`);
    return;
  }

  try {
    if (action === 'close') {
      const res_ = await withDeadline('delegate.close', 15_000, () =>
        delegateClose(sql, token, taskId, form.get('actual_minutes')),
      );
      if (!res_.ok) {
        redirect(res, `${base}?m=notyours`);
        return;
      }
      await tell(
        `${token.person_name} marked done: ${await titleOf(sql, taskId)}${
          res_.minutes ? ` — ${res_.minutes} min (stated)` : ''
        }`,
      );
      redirect(res, `${base}?m=done`);
      return;
    }

    if (action === 'comment') {
      const body = form.get('body') ?? '';
      const blocks = form.get('blocks') === '1';
      const res_ = await withDeadline('delegate.comment', 15_000, () =>
        delegateComment(sql, token, taskId, body, blocks),
      );
      if (!res_.ok) {
        const code =
          res_.message === 'Nothing to say.'
            ? 'empty'
            : res_.message === 'That is too long.'
              ? 'toolong'
              : 'notyours';
        redirect(res, `${base}?m=${code}`);
        return;
      }
      await tell(
        `${blocks ? '⚠️ STUCK' : 'Note'} from ${token.person_name} on "${await titleOf(
          sql,
          taskId,
        )}":\n${body.trim().slice(0, 800)}`,
      );
      redirect(res, `${base}?m=${blocks ? 'flagged' : 'sent'}`);
      return;
    }

    // undo
    const res_ = await withDeadline('delegate.undo', 15_000, () =>
      delegateUndo(sql, token, taskId),
    );
    if (!res_.ok) {
      redirect(res, `${base}?m=${res_.message.startsWith('Too late') ? 'toolate' : 'notyours'}`);
      return;
    }
    await tell(`${token.person_name} undid: ${await titleOf(sql, taskId)}`);
    redirect(res, `${base}?m=undone`);
  } catch (e) {
    console.log(
      `[taskos] delegate ${action} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    redirect(res, `${base}?m=failed`);
  }
}

/** The title, for a notification. Scoped, because everything here is scoped. */
async function titleOf(
  sql: ReturnType<typeof getSql>,
  taskId: string,
): Promise<string> {
  const rows = await sql<Array<{ title: string }>>`
    select title from tasks where id = ${taskId}`;
  return rows[0]?.title ?? 'a task';
}

// ---------------------------------------------------------------------------
// Tal's own page
// ---------------------------------------------------------------------------

/**
 * The owner page: read everything, change exactly two things.
 *
 * The narrowness is the point. This token reaches the whole portfolio, so the
 * mutations it can perform are held to close and undo — a stolen link can read,
 * and can mark something done that a fifteen-minute undo reverses. It cannot
 * kill, delete, edit, reassign or mint another link.
 */
async function handleOwner(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
  token: ResolvedToken,
  base: string,
  action: string | undefined,
  head: boolean,
): Promise<void> {
  const sql = getSql();

  if (!action) {
    await stampFetch(sql, token.token_id);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const view = await withDeadline('owner.page', 20_000, () => loadOwnerView(sql, token));
    html(res, 200, renderOwnerPage(view, { base, flash: url.searchParams.get('m') }), head);
    return;
  }

  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch {
    redirect(res, `${base}?m=failed`);
    return;
  }

  const taskId = (form.get('task_id') ?? '').trim();
  if (!/^[0-9a-fA-F-]{36}$/.test(taskId)) {
    redirect(res, `${base}?m=notyours`);
    return;
  }

  try {
    if (action === 'close') {
      const done = await withDeadline('owner.close', 15_000, () =>
        ownerClose(sql, token, taskId),
      );
      redirect(res, `${base}?m=${done.ok ? 'done' : 'failed'}`);
      return;
    }
    const undone = await withDeadline('owner.undo', 15_000, () => ownerUndo(sql, token, taskId));
    redirect(res, `${base}?m=${undone.ok ? 'undone' : 'toolate'}`);
  } catch (e) {
    console.log(`[taskos] owner ${action} failed: ${e instanceof Error ? e.message : String(e)}`);
    redirect(res, `${base}?m=failed`);
  }
}
