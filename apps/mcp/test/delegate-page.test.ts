import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import entrypoint from '../src/server.js';
import { delegateLink, resolveToken } from '../src/delegation.js';
import { commentOnTask, delegationInbox } from '../src/delegate-inbox.js';
import { commitTasks } from '../src/tools.js';
import { createPerson } from '../src/registry.js';
import type { Sql } from '../src/db.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * The delegate pages over real HTTP, through the same default export Vercel
 * invokes.
 *
 * This is the only unauthenticated surface in TaskOS, so the tests are weighted
 * accordingly: most of them are about what a page must NOT do. The three that
 * would be worst to get wrong are
 *
 *   - a GET that mutates, because every messaging app fetches a link the moment
 *     it is pasted, which would mean sending the link did the work;
 *   - an unescaped interpolation, because the page holds a live credential in
 *     its own URL and script execution there is a credential theft;
 *   - a link that reaches work belonging to somebody else.
 */

let db: TestDb;
let sql: Sql;
let httpServer: Server;
let origin: string;

/** Follow nothing: a 303 is the assertion, not a step on the way to one. */
async function get(path: string, extra: RequestInit = {}) {
  return fetch(`${origin}${path}`, { redirect: 'manual', ...extra });
}

async function post(path: string, form: Record<string, string>) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}

async function mint(person: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await delegateLink(sql, { person, ...extra } as never);
  if (!res['link']) throw new Error(`no link: ${JSON.stringify(res['errors'])}`);
  // A calendar link is `/c/<token>.ics`; the token is what the tests present.
  return String(res['link']).split('/').pop()!.replace(/\.ics$/, '');
}

async function statusOf(title: string): Promise<string> {
  const rows = await sql<Array<{ status: string }>>`
    select status from tasks where title = ${title}`;
  return rows[0]!.status;
}

let othman: string;
let saar: string;

