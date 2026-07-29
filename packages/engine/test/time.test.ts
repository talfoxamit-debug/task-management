import { describe, expect, it } from 'vitest';
import {
  addDays,
  civilFromDays,
  daysBetween,
  daysFromCivil,
  daysSince,
  isoDayOfWeek,
  sameWeek,
  startOfWeek,
  toCivilDate,
  weeksUntil,
} from '../src/time.js';

const TZ = 'America/New_York';

describe('daysBetween — plain calendar arithmetic', () => {
  it('counts forward days', () => {
    expect(daysBetween('2026-07-29', '2026-08-10', TZ)).toBe(12);
    expect(daysBetween('2026-07-29', '2026-07-30', TZ)).toBe(1);
    expect(daysBetween('2026-07-29', '2026-07-29', TZ)).toBe(0);
  });

  it('is signed, and antisymmetric', () => {
    expect(daysBetween('2026-08-10', '2026-07-29', TZ)).toBe(-12);
    expect(daysBetween('2026-01-01', '2026-12-31', TZ)).toBe(364);
    expect(daysBetween('2026-12-31', '2026-01-01', TZ)).toBe(-364);
  });

  it('crosses month and year boundaries', () => {
    expect(daysBetween('2026-07-31', '2026-08-01', TZ)).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-01', TZ)).toBe(1);
    expect(daysBetween('2024-02-28', '2024-03-01', TZ)).toBe(2); // leap year
    expect(daysBetween('2026-02-28', '2026-03-01', TZ)).toBe(1); // non-leap
    expect(daysBetween('2000-02-28', '2000-03-01', TZ)).toBe(2); // 400-year rule
    expect(daysBetween('1900-02-28', '1900-03-01', TZ)).toBe(1); // 100-year rule
  });
});

describe('daysBetween — the DST property this function exists for', () => {
  // 2026-03-08 is the spring-forward date in America/New_York: a 23-hour day.
  it('spring forward is still exactly one day', () => {
    expect(daysBetween('2026-03-07', '2026-03-08', TZ)).toBe(1);
    expect(daysBetween('2026-03-08', '2026-03-09', TZ)).toBe(1);
    expect(daysBetween('2026-03-07', '2026-03-09', TZ)).toBe(2);
  });

  // 2026-11-01 is the fall-back date: a 25-hour day.
  it('fall back is still exactly one day', () => {
    expect(daysBetween('2026-10-31', '2026-11-01', TZ)).toBe(1);
    expect(daysBetween('2026-11-01', '2026-11-02', TZ)).toBe(1);
    expect(daysBetween('2026-10-31', '2026-11-02', TZ)).toBe(2);
  });

  it('beats naive millisecond division across both boundaries', () => {
    // The bug D2 forbids: ms division returns 0.958 and 1.042 for these.
    const naive = (a: string, b: string) =>
      (new Date(`${b}T00:00:00-04:00`).getTime() - new Date(`${a}T00:00:00-05:00`).getTime()) /
      86_400_000;
    expect(naive('2026-03-07', '2026-03-08')).toBeCloseTo(0.9583, 3);
    expect(Math.trunc(naive('2026-03-07', '2026-03-08'))).toBe(0); // naive says zero days
    expect(daysBetween('2026-03-07', '2026-03-08', TZ)).toBe(1); // we say one
  });

  it('spans a whole year of DST transitions without drift', () => {
    // 2026-03-08 (23h) and 2026-11-01 (25h) both fall inside this range.
    expect(daysBetween('2026-01-01', '2027-01-01', TZ)).toBe(365);
    // Walking day by day must land on the same total.
    let cursor = '2026-01-01';
    let steps = 0;
    while (cursor !== '2027-01-01') {
      cursor = addDays(cursor, 1, TZ)!;
      steps += 1;
      if (steps > 400) break;
    }
    expect(steps).toBe(365);
  });
});

