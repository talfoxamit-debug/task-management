import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSql, withDeadline } from './db.js';
import {
  handleUpdate,
  secretHeaderValid,
  sendMessage,
  telegramConfig,
  workspaceReachable,
  type TelegramUpdate,
} from './telegram.js';

export const TELEGRAM_PATH = '/api/telegram';

/** Telegram will not send an update body larger than this; anything bigger is not Telegram. */
const MAX_BODY_BYTES = 1_000_000;

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<unknown> {
  // Some platforms parse the body before the handler runs; some do not.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return JSON.parse(req.body);
    return req.body;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The Telegram webhook.
 *
 * ALWAYS 200, once the request is proven to be from Telegram. Telegram retries
 * any update it does not get a 200 for, with backoff, for hours — so a 500 from
 * a transient database error turns one captured note into several, and a bug
 * into a flood. Problems are reported in the reply message instead, where the
 * person can see them.
 *
 * The exception is the secret header. A request that cannot prove it came from
 * Telegram gets 401 and nothing else happens: no parsing, no database, no reply.
 * Answering 200 there would make this endpoint a free way for anyone on the
 * internet to drive the bot.
 */
export default async function telegramRoute(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  const reply = (status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('allow', 'POST');
    res.end(JSON.stringify({ error: 'telegram webhooks are POST' }));
    return;
  }

  const setup = telegramConfig();
  if (!setup.configured) {
    // 503, not 200: Telegram should retry once this is configured rather than
    // consider the update delivered and drop it.
    reply(503, { error: setup.reason });
    return;
  }

  const header = req.headers['x-telegram-bot-api-secret-token'];
  if (!secretHeaderValid(Array.isArray(header) ? header[0] : header, setup.config.webhookSecret)) {
    reply(401, { error: 'unauthorized' });
    return;
  }

  let update: TelegramUpdate;
  try {
    update = (await readBody(req)) as TelegramUpdate;
  } catch {
    reply(200, { ok: true, ignored: 'unparseable body' });
    return;
  }

  try {
    const sql = getSql();

    const unreachable = await workspaceReachable(sql);
    if (unreachable) {
      const chatId = String(update.message?.chat?.id ?? '');
      if (chatId && setup.config.allowedChatIds.has(chatId)) {
        await sendMessage(setup.config, chatId, `TaskOS cannot reach its data: ${unreachable}`);
      }
      reply(200, { ok: true, ignored: 'workspace unresolved' });
      return;
    }

    const outcome = await withDeadline('telegram.update', 25_000, () =>
      handleUpdate(sql, setup.config, update),
    );

    if (!outcome.handled) {
      console.log(`[taskos] telegram update ignored: ${outcome.reason}`);
      reply(200, { ok: true, ignored: outcome.reason });
      return;
    }

    await sendMessage(setup.config, outcome.chatId, outcome.reply);
    reply(200, { ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`[taskos] telegram update failed: ${message}`);
    // Tell the sender rather than leaving them staring at a bot that ate their
    // message — but only if they are on the allow-list, and still answer 200 so
    // Telegram does not redeliver.
    const chatId = String(update.message?.chat?.id ?? '');
    if (chatId && setup.config.allowedChatIds.has(chatId)) {
      await sendMessage(setup.config, chatId, `Something went wrong: ${message}`).catch(() => {});
    }
    reply(200, { ok: true, error: message });
  }
}
