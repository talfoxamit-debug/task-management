import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import entrypoint from '../src/server.js';
import {
  delegateLink,
  listDelegationLinks,
  ownerLink,
  resolveToken,
  revokeDelegation,
} from '../src/delegation.js';
import { setWorkHours } from '../src/day-plan.js';
import { setDayAllocation } from '../src/next-actions.js';
import { markPrepared } from '../src/edit.js';
import { createPerson } from '../src/registry.js';
import { commitTasks, setMilestone } from '../src/tools.js';
import type { Sql } from '../src/db.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * Tal's own page.
 *
 * This is the widest credential in the system — a delegate link reaches one
 * person's assigned work, this reaches the portfolio — so the tests are mostly
 * about the boundaries that make that acceptable rather than about layout.
 *
 * The two that matter most: an owner token must not be usable at a delegate
 * path and vice versa, and the page must be able to do exactly two things. If a
 * stolen link could kill or edit, the trade would not be worth making.
 */

let db: TestDb;
let sql: Sql;
let httpServer: Server;
let origin: string;
let me: string;
let othman: string;

async function get(path: string) {
  return fetch(`${origin}${path}`, { redirect: 'manual' });
}
async function post(path: string, form: Record<string, string>) {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}
async function statusOf(title: string): Promise<string> {
  const rows = await sql<Array<{ status: string }>>`select status from tasks where title = ${title}`;
  return rows[0]!.status;
}

