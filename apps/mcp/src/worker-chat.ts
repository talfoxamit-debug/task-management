import { randomInt } from 'node:crypto';
import { resolveWorkspaceId, type Queryable, type Sql } from './db.js';
import { envelope, plainConfidence, type ToolEnvelope } from './narrow.js';
import { delegateLink } from './delegation.js';

/**
 * Reaching Othman and Saar where they already are.
 *
 * Every delegation link so far has had to be copied out of a Claude response
 * and pasted into a chat by hand. That is the step that does not happen on a
 * busy day, which quietly made the whole feature optional.
 *
 * THE APPROVAL STEP IS KEPT. Tal's standing rule is that he is the final
 * reviewer and sender — "automated output is often not what I would have
 * chosen" — and assignments in particular get made provisionally during
 * planning. So nothing here sends on assignment. Claude prepares, Tal says the
 * word, the bot delivers. The automation removes the copy-paste, not the
 * decision.
 */

/**
 * Unambiguous characters only.
 *
 * The code is read off one screen and typed into another, frequently on a
 * phone, sometimes by somebody who did not choose to be doing this. 0/O and
 * 1/I/l cost more in failed pairings than the entropy they add is worth; what
 * is left is 32 symbols over 8 characters, which is 40 bits — far beyond
 * guessable inside a thirty-minute window.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode(): string {
  let out = '';
  for (let i = 0; i < 8; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export async function pairPersonChat(
  sql: Sql,
  input: { person: string },
): Promise<ToolEnvelope> {
  const workspaceId = await resolveWorkspaceId(sql);
  const people = await sql<
    Array<{ id: string; name: string; chat: string | null; title: string | null }>
  >`
    select id, name, telegram_chat_id as chat, telegram_chat_title as title
      from people where workspace_id = ${workspaceId} and lower(name) = lower(${input.person})`;
  const person = people[0];
  if (!person) {
    const known = await sql<Array<{ name: string }>>`
      select name from people where workspace_id = ${workspaceId} order by name`;
    return envelope(plainConfidence([]), { code: null }, [
      {
        code: 'not_found',
        message: `no person called "${input.person}" — nothing was written. Known: ${known
          .map((k) => k.name)
          .join(', ')}`,
      },
    ]);
  }

  const code = makeCode();
  await sql`
    insert into chat_pairing_codes (code, workspace_id, person_id)
    values (${code}, ${workspaceId}, ${person.id})`;

  return envelope(
    plainConfidence([
      'the code is single-use and expires in 30 minutes',
      'a paired chat can RECEIVE messages and cannot command the bot — it never gains access to the portfolio',
      person.chat
        ? `${person.name} is already paired to ${person.title ?? 'a chat'}; redeeming this replaces it`
        : `${person.name} is not paired yet`,
    ]),
    {
      code,
      person: person.name,
      instructions: [
        `Add the TaskOS bot to the Telegram chat you share with ${person.name}.`,
        `Send this message in that chat: /taskos ${code}`,
        'The bot replies to confirm, and can then be sent work there.',
      ],
    },
  );
}

/**
 * Redeem a code from a chat the allow-list does not know.
 *
 * THE ONE EXCEPTION to the webhook's allow-list, and it is kept as narrow as it
 * can be: this command and no other, a code that must already exist, be
 * unredeemed and unexpired. Anything else from an unknown chat is still met
 * with silence.
 */
export async function redeemPairingCode(
  sql: Queryable,
  code: string,
  chatId: string,
  chatTitle: string | null,
): Promise<{ ok: boolean; reply: string }> {
  const normalised = code.trim().toUpperCase();
  const rows = await sql<Array<{ person_id: string; name: string; workspace_id: string }>>`
    update chat_pairing_codes c
       set redeemed_at = now(), redeemed_chat = ${chatId}
      from people p
     where p.id = c.person_id
       and c.code = ${normalised}
       and c.redeemed_at is null
       and c.expires_at > now()
    returning c.person_id, p.name, c.workspace_id`;

  const row = rows[0];
  if (!row) {
    // Deliberately vague. An unknown chat learns only that this code did not
    // work, not whether it ever existed.
    return { ok: false, reply: 'That code is not valid. Ask Tal for a new one.' };
  }

  await sql`
    update people
       set telegram_chat_id = ${chatId},
           telegram_chat_title = ${chatTitle},
           telegram_paired_at = now()
     where id = ${row.person_id}`;

  return {
    ok: true,
    reply: `Paired. Work for ${row.name} will arrive in this chat.\n\nThis chat can receive messages only — it cannot run commands.`,
  };
}

// ---------------------------------------------------------------------------
// Sending, after Tal approves
// ---------------------------------------------------------------------------

export interface SendWorkInput {
  person: string;
  /** What Tal approved. Sent verbatim; nothing is rewritten on the way out. */
  message?: string;
  /** Mint and include a fresh link to their page. */
  include_link?: boolean;
  scope?: 'person' | 'task';
  task_id?: string;
  idempotency_key?: string;
}

/**
 * Deliver approved work to a person's chat.
 *
 * The message is sent VERBATIM. Claude drafts it, Tal reads it, and what he
 * approved is what arrives — a tool that rewrote the text on the way out would
 * make the approval meaningless, because he would have approved something else.
 */
