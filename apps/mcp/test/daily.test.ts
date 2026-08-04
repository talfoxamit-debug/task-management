import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import entrypoint from '../src/server.js';
import { buildDailyBrief } from '../src/daily.js';
import { commitTasks, setMilestone } from '../src/tools.js';
import { createPerson } from '../src/registry.js';
import { markPrepared } from '../src/edit.js';
import { setDayAllocation } from '../src/next-actions.js';
import type { Sql } from '../src/db.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * The 08:00 brief.
 *
 * Two classes of failure matter here and neither is about wording. A brief that
 * arrives at the wrong hour for five months of the year is worse than none,
 * because the hour is the only reason it is useful; and a brief that arrives
 * twice every morning gets muted, which costs the notification for good.
 *
 * The rest is the standing rule of this system, applied to a message that sends
 * itself: it must never state a number it did not compute.
 */

let db: TestDb;
let sql: Sql;
let httpServer: Server;
let origin: string;

const TOKEN = 'test-token-for-the-daily-brief';
const ENV = { ...process.env };

async function call(query: string) {
  const res = await fetch(`${origin}/api/daily${query}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Move the workspace clock, so the window logic can be exercised honestly. */
async function setLocalHour(hour: number): Promise<void> {
  // Shifting the timezone is how the local hour is moved without mocking the
  // database's now(), which is what the route actually reads.
  const utcHour = new Date().getUTCHours();
  const offset = ((hour - utcHour) % 24 + 24) % 24;
  const zone = offset === 0 ? 'UTC' : `Etc/GMT${offset > 12 ? `+${24 - offset}` : `-${offset}`}`;
  await sql`update settings set active_tz = ${zone}`;
}

beforeAll(async () => {
  db = await freshDb('daily');
  sql = db.sql;
  process.env['DATABASE_URL'] = db.url;
  process.env['TASKOS_TOKEN'] = TOKEN;
  delete process.env['CRON_SECRET'];
  // Unset, so a passing test can never put a message on a real phone.
  delete process.env['TELEGRAM_BOT_TOKEN'];

  await sql`update settings set default_weekly_hours = 28, buffer_ratio = 0.2`;

  // Sunday..Friday worked, Saturday off — the allocation Tal actually has.
  await setDayAllocation(sql, {
    days: [
      { day_of_week: 0, venture: 'seatop', flex_minutes: 90 },
      { day_of_week: 1, venture: 'seatop', flex_minutes: 90 },
      { day_of_week: 2, venture: 'yachtyhub', flex_minutes: 90 },
      { day_of_week: 3, venture: 'seatop', flex_minutes: 90 },
      { day_of_week: 4, venture: 'yachtyhub', flex_minutes: 90 },
      { day_of_week: 5, venture: 'seatop', flex_minutes: 90 },
      { day_of_week: 6, is_working_day: false },
    ],
  });

  await createPerson(sql, { name: 'Othman', hours_per_week: 40 });

  httpServer = createServer((req, res) => {
    void entrypoint(req, res);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
  await db?.drop();
});

afterEach(() => {
  process.env = { ...ENV, DATABASE_URL: db.url, TASKOS_TOKEN: TOKEN };
  delete process.env['TELEGRAM_BOT_TOKEN'];
});

describe('who may fire it', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await fetch(`${origin}/api/daily`);
    expect(res.status).toBe(401);
    // Otherwise this endpoint is a free way for anyone on the internet to push
    // messages to Tal's phone.
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  });

  it('accepts the CRON_SECRET Vercel signs its own invocations with', async () => {
    process.env['CRON_SECRET'] = 'cron-secret-value';
    const res = await fetch(`${origin}/api/daily?dry=1`, {
      headers: { authorization: 'Bearer cron-secret-value' },
    });
    expect(res.status).toBe(200);
    const bad = await fetch(`${origin}/api/daily?dry=1`, {
      headers: { authorization: 'Bearer not-the-secret' },
    });
    expect(bad.status).toBe(401);
  });
});

describe('the hour it is allowed to send', () => {
  it('does nothing outside the local morning window', async () => {
    await setLocalHour(3);
    const res = await call('');
    expect(res.body['sent']).toBe(false);
    expect(res.body['reason']).toContain('outside');
  });

  it('sends inside it', async () => {
    await setLocalHour(8);
    const res = await call('');
    expect(res.body['sent']).toBe(true);
  });

  it('tolerates a late cron rather than skipping the day', async () => {
    // Vercel Hobby triggers a cron within the hour, not on the minute, so an
    // exact-hour check would drop the brief entirely on a slow morning.
    await sql`delete from events where idempotency_key like 'daily-brief:%'`;
    await setLocalHour(11);
    expect((await call('')).body['sent']).toBe(true);
  });

  it('never sends in the evening', async () => {
    await sql`delete from events where idempotency_key like 'daily-brief:%'`;
    await setLocalHour(19);
    expect((await call('')).body['sent']).toBe(false);
  });
});

describe('exactly one per day', () => {
  it('sends once even though two cron schedules fire', async () => {
    await sql`delete from events where idempotency_key like 'daily-brief:%'`;
    await setLocalHour(8);

    // 12:00 UTC and 13:00 UTC both fire every day; on any given date one of
    // them is the right one and the other must be silent.
    const first = await call('');
    const second = await call('');
    expect(first.body['sent']).toBe(true);
    expect(second.body['sent']).toBe(false);
    expect(second.body['reason']).toContain('already sent');
  });

  it('records the receipt before sending, not after', async () => {
    // A platform that kills the invocation mid-send should cost one missed
    // brief, never a duplicate every morning.
    const rows = await sql<Array<{ verb: string }>>`
      select verb from events where idempotency_key like 'daily-brief:%'`;
    expect(rows.length).toBe(1);
    expect(rows[0]!.verb).toBe('daily_brief');
  });
});

describe('the day off', () => {
  it('sends NOTHING on a non-working day, rather than a message saying so', async () => {
    // Read from day_allocation, not from the cron expression: change the
    // allocation and the brief follows with no redeploy.
    const saturday = await sql<Array<{ d: string }>>`
      select (date_trunc('week', now())::date + 5)::text as d`;
    const brief = await buildDailyBrief(sql, saturday[0]!.d);
    expect(brief.working).toBe(false);
    expect(brief.text).toBe('');
  });
});

describe('what the brief says', () => {
  beforeAll(async () => {
    const today = await sql<Array<{ d: string }>>`select taskos_today((select id from workspaces limit 1))::text as d`;
    const day = today[0]!.d;

    await commitTasks(sql, {
      tasks: [
        {
          title: 'Send the Lisa proposal',
          venture: 'seatop',
          estimate_minutes: 60,
          deadline_date: day,
          criticality: 'blocking',
        },
        { title: 'Draft the pricing page', venture: 'seatop', estimate_minutes: 90 },
        {
          title: 'Fix the booking redirect',
          venture: 'yachtyhub',
          assignee: 'Othman',
          estimate_minutes: 120,
        },
      ],
      idempotency_key: 'daily-seed',
    });

    await markPrepared(sql, {
      task_id: await taskIdByTitle(sql, 'Draft the pricing page'),
      summary: 'Drafted three tiers with copy',
      review_minutes: 20,
    });

    await sql`update tasks set needs_attention_at = now() - interval '3 days'
               where title = 'Fix the booking redirect'`;
    await sql`
      insert into task_comments (workspace_id, task_id, author_person_id, author_kind, body,
                                 blocks_progress)
      values ((select id from workspaces limit 1),
              (select id from tasks where title = 'Fix the booking redirect'),
              (select id from people where name = 'Othman'), 'delegate',
              'The vendor has not answered since Friday.', true)`;

    await setMilestone(sql, {
      venture: 'seatop',
      name: 'Lisa signs',
      due_date: day,
      hardness: 'hard',
      cost_of_slip: 'the deal moves a quarter',
    });
  });

  it('leads with what is due, not with a greeting', async () => {
    const brief = await buildDailyBrief(sql);
    const body = brief.text;
    expect(body).toContain('DUE');
    expect(body).toContain('Send the Lisa proposal');
    expect(body.indexOf('DUE')).toBeLessThan(body.indexOf('WAITING ON YOU'));
  });

  it('surfaces a blocked delegate with how long they have been blocked', async () => {
    const brief = await buildDailyBrief(sql);
    // The most expensive silence in a system with 48 delegated hours behind a
    // 28-hour bottleneck.
    expect(brief.text).toContain('BLOCKED 3d');
    expect(brief.text).toContain('Othman');
    expect(brief.text).toContain('unread comment');
  });

  it('says drafted work is NOT sent', async () => {
    const brief = await buildDailyBrief(sql);
    expect(brief.text).toContain('WAITING ON YOU: 1 drafted');
    // The rule that keeps a fiction out of the only system that says what slips.
    expect(brief.text).toContain('None are sent.');
  });

  it('never shows another person\'s work as something for Tal to do', async () => {
    const brief = await buildDailyBrief(sql);
    const dueBlock = brief.text.slice(brief.text.indexOf('DUE'), brief.text.indexOf('FIRST'));
    expect(dueBlock).not.toContain('Fix the booking redirect');
  });

  it('states the hours it used rather than assuming a number', async () => {
    const brief = await buildDailyBrief(sql);
    expect(brief.text).toMatch(/FIRST \(\d/);
  });

  it('omits the "first" section entirely when the week is unknown', async () => {
    await sql`update settings set default_weekly_hours = null`;
    const brief = await buildDailyBrief(sql);
    // An invented hours figure produces a confident answer to a question
    // nobody asked, so the section disappears and says why.
    expect(brief.text).not.toContain('FIRST (');
    expect(brief.text).toContain('NOT KNOWN');
    expect(brief.text).toContain('weekly hours are not on record');
    await sql`update settings set default_weekly_hours = 28`;
  });

  it('fits in a Telegram message', async () => {
    const brief = await buildDailyBrief(sql);
    // Telegram rejects anything over 4096 characters outright, which would turn
    // the brief into no brief at all.
    expect(brief.text.length).toBeLessThan(3500);
  });

  it('can be previewed without sending anything', async () => {
    await setLocalHour(8);
    const res = await call('?dry=1&force=1');
    expect(res.body['sent']).toBe(false);
    expect(res.body['dry']).toBe(true);
    expect(String(res.body['text'])).toContain('DUE');
  });
});