beforeAll(async () => {
  db = await freshDb('ownerpage');
  sql = db.sql;
  process.env['DATABASE_URL'] = db.url;
  process.env['TASKOS_PUBLIC_URL'] = 'https://taskos.example';
  delete process.env['TELEGRAM_BOT_TOKEN'];

  await sql`update settings set default_weekly_hours = 28, buffer_ratio = 0.2`;
  const today = (
    await sql<Array<{ d: string }>>`
      select taskos_today((select id from workspaces limit 1))::text as d`
  )[0]!.d;
  const dow = (
    await sql<Array<{ d: number }>>`select extract(dow from ${today}::date)::int as d`
  )[0]!.d;
  await setDayAllocation(sql, { days: [{ day_of_week: dow, venture: 'seatop', flex_minutes: 90 }] });
  await setWorkHours(sql, { start_hour: 9, end_hour: 18 });
  await createPerson(sql, { name: 'Othman', hours_per_week: 40 });

  const past = new Date(Date.parse(`${today}T00:00:00Z`) - 5 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  await commitTasks(sql, {
    tasks: [
      {
        title: 'Confirm PE licensing structure',
        venture: 'seatop',
        estimate_minutes: 45,
        value: 9,
        criticality: 'blocking',
        deadline_date: past,
      },
      { title: 'Draft the pricing page', venture: 'seatop', estimate_minutes: 90, value: 6 },
      { title: 'A <script>alert(1)</script> title', venture: 'seatop', estimate_minutes: 20 },
      {
        title: 'Fix the booking redirect',
        venture: 'yachtyhub',
        assignee: 'Othman',
        estimate_minutes: 120,
      },
    ],
    idempotency_key: 'owner-seed',
  });

  await markPrepared(sql, {
    task_id: await taskIdByTitle(sql, 'Draft the pricing page'),
    summary: 'Three tiers drafted',
    review_minutes: 15,
  });
  await sql`update tasks set needs_attention_at = now() - interval '4 days'
             where title = 'Fix the booking redirect'`;
  await setMilestone(sql, {
    venture: 'seatop',
    name: 'Lisa signs',
    due_date: today,
    hardness: 'hard',
    cost_of_slip: 'critical: the deal moves a quarter',
  });

  httpServer = createServer((req, res) => {
    void entrypoint(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  me = String((await ownerLink(sql, {}))['link']).split('/').pop()!;
  othman = String((await delegateLink(sql, { person: 'Othman' }))['link']).split('/').pop()!;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  await db?.drop();
});

describe('minting', () => {
  it('returns the secret once and stores only its hash', async () => {
    const rows = await sql<Array<{ token_hash: string; person_id: string | null }>>`
      select token_hash, person_id from delegation_tokens where scope = 'owner'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // The owner is not a row in `people` — that table is who work goes TO.
    expect(rows[0]!.person_id).toBeNull();
  });

  it('says plainly what it is handing over', async () => {
    const again = await ownerLink(sql, {});
    expect(again['already_live']).toBe(true);
    const fresh = await ownerLink(sql, { rotate: true, grace_hours: 1 });
    expect(fresh.confidence.notes.join(' ')).toContain('WIDEST CREDENTIAL');
    expect(fresh.confidence.notes.join(' ')).toContain('cannot kill, delete or edit');
    // The old one keeps working through its grace window.
    expect((await resolveToken(sql, me)).ok).toBe(true);
    me = String(fresh['link']).split('/').pop()!;
  });
});

describe('the page', () => {
  it('leads with what is already late', async () => {
    const res = await get(`/me/${me}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Overdue');
    expect(html).toContain('Confirm PE licensing structure');
    expect(html.indexOf('Overdue')).toBeLessThan(html.indexOf('Today, in order'));
  });

  it('shows the day in clock times', async () => {
    const html = await (await get(`/me/${me}`)).text();
    expect(html).toContain('Today, in order');
    expect(html).toMatch(/\d\d:\d\d–\d\d:\d\d/);
  });

  it('shows drafted work and says it is not sent', async () => {
    const html = await (await get(`/me/${me}`)).text();
    expect(html).toContain('Drafted, waiting on you');
    expect(html).toContain('Three tiers drafted');
    expect(html).toContain('None of these are sent');
  });

  it('shows who is blocked and for how long', async () => {
    const html = await (await get(`/me/${me}`)).text();
    expect(html).toContain('Othman blocked 4d');
  });

  it('keeps somebody else\'s work out of Tal\'s own lists', async () => {
    const html = await (await get(`/me/${me}`)).text();
    const mine = html.slice(0, html.indexOf('Delegated'));
    expect(mine).not.toContain('Fix the booking redirect');
  });

  it('escapes every interpolation', async () => {
    const html = await (await get(`/me/${me}`)).text();
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('carries the headers that keep the token out of other logs', async () => {
    const res = await get(`/me/${me}`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });
});

describe('what the page may change', () => {
  it('closes and undoes, through a 303', async () => {
    const id = await taskIdByTitle(sql, 'Confirm PE licensing structure');
    const closed = await post(`/me/${me}/close`, { task_id: id });
    expect(closed.status).toBe(303);
    expect(closed.headers.get('location')).toBe(`/me/${me}?m=done`);
    expect(await statusOf('Confirm PE licensing structure')).toBe('done');

    const html = await (await get(`/me/${me}`)).text();
    expect(html).toContain('Just done');

    const undone = await post(`/me/${me}/undo`, { task_id: id });
    expect(undone.headers.get('location')).toBe(`/me/${me}?m=undone`);
    expect(await statusOf('Confirm PE licensing structure')).toBe('active');
  });

  it('records the close as INFERRED, never as a measurement', async () => {
    const id = await taskIdByTitle(sql, 'Confirm PE licensing structure');
    await post(`/me/${me}/close`, { task_id: id });
    const rows = await sql<Array<{ actual_inferred: boolean; by: string | null }>>`
      select actual_inferred, actual_by_person_id as by from tasks where id = ${id}`;
    // A number typed into a box because a box was there is a guess that becomes
    // indistinguishable from a measurement the moment it is saved, so the page
    // has no such box (D6).
    expect(rows[0]!.actual_inferred).toBe(true);
    expect(rows[0]!.by).toBeNull();
    await post(`/me/${me}/undo`, { task_id: id });
  });

  it('has NO route that kills, deletes or edits', async () => {
    for (const verb of ['kill', 'delete', 'edit', 'update', 'assign']) {
      const res = await post(`/me/${me}/${verb}`, { task_id: 'x' });
      // The token reaches everything; the surface it can change is two verbs.
      expect(res.status).toBe(404);
    }
  });

  it('refuses GET on the mutating paths', async () => {
    const id = await taskIdByTitle(sql, 'Draft the pricing page');
    const res = await get(`/me/${me}/close?task_id=${id}`);
    expect(res.status).toBe(405);
    expect(await statusOf('Draft the pricing page')).not.toBe('done');
  });
});

describe('the scopes cannot be swapped', () => {
  it('will not serve the owner page to a delegate token', async () => {
    expect((await get(`/me/${othman}`)).status).toBe(404);
  });

  it('will not serve a delegate page to the owner token', async () => {
    expect((await get(`/p/${me}`)).status).toBe(404);
    expect((await get(`/d/${me}`)).status).toBe(404);
    expect((await get(`/c/${me}.ics`)).status).toBe(404);
  });

  it('dies the moment it is revoked', async () => {
    await sql`update delegation_tokens set revoked_at = now() where scope = 'owner'`;
    const res = await get(`/me/${me}`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('Link closed');
  });

  it('IS LISTABLE — an owner link that nothing can see is one nothing can revoke', async () => {
    const fresh = await ownerLink(sql, { rotate: true });
    expect(fresh['link']).toBeTruthy();
    const listed = await listDelegationLinks(sql, {});
    const rows = listed['links'] as Array<Record<string, unknown>>;
    expect(rows.some((r) => r['scope'] === 'owner')).toBe(true);
  });

  it('can be revoked by the ordinary tool', async () => {
    const minted = await ownerLink(sql, { rotate: true });
    const fresh = String(minted['link']).split('/').pop()!;
    expect((await get(`/me/${fresh}`)).status).toBe(200);

    // By ITS OWN prefix. Rotation leaves the superseded row unrevoked during
    // its grace window, so "the first unrevoked owner row" is not necessarily
    // the one just minted.
    const res = await revokeDelegation(sql, {
      token_prefix: String(minted['token_prefix']),
      reason: 'test',
    });
    expect(res['revoked']).toBe(1);
    // Before the join was removed this returned 0: an owner token has no
    // person, so joining people dropped the one link that reaches everything.
    expect((await get(`/me/${fresh}`)).status).toBe(410);
  });
});
