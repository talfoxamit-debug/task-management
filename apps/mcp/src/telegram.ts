import { timingSafeEqual } from 'node:crypto';
import { resolveWorkspaceId, type Sql } from './db.js';
import { attachDocument } from './documents.js';
import { capture } from './tools.js';
import { MAX_INLINE_BYTES } from './storage.js';

/**
 * The Telegram bridge: capture from your phone, in a sentence or a photo.
 *
 * This is an INGEST path, not a second interface to TaskOS. It does three
 * things — capture text to the inbox, store a file against the work, and answer
 * "what's going to slip" — and deliberately nothing else. Anything requiring
 * judgement (which venture, what estimate, what depends on what) stays in the
 * Claude conversation, because that is where judgement is available. A bot that
 * tried to parse "urgent yachtyhub thing by friday" would be guessing, and D-day
 * one of this system is that it does not guess.
 *
 * SECURITY, and this is the part that matters. A Telegram bot answers whoever
 * finds it. Two independent gates stand in front of every update:
 *
 *   1. the secret header Telegram echoes back, which proves the request came
 *      from Telegram and not from someone who guessed the webhook URL
 *   2. an explicit allow-list of chat ids, which proves the sender is you
 *
 * Either one failing drops the update. Both are required, because the first
 * alone would let any Telegram user talk to the bot, and the second alone would
 * let anyone who learned a chat id forge an update.
 */

const TELEGRAM_API = 'https://api.telegram.org';

/** Telegram refuses to serve bot downloads above this. */
const MAX_TELEGRAM_FILE_BYTES = 20 * 1024 * 1024;

export interface TelegramConfig {
  botToken: string;
  webhookSecret: string;
  allowedChatIds: Set<string>;
}

export type TelegramSetup =
  | { configured: true; config: TelegramConfig }
  | { configured: false; reason: string };

export function telegramConfig(): TelegramSetup {
  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  const webhookSecret = process.env['TELEGRAM_WEBHOOK_SECRET'];
  const allowed = process.env['TELEGRAM_ALLOWED_CHAT_IDS'];

  const missing: string[] = [];
  if (!botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!webhookSecret) missing.push('TELEGRAM_WEBHOOK_SECRET');
  if (!allowed) missing.push('TELEGRAM_ALLOWED_CHAT_IDS');
  if (!botToken || !webhookSecret || !allowed) {
    return { configured: false, reason: `telegram is not configured: ${missing.join(', ')} unset` };
  }

  const ids = new Set(
    allowed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  if (ids.size === 0) {
    // An empty allow-list must mean "nobody", never "everybody". This is the
    // one configuration mistake that would silently open the bot to the world.
    return {
      configured: false,
      reason: 'TELEGRAM_ALLOWED_CHAT_IDS is set but empty: refusing to serve every chat',
    };
  }

  return { configured: true, config: { botToken, webhookSecret, allowedChatIds: ids } };
}

function constantTimeEquals(presented: string, secret: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function secretHeaderValid(header: string | undefined | null, secret: string): boolean {
  if (!header) return false;
  return constantTimeEquals(header, secret);
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function api<T>(cfg: TelegramConfig, method: string, body: unknown): Promise<T> {
  const res = await fetch(`${TELEGRAM_API}/bot${cfg.botToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result as T;
}

export async function sendMessage(cfg: TelegramConfig, chatId: string, text: string): Promise<void> {
  // Telegram rejects messages over 4096 characters outright, which would turn a
  // long answer into no answer at all.
  const trimmed = text.length > 4000 ? `${text.slice(0, 3990)}\n…(truncated)` : text;
  await api(cfg, 'sendMessage', { chat_id: chatId, text: trimmed });
}

async function downloadFile(
  cfg: TelegramConfig,
  fileId: string,
): Promise<{ bytes: Buffer; path: string }> {
  const file = await api<{ file_path?: string; file_size?: number }>(cfg, 'getFile', {
    file_id: fileId,
  });
  if (!file.file_path) throw new Error('telegram returned no file_path');
  const res = await fetch(`${TELEGRAM_API}/file/bot${cfg.botToken}/${file.file_path}`);
  if (!res.ok) throw new Error(`downloading from telegram failed: ${res.status}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), path: file.file_path };
}

// ---------------------------------------------------------------------------
// Update shape — only the fields this bridge reads
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat?: { id?: number | string };
    text?: string;
    caption?: string;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    photo?: Array<{ file_id: string; file_size?: number; width?: number }>;
  };
}

