import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { getSql, resolveWorkspaceId, withDeadline } from './db.js';
import { buildDailyBrief } from './daily.js';
import { findReplay, recordReceipt } from './idempotency.js';
import { checkCredential } from './auth.js';
import { notifyOwner } from './telegram.js';

export const DAILY_PATH = '/api/daily';

/**
 * The 08:00 brief, driven by Vercel Cron.
 *
 * Three things here are not obvious and all three are the difference between a
 * message that arrives every morning and one that arrives at the wrong hour,
 * twice, or on a day off.
 *
 * 1. DST. Vercel evaluates cron schedules in UTC and has no timezone option, so
 *    a fixed UTC hour drifts by one across the year: 08:00 in New York is 12:00
 *    UTC in summer and 13:00 UTC in winter. The fix is two schedules, one for
 *    each, with THIS route deciding whether the local time is actually right.
 *    Pinning a single UTC hour would silently deliver at 07:00 for five months
 *    of the year.
 *
 * 2. ONE PER LOCAL DAY. Both schedules fire every day, so on any given date one
 *    of them is wrong — and on Vercel's Hobby plan a cron is triggered within
 *    the hour rather than on the minute, so the right one can arrive late. The
 *    window below is deliberately wide (08:00–11:59 local) to tolerate that
 *    delay, and the receipt is what stops the wide window becoming two
 *    messages. Idempotency is the mechanism the rest of this system already
 *    uses for exactly this, so it is the mechanism used here.
 *
 * 3. THE DAY OFF IS READ FROM THE DATA. Saturday is skipped because
 *    day_allocation says it is not a working day, not because the cron
 *    expression excludes it. Change the allocation with set_day_allocation and
 *    the brief follows, with no redeploy and nothing to keep in sync.
 */

/** Send no earlier than 08:00 local, and give up rather than send by lunchtime. */
const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 12;

function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Who may fire this.
 *
 * Vercel signs its own cron invocations with CRON_SECRET when that variable is
 * set; TASKOS_TOKEN is accepted too so the brief can be triggered by hand to
 * see what it looks like. Unauthenticated access would let anyone on the
 * internet push messages to Tal's phone, which is a nuisance attack that needs
 * no skill at all.
 */
function authorised(req: IncomingMessage): boolean {
  const header = req.headers['authorization'];
  const presented = Array.isArray(header) ? header[0] : header;

  const cronSecret = process.env['CRON_SECRET'];
  if (cronSecret && presented && constantTimeEquals(presented, `Bearer ${cronSecret}`)) {
    return true;
  }
  return checkCredential(presented, req.url).ok;
}

export default async function dailyRoute(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(body));
  };

  if (!authorised(req)) {
    reply(401, { ok: false, error: 'unauthorized' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  // `?dry=1` composes the brief and returns it without sending. This is how the
  // wording gets checked against real data without putting a test message on a
  // phone, and it is why the composer is a separate module.
  const dry = url.searchParams.get('dry') === '1';
  // `?force=1` ignores the time window and the receipt, for a manual send.
  const force = url.searchParams.get('force') === '1';

  try {
    const sql = getSql();
    const workspaceId = await resolveWorkspaceId(sql);

    // The hour, in the workspace's own timezone, resolved by the database — the
    // same way every other date in this system is resolved. Doing it in Node
    // would depend on the container's TZ, which is UTC and would be wrong.
    const nowRows = await sql<Array<{ hour: number; date: string }>>`
      select extract(hour from now() at time zone s.active_tz)::int as hour,
             taskos_today(${workspaceId})::text as date
        from settings s where s.workspace_id = ${workspaceId}`;
    const { hour, date } = nowRows[0]!;

    if (!force && (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR)) {
      // The other schedule's turn. Not an error: exactly one of the two fires
      // inside the window on any given date.
      reply(200, { ok: true, sent: false, reason: 'outside the local window', hour, date });
      return;
    }

    const key = `daily-brief:${date}`;
    if (!force && (await findReplay(sql, key))) {
      reply(200, { ok: true, sent: false, reason: 'already sent today', date });
      return;
    }

    const brief = await withDeadline('daily.brief', 25_000, () => buildDailyBrief(sql));

    if (!brief.working) {
      // A notification on a day off trains you to ignore the ones on the days
      // that matter. Still recorded, so the other schedule does not re-check.
      if (!dry) {
        await recordReceipt(sql, {
          key,
          actor: 'system',
          verb: 'daily_brief_skipped',
          workspace_id: workspaceId,
          result: { date: brief.date, reason: 'not a working day' },
        });
      }
      reply(200, { ok: true, sent: false, reason: 'not a working day', date: brief.date });
      return;
    }

    if (dry) {
      reply(200, { ok: true, sent: false, dry: true, date: brief.date, text: brief.text });
      return;
    }

    // Receipt BEFORE the send. If Telegram is slow and the platform kills the
    // invocation mid-flight, the worst case is a brief that is missed once —
    // strictly better than one delivered twice every morning, which is how a
    // useful notification becomes one that gets muted.
    await recordReceipt(sql, {
      key,
      actor: 'system',
      verb: 'daily_brief',
      workspace_id: workspaceId,
      result: { date: brief.date, characters: brief.text.length },
    });

    await notifyOwner(brief.text);
    reply(200, { ok: true, sent: true, date: brief.date });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`[taskos] daily brief failed: ${message}`);
    // 500 so the failure is visible in Vercel's cron log rather than being
    // recorded as a successful delivery of nothing.
    reply(500, { ok: false, error: message });
  }
}
