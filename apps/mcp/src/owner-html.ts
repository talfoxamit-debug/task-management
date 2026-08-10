import { esc, flashFor, shellFor } from './delegate-html.js';
import type { OwnerTask, OwnerView } from './owner-page.js';

/**
 * What Tal sees.
 *
 * Same construction as the delegate page and for the same reasons — zero
 * JavaScript, forms and 303s, escaped at every interpolation — but a different
 * shape, because it answers a different question. Othman's page asks "what do I
 * do next"; this one asks "what is going to slip", which is the only question
 * this whole system exists to answer.
 *
 * So the order is not a priority ranking dressed up as a list. It is: what is
 * already late, what today looks like hour by hour, what is nearly finished and
 * needs minutes of judgement, and who is stuck. Anything further down is
 * reference.
 */

function tasksList(items: readonly OwnerTask[], base: string, showOver: boolean): string {
  return items
    .map((t) => {
      const over =
        showOver && t.days_over !== null && t.days_over > 0
          ? `<span class="due">${esc(t.days_over)}d overdue</span> · `
          : t.deadline_date
            ? `<span class="due">due ${esc(t.deadline_date)}</span> · `
            : '';
      const prep = t.prepared_summary
        ? `<div class="notes">Drafted: ${esc(t.prepared_summary)}</div>`
        : '';
      return `<article>
  <h3>${esc(t.title)}</h3>
  <p class="meta">${over}${esc(t.venture)} · ${esc(t.estimate_minutes)} min</p>
  ${prep}
  <form method="post" action="${esc(base)}/close">
    <input type="hidden" name="task_id" value="${esc(t.id)}">
    <button type="submit" class="quiet">Done</button>
  </form>
</article>`;
    })
    .join('');
}

export function renderOwnerPage(
  view: OwnerView,
  opts: { base: string; flash?: string | null },
): string {
  const flash = flashFor(opts.flash);
  const parts: string[] = [];

  parts.push(`<header>
  <h1>${esc(view.today)}${view.day_venture ? ` · ${esc(view.day_venture)}` : ''}</h1>
  <p>${esc(view.counts.open)} open${view.counts.inbox > 0 ? ` · ${esc(view.counts.inbox)} in inbox` : ''}</p>
</header>`);

  if (flash) parts.push(`<div class="flash ${flash.tone}">${esc(flash.text)}</div>`);

  if (view.rotated) {
    parts.push(
      `<div class="banner">A newer link for this page exists. This one still works for a
       little while — bookmark the new one.</div>`,
    );
  }

  if (view.just_closed.length > 0) {
    parts.push('<h2 class="section">Just done</h2>');
    parts.push(
      view.just_closed
        .map(
          (t) => `<article>
  <h3>${esc(t.title)}</h3>
  <p class="meta">Undo is available for a few more minutes.</p>
  <form method="post" action="${esc(opts.base)}/undo">
    <input type="hidden" name="task_id" value="${esc(t.id)}">
    <button type="submit" class="quiet">Undo</button>
  </form>
</article>`,
        )
        .join(''),
    );
  }

  // Late first. Nothing else on this page is more important than work that has
  // already missed its date.
  if (view.overdue.length > 0) {
    parts.push(`<h2 class="section">Overdue (${esc(view.overdue.length)})</h2>`);
    parts.push(tasksList(view.overdue, opts.base, true));
  }

  if (view.plan.length > 0) {
    parts.push('<h2 class="section">Today, in order</h2>');
    parts.push(
      `<article>${view.plan
        .map((s) => {
          const marks: string[] = [];
          if (s.review_of_draft) marks.push('review');
          if (s.ai_can_prepare) marks.push('Claude drafts first');
          if (s.uses_flex) marks.push('flex');
          const tag = marks.length > 0 ? ` <span class="unblocks">${esc(marks.join(' · '))}</span>` : '';
          const after =
            s.after && s.after.length > 0 ? ` · after ${esc(s.after.join(', '))}` : '';
          return `<div class="slot"><b>${esc(s.start)}–${esc(s.end)}</b> ${esc(s.title)}${tag}
        <div class="who">${esc(s.venture)}${after}</div></div>`;
        })
        .join('')}</article>`,
    );
  } else if (view.plan_note) {
    // An empty schedule with no explanation reads as "nothing to do today".
    parts.push('<h2 class="section">Today, in order</h2>');
    parts.push(`<article><p class="empty">${esc(view.plan_note)}</p></article>`);
  }

  if (view.awaiting_review.length > 0) {
    parts.push(`<h2 class="section">Drafted, waiting on you (${esc(view.awaiting_review.length)})</h2>`);
    parts.push(
      `<p class="empty">None of these are sent. Each needs your judgement, then sending.</p>`,
    );
    parts.push(tasksList(view.awaiting_review, opts.base, false));
  }

  if (view.blocked.length > 0 || view.unread_comments > 0) {
    parts.push('<h2 class="section">Delegated</h2>');
    const rows = view.blocked
      .map(
        (b) =>
          `<li><b>${esc(b.person)} blocked ${esc(b.days)}d</b> · ${esc(b.title)}</li>`,
      )
      .join('');
    const unread =
      view.unread_comments > 0
        ? `<li>${esc(view.unread_comments)} unread comment(s) — ask Claude for delegation_inbox</li>`
        : '';
    parts.push(`<article><ul class="past">${rows}${unread}</ul></article>`);
  }

  if (view.due_soon.length > 0) {
    parts.push(`<h2 class="section">Next 7 days</h2>`);
    parts.push(tasksList(view.due_soon, opts.base, false));
  }

  if (view.milestones.length > 0) {
    parts.push('<h2 class="section">Milestones</h2>');
    parts.push(
      `<article><ul class="past">${view.milestones
        .map(
          (m) =>
            `<li><b>${esc(m.name)}</b> · ${esc(m.venture)} · ${
              m.days < 0 ? `${esc(Math.abs(m.days))}d overdue` : m.days === 0 ? 'today' : `in ${esc(m.days)}d`
            }${m.hard ? ' (hard)' : ''}</li>`,
        )
        .join('')}</ul></article>`,
    );
  }

  if (
    view.overdue.length === 0 &&
    view.plan.length === 0 &&
    view.due_soon.length === 0 &&
    view.awaiting_review.length === 0
  ) {
    parts.push('<p class="empty">Nothing overdue, nothing scheduled, nothing waiting.</p>');
  }

  parts.push(`<footer>
  <p>Dates in ${esc(view.timezone)}. This page can mark work done and undo it, and nothing else —
     it cannot delete, kill or edit anything.</p>
  <p>This link is the credential for your whole portfolio. Do not forward it. Ask Claude to
     revoke it if it ends up somewhere it should not be.</p>
</footer>`);

  return shellFor(`TaskOS · ${view.today}`, parts.join('\n'), EXTRA_STYLE);
}

const EXTRA_STYLE = `
.slot { padding:.4rem 0; border-bottom:1px solid var(--line); font-size:.95rem; }
.slot:last-child { border-bottom:0; }
.slot .who { color:var(--dim); font-size:.8rem; }
`;