export type TelegramOutcome =
  | { handled: false; reason: string }
  | { handled: true; chatId: string; reply: string };

/**
 * Decide what an update means and do it.
 *
 * Returns rather than throws for every expected condition, because Telegram
 * retries any webhook that does not answer 200 — so an exception here becomes a
 * message delivered repeatedly, and a captured note stored several times over.
 * The route answers 200 to everything and reports problems in the reply.
 */
export async function handleUpdate(
  sql: Sql,
  cfg: TelegramConfig,
  update: TelegramUpdate,
): Promise<TelegramOutcome> {
  const message = update.message;
  if (!message) return { handled: false, reason: 'no message in update' };

  const chatId = String(message.chat?.id ?? '');
  if (!chatId) return { handled: false, reason: 'no chat id' };

  // Gate two. Silence, not an error message: telling an unknown sender that the
  // bot exists and rejected them is more than they need to know.
  if (!cfg.allowedChatIds.has(chatId)) {
    return { handled: false, reason: `chat ${chatId} is not on the allow-list` };
  }

  const text = (message.text ?? '').trim();

  if (text.startsWith('/start') || text.startsWith('/help')) {
    return { handled: true, chatId, reply: HELP };
  }

  if (text.startsWith('/hours')) {
    return { handled: true, chatId, reply: await setHoursReply(sql, text) };
  }

  if (text.startsWith('/week') || text.startsWith('/capacity')) {
    return { handled: true, chatId, reply: await weekReply(sql, text) };
  }

  if (text.startsWith('/next')) {
    return { handled: true, chatId, reply: await nextReply(sql) };
  }

  if (text.startsWith('/ideas')) {
    return { handled: true, chatId, reply: await ideasReply(sql) };
  }

  // A document or photo, with its caption as the title.
  const file = message.document
    ? {
        fileId: message.document.file_id,
        name: message.document.file_name ?? 'document',
        mime: message.document.mime_type,
        size: message.document.file_size,
      }
    : message.photo && message.photo.length > 0
      ? (() => {
          // Telegram sends several sizes; the last is the largest.
          const largest = message.photo[message.photo.length - 1]!;
          return {
            fileId: largest.file_id,
            name: `photo-${message.message_id ?? 'x'}.jpg`,
            mime: 'image/jpeg',
            size: largest.file_size,
          };
        })()
      : null;

  if (file) {
    return { handled: true, chatId, reply: await storeFile(sql, cfg, file, message.caption) };
  }

  if (text.length === 0) {
    return {
      handled: true,
      chatId,
      reply: 'I can take text, a photo or a file. Send /help to see what I do.',
    };
  }

  if (text.startsWith('/')) {
    return { handled: true, chatId, reply: `I do not know that command.\n\n${HELP}` };
  }

  // Anything else is a capture. Verbatim, unparsed — the same contract the
  // capture() tool has, for the same reason.
  const res = await capture(sql, { text });
  const created = (res['created'] as Array<{ title: string }> | undefined) ?? [];
  if (created.length === 0) return { handled: true, chatId, reply: 'Nothing to capture.' };
  return {
    handled: true,
    chatId,
    reply:
      created.length === 1
        ? `Captured: ${created[0]!.title}\n\nIt is in the inbox, unsorted. Tell Claude to process the inbox when you want it filed.`
        : `Captured ${created.length} items to the inbox, unsorted.`,
  };
}

const HELP = [
  'TaskOS — what is going to slip.',
  '',
  'Send me anything and it goes to your inbox, word for word. No guessing at',
  'ventures or deadlines; that happens later, with Claude.',
  '',
  'Send a photo or file and I store it. The caption becomes its title.',
  '',
  '/ideas — what the AI says is missing from this system',
  '/next — what to work on now',
  '/week — what slips this week',
  '/hours 25 — set your normal working week',
  '/help — this',
].join('\n');

