import type { Task } from './types.js';

/**
 * D5. Recurring tasks NEVER count toward demand: they are fixed overhead,
 * subtracted from available capacity before anything is allocated. Missed
 * recurrences never accumulate — the rule is skip forward to the next
 * occurrence — so a recurring task's cost is a steady rate, not a backlog.
 *
 * This converts a recurrence_rule into that rate. Only the RRULE subset TaskOS
 * writes is understood; anything else is reported rather than guessed at.
 */

const OCCURRENCES_PER_WEEK: Record<string, number> = {
  DAILY: 7,
  WEEKLY: 1,
  // 365.25 / 12 / 7 — a month is not four weeks, and pretending it is
  // understates monthly overhead by about 8%.
  MONTHLY: 365.25 / 12 / 7,
  YEARLY: 365.25 / 7 / 365.25,
};

export interface RecurringLoad {
  hoursPerWeek: number;
  perTask: Record<string, number>;
  unparsed: Array<{ task_id: string; rule: string | null | undefined; reason: string }>;
}

/** Occurrences per week implied by an RRULE-style string, or null if unreadable. */
export function occurrencesPerWeek(rule: string | null | undefined): number | null {
  if (!rule) return null;
  const parts = new Map<string, string>();
  for (const chunk of rule.split(';')) {
    const [k, v] = chunk.split('=');
    if (k && v) parts.set(k.trim().toUpperCase(), v.trim().toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (!freq) return null;
  const base = OCCURRENCES_PER_WEEK[freq];
  if (base === undefined) return null;

  const intervalRaw = parts.get('INTERVAL');
  const interval = intervalRaw === undefined ? 1 : Number(intervalRaw);
  if (!Number.isFinite(interval) || interval < 1) return null;

  // A weekly rule listing days recurs once per listed day.
  const byday = parts.get('BYDAY');
  const dayCount =
    freq === 'WEEKLY' && byday ? byday.split(',').filter((d) => d.length > 0).length : 1;

  return (base * dayCount) / interval;
}

/**
 * Fixed weekly overhead from the recurring tasks in a portfolio. Feeds
 * capacityCheck's `recurringHours` argument.
 */
export function recurringHoursPerWeek(tasks: readonly Task[]): RecurringLoad {
  const perTask: Record<string, number> = {};
  const unparsed: RecurringLoad['unparsed'] = [];
  let total = 0;

  for (const t of tasks) {
    if (!t.is_recurring) continue;
    const per = occurrencesPerWeek(t.recurrence_rule);
    if (per === null) {
      unparsed.push({
        task_id: t.id,
        rule: t.recurrence_rule,
        reason: 'unreadable recurrence_rule: its overhead is NOT reserved, so capacity is overstated',
      });
      continue;
    }
    const hours = (per * t.estimate_minutes) / 60;
    perTask[t.id] = hours;
    total += hours;
  }

  return { hoursPerWeek: total, perTask, unparsed };
}
