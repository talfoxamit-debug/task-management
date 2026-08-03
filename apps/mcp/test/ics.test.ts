import { describe, expect, it } from 'vitest';
import { buildCalendar, foldLine, icsFilename, icsStamp, type IcsTask } from '../src/ics.js';

/**
 * The .ics format.
 *
 * Every assertion here is about something that fails SILENTLY. A line over 75
 * octets, a bare LF, an unescaped comma — none of them produce an error anyone
 * sees. Google Calendar simply imports nothing, or imports an event with half a
 * title, and the person who tapped "add to calendar" concludes the link is
 * broken and stops using it.
 */

const NOW = new Date('2026-08-03T14:30:00.000Z');

function task(over: Partial<IcsTask> = {}): IcsTask {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    title: 'Rewire the checkout redirect',
    venture: 'YachtyHub',
    notes: null,
    estimate_minutes: 90,
    deadline_date: '2026-08-06',
    unblocks: 0,
    ...over,
  };
}

function lines(ics: string): string[] {
  return ics.split('\r\n');
}

/** What a parser does first: rejoin folded lines. */
function unfold(ics: string): string {
  return ics.split('\r\n ').join('');
}

describe('line folding', () => {
  it('leaves a short line alone', () => {
    expect(foldLine('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('never emits a line over 75 octets, continuation space included', () => {
    const folded = foldLine(`SUMMARY:${'a'.repeat(400)}`);
    for (const line of folded.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Every continuation carries exactly one leading space, which is what a
    // parser strips to reassemble the value.
    for (const line of folded.split('\r\n').slice(1)) expect(line.startsWith(' ')).toBe(true);
  });

  it('counts OCTETS, not characters', () => {
    // 40 em dashes is 40 characters and 120 bytes: a character-counting folder
    // emits one legal-looking line that every parser rejects.
    const folded = foldLine(`SUMMARY:${'—'.repeat(40)}`);
    expect(folded).toContain('\r\n ');
    for (const line of folded.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte character in half', () => {
    const value = '×'.repeat(90);
    const folded = foldLine(`SUMMARY:${value}`);
    // Unfolding is: drop the CRLF and the single space that follows it.
    const rejoined = folded.split('\r\n ').join('');
    expect(rejoined).toBe(`SUMMARY:${value}`);
    expect(rejoined).not.toContain('�');
  });
});

describe('escaping', () => {
  it('escapes the four characters that break a TEXT value', () => {
    const ics = buildCalendar(
      [task({ title: 'Ship A, B; and C\\D', notes: 'line one\nline two' })],
      { calendarName: 'x', now: NOW },
    );
    const summary = lines(ics).find((l) => l.startsWith('SUMMARY:'))!;
    expect(summary).toBe('SUMMARY:Ship A\\, B\\; and C\\\\D');
    expect(lines(ics).some((l) => l.includes('line one\\nline two'))).toBe(true);
  });

  it('strips control characters rather than emitting them', () => {
    const ics = buildCalendar([task({ title: `Bad\u0007ti\u0000tle` })], {
      calendarName: 'x',
      now: NOW,
    });
    // A control byte in a TEXT value is invalid and corrupts silently rather
    // than being rejected loudly.
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(ics)).toBe(false);
    expect(ics).toContain('SUMMARY:Badtitle');
  });
});

describe('the calendar', () => {
  it('uses CRLF everywhere, including the last line', () => {
    const ics = buildCalendar([task()], { calendarName: 'TaskOS', now: NOW });
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // A bare LF anywhere is the single most common reason an .ics "does nothing".
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('writes an all-day event whose DTEND is the following day', () => {
    const ics = buildCalendar([task({ deadline_date: '2026-08-06' })], {
      calendarName: 'TaskOS',
      now: NOW,
    });
    expect(ics).toContain('DTSTART;VALUE=DATE:20260806');
    // DTEND is exclusive in RFC 5545; omitting it renders a zero-length event.
    expect(ics).toContain('DTEND;VALUE=DATE:20260807');
    expect(ics).toContain(`DTSTAMP:${icsStamp(NOW)}`);
  });

  it('gives every task a stable UID, so a refresh updates rather than duplicates', () => {
    const a = buildCalendar([task()], { calendarName: 'x', now: NOW });
    const b = buildCalendar([task()], { calendarName: 'x', now: new Date('2026-09-01T00:00:00Z') });
    const uid = (s: string) => lines(s).find((l) => l.startsWith('UID:'));
    expect(uid(a)).toBe(uid(b));
  });

  it('DROPS undated tasks rather than inventing a date for them', () => {
    const ics = buildCalendar([task({ deadline_date: null, title: 'No date at all' }), task()], {
      calendarName: 'x',
      now: NOW,
    });
    expect(ics).not.toContain('No date at all');
    expect(lines(ics).filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('asks a subscribed client to refresh, and a download not to', () => {
    const feed = buildCalendar([task()], { calendarName: 'x', feed: true, now: NOW });
    expect(feed).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    const download = buildCalendar([task()], { calendarName: 'x', now: NOW });
    expect(download).not.toContain('REFRESH-INTERVAL');
  });

  it('says what a task unblocks, as a count', () => {
    const ics = buildCalendar([task({ unblocks: 2 })], { calendarName: 'x', now: NOW });
    // Read the way a client reads it: unfolded. Asserting on the raw text here
    // would pass only while the description happened to be short.
    expect(unfold(ics)).toContain('2 other things are waiting on this');
  });

  it('produces a filename a phone will not mangle', () => {
    expect(icsFilename('Rewire the checkout redirect')).toBe('rewire-the-checkout-redirect.ics');
    expect(icsFilename('!!!')).toBe('task.ics');
    expect(icsFilename('a'.repeat(200)).length).toBeLessThanOrEqual(52);
  });
});
