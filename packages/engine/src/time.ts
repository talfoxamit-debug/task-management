/**
 * Time utilities. D2.
 *
 * Every day boundary, week boundary and "today" in TaskOS resolves in
 * settings.active_tz. This module is the ONLY place that converts between an
 * instant and a calendar day, and `daysBetween` is written exactly once.
 *
 * The rule that forces this design: a calendar-day difference must never be
 * computed as (t2 - t1) / 86400000. In America/New_York there is a 23-hour day
 * in March and a 25-hour day in November, so millisecond division silently
 * returns 0.958 or 1.042 days across those boundaries. Truncated, that turns
 * "due tomorrow" into "due today" twice a year and corrupts every urgency
 * multiplier downstream.
 *
 * ZERO I/O: nothing here calls Date.now(), and no function infers the current
 * date. `today` is always an explicit argument coming from the caller.
 */

/** A calendar date with no time and no zone: `YYYY-MM-DD`. */
export type CivilDate = string;

/** Broken-down calendar date in some timezone. */
export interface CivilParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export const DEFAULT_TZ = 'America/New_York';

const CIVIL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A timestamptz: strict ISO-8601 date, then a time. Postgres emits either
 * `2026-07-29T13:00:00+00:00` or `2026-07-29 13:00:00+00`.
 *
 * Only strings matching this take the instant-parsing path. Everything else is
 * either a strict civil date or an error. `new Date()` is far too lenient to be
 * a fallback here: it accepts `2026-8-1` and silently rolls `2026-02-30`
 * forward to March 2nd, which would put a task's deadline on the wrong day.
 */
const INSTANT_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** Thrown-free parse: returns null rather than throwing, per D7. */
function parseCivilDate(input: string): CivilParts | null {
  const m = CIVIL_DATE_RE.exec(input);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject 2026-02-31 and friends: round-trip through the civil-day algorithm.
  const parts = civilFromDays(daysFromCivil({ year, month, day }));
  if (parts.year !== year || parts.month !== month || parts.day !== day) return null;
  return { year, month, day };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/**
 * Resolve any TaskOS time value to the calendar date it falls on in `tz`.
 *
 * - `YYYY-MM-DD` is already a civil date (a Postgres `date`). It is returned
 *   as-is and is NOT shifted by the timezone: a due_date of 2026-08-10 means
 *   the 10th in active_tz, not an instant.
 * - anything else is parsed as an instant (a timestamptz) and projected into
 *   `tz` to find the local calendar day.
 *
 * Returns null on unparseable input; callers surface that as an error rather
 * than throwing (D7).
 */
export function civilPartsIn(value: string, tz: string = DEFAULT_TZ): CivilParts | null {
  const direct = parseCivilDate(value);
  if (direct) return direct;

  const m = INSTANT_RE.exec(value);
  if (!m) return null;

  const datePart = parseCivilDate(m[1]!);
  if (!datePart) return null; // e.g. 2026-02-30T09:00:00Z

  // No offset means no instant to project: an unzoned datetime's calendar day
  // is simply its own date part. Postgres timestamptz always carries an offset,
  // so this branch only catches hand-written input.
  if (!m[3]) return datePart;

  // Normalise a Postgres-style `+00` offset to the `+00:00` JS requires.
  const offset = /^[+-]\d{2}$/.test(m[3]) ? `${m[3]}:00` : m[3];
  const instant = new Date(`${m[1]}T${m[2]}${offset}`);
  if (Number.isNaN(instant.getTime())) return null;

  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = zonedFormatter(tz).formatToParts(instant);
  } catch {
    // Unknown timezone identifier: fall back to UTC rather than throwing.
    parts = zonedFormatter('UTC').formatToParts(instant);
  }
  const get = (type: string) => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return { year, month, day };
}

/** Normalise any TaskOS time value to a `YYYY-MM-DD` civil date in `tz`. */
export function toCivilDate(value: string, tz: string = DEFAULT_TZ): CivilDate | null {
  const p = civilPartsIn(value, tz);
  return p ? formatCivil(p) : null;
}