describe('timestamptz values resolve to their local calendar day', () => {
  it('projects an instant into active_tz', () => {
    // 04:00Z on the 30th is 00:00 EDT on the 30th — same calendar day.
    expect(toCivilDate('2026-07-30T04:00:00Z', TZ)).toBe('2026-07-30');
    // 03:59Z on the 30th is 23:59 EDT on the 29th — the PREVIOUS day locally.
    expect(toCivilDate('2026-07-30T03:59:00Z', TZ)).toBe('2026-07-29');
  });

  it('makes the midnight-timestamp trap visible', () => {
    // This is why deadlines are (date, time) and never a midnight timestamp.
    expect(toCivilDate('2026-08-10T00:00:00Z', TZ)).toBe('2026-08-09');
    expect(toCivilDate('2026-08-10', TZ)).toBe('2026-08-10');
  });

  it('does not shift a bare civil date by the timezone', () => {
    for (const tz of ['America/New_York', 'UTC', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      expect(toCivilDate('2026-08-10', tz)).toBe('2026-08-10');
      expect(daysBetween('2026-08-01', '2026-08-10', tz)).toBe(9);
    }
  });

  it('handles a timezone east of the line', () => {
    expect(toCivilDate('2026-07-29T20:00:00Z', 'Asia/Tokyo')).toBe('2026-07-30');
    expect(toCivilDate('2026-07-29T20:00:00Z', 'America/New_York')).toBe('2026-07-29');
  });
});

describe('degraded input returns null, never NaN and never a throw', () => {
  it.each([
    'not a date',
    '2026-13-01',
    '2026-02-30',
    '2026-00-10',
    '',
    '2026-8-1',
  ])('rejects %o', (bad) => {
    expect(daysBetween('2026-07-29', bad, TZ)).toBeNull();
    expect(daysBetween(bad, '2026-07-29', TZ)).toBeNull();
    expect(toCivilDate(bad, TZ)).toBeNull();
  });

  it('falls back to UTC on an unknown timezone rather than throwing', () => {
    expect(() => daysBetween('2026-07-29T12:00:00Z', '2026-07-30T12:00:00Z', 'Mars/Olympus')).not.toThrow();
    expect(daysBetween('2026-07-29T12:00:00Z', '2026-07-30T12:00:00Z', 'Mars/Olympus')).toBe(1);
  });
});

describe('civil day number round-trips', () => {
  it('is the identity over a long span', () => {
    for (let z = -20_000; z <= 30_000; z += 37) {
      expect(daysFromCivil(civilFromDays(z))).toBe(z);
    }
  });

  it('anchors on the epoch', () => {
    expect(daysFromCivil({ year: 1970, month: 1, day: 1 })).toBe(0);
    expect(daysFromCivil({ year: 2026, month: 7, day: 29 })).toBe(20_663);
  });
});

describe('addDays', () => {
  it('moves forward and backward across boundaries', () => {
    expect(addDays('2026-07-29', 12, TZ)).toBe('2026-08-10');
    expect(addDays('2026-08-10', -12, TZ)).toBe('2026-07-29');
    expect(addDays('2026-12-31', 1, TZ)).toBe('2027-01-01');
    expect(addDays('2026-03-08', -1, TZ)).toBe('2026-03-07'); // across spring forward
    expect(addDays('2026-11-01', -1, TZ)).toBe('2026-10-31'); // across fall back
    expect(addDays('2024-02-28', 1, TZ)).toBe('2024-02-29');
  });

  it('inverts daysBetween', () => {
    const start = '2026-07-29';
    for (const n of [-400, -31, -1, 0, 1, 14, 365]) {
      const shifted = addDays(start, n, TZ)!;
      expect(daysBetween(start, shifted, TZ)).toBe(n);
    }
  });
});

describe('weeksUntil', () => {
  it('is days over seven, signed', () => {
    expect(weeksUntil('2026-08-12', '2026-07-29', TZ)).toBeCloseTo(14 / 7, 10);
    expect(weeksUntil('2026-08-10', '2026-07-29', TZ)).toBeCloseTo(12 / 7, 10);
    expect(weeksUntil('2026-07-29', '2026-07-29', TZ)).toBe(0);
    expect(weeksUntil('2026-07-22', '2026-07-29', TZ)).toBeCloseTo(-1, 10);
  });
});

describe('week boundaries start Monday in active_tz', () => {
  it('knows the ISO day of week', () => {
    expect(isoDayOfWeek('2026-07-27', TZ)).toBe(1); // Monday
    expect(isoDayOfWeek('2026-07-29', TZ)).toBe(3); // Wednesday
    expect(isoDayOfWeek('2026-08-02', TZ)).toBe(7); // Sunday
  });

  it('anchors the week on Monday', () => {
    expect(startOfWeek('2026-07-29', TZ)).toBe('2026-07-27');
    expect(startOfWeek('2026-07-27', TZ)).toBe('2026-07-27'); // idempotent on Monday
    expect(startOfWeek('2026-08-02', TZ)).toBe('2026-07-27'); // Sunday belongs to the prior Monday
    expect(startOfWeek('2026-08-03', TZ)).toBe('2026-08-03'); // next Monday starts a new week
  });

  it('groups days into Monday-anchored weeks', () => {
    expect(sameWeek('2026-08-02', '2026-07-29', TZ)).toBe(true); // Sunday with its Wednesday
    expect(sameWeek('2026-08-03', '2026-07-29', TZ)).toBe(false); // Monday is a new week
  });
});

describe('daysSince — the D4 cold-start gates', () => {
  it('measures elapsed days for the 14- and 21-day thresholds', () => {
    const started = '2026-07-15';
    expect(daysSince(started, '2026-07-15', TZ)).toBe(0);
    expect(daysSince(started, '2026-07-28', TZ)).toBe(13); // balance still off
    expect(daysSince(started, '2026-07-29', TZ)).toBe(14); // balance switches on
    expect(daysSince(started, '2026-08-05', TZ)).toBe(21); // debt may release
  });

  it('works from a timestamptz start, resolved in active_tz', () => {
    expect(daysSince('2026-07-15T13:00:00Z', '2026-07-29', TZ)).toBe(14);
  });
});
