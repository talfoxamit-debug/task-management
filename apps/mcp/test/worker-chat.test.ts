import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dueNudges, pairPersonChat, redeemPairingCode, sendNudges, sendWorkToPerson } from '../src/worker-chat.js';
import { handleUpdate, telegramConfig } from '../src/telegram.js';
import { createPerson } from '../src/registry.js';
import { commitTasks } from '../src/tools.js';
import type { Sql } from '../src/db.js';
import { freshDb, taskIdByTitle, type TestDb } from './harness.js';

/**
 * Sending work to the people who do it.
 *
 * Two things carry real risk here and the tests are weighted to them.
 *
 * THE ALLOW-LIST EXCEPTION. The webhook refuses every chat but Tal's, and it has
 * to keep doing that — that list grants command access to the whole portfolio.
 * Pairing needs exactly one hole in it, so the assertions below are mostly about
 * how small that hole is: one command, a code that must exist unredeemed and
 * unexpired, single use, and no new command access afterwards.
 *
 * THE APPROVAL STEP. Tal's standing rule is that he sends. A tool that delivered
 * on assignment would quietly overturn a decision he made deliberately, so
 * sending is explicit and the message goes verbatim.
 */

let db: TestDb;
let sql: Sql;
const ENV = { ...process.env };
const sent: Array<{ chat: string; text: string }> = [];

beforeAll(async () => {
  db = await freshDb('workerchat');
  sql = db.sql;
  process.env['TASKOS_PUBLIC_URL'] = 'https://taskos.example';
  process.env['TELEGRAM_BOT_TOKEN'] = 'test-bot-token';
  process.env['TELEGRAM_WEBHOOK_SECRET'] = 'test-secret';
  process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '111';

  // Intercept the Telegram API rather than calling it.
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { chat_id?: string; text?: string };
    if (String(url).includes('sendMessage')) {
      sent.push({ chat: String(body.chat_id), text: String(body.text) });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  });

  await createPerson(sql, { name: 'Othman', hours_per_week: 40 });
  await createPerson(sql, { name: 'Saar', hours_per_week: 8 });

  const today = (
    await sql<Array<{ d: string }>>`
      select taskos_today((select id from workspaces limit 1))::text as d`
  )[0]!.d;
  const past = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  await commitTasks(sql, {
    tasks: [
      {
        title: 'Fix the booking redirect',
        venture: 'yachtyhub',
        assignee: 'Othman',
        estimate_minutes: 120,
        deadline_date: past,
      },
      {
        title: 'Blocked on the vendor',
        venture: 'yachtyhub',
        assignee: 'Othman',
        estimate_minutes: 60,
        deadline_date: past,
      },
      {
        title: 'Not due yet',
        venture: 'yachtyhub',
        assignee: 'Othman',
        estimate_minutes: 30,
      },
    ],
    idempotency_key: 'worker-seed',
  });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  process.env = ENV;
  await db.drop();
});

