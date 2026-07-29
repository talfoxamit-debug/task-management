import type { Criticality, TaskContext, Venture } from '@taskos/engine';

/**
 * Proposals for process_inbox. Deterministic keyword rules, no model call —
 * there is no Anthropic API key in this system and no LLM in this code path.
 *
 * These are PROPOSALS. Every one comes back with the reason it was proposed and
 * a `certain` flag, because Tal confirms them; a guess presented as a parse is
 * worse than no guess at all.
 */

export interface Proposal<T> {
  value: T;
  reason: string;
  certain: boolean;
}

export interface InboxProposal {
  task_id: string;
  text: string;
  venture: Proposal<{ id: string; slug: string } | null>;
  project: Proposal<{ id: string; name: string } | null>;
  criticality: Proposal<Criticality>;
  context: Proposal<TaskContext>;
  estimate_minutes: Proposal<number>;
  value: Proposal<number>;
}

const CONTEXT_KEYWORDS: Array<[TaskContext, RegExp]> = [
  ['calls', /\b(call|calls|phone|zoom|meeting|meet|standup|interview|demo call)\b/i],
  ['review', /\b(review|reviews|proofread|check over|read through|audit|sign off)\b/i],
  ['errands', /\b(pick up|drop off|post office|store|bank|dmv|errand|courier)\b/i],
  ['physical', /\b(gym|run|swim|workout|move|carry|clean|install|assemble)\b/i],
  ['creative', /\b(copy|copywriting|logo|brand|design|landing page|pricing page|one-pager|photos|video)\b/i],
  [
    'deep_work',
    /\b(build|code|implement|refactor|debug|architect|migrate|write the|integrate|integration|api|schema|wire|wiring|deploy|provision|endpoint|webhook|database|query|script|keys)\b/i,
  ],
  ['admin', /\b(invoice|invoicing|file|filing|pay|renew|submit|tax|insurance|licen[cs]e|receipt|expense)\b/i],
];

const DEFAULT_ESTIMATE_BY_CONTEXT: Record<TaskContext, number> = {
  deep_work: 90,
  calls: 30,
  admin: 20,
  errands: 45,
  creative: 60,
  review: 30,
  physical: 45,
};

const BLOCKING = /\b(blocked on|blocker|must|before .* can|required for|cannot ship|launch|go live|prerequisite)\b/i;
const ENABLING = /\b(prep|prepare|draft|set up|groundwork|unblock|helps|so that)\b/i;
const OPTIONAL = /\b(maybe|someday|nice to have|if there is time|eventually|consider)\b/i;

const HIGH_VALUE = /\b(urgent|critical|revenue|sale|paying|client is waiting|launch|deadline|overdue|contract)\b/i;
const LOW_VALUE = /\b(maybe|someday|nice to have|tidy|cosmetic|cleanup)\b/i;

const QUICK = /\b(quick|quickly|five minutes|5 ?min|tiny|small)\b/i;