/** The remembered working week, or null if never stated. */
async function defaultHours(sql: Sql, workspaceId: string): Promise<number | null> {
  const rows = await sql<Array<{ h: string | null }>>`
    select default_weekly_hours::text as h from settings where workspace_id = ${workspaceId}`;
  const raw = rows[0]?.h;
  return raw === null || raw === undefined ? null : Number(raw);
}

async function setHoursReply(sql: Sql, text: string): Promise<string> {
  const arg = text.replace(/^\/hours(@\S+)?/, '').trim();
  const hours = arg.length === 0 ? NaN : Number(arg);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    return 'How many hours do you normally have for work in a week?\n\nSend: /hours 25';
  }
  const workspaceId = await resolveWorkspaceId(sql);
  await sql`update settings set default_weekly_hours = ${hours} where workspace_id = ${workspaceId}`;
  return `Set. A normal week for you is ${hours} hours.\n\n/week now uses that, so you do not have to say it every time.`;
}

/**
 * "What slips this week", in words rather than in figures.
 *
 * The earlier version reported usable-versus-required hours, which is exactly
 * what the engine computes and exactly the wrong thing to put on a phone: it
 * asks the reader to do the interpretation the system exists to do for them.
 * This one leads with the answer, and only then shows the arithmetic behind it.
 */
async function weekReply(sql: Sql, text: string): Promise<string> {
  const workspaceId = await resolveWorkspaceId(sql);
  const arg = text.replace(/^\/(week|capacity)(@\S+)?/, '').trim();
  const given = arg.length === 0 ? NaN : Number(arg);

  let hours: number;
  if (Number.isFinite(given) && given >= 0) {
    hours = given;
  } else {
    const remembered = await defaultHours(sql, workspaceId);
    if (remembered === null) {
      // Never invent a working week. An assumed number produces a confident
      // answer to a question nobody asked.
      return [
        'How many hours do you have for work this week?',
        '',
        'Send /hours 25 once and I will remember it,',
        'or /week 18 for just this week.',
      ].join('\n');
    }
    hours = remembered;
  }

  const { capacity } = await import('./tools.js');
  const res = await capacity(sql, { available_hours: hours });
  const h = res['hours'] as
    | { usable: number; required: number; deficit: number; buffer: number; recurring_overhead: number }
    | undefined;
  if (!h) return 'No answer came back.';

  const notes = (res['confidence'] as { notes?: string[] } | undefined)?.notes ?? [];
  const nothingLoaded = notes.some((n) => n.includes('shares fall back to floors'));

  // The empty-system case, said plainly. Reporting "clear, 20h spare" when
  // there is no work in the system is technically true and actively misleading.
  if (nothingLoaded) {
    return [
      `This week: ${hours}h available.`,
      '',
      'But I cannot tell you what will slip, because no tasks are attached to',
      'any milestone yet. There is nothing to weigh.',
      '',
      'Talk to Claude about what each milestone actually needs, and this',
      'becomes a real answer.',
    ].join('\n');
  }

  const lines: string[] = [];
  if (res['verdict'] === 'deficit') {
    lines.push(`This week does not fit. You are ${round(h.deficit)}h short.`);
  } else {
    lines.push(`This week fits, with ${round(-h.deficit)}h to spare.`);
  }

  lines.push(
    '',
    `${hours}h available − ${round(h.recurring_overhead)}h recurring − ${round(h.buffer)}h buffer = ${round(h.usable)}h real working time.`,
    `Your milestones need ${round(h.required)}h.`,
  );

  const slips = (res['slip_order'] as Array<{ milestone: string; cost_of_slip: string }>) ?? [];
  if (res['verdict'] === 'deficit' && slips.length > 0) {
    lines.push('', 'Give up first, in this order:');
    slips.slice(0, 3).forEach((s, i) => lines.push(`${i + 1}. ${s.milestone} — ${s.cost_of_slip}`));
  }

  const caveats = notes.filter(
    (n) =>
      n.includes('coverage is vacuously') ||
      n.includes('no critical path') ||
      n.includes('calibration not applied'),
  );
  if (caveats.length > 0) {
    lines.push('', `Treat this as rough: ${caveats.length} things are not measured yet.`);
  }
  return lines.join('\n');
}