beforeAll(async () => {
  db = await freshDb('delegatepage');
  sql = db.sql;
  process.env['DATABASE_URL'] = db.url;
  process.env['TASKOS_PUBLIC_URL'] = 'https://taskos.example';
  // Unset, so no test can accidentally send Tal a real Telegram message.
  delete process.env['TELEGRAM_BOT_TOKEN'];

  await createPerson(sql, { name: 'Othman', hours_per_week: 40 });
  await createPerson(sql, { name: 'Saar', hours_per_week: 8 });

  await commitTasks(sql, {
    tasks: [
      {
        title: 'Rewire the checkout redirect',
        venture: 'yachtyhub',
        assignee: 'Othman',
        estimate_minutes: 90,
        deadline_date: '2026-08-06',
        notes: 'The redirect loop is what is blocking the demo.',
      },
      {
        title: 'Purge the CDN cache',
        venture: 'yachtyhub',
        assignee: 'Othman',
        estimate_minutes: 30,
      },
      {
        // Every interpolation on the page is fed from here.
        title: '<script>alert("xss")</script> & "quoted" \'title\'',
        venture: 'yachtyhub',
        assignee: 'Othman',
        estimate_minutes: 15,
        notes: '<img src=x onerror=alert(1)>',
      },
      { title: 'Saar private thing', venture: 'yachtyhub', assignee: 'Saar', estimate_minutes: 45 },
      { title: 'Tal keeps this one', venture: 'yachtyhub', estimate_minutes: 60 },
    ],
    idempotency_key: 'page-seed',
  });

  httpServer = createServer((req, res) => {
    void entrypoint(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  othman = await mint('Othman');
  saar = await mint('Saar');
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  await db?.drop();
});

describe('the page a delegate opens', () => {
  it('renders their own work and nothing else', async () => {
    const res = await get(`/p/${othman}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();

    expect(html).toContain('Hi Othman');
    expect(html).toContain('Rewire the checkout redirect');
    expect(html).toContain('Purge the CDN cache');
    expect(html).not.toContain('Saar private thing');
    expect(html).not.toContain('Tal keeps this one');
  });

  it('ESCAPES every interpolation', async () => {
    const html = await (await get(`/p/${othman}`)).text();
    // The only <script> that may appear is one that is escaped.
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('never echoes anything from the query string', async () => {
    const marker = '<script>QUERY_STRING_INJECTION</script>';
    const html = await (
      await get(`/p/${othman}?m=${encodeURIComponent(marker)}`)
    ).text();
    // Flash messages are codes looked up in a fixed table, so a crafted URL
    // cannot put text on the page at all — escaped or otherwise. The marker is
    // unique so the assertion cannot be satisfied by fixture text.
    expect(html).not.toContain('QUERY_STRING_INJECTION');
  });

  it('never pre-fills the duration field with the estimate', async () => {
    const html = await (await get(`/p/${othman}`)).text();
    const inputs = html.match(/<input[^>]*name="actual_minutes"[^>]*>/g) ?? [];
    expect(inputs.length).toBeGreaterThan(0);
    // A pre-filled guess becomes a measurement the instant it is submitted, and
    // nothing downstream can ever tell it apart from a real one.
    for (const input of inputs) expect(input).not.toMatch(/\svalue=/);
  });

  it('carries the headers that keep the token out of other people\'s logs', async () => {
    const res = await get(`/p/${othman}`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    // No external request can be made from this page, so there is nothing for a
    // token in the URL to leak into.
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
  });

  it('says which timezone the dates are in', async () => {
    const html = await (await get(`/p/${othman}`)).text();
    expect(html).toContain('Dates shown for');
  });
});

describe('a GET never mutates', () => {
  it('leaves everything alone when a link preview fetches the page', async () => {
    const before = await sql<Array<{ n: string }>>`
      select count(*)::text as n from tasks where status = 'done'`;
    await get(`/p/${othman}`);
    await get(`/p/${othman}`);
    const after = await sql<Array<{ n: string }>>`
      select count(*)::text as n from tasks where status = 'done'`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('refuses GET on the action URLs rather than performing them', async () => {
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');
    for (const action of ['close', 'comment', 'undo']) {
      const res = await get(`/p/${othman}/${action}?task_id=${id}`);
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
    expect(await statusOf('Purge the CDN cache')).not.toBe('done');
  });

  it('counts a fetch without claiming it was read', async () => {
    const rows = await sql<Array<{ fetch_count: number; acted_at: Date | null }>>`
      select fetch_count, acted_at from delegation_tokens
       where person_id = (select id from people where name = 'Othman') and scope = 'person'`;
    expect(rows[0]!.fetch_count).toBeGreaterThan(0);
  });
});

describe('what a delegate can actually do', () => {
  it('closes a task and answers 303, so a refresh cannot resubmit', async () => {
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');
    const res = await post(`/p/${othman}/close`, { task_id: id, actual_minutes: '25' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`/p/${othman}?m=done`);
    expect(await statusOf('Purge the CDN cache')).toBe('done');

    const row = await sql<Array<{ actual_minutes: number; actual_inferred: boolean }>>`
      select actual_minutes, actual_inferred from tasks where id = ${id}`;
    expect(row[0]!.actual_minutes).toBe(25);
    expect(row[0]!.actual_inferred).toBe(false);
  });

  it('offers Undo on the page afterwards, and undoing puts it back', async () => {
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');
    const html = await (await get(`/p/${othman}`)).text();
    expect(html).toContain('Just finished');
    expect(html).toContain(`action="/p/${othman}/undo"`);

    const res = await post(`/p/${othman}/undo`, { task_id: id });
    expect(res.headers.get('location')).toBe(`/p/${othman}?m=undone`);
    expect(await statusOf('Purge the CDN cache')).toBe('active');
  });

  it('flags being stuck WITHOUT changing status', async () => {
    const id = await taskIdByTitle(sql, 'Rewire the checkout redirect');
    const before = await statusOf('Rewire the checkout redirect');
    const res = await post(`/p/${othman}/comment`, {
      task_id: id,
      body: 'The vendor has not answered since Friday.',
      blocks: '1',
    });
    expect(res.headers.get('location')).toBe(`/p/${othman}?m=flagged`);

    const after = await sql<Array<{ status: string; needs_attention_at: Date | null }>>`
      select status, needs_attention_at from tasks where id = ${id}`;
    // `waiting` is in DEMAND_EXCLUDED_STATUSES: if being stuck changed status,
    // capacity() would report a LIGHTER week because somebody got blocked.
    expect(after[0]!.status).toBe(before);
    expect(after[0]!.needs_attention_at).not.toBeNull();
  });

  it('refuses to act on somebody else\'s task, and writes nothing', async () => {
    const saarTask = await taskIdByTitle(sql, 'Saar private thing');
    const res = await post(`/p/${othman}/close`, { task_id: saarTask });
    expect(res.headers.get('location')).toBe(`/p/${othman}?m=notyours`);
    expect(await statusOf('Saar private thing')).not.toBe('done');

    const commented = await post(`/p/${othman}/comment`, { task_id: saarTask, body: 'hello' });
    expect(commented.headers.get('location')).toContain('m=notyours');
    const rows = await sql<Array<{ n: string }>>`
      select count(*)::text as n from task_comments where task_id = ${saarTask}`;
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('rejects a task_id that is not a uuid without touching the database', async () => {
    const res = await post(`/p/${othman}/close`, { task_id: "1' or '1'='1" });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('m=notyours');
  });

  it('says so when the message is empty', async () => {
    const id = await taskIdByTitle(sql, 'Rewire the checkout redirect');
    const res = await post(`/p/${othman}/comment`, { task_id: id, body: '   ' });
    expect(res.headers.get('location')).toBe(`/p/${othman}?m=empty`);
  });
});

describe('dead links', () => {
  it('answers 404 for a token that matches nothing', async () => {
    const res = await get(`/p/tdp_${'A'.repeat(43)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Link not found');
  });

  it('does not route a malformed path at all', async () => {
    const res = await get('/p/../../etc/passwd');
    expect([404, 400, 301]).toContain(res.status);
    const body = await res.text();
    expect(body).not.toContain('root:');
  });

  it('answers 410 once Tal revokes it', async () => {
    const throwaway = await mint('Saar', { rotate: true });
    expect((await get(`/p/${throwaway}`)).status).toBe(200);
    await sql`update delegation_tokens set revoked_at = now()
               where person_id = (select id from people where name = 'Saar')`;
    const res = await get(`/p/${throwaway}`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('Link closed');
    saar = await mint('Saar', { rotate: true });
  });
});

describe('one link per task, gone 90 minutes after it is approved', () => {
  it('keeps working through the undo window, then closes itself', async () => {
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');
    const link = await mint('Othman', { scope: 'task', task_id: id });

    expect((await get(`/d/${link}`)).status).toBe(200);

    await post(`/d/${link}/close`, { task_id: id });
    expect(await statusOf('Purge the CDN cache')).toBe('done');

    // Straight after the close the link still works: this is the window in
    // which the undo gets used and the receipt gets read.
    const during = await get(`/d/${link}`);
    expect(during.status).toBe(200);
    expect(await during.text()).toContain('Undo');

    // Ninety-one minutes later it is gone, with no sweeper having run.
    await sql`update tasks set closed_at = now() - interval '91 minutes' where id = ${id}`;
    const after = await get(`/d/${link}`);
    expect(after.status).toBe(410);
    expect(await after.text()).toContain('All done');

    // And it is revoked on the way past, so the partial-unique index stays
    // honest and a fresh link can be minted for the same task later.
    const rows = await sql<Array<{ revoked_reason: string | null }>>`
      select revoked_reason from delegation_tokens where scope = 'task' and task_id = ${id}`;
    expect(rows.some((r) => r.revoked_reason === 'completed')).toBe(true);

    await sql`update tasks set status = 'active', closed_at = null where id = ${id}`;
  });

  it('reads the rule off the task, so an undo revives the link', async () => {
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');
    const link = await mint('Othman', { scope: 'task', task_id: id });
    await post(`/d/${link}/close`, { task_id: id });
    await post(`/d/${link}/undo`, { task_id: id });
    // Nothing had to be put back on the token: there is no longer a closed_at
    // to measure the ninety minutes from.
    expect((await get(`/d/${link}`)).status).toBe(200);
  });

  it('will not mint a link for work that is already finished', async () => {
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');
    await sql`update tasks set status = 'done', closed_at = now() where id = ${id}`;
    const res = await delegateLink(sql, { person: 'Othman', scope: 'task', task_id: id });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('already_finished');
    await sql`update tasks set status = 'active', closed_at = null where id = ${id}`;
  });

  it('a task link reaches exactly one task, over HTTP', async () => {
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');
    const link = await mint('Othman', { scope: 'task', task_id: id, rotate: true });
    const html = await (await get(`/d/${link}`)).text();
    expect(html).toContain('Purge the CDN cache');
    expect(html).not.toContain('Rewire the checkout redirect');

    const other = await taskIdByTitle(sql, 'Rewire the checkout redirect');
    const res = await post(`/d/${link}/close`, { task_id: other });
    expect(res.headers.get('location')).toContain('m=notyours');
    expect(await statusOf('Rewire the checkout redirect')).not.toBe('done');
  });
});

describe('the calendar', () => {
  it('serves a subscribable feed, and only to a calendar token', async () => {
    const feed = await mint('Othman', { scope: 'calendar' });
    const res = await get(`/c/${feed}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('Rewire the checkout redirect');

    // A feed URL lives forever in Google's servers. It must not be usable as a
    // page that can close anything.
    expect((await get(`/p/${feed}`)).status).toBe(404);
    expect((await post(`/p/${feed}/close`, { task_id: await taskIdByTitle(sql, 'Purge the CDN cache') })).status)
      .toBe(404);
  });

  it('refuses to serve a person token as a feed', async () => {
    expect((await get(`/c/${othman}.ics`)).status).toBe(404);
  });

  it('downloads one task as an attachment', async () => {
    const id = await taskIdByTitle(sql, 'Rewire the checkout redirect');
    const res = await get(`/p/${othman}/task/${id}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('rewire-the-checkout-redirect.ics');
    const body = await res.text();
    // The token must not travel into a calendar entry that syncs to Google.
    expect(body).not.toContain(othman);
    expect(body).not.toContain('URL:');
  });

  it('has no calendar entry for an undated task', async () => {
    const id = await taskIdByTitle(sql, 'Purge the CDN cache');
    expect((await get(`/p/${othman}/task/${id}.ics`)).status).toBe(404);
  });

  it('will not serve another person\'s task', async () => {
    const id = await taskIdByTitle(sql, 'Saar private thing');
    expect((await get(`/p/${othman}/task/${id}.ics`)).status).toBe(404);
  });
});

describe('what comes back to Tal', () => {
  it('lists unread comments and how long a block has been sitting', async () => {
    const res = await delegationInbox(sql, {});
    expect(res['unread_total']).toBeGreaterThan(0);
    const comments = res['unread_comments'] as Array<Record<string, unknown>>;
    expect(comments.some((c) => String(c['body']).includes('vendor has not answered'))).toBe(true);
    expect((res['blocked'] as unknown[]).length).toBeGreaterThan(0);
    expect(res.confidence.notes.join(' ')).toContain('does not reduce demand');
  });

  it('does NOT mark anything read just because it was listed', async () => {
    await delegationInbox(sql, {});
    const rows = await sql<Array<{ n: string }>>`
      select count(*)::text as n from task_comments
       where author_kind = 'delegate' and read_by_owner_at is null`;
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    // An agent that reads these and then loses the conversation would otherwise
    // have consumed the only notification Tal was ever going to get.
    const marked = await delegationInbox(sql, { mark_read: true });
    expect(marked['marked_read']).toBeGreaterThan(0);
    const after = await sql<Array<{ n: string }>>`
      select count(*)::text as n from task_comments
       where author_kind = 'delegate' and read_by_owner_at is null`;
    expect(Number(after[0]!.n)).toBe(0);
  });

  it('lets Tal answer in the thread the delegate is already reading', async () => {
    const id = await taskIdByTitle(sql, 'Rewire the checkout redirect');
    const res = await commentOnTask(sql, {
      task_id: id,
      body: 'I have escalated it — start on the caching work instead.',
      clear_flag: true,
      idempotency_key: 'reply-1',
    });
    expect(res.ok).toBe(true);
    expect(res['flag_cleared']).toBe(true);

    const html = await (await get(`/p/${othman}`)).text();
    expect(html).toContain('I have escalated it');
    expect(html).toContain('Tal');

    const again = await commentOnTask(sql, {
      task_id: id,
      body: 'different text entirely',
      idempotency_key: 'reply-1',
    });
    expect(again['replayed']).toBe(true);
  });

  it('warns when a comment is written where nobody will see it', async () => {
    const id = await taskIdByTitle(sql, 'Tal keeps this one');
    const res = await commentOnTask(sql, { task_id: id, body: 'note to self' });
    expect(res.confidence.notes.join(' ')).toContain('nobody is assigned');
  });
});

describe('a rotated link says so', () => {
  it('shows the grace-window banner rather than simply failing', async () => {
    const before = saar;
    await delegateLink(sql, { person: 'Saar', rotate: true, grace_hours: 72 });
    const res = await get(`/p/${before}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('newer link');
    const t = await resolveToken(sql, before);
    expect(t.ok).toBe(true);
  });
});
