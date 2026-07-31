import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Sql } from '../src/db.js';
import {
  handleUpdate,
  secretHeaderValid,
  telegramConfig,
  type TelegramConfig,
} from '../src/telegram.js';
import { freshDb, type TestDb } from './harness.js';

/**
 * The Telegram bridge.
 *
 * The security tests are the point of this file. A Telegram bot answers whoever
 * finds it, so the allow-list and the secret header are the only two things
 * standing between a stranger and Tal's inbox, and both are the kind of check
 * that is easy to weaken accidentally while changing something else.
 */

let db: TestDb;
let sql: Sql;

const ENV = { ...process.env };

const cfg: TelegramConfig = {
  botToken: 'test-token',
  webhookSecret: 'the-secret',
  allowedChatIds: new Set(['12345']),
};

beforeAll(async () => {
  db = await freshDb('telegram');
  sql = db.sql;
});

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

function message(chatId: string | number, fields: Record<string, unknown> = {}) {
  return { message: { message_id: 1, chat: { id: chatId }, ...fields } };
}

describe('configuration', () => {
  it('is unconfigured when anything is missing, naming what', () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    process.env['TELEGRAM_WEBHOOK_SECRET'] = 's';
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '1';
    const setup = telegramConfig();
    expect(setup.configured).toBe(false);
    if (!setup.configured) expect(setup.reason).toContain('TELEGRAM_BOT_TOKEN');
  });

  it('treats an empty allow-list as nobody, never everybody', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['TELEGRAM_WEBHOOK_SECRET'] = 's';
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '   , ,';
    const setup = telegramConfig();
    // The failure mode this guards against is a bot silently open to the world.
    expect(setup.configured).toBe(false);
    if (!setup.configured) expect(setup.reason).toContain('refusing to serve every chat');
  });

  it('parses a comma-separated list', () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 't';
    process.env['TELEGRAM_WEBHOOK_SECRET'] = 's';
    process.env['TELEGRAM_ALLOWED_CHAT_IDS'] = '111, 222 ,333';
    const setup = telegramConfig();
    expect(setup.configured).toBe(true);
    if (setup.configured) {
      expect([...setup.config.allowedChatIds].sort()).toEqual(['111', '222', '333']);
    }
  });
});

describe('the secret header', () => {
  it('rejects a missing, wrong, or nearly-right value', () => {
    expect(secretHeaderValid(undefined, 'the-secret')).toBe(false);
    expect(secretHeaderValid('', 'the-secret')).toBe(false);
    expect(secretHeaderValid('wrong', 'the-secret')).toBe(false);
    expect(secretHeaderValid('the-secre', 'the-secret')).toBe(false);
    expect(secretHeaderValid('the-secrets', 'the-secret')).toBe(false);
  });

  it('accepts the right one', () => {
    expect(secretHeaderValid('the-secret', 'the-secret')).toBe(true);
  });
});