describe('pairing', () => {
  let code: string;

  it('hands out a readable single-use code', async () => {
    const res = await pairPersonChat(sql, { person: 'Othman' });
    expect(res.ok).toBe(true);
    code = String(res['code']);
    // 0/O and 1/I cost more in failed pairings than the entropy they add.
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(res.confidence.notes.join(' ')).toContain('cannot command the bot');
  });

  it('refuses an unknown person, naming who exists', async () => {
    const res = await pairPersonChat(sql, { person: 'Nobody' });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.message).toContain('Othman');
  });

  it('binds the chat when the code is redeemed from it', async () => {
    const setup = telegramConfig();
    if (!setup.configured) throw new Error('telegram should be configured in this test');

    // Chat 999 is NOT on the allow-list. This is the one command it may run.
    const out = await handleUpdate(sql, setup.config, {
      message: { chat: { id: 999, title: 'Tal + Othman' }, text: `/taskos ${code}` },
    });
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Paired');

    const rows = await sql<Array<{ chat: string; title: string }>>`
      select telegram_chat_id as chat, telegram_chat_title as title
        from people where name = 'Othman'`;
    expect(rows[0]!.chat).toBe('999');
    expect(rows[0]!.title).toBe('Tal + Othman');
  });

  it('will not redeem the same code twice', async () => {
    const res = await redeemPairingCode(sql, code, '888', 'Somewhere else');
    expect(res.ok).toBe(false);
    // A code that still works after redemption can bind a second, unintended
    // chat to the same person.
    const rows = await sql<Array<{ chat: string }>>`
      select telegram_chat_id as chat from people where name = 'Othman'`;
    expect(rows[0]!.chat).toBe('999');
  });

  it('refuses an expired code', async () => {
    const fresh = String((await pairPersonChat(sql, { person: 'Saar' }))['code']);
    await sql`update chat_pairing_codes set expires_at = now() - interval '1 minute'
               where code = ${fresh}`;
    const res = await redeemPairingCode(sql, fresh, '777', null);
    expect(res.ok).toBe(false);
  });

  it('tells an unknown chat nothing about whether a code ever existed', async () => {
    const res = await redeemPairingCode(sql, 'ZZZZ-ZZZZ', '777', null);
    expect(res.ok).toBe(false);
    expect(res.reply).toBe('That code is not valid. Ask Tal for a new one.');
  });

  it('GRANTS NO COMMAND ACCESS: the paired chat is still refused everything else', async () => {
    const setup = telegramConfig();
    if (!setup.configured) throw new Error('configured');
    for (const text of ['/week 20', '/next', '/ideas', 'capture this please']) {
      const out = await handleUpdate(sql, setup.config, {
        message: { chat: { id: 999 }, text },
      });
      // Pairing buys outbound delivery and nothing more. The allow-list is what
      // stands between a chat and the whole portfolio.
      expect(out.handled).toBe(false);
    }
  });
});

describe('sending, only when asked', () => {
  it('delivers the approved text verbatim, with a link', async () => {
    sent.length = 0;
    const res = await sendWorkToPerson(sql, {
      person: 'Othman',
      message: 'Two things for this week — the redirect first.',
    });
    expect(res.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chat).toBe('999');
    // Verbatim: a tool that rewrote the text would make Tal's approval
    // meaningless, because he approved something else.
    expect(sent[0]!.text).toContain('Two things for this week — the redirect first.');
    expect(sent[0]!.text).toContain('https://taskos.example/p/');
  });

  it('refuses to send to somebody with no chat on record', async () => {
    const res = await sendWorkToPerson(sql, { person: 'Saar', message: 'hello' });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('not_paired');
    expect(res.errors?.[0]?.message).toContain('pair_person_chat');
  });

  it('refuses to send nothing at all', async () => {
    const res = await sendWorkToPerson(sql, { person: 'Othman', include_link: false });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('empty');
  });
});

describe('chasing, without nagging', () => {
  let today: string;

  beforeAll(async () => {
    today = (
      await sql<Array<{ d: string }>>`
        select taskos_today((select id from workspaces limit 1))::text as d`
    )[0]!.d;
    await sql`update tasks set needs_attention_at = now() - interval '5 days'
               where title = 'Blocked on the vendor'`;
  });

  it('chases what is overdue', async () => {
    const nudges = await dueNudges(sql, today);
    expect(nudges.map((n) => n.title)).toContain('Fix the booking redirect');
    expect(nudges[0]!.reason).toContain('overdue');
  });

  it('does NOT chase somebody who has already said they are stuck', async () => {
    const nudges = await dueNudges(sql, today);
    // They do not need reminding that they are stuck. The person who has not
    // answered them does, and that is the brief's job.
    expect(nudges.map((n) => n.title)).not.toContain('Blocked on the vendor');
  });

  it('does not chase work that is not late', async () => {
    const nudges = await dueNudges(sql, today);
    expect(nudges.map((n) => n.title)).not.toContain('Not due yet');
  });

  it('sends at most one nudge per task per day', async () => {
    sent.length = 0;
    const first = await sendNudges(sql, today);
    expect(first).toBeGreaterThan(0);
    expect(sent).toHaveLength(first);

    // A chaser that fires on every cron run gets muted in two days, and a muted
    // channel takes the useful messages with it.
    sent.length = 0;
    const second = await sendNudges(sql, today);
    expect(second).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('never chases somebody with no chat on record', async () => {
    const id = await taskIdByTitle(sql, 'Not due yet');
    await sql`update tasks set assignee_person_id = (select id from people where name = 'Saar'),
                deadline_date = ${today}::date - 2 where id = ${id}`;
    const nudges = await dueNudges(sql, today);
    expect(nudges.map((n) => n.person)).not.toContain('Saar');
  });
});
