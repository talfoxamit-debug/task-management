/**
 * iCalendar (RFC 5545) generation.
 *
 * Two consumers, one format: a "add this to my calendar" download for a single
 * task, and a subscribable feed of a person's dated work. Both go to Google
 * Calendar, Apple Calendar and Outlook, and all three are unforgiving about the
 * parts that look cosmetic — a line over 75 octets, an LF where a CRLF belongs,
 * or an unescaped comma in a SUMMARY produces a file that imports as empty or
 * not at all, with no error the user will ever see.
 *
 * So the folding below counts OCTETS, not characters. A task title with an
 * em dash or a Hebrew word is several bytes per character, and folding on
 * character count produces lines that are legal-looking and too long. Splitting
 * mid-sequence is worse still: it corrupts the character and some parsers give
 * up on the whole event.
 *
 * ONLY DATED TASKS BECOME EVENTS. A task with no deadline has no day to sit on,
 * and putting it on "today" would be the system inventing a date — which is the
 * one thing it must never do, in a calendar most of all: an invented due date
 * that syncs to a phone becomes a fact nobody can trace back.
 */

/** RFC 5545 TEXT escaping. Order matters: the backslash must go first. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // Control characters are not valid in a TEXT value and are silently
    // corrupting rather than loudly rejected. Run last, so the escapes written
    // above survive.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/**
 * Fold one content line to 75 octets, continuing with a single leading space.
 *
 * The continuation space is itself part of the 75, so every line after the
 * first carries only 74 octets of payload. Getting that off by one produces
 * files that pass a naive test and fail in Outlook.
 */
export function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.byteLength <= 75) return line;

  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.byteLength) {
    let end = Math.min(start + limit, bytes.byteLength);
    // 10xxxxxx is a UTF-8 continuation byte: back up until the boundary so a
    // multi-byte character is never cut in half.
    while (end > start + 1 && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return parts.join('\r\n ');
}

function line(name: string, value: string): string {
  return foldLine(`${name}:${escapeText(value)}`);
}

/** YYYYMMDDTHHMMSSZ, the only timestamp form that needs no VTIMEZONE. */
export function icsStamp(at: Date): string {
  return `${at.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/** YYYYMMDD from a civil date, for an all-day VALUE=DATE property. */
function icsDate(civil: string): string {
  return civil.replace(/-/g, '');
}

function nextDay(civil: string): string {
  const [y, m, d] = civil.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
}

export interface IcsTask {
  id: string;
  title: string;
  venture: string;
  notes: string | null;
  estimate_minutes: number;
  deadline_date: string | null;
  unblocks: number;
}

function event(task: IcsTask, stamp: string, url: string | null): string[] {
  const day = icsDate(task.deadline_date!);
  const description = [
    `${task.venture} · about ${task.estimate_minutes} minutes`,
    task.unblocks > 0
      ? `${task.unblocks} other ${task.unblocks === 1 ? 'thing is' : 'things are'} waiting on this`
      : null,
    task.notes,
  ]
    .filter((x): x is string => Boolean(x))
    .join('\n');

  return [
    'BEGIN:VEVENT',
    // Stable per task, so a re-import updates the existing entry rather than
    // creating a second one every time the feed refreshes.
    line('UID', `${task.id}@taskos`),
    `DTSTAMP:${stamp}`,
    // All-day. DTEND is exclusive in RFC 5545, so a one-day event ends the
    // next morning; omitting it makes Outlook render a zero-length event.
    `DTSTART;VALUE=DATE:${day}`,
    `DTEND;VALUE=DATE:${icsDate(nextDay(task.deadline_date!))}`,
    line('SUMMARY', task.title),
    line('DESCRIPTION', description),
    ...(url ? [line('URL', url)] : []),
    'STATUS:CONFIRMED',
    'TRANSP:TRANSPARENT',
    'SEQUENCE:0',
    'END:VEVENT',
  ];
}

export interface IcsOptions {
  /** Shown as the calendar name in Google and Apple. */
  calendarName: string;
  /** The delegate page, so an event links back to where it can be closed. */
  url?: string | null;
  /** A subscribable feed asks clients to re-fetch; a one-off download does not. */
  feed?: boolean;
  now?: Date;
}

/**
 * A whole calendar. Undated tasks are dropped rather than dated, and the caller
 * is expected to have said so on the page.
 */
export function buildCalendar(tasks: readonly IcsTask[], opts: IcsOptions): string {
  const stamp = icsStamp(opts.now ?? new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fox Solutions//TaskOS//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    line('X-WR-CALNAME', opts.calendarName),
    ...(opts.feed
      ? ['REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H']
      : []),
  ];

  for (const task of tasks) {
    if (!task.deadline_date) continue;
    lines.push(...event(task, stamp, opts.url ?? null));
  }

  lines.push('END:VCALENDAR');
  // CRLF everywhere, including the final line. A file ending in a bare LF is
  // the single most common reason an .ics "does nothing" when opened.
  return `${lines.join('\r\n')}\r\n`;
}

/** A filename a phone will not mangle. */
export function icsFilename(title: string): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'task';
  return `${slug}.ics`;
}