describe('the chat allow-list', () => {
  it('ignores a chat that is not on it, and writes nothing', async () => {
    const before = await sql<Array<{ n: number }>>`select count(*)::int as n from tasks`;
    const out = await handleUpdate(sql, cfg, message('99999', { text: 'steal this' }));
    expect(out.handled).toBe(false);
    if (!out.handled) expect(out.reason).toContain('not on the allow-list');
    const after = await sql<Array<{ n: number }>>`select count(*)::int as n from tasks`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('does not leak the bot\'s existence back to a stranger', async () => {
    const out = await handleUpdate(sql, cfg, message('99999', { text: 'hello' }));
    // handled:false means the route sends nothing at all.
    expect(out.handled).toBe(false);
  });

  it('serves a chat that is on it', async () => {
    const out = await handleUpdate(sql, cfg, message('12345', { text: '/help' }));
    expect(out.handled).toBe(true);
  });
});

describe('capture', () => {
  it('puts plain text in the inbox verbatim', async () => {
    const out = await handleUpdate(
      sql,
      cfg,
      message('12345', { text: 'call the surveyor about the Bertram' }),
    );
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Captured');

    const rows = await sql<Array<{ title: string; status: string }>>`
      select title, status from tasks where title = 'call the surveyor about the Bertram'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('inbox');
  });

  it('does not interpret what it captures', async () => {
    await handleUpdate(sql, cfg, message('12345', { text: 'urgent yachtyhub launch by friday' }));
    const rows = await sql<Array<{ title: string; criticality: string; venture_id: string }>>`
      select t.title, t.criticality, v.slug as venture_id from tasks t
        join ventures v on v.id = t.venture_id
       where t.title = 'urgent yachtyhub launch by friday'`;
    // "urgent" must not become criticality, and "yachtyhub" must not become the
    // venture. Guessing here is how the inbox stops being trustworthy.
    expect(rows[0]!.criticality).toBe('supporting');
    expect(rows[0]!.venture_id).toBe('unsorted');
  });

  it('splits multiple lines into separate items', async () => {
    const out = await handleUpdate(sql, cfg, message('12345', { text: 'first thing\nsecond thing' }));
    if (out.handled) expect(out.reply).toContain('2 items');
    const rows = await sql`select id from tasks where title in ('first thing', 'second thing')`;
    expect(rows).toHaveLength(2);
  });

  it('answers an unknown command with help rather than capturing it', async () => {
    const out = await handleUpdate(sql, cfg, message('12345', { text: '/nonsense' }));
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('do not know that command');
    const rows = await sql`select id from tasks where title = '/nonsense'`;
    expect(rows).toHaveLength(0);
  });
});

describe('/week and /hours', () => {
  it('asks for the week rather than inventing one, the first time', async () => {
    const out = await handleUpdate(sql, cfg, message('12345', { text: '/week' }));
    // An assumed 40-hour week produces a confident answer to a question nobody
    // asked, so the only correct move with no number on record is to ask.
    if (out.handled) {
      expect(out.reply).toContain('How many hours');
      expect(out.reply).toContain('/hours 25');
    }
  });

  it('remembers a normal week so the number never has to be repeated', async () => {
    const set = await handleUpdate(sql, cfg, message('12345', { text: '/hours 30' }));
    if (set.handled) expect(set.reply).toContain('30 hours');

    const rows = await sql<Array<{ h: string }>>`
      select default_weekly_hours::text as h from settings limit 1`;
    expect(Number(rows[0]!.h)).toBe(30);

    const out = await handleUpdate(sql, cfg, message('12345', { text: '/week' }));
    if (out.handled) expect(out.reply).toContain('30h available');
  });

  it('rejects a nonsense week instead of storing it', async () => {
    const out = await handleUpdate(sql, cfg, message('12345', { text: '/hours 900' }));
    if (out.handled) expect(out.reply).toContain('How many hours');
    const rows = await sql<Array<{ h: string }>>`
      select default_weekly_hours::text as h from settings limit 1`;
    expect(Number(rows[0]!.h)).toBe(30);
  });

  it('says plainly that it cannot answer when no work is attached', async () => {
    const out = await handleUpdate(sql, cfg, message('12345', { text: '/week 25' }));
    expect(out.handled).toBe(true);
    if (out.handled) {
      // "Clear, 20h spare" against an empty system is true and misleading. The
      // reply has to say why it cannot answer instead.
      expect(out.reply).toContain('cannot tell you what will slip');
      expect(out.reply).toContain('no tasks are attached');
      expect(out.reply).not.toMatch(/to spare/);
    }
  });

  it('still accepts /capacity for anyone who learned that name', async () => {
    const out = await handleUpdate(sql, cfg, message('12345', { text: '/capacity 25' }));
    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('This week');
  });
});

describe('/next', () => {
  it('points at the inbox when nothing is active yet', async () => {
    const out = await handleUpdate(sql, cfg, message('12345', { text: '/next' }));
    expect(out.handled).toBe(true);
    if (out.handled) {
      expect(out.reply).toContain('inbox');
      expect(out.reply).toContain('process the inbox');
    }
  });
});

describe('files', () => {
  it('refuses a file Telegram will not serve, and says what to do instead', async () => {
    const out = await handleUpdate(
      sql,
      cfg,
      message('12345', {
        document: { file_id: 'f1', file_name: 'huge.pdf', file_size: 25 * 1024 * 1024 },
      }),
    );
    if (out.handled) {
      expect(out.reply).toContain('20MB');
      expect(out.reply).toContain('upload link');
    }
  });

  it('stores a document, using the caption as its title', async () => {
    process.env['SUPABASE_URL'] = 'https://example.supabase.co';
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'k';
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/getFile'))
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'docs/a.pdf' } }), {
          status: 200,
        });
      if (url.includes('/file/bot')) return new Response(Buffer.from('%PDF-1.4 fake'), { status: 200 });
      // Supabase storage upload.
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const out = await handleUpdate(
      sql,
      cfg,
      message('12345', {
        caption: 'Signed charter agreement',
        document: { file_id: 'f2', file_name: 'charter.pdf', mime_type: 'application/pdf' },
      }),
    );

    expect(out.handled).toBe(true);
    if (out.handled) expect(out.reply).toContain('Signed charter agreement');

    const rows = await sql<Array<{ title: string; source: string; status: string }>>`
      select title, source, status from documents where title = 'Signed charter agreement'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('stored');
  });

  it('falls back to the filename when there is no caption', async () => {
    process.env['SUPABASE_URL'] = 'https://example.supabase.co';
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'k';
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/getFile'))
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'docs/b.pdf' } }), {
          status: 200,
        });
      if (url.includes('/file/bot')) return new Response(Buffer.from('x'), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const out = await handleUpdate(
      sql,
      cfg,
      message('12345', { document: { file_id: 'f3', file_name: 'invoice-88.pdf' } }),
    );
    if (out.handled) expect(out.reply).toContain('invoice-88.pdf');
  });

  it('takes the largest size of a photo, not the thumbnail', async () => {
    process.env['SUPABASE_URL'] = 'https://example.supabase.co';
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'k';
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/getFile')) {
        asked.push(String(JSON.parse(String(init?.body ?? '{}')).file_id));
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'p/c.jpg' } }), {
          status: 200,
        });
      }
      if (url.includes('/file/bot')) return new Response(Buffer.from('jpegbytes'), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await handleUpdate(
      sql,
      cfg,
      message('12345', {
        caption: 'dock damage',
        photo: [
          { file_id: 'thumb', file_size: 500 },
          { file_id: 'full', file_size: 90_000 },
        ],
      }),
    );
    expect(asked).toEqual(['full']);
  });

  it('reports a storage failure instead of silently dropping the file', async () => {
    delete process.env['SUPABASE_URL'];
    delete process.env['NEXT_PUBLIC_SUPABASE_URL'];
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/getFile'))
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'p/d.jpg' } }), {
          status: 200,
        });
      return new Response(Buffer.from('x'), { status: 200 });
    });

    const out = await handleUpdate(
      sql,
      cfg,
      message('12345', { document: { file_id: 'f4', file_name: 'x.pdf' } }),
    );
    if (out.handled) expect(out.reply).toContain('could not store');
  });
});