export async function sendWorkToPerson(
  sql: Sql,
  input: SendWorkInput,
): Promise<ToolEnvelope> {
  const { sendMessage, telegramConfig } = await import('./telegram.js');
  const workspaceId = await resolveWorkspaceId(sql);

  const people = await sql<Array<{ id: string; name: string; chat: string | null }>>`
    select id, name, telegram_chat_id as chat from people
     where workspace_id = ${workspaceId} and lower(name) = lower(${input.person})`;
  const person = people[0];
  if (!person) {
    return envelope(plainConfidence([]), { sent: false }, [
      { code: 'not_found', message: `no person called "${input.person}" — nothing was sent` },
    ]);
  }
  if (!person.chat) {
    return envelope(plainConfidence([]), { sent: false }, [
      {
        code: 'not_paired',
        message: `${person.name} has no chat on record — nothing was sent. Run pair_person_chat("${person.name}") and give Tal the code.`,
      },
    ]);
  }

  const setup = telegramConfig();
  if (!setup.configured) {
    return envelope(plainConfidence([]), { sent: false }, [
      { code: 'telegram_unconfigured', message: setup.reason },
    ]);
  }

  const parts: string[] = [];
  if (input.message && input.message.trim().length > 0) parts.push(input.message.trim());

  let link: string | null = null;
  if (input.include_link !== false) {
    const minted = await delegateLink(sql, {
      person: person.name,
      ...(input.scope === 'task' && input.task_id
        ? { scope: 'task' as const, task_id: input.task_id }
        : { scope: 'person' as const, rotate: true }),
    });
    link = minted['link'] ? String(minted['link']) : null;
    if (link) parts.push(link);
    else if (minted['already_live']) {
      parts.push('(link unchanged — they already have a working one)');
    }
  }

  if (parts.length === 0) {
    return envelope(plainConfidence([]), { sent: false }, [
      { code: 'empty', message: 'nothing to send: give a message, a link, or both' },
    ]);
  }

  const body = parts.join('\n\n');
  await sendMessage(setup.config, person.chat, body);

  return envelope(
    plainConfidence([
      'sent verbatim — what Tal approved is what arrived',
      link
        ? 'a fresh link was included; the previous one keeps working through its grace window'
        : 'no new link was minted',
    ]),
    { sent: true, person: person.name, characters: body.length, link },
  );
}

// ---------------------------------------------------------------------------
// Chasing, when work goes quiet
// ---------------------------------------------------------------------------

export interface Nudge {
  task_id: string;
  person: string;
  chat: string;
  title: string;
  reason: string;
  text: string;
}

/**
 * What deserves a nudge today, and nothing that does not.
 *
 * Two conditions only: past its date, or flagged blocked for three days with no
 * movement. A chaser with a wider net is a chaser that fires constantly, gets
 * muted inside a week, and takes the useful messages with it — so the bar is
 * high on purpose.
 *
 * A blocked task is nudged in TAL's direction, not theirs. Somebody who has
 * said they are stuck does not need reminding that they are stuck; the person
 * who has not answered them does.
 */
export async function dueNudges(sql: Sql, today: string): Promise<Nudge[]> {
  const workspaceId = await resolveWorkspaceId(sql);

  const rows = await sql<
    Array<{
      id: string;
      title: string;
      person: string;
      chat: string;
      days_over: number | null;
      blocked_days: number | null;
    }>
  >`
    select t.id, t.title, p.name as person, p.telegram_chat_id as chat,
           case when t.deadline_date is not null
                then (${today}::date - t.deadline_date) end as days_over,
           case when t.needs_attention_at is not null
                then extract(day from now() - t.needs_attention_at)::int end as blocked_days
      from tasks t
      join people p on p.id = t.assignee_person_id
     where t.workspace_id = ${workspaceId}
       and t.status not in ('done', 'killed')
       and p.telegram_chat_id is not null
       and not exists (
         select 1 from task_nudges n
          where n.workspace_id = t.workspace_id and n.task_id = t.id and n.on_date = ${today}::date
       )`;

  const out: Nudge[] = [];
  for (const r of rows) {
    // Somebody who has said they are stuck does not need chasing about it.
    if ((r.blocked_days ?? 0) >= 3) continue;
    if ((r.days_over ?? -1) <= 0) continue;

    out.push({
      task_id: r.id,
      person: r.person,
      chat: r.chat,
      title: r.title,
      reason: `${r.days_over}d overdue`,
      text:
        r.days_over === 1
          ? `Quick nudge: "${r.title}" was due yesterday. If something is in the way, reply on your task page and Tal will see it.`
          : `Quick nudge: "${r.title}" is ${r.days_over} days past its date. If something is in the way, reply on your task page and Tal will see it.`,
    });
  }
  return out;
}

/** Send the nudges, recording each so it cannot fire twice in a day. */
export async function sendNudges(sql: Sql, today: string): Promise<number> {
  const { sendMessage, telegramConfig } = await import('./telegram.js');
  const setup = telegramConfig();
  if (!setup.configured) return 0;

  const workspaceId = await resolveWorkspaceId(sql);
  const nudges = await dueNudges(sql, today);
  let sent = 0;

  for (const n of nudges) {
    // Recorded BEFORE sending, and inside its own statement. A duplicate key
    // here means another invocation already claimed this nudge, which is
    // exactly the outcome wanted when two cron schedules overlap.
    const claimed = await sql<Array<{ task_id: string }>>`
      insert into task_nudges (workspace_id, task_id, on_date, reason)
      values (${workspaceId}, ${n.task_id}, ${today}::date, ${n.reason})
      on conflict do nothing
      returning task_id`;
    if (claimed.length === 0) continue;

    try {
      await sendMessage(setup.config, n.chat, n.text);
      sent += 1;
    } catch (e) {
      console.log(`[taskos] nudge failed for ${n.person}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return sent;
}