export function formatCivil(p: CivilParts): CivilDate {
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

/**
 * Days since 1970-01-01 for a proleptic Gregorian calendar date.
 * Howard Hinnant's days_from_civil: pure integer arithmetic, so it cannot be
 * perturbed by DST, leap seconds, or a host timezone.
 */
export function daysFromCivil({ year, month, day }: CivilParts): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400; // [0, 399]
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** Inverse of daysFromCivil. */
export function civilFromDays(z: number): CivilParts {
  const zz = z + 719468;
  const era = Math.floor((zz >= 0 ? zz : zz - 146096) / 146097);
  const doe = zz - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const m = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return { year: y + (m <= 2 ? 1 : 0), month: m, day: d };
}

/**
 * THE calendar-day difference. Positive when `b` is later than `a`.
 *
 * daysBetween('2026-07-29', '2026-08-10') === 12
 *
 * Both arguments are resolved to their calendar day in `tz` first, then
 * subtracted as integers. Crossing a DST boundary changes nothing: the 23-hour
 * and 25-hour days are still exactly one calendar day apart.
 *
 * Returns null when either side is unparseable, so callers can report the
 * reason instead of propagating NaN.
 */
export function daysBetween(a: string, b: string, tz: string = DEFAULT_TZ): number | null {
  const pa = civilPartsIn(a, tz);
  const pb = civilPartsIn(b, tz);
  if (!pa || !pb) return null;
  return daysFromCivil(pb) - daysFromCivil(pa);
}

/** Shift a civil date by whole days. Never crosses into instant arithmetic. */
export function addDays(date: string, n: number, tz: string = DEFAULT_TZ): CivilDate | null {
  const p = civilPartsIn(date, tz);
  if (!p) return null;
  return formatCivil(civilFromDays(daysFromCivil(p) + Math.trunc(n)));
}

/**
 * Fractional weeks from `today` until `date`. Negative when `date` has passed.
 * Built on daysBetween, so it inherits the DST-proof property.
 */
export function weeksUntil(date: string, today: string, tz: string = DEFAULT_TZ): number | null {
  const d = daysBetween(today, date, tz);
  return d === null ? null : d / 7;
}

/** ISO day of week in `tz`: 1 = Monday .. 7 = Sunday. */
export function isoDayOfWeek(date: string, tz: string = DEFAULT_TZ): number | null {
  const p = civilPartsIn(date, tz);
  if (!p) return null;
  // 1970-01-01 was a Thursday (ISO 4).
  const dn = daysFromCivil(p);
  return ((((dn + 3) % 7) + 7) % 7) + 1;
}

/** Monday of the week containing `date`. Weeks start Monday 00:00 active_tz (D2). */
export function startOfWeek(date: string, tz: string = DEFAULT_TZ): CivilDate | null {
  const dow = isoDayOfWeek(date, tz);
  if (dow === null) return null;
  return addDays(date, -(dow - 1), tz);
}

/** True when `date` falls in the same Monday-anchored week as `reference`. */
export function sameWeek(date: string, reference: string, tz: string = DEFAULT_TZ): boolean {
  const a = startOfWeek(date, tz);
  const b = startOfWeek(reference, tz);
  return a !== null && a === b;
}

/** Inclusive comparisons that read as intent at the call sites. */
export function isBefore(a: string, b: string, tz: string = DEFAULT_TZ): boolean {
  const d = daysBetween(a, b, tz);
  return d !== null && d > 0;
}

export function isOnOrBefore(a: string, b: string, tz: string = DEFAULT_TZ): boolean {
  const d = daysBetween(a, b, tz);
  return d !== null && d >= 0;
}

/**
 * Whole days elapsed since `since` as of `today`. Used for the cold-start gates
 * in D4 (balance corrector at 14 days, attention-debt release at 21).
 */
export function daysSince(since: string, today: string, tz: string = DEFAULT_TZ): number | null {
  return daysBetween(since, today, tz);
}