/** An explicit duration written into the text always beats the default. */
export function explicitMinutes(text: string): number | null {
  const hours = /\b(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i.exec(text);
  if (hours) {
    const n = Number(hours[1]);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 60);
  }
  const mins = /\b(\d+)\s*(?:m|min|mins|minute|minutes)\b/i.exec(text);
  if (mins) {
    const n = Number(mins[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/** Extra words that should point at a venture but are not in its name. */
const VENTURE_ALIASES: Record<string, string[]> = {
  yachtyhub: ['yacht', 'yachts', 'yachty', 'foxstays', 'charter', 'boat', 'marina', 'slip', 'dock'],
  stackwrk: ['stack', 'stackwork'],
  seatop: ['seatop', 'listing', 'realtor', 'lead', 'buyer', 'seller', 'proposal'],
  foxsolutions: ['client', 'freelance', 'retainer', 'consulting'],
  octo: ['octo', 'prototype'],
};

export function proposeVenture(
  text: string,
  ventures: readonly Venture[],
): Proposal<{ id: string; slug: string } | null> {
  const t = text.toLowerCase();
  const candidates = ventures.filter((v) => v.slug !== 'unsorted');

  const hits: Array<{ v: Venture; word: string }> = [];
  for (const v of candidates) {
    const words = [v.slug, ...tokens(v.name), ...(VENTURE_ALIASES[v.slug] ?? [])];
    for (const w of new Set(words)) {
      if (w.length > 2 && new RegExp(`\\b${w}\\b`, 'i').test(t)) {
        hits.push({ v, word: w });
        break;
      }
    }
  }

  if (hits.length === 1) {
    const hit = hits[0]!;
    return {
      value: { id: hit.v.id, slug: hit.v.slug },
      reason: `the text mentions "${hit.word}"`,
      certain: true,
    };
  }
  if (hits.length > 1) {
    return {
      value: { id: hits[0]!.v.id, slug: hits[0]!.v.slug },
      reason: `ambiguous: matched ${hits.map((h) => `${h.v.slug} ("${h.word}")`).join(' and ')} — confirm which`,
      certain: false,
    };
  }
  return { value: null, reason: 'no venture named or implied in the text', certain: false };
}

export function proposeProject(
  text: string,
  ventureId: string | null,
  projects: ReadonlyArray<{ id: string; name: string; venture_id: string; status: string }>,
): Proposal<{ id: string; name: string } | null> {
  if (!ventureId) {
    return { value: null, reason: 'no venture proposed, so no project can be', certain: false };
  }
  const textTokens = new Set(tokens(text));
  let best: { id: string; name: string; overlap: number } | null = null;
  for (const p of projects) {
    if (p.venture_id !== ventureId || p.status !== 'active') continue;
    const overlap = tokens(p.name).filter((w) => textTokens.has(w)).length;
    if (overlap > 0 && (best === null || overlap > best.overlap)) {
      best = { id: p.id, name: p.name, overlap };
    }
  }
  if (best) {
    return {
      value: { id: best.id, name: best.name },
      reason: `${best.overlap} word(s) overlap with project "${best.name}"`,
      certain: best.overlap > 1,
    };
  }
  return {
    value: null,
    reason: 'no active project in that venture shares wording with the text',
    certain: false,
  };
}

export function proposeCriticality(text: string): Proposal<Criticality> {
  if (BLOCKING.test(text)) {
    return { value: 'blocking', reason: 'the text reads as something else waits on it', certain: false };
  }
  if (OPTIONAL.test(text)) {
    return { value: 'optional', reason: 'the text hedges ("maybe", "someday")', certain: false };
  }
  if (ENABLING.test(text)) {
    return { value: 'enabling', reason: 'the text reads as preparation for other work', certain: false };
  }
  return {
    value: 'supporting',
    reason: 'nothing marks it as blocking or optional, so the safe default applies',
    certain: false,
  };
}

export function proposeContext(text: string): Proposal<TaskContext> {
  for (const [ctx, re] of CONTEXT_KEYWORDS) {
    const m = re.exec(text);
    if (m) return { value: ctx, reason: `matched "${m[0]}"`, certain: true };
  }
  return { value: 'admin', reason: 'no context keyword matched, defaulting to admin', certain: false };
}

export function proposeEstimate(text: string, context: TaskContext): Proposal<number> {
  const explicit = explicitMinutes(text);
  if (explicit !== null) {
    return { value: explicit, reason: `the text says ${explicit} minutes`, certain: true };
  }
  if (QUICK.test(text)) {
    return { value: 15, reason: 'the text calls it quick', certain: false };
  }
  return {
    value: DEFAULT_ESTIMATE_BY_CONTEXT[context],
    reason: `no duration given, using the default for ${context}`,
    certain: false,
  };
}

export function proposeValue(text: string): Proposal<number> {
  if (HIGH_VALUE.test(text)) {
    const m = HIGH_VALUE.exec(text)!;
    return { value: 8, reason: `matched "${m[0]}"`, certain: false };
  }
  if (LOW_VALUE.test(text)) {
    const m = LOW_VALUE.exec(text)!;
    return { value: 3, reason: `matched "${m[0]}"`, certain: false };
  }
  return { value: 5, reason: 'nothing signals unusual value, using the midpoint', certain: false };
}

export function proposeForText(
  task: { id: string; title: string; notes?: string | null },
  ventures: readonly Venture[],
  projects: ReadonlyArray<{ id: string; name: string; venture_id: string; status: string }>,
): InboxProposal {
  const text = [task.title, task.notes ?? ''].join(' ').trim();
  const venture = proposeVenture(text, ventures);
  const project = proposeProject(text, venture.value?.id ?? null, projects);
  const context = proposeContext(text);
  return {
    task_id: task.id,
    text: task.title,
    venture,
    project,
    criticality: proposeCriticality(text),
    context,
    estimate_minutes: proposeEstimate(text, context.value),
    value: proposeValue(text),
  };
}