/**
 * What the agents using this have reported as missing or broken.
 *
 * On the phone because Tal is the one who builds it, and the moment he is most
 * likely to think about what to build next is not when he is at a desk.
 */
async function ideasReply(sql: Sql): Promise<string> {
  const { listSuggestions } = await import('./feedback.js');
  const res = await listSuggestions(sql, { status: 'open' });
  const items =
    (res['suggestions'] as Array<{
      kind: string;
      title: string;
      severity: string;
      occurrences: number;
    }>) ?? [];

  if (items.length === 0) {
    return 'Nothing reported yet. When an AI session hits a limit of this system it files it here.';
  }

  const lines = [`${res['total']} open:`, ''];
  for (const i of items.slice(0, 8)) {
    const hits = i.occurrences > 1 ? ` ×${i.occurrences}` : '';
    lines.push(`• [${i.severity}] ${i.title} (${i.kind}${hits})`);
  }
  lines.push('', 'Ask Claude for the detail on any of these.');
  return lines.join('\n');
}

/** What to actually pick up now — the question a phone is usually asked. */
async function nextReply(sql: Sql): Promise<string> {
  const { listTasks } = await import('./tools.js');
  const res = await listTasks(sql, { status: 'active' });
  const tasks =
    (res['tasks'] as Array<{ title: string; venture: string; estimate_minutes: number }>) ?? [];

  if (tasks.length === 0) {
    const inbox = await listTasks(sql, { status: 'inbox' });
    const n = (inbox['total'] as number) ?? 0;
    return n > 0
      ? `Nothing is active yet. ${n} item(s) are sitting in the inbox — ask Claude to process the inbox and file them.`
      : 'Nothing active and nothing in the inbox. Send me anything to capture it.';
  }

  const lines = ['Next, highest first:', ''];
  tasks.slice(0, 5).forEach((t, i) => {
    const mins = t.estimate_minutes;
    const size = mins >= 60 ? `${Math.round((mins / 60) * 10) / 10}h` : `${mins}m`;
    lines.push(`${i + 1}. ${t.title} — ${t.venture}, ${size}`);
  });
  return lines.join('\n');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

async function storeFile(
  sql: Sql,
  cfg: TelegramConfig,
  file: { fileId: string; name: string; mime?: string | undefined; size?: number | undefined },
  caption: string | undefined,
): Promise<string> {
  if (file.size !== undefined && file.size > MAX_TELEGRAM_FILE_BYTES) {
    return `That file is ${Math.round(file.size / 1024 / 1024)}MB. Telegram will not let a bot download anything over 20MB — ask Claude for an upload link instead.`;
  }

  let bytes: Buffer;
  try {
    ({ bytes } = await downloadFile(cfg, file.fileId));
  } catch (e) {
    return `I could not fetch that from Telegram: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (bytes.byteLength > MAX_INLINE_BYTES) {
    // attachDocument's inline ceiling is about what fits in a tool call, which
    // does not apply here — but honouring it keeps one path through the code
    // rather than two, and 5MB covers photos and ordinary documents. Anything
    // larger gets the upload link, which has no ceiling at all.
    return `That file is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, over the 5MB direct limit. Ask Claude for an upload link and send it there.`;
  }

  const title = (caption ?? '').trim() || file.name;
  const res = await attachDocument(sql, {
    title,
    filename: file.name,
    content_base64: bytes.toString('base64'),
    ...(file.mime ? { mime_type: file.mime } : {}),
    notes: 'sent via Telegram',
  });

  if (!res.ok) {
    const err = res.errors?.[0];
    return `I could not store that: ${err?.message ?? 'unknown error'}`;
  }
  return `Stored "${title}". It is not filed against a venture yet — tell Claude where it belongs.`;
}

/**
 * Confirm the workspace resolves before answering Telegram at all.
 *
 * Called once per update so a misconfigured deployment says so in the reply
 * rather than failing silently inside a tool.
 */
export async function workspaceReachable(sql: Sql): Promise<string | null> {
  try {
    await resolveWorkspaceId(sql);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
