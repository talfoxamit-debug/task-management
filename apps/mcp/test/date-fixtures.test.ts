import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import baseline from './date-fixtures.baseline.json' with { type: 'json' };

/**
 * THE GUARD FOR AN ABSOLUTE-DATE FIXTURE.
 *
 * This is a defect CLASS, not a bug. Four times now a test has been written
 * with a hardcoded date that was in the future on the day it was written:
 *
 *   - the seed's 2026-08-08/10/12, which broke five tests across three files;
 *   - the same seed dates again, patched a second time;
 *   - next_actions' milestone due 2026-08-20, which went past and drove the
 *     required hours to zero, so "does not cap the rate at usable" started
 *     asserting 0 > 0.8;
 *   - tenancy's milestone due 2026-09-01, same failure, different file.
 *
 * The shape is always identical and it is why the family is invisible: the test
 * passes when written, passes in review, passes in CI for months, and then
 * fails on an ordinary morning in a file nobody touched. The person who has to
 * diagnose it has no reason to suspect the calendar.
 *
 * The rule is: a date in a fixture is written RELATIVE to today —
 * `current_date + N` in SQL, an offset helper in TypeScript — and the assertion
 * is written against the same offset.
 *
 * SHIPPED AS A RATCHET, deliberately. There are pre-existing literals in this
 * suite and a check that fails on all of them is a check that gets deleted
 * within a day, leaving neither the guard nor the fix. So the baseline is
 * checked in, the count per file may only go DOWN, and a new one fails the
 * build. Shrink the baseline as fixtures are converted.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;

function countIn(file: string): number {
  const text = readFileSync(path.join(here, file), 'utf8');
  return Array.from(text.matchAll(DATE)).length;
}

// This file is excluded: it plants a violation on purpose, below.
const SELF = 'date-fixtures.test.ts';
const files = readdirSync(here).filter((f) => f.endsWith('.test.ts') && f !== SELF);
const known = baseline as Record<string, number>;

describe('absolute dates in test fixtures', () => {
  it('does not appear in any file that had none', () => {
    const added = files.filter((f) => !(f in known) && countIn(f) > 0);
    expect(
      added,
      'A hardcoded YYYY-MM-DD in a fixture is a test that will fail on a future morning ' +
        'for no reason anyone can trace. Use a date relative to today instead ' +
        '(current_date + N in SQL). If it is genuinely a fixed historical date, add the ' +
        'file to date-fixtures.baseline.json with a note saying why.',
    ).toEqual([]);
  });

  it('does not grow in a file that already had some', () => {
    const grown = Object.entries(known)
      .map(([file, allowed]) => ({ file, allowed, now: countIn(file) }))
      .filter((r) => r.now > r.allowed);
    expect(grown, 'the ratchet only turns one way: convert one before adding one').toEqual([]);
  });

  it('reports a file that has improved, so the baseline can be tightened', () => {
    // Not a failure. A baseline that never shrinks stops being a ratchet and
    // becomes a permanent exemption list.
    const stale = Object.entries(known)
      .map(([file, allowed]) => ({ file, allowed, now: countIn(file) }))
      .filter((r) => r.now < r.allowed);
    if (stale.length > 0) {
      console.warn(
        'date-fixtures baseline is loose; lower these:',
        stale.map((s) => `${s.file}: ${s.allowed} -> ${s.now}`).join(', '),
      );
    }
    expect(true).toBe(true);
  });

  it('detects a planted violation, so an empty result is a real result', () => {
    // An empty result from a broken matcher is indistinguishable from good
    // news. This proves the matcher works before the two tests above are
    // allowed to report all-clear.
    const planted = ['due_date: ', '2026', '-12-25, deadline: ', '2020', '-01-01'].join('');
    expect(Array.from(planted.matchAll(DATE))).toHaveLength(2);
    expect(Array.from('id: abc-123-456'.matchAll(DATE))).toHaveLength(0);
  });
});
