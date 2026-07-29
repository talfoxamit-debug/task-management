import { describe, expect, it } from 'vitest';
import type { Venture } from '@taskos/engine';
import {
  explicitMinutes,
  proposeContext,
  proposeCriticality,
  proposeEstimate,
  proposeProject,
  proposeValue,
  proposeVenture,
} from '../src/propose.js';

/**
 * The proposal rules. Deterministic keyword matching, so they are testable
 * exactly — and worth testing, because a proposal that is confidently wrong
 * costs more attention than one that admits it does not know.
 */

const ventures: Venture[] = [
  { id: 'v1', name: 'FoxStays / YachtyHub', slug: 'yachtyhub', strategic_weight: 1.3, floor_share: 0.1, ceiling_share: 0.6, active: true },
  { id: 'v2', name: 'Stackwrk', slug: 'stackwrk', strategic_weight: 1.2, floor_share: 0.08, ceiling_share: 0.55, active: true },
  { id: 'v3', name: 'Seatop Homes', slug: 'seatop', strategic_weight: 1.3, floor_share: 0.07, ceiling_share: 0.5, active: true },
  { id: 'v4', name: 'Fox Solutions', slug: 'foxsolutions', strategic_weight: 1.0, floor_share: 0.1, ceiling_share: 0.5, active: true },
  { id: 'v5', name: 'Octo', slug: 'octo', strategic_weight: 0.5, floor_share: 0.03, ceiling_share: 0.3, active: true },
  { id: 'v6', name: 'Unsorted inbox', slug: 'unsorted', strategic_weight: 0.3, floor_share: 0, ceiling_share: 0.1, active: false },
];

describe('proposeVenture', () => {
  it('matches a slug, a name word, or an alias', () => {
    expect(proposeVenture('stackwrk pricing page', ventures).value?.slug).toBe('stackwrk');
    expect(proposeVenture('call the marina', ventures).value?.slug).toBe('yachtyhub');
    expect(proposeVenture('Octo prototype', ventures).value?.slug).toBe('octo');
  });

  it('gives the reason, so a wrong guess is visible', () => {
    expect(proposeVenture('book a charter', ventures).reason).toContain('charter');
  });

  it('admits ambiguity instead of picking silently', () => {
    const p = proposeVenture('send the client a yacht listing', ventures);
    expect(p.certain).toBe(false);
    expect(p.reason).toContain('ambiguous');
    expect(p.reason).toContain('confirm which');
  });

  it('proposes nothing when nothing is implied', () => {
    const p = proposeVenture('renew the insurance certificate', ventures);
    expect(p.value).toBeNull();
    expect(p.certain).toBe(false);
  });

  it('never proposes the holding venture', () => {
    expect(proposeVenture('unsorted inbox thing', ventures).value?.slug).not.toBe('unsorted');
  });

  it('is not fooled by a substring', () => {
    // "docking" contains "dock" but is not the word.
    expect(proposeVenture('reading about docking procedures', ventures).value).toBeNull();
  });
});

describe('proposeProject', () => {
  const projects = [
    { id: 'p1', name: 'Launch readiness', venture_id: 'v1', status: 'active' },
    { id: 'p2', name: 'Listings data pipeline', venture_id: 'v1', status: 'active' },
    { id: 'p3', name: 'Old paused thing', venture_id: 'v1', status: 'paused' },
  ];

  it('matches on shared wording and reports the overlap', () => {
    const p = proposeProject('fix the listings pipeline importer', 'v1', projects);
    expect(p.value?.name).toBe('Listings data pipeline');
    expect(p.certain).toBe(true);
  });

  it('is uncertain on a single word overlap', () => {
    expect(proposeProject('launch something', 'v1', projects).certain).toBe(false);
  });

  it('ignores paused projects and other ventures', () => {
    expect(proposeProject('old paused thing', 'v1', projects).value).toBeNull();
    expect(proposeProject('launch readiness', 'v2', projects).value).toBeNull();
  });

  it('proposes nothing without a venture', () => {
    expect(proposeProject('launch readiness', null, projects).value).toBeNull();
  });
});

describe('proposeCriticality', () => {
  it('reads blocking, enabling and optional language', () => {
    expect(proposeCriticality('blocked on the API keys').value).toBe('blocking');
    expect(proposeCriticality('must ship before launch').value).toBe('blocking');
    expect(proposeCriticality('prep the deck').value).toBe('enabling');
    expect(proposeCriticality('maybe redo the logo someday').value).toBe('optional');
  });

  it('defaults to supporting, and never claims certainty', () => {
    const p = proposeCriticality('email the accountant');
    expect(p.value).toBe('supporting');
    expect(p.certain).toBe(false);
  });
});

describe('proposeContext', () => {
  it.each([
    ['call the broker back', 'calls'],
    ['review the contract', 'review'],
    ['pick up the keys from the post office', 'errands'],
    ['gym session', 'physical'],
    ['redo the landing page copy', 'creative'],
    ['implement the importer', 'deep_work'],
    ['wire Stripe live keys', 'deep_work'],
    ['submit the sales tax filing', 'admin'],
  ])('%s -> %s', (text, expected) => {
    expect(proposeContext(text).value).toBe(expected);
  });

  it('falls back to admin, and says the fallback happened', () => {
    const p = proposeContext('think about the thing');
    expect(p.value).toBe('admin');
    expect(p.certain).toBe(false);
    expect(p.reason).toContain('defaulting');
  });
});

describe('proposeEstimate', () => {
  it('reads an explicit duration and trusts it', () => {
    expect(explicitMinutes('spend 45 minutes on it')).toBe(45);
    expect(explicitMinutes('about 2 hours')).toBe(120);
    expect(explicitMinutes('1.5h of work')).toBe(90);
    expect(explicitMinutes('no duration here')).toBeNull();
    expect(proposeEstimate('spend 45 minutes on it', 'admin').certain).toBe(true);
  });

  it('prefers hours over minutes when both appear', () => {
    expect(explicitMinutes('2 hours 30 minutes')).toBe(120);
  });

  it('uses the context default otherwise', () => {
    expect(proposeEstimate('build the thing', 'deep_work').value).toBe(90);
    expect(proposeEstimate('file it', 'admin').value).toBe(20);
    expect(proposeEstimate('quick fix', 'deep_work').value).toBe(15);
  });
});

describe('proposeValue', () => {
  it('raises value on revenue and deadline language', () => {
    expect(proposeValue('urgent: the client is waiting').value).toBe(8);
    expect(proposeValue('this blocks revenue').value).toBe(8);
  });

  it('lowers it on hedging language', () => {
    expect(proposeValue('tidy the repo someday').value).toBe(3);
  });

  it('defaults to the midpoint and never claims certainty', () => {
    const p = proposeValue('update the docs');
    expect(p.value).toBe(5);
    expect(p.certain).toBe(false);
  });
});
