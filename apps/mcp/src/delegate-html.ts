import type { DelegateTask, DelegateView, ClosedTask } from './delegate-data.js';

/**
 * The page Othman and Saar actually open.
 *
 * ZERO JAVASCRIPT, and that is a decision rather than minimalism. This page is
 * opened from a WhatsApp link on a phone with one bar of signal, by somebody who
 * is not going to install anything, debug anything, or tell Tal it did not work
 * — they will just close it, and the task will sit. Plain forms and 303
 * redirects work in every browser that has ever existed, degrade to nothing, and
 * cannot half-load.
 *
 * EVERY INTERPOLATION GOES THROUGH esc(). Task titles and notes are written by
 * Tal, comments by delegates; none of it is trusted here, because the cost of
 * being wrong once is script execution on a page that holds a live credential in
 * its own URL. The token itself is escaped too even though it is regex-validated
 * upstream — defence that depends on a check in another file is defence that
 * disappears when that file is edited.
 *
 * Nothing user-supplied is ever echoed from the query string. Flash messages are
 * looked up from a fixed table by code, so a crafted URL cannot put text on the
 * page at all, let alone markup.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/**
 * The only messages this page can display, by code.
 *
 * A whitelist rather than a message in the URL: reflected text is the classic
 * way a server-rendered page acquires an XSS hole, and nothing here needs the
 * flexibility.
 */
const FLASH: Record<string, { tone: 'ok' | 'bad'; text: string }> = {
  done: { tone: 'ok', text: 'Marked done. Thanks.' },
  sent: { tone: 'ok', text: 'Sent to Tal.' },
  flagged: { tone: 'ok', text: 'Flagged for Tal — he will see it.' },
  undone: { tone: 'ok', text: 'Put back on your list.' },
  notyours: { tone: 'bad', text: 'That one is not on your list.' },
  toolate: { tone: 'bad', text: 'Too late to undo that one — tell Tal.' },
  empty: { tone: 'bad', text: 'Nothing was written — the message was empty.' },
  toolong: { tone: 'bad', text: 'That message was too long to save.' },
  failed: { tone: 'bad', text: 'That did not go through. Try again.' },
};

export function flashFor(code: string | null | undefined) {
  return code && Object.prototype.hasOwnProperty.call(FLASH, code) ? FLASH[code]! : null;
}

const STYLE = `
:root { color-scheme: light dark; --fg:#16181d; --dim:#5b6270; --line:#e2e5ea; --bg:#fbfbfc;
        --card:#fff; --accent:#1b6ef3; --warn:#b4441a; --ok:#0d7a4a; }
@media (prefers-color-scheme: dark) {
  :root { --fg:#e8eaee; --dim:#9aa2b1; --line:#2a2f3a; --bg:#121419; --card:#191c23;
          --accent:#6ba4ff; --warn:#ff9b6b; --ok:#4fd39a; }
}
* { box-sizing: border-box; }
body { margin:0; padding:0 0 4rem; background:var(--bg); color:var(--fg);
       font:16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 42rem; margin:0 auto; padding:1.25rem 1rem; }
header h1 { font-size:1.4rem; margin:0 0 .25rem; }
header p { margin:0; color:var(--dim); font-size:.9rem; }
.flash { margin:1rem 0; padding:.75rem 1rem; border-radius:.6rem; font-weight:600; }
.flash.ok { background:rgba(13,122,74,.12); color:var(--ok); }
.flash.bad { background:rgba(180,68,26,.12); color:var(--warn); }
.banner { margin:1rem 0; padding:.75rem 1rem; border:1px solid var(--line);
          border-radius:.6rem; color:var(--dim); font-size:.9rem; }
h2.section { font-size:.8rem; text-transform:uppercase; letter-spacing:.06em;
             color:var(--dim); margin:2rem 0 .5rem; }
article { background:var(--card); border:1px solid var(--line); border-radius:.8rem;
          padding:1rem; margin:0 0 .85rem; }
article.attention { border-color:var(--warn); }
article h3 { margin:0 0 .35rem; font-size:1.05rem; line-height:1.35; }
.meta { margin:0 0 .5rem; color:var(--dim); font-size:.85rem; }
.meta .due { color:var(--warn); font-weight:600; }
.notes { margin:.5rem 0; padding:.6rem .75rem; background:var(--bg);
         border-radius:.45rem; white-space:pre-wrap; font-size:.92rem; }
.unblocks { margin:.5rem 0 0; font-size:.85rem; color:var(--accent); font-weight:600; }
ul.thread { list-style:none; margin:.75rem 0 0; padding:0; border-top:1px solid var(--line); }
ul.thread li { padding:.5rem 0 0; font-size:.9rem; }
ul.thread .who { color:var(--dim); font-size:.78rem; }
form { margin:.85rem 0 0; }
form.row { display:flex; gap:.5rem; align-items:flex-end; flex-wrap:wrap; }
label { display:block; font-size:.85rem; color:var(--dim); }
input[type=number] { width:7.5rem; }
input, textarea { font:inherit; padding:.5rem .6rem; border:1px solid var(--line);
                  border-radius:.45rem; background:var(--bg); color:var(--fg); width:100%; }
textarea { min-height:4.5rem; resize:vertical; }
button { font:inherit; font-weight:600; padding:.6rem 1.1rem; border:0; border-radius:.5rem;
         background:var(--accent); color:#fff; cursor:pointer; }
button.quiet { background:transparent; color:var(--accent); border:1px solid var(--line); }
details { margin-top:.75rem; }
summary { cursor:pointer; color:var(--accent); font-size:.9rem; font-weight:600; }
a.cal { display:inline-block; margin-top:.75rem; font-size:.85rem; color:var(--accent); }
ul.files { list-style:none; margin:.6rem 0 0; padding:0; }
ul.files li { font-size:.88rem; padding:.15rem 0; }
ul.files a { color:var(--accent); }
ul.files .exp { color:var(--dim); font-size:.78rem; }
ul.past { list-style:none; margin:0; padding:0; }
ul.past li { font-size:.9rem; color:var(--dim); padding:.2rem 0; }
ul.past li b { color:var(--fg); font-weight:500; }
footer { margin-top:2.5rem; color:var(--dim); font-size:.8rem; border-top:1px solid var(--line);
         padding-top:1rem; }
.empty { color:var(--dim); }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- The token lives in this page's own URL, so it must never travel in a Referer. -->
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>
`;
}

/** Thu 6 Aug — a date somebody reads, not one they parse. */
function humanDate(iso: string, today: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d!));
  const days = Math.round((at.getTime() - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const label = at.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return days < 0 ? `${label} — overdue` : label;
}

function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function thread(task: DelegateTask): string {
  if (task.comments.length === 0) return '';
  const items = task.comments
    .map(
      (c) =>
        `<li><div class="who">${esc(c.author)} · ${esc(c.at.slice(0, 10))}</div>${esc(c.body)}</li>`,
    )
    .join('');
  return `<ul class="thread">${items}</ul>`;
}

/**
 * Attached files, with URLs that expire.
 *
 * The link is minted per page load and lasts fifteen minutes. A permanent URL
 * on a page built to be forwarded is a file handed to whoever the page reaches,
 * long after the link that showed it has been revoked.
 */
function files(task: DelegateTask): string {
  if (task.files.length === 0) return '';
  const items = task.files
    .map((f) =>
      f.url
        ? `<li><a href="${esc(f.url)}" rel="noreferrer">${esc(f.title)}</a> <span class="exp">${esc(f.note)}</span></li>`
        : `<li>${esc(f.title)} <span class="exp">— ${esc(f.note)}</span></li>`,
    )
    .join('');
  return `<ul class="files">${items}</ul>`;
}

function card(task: DelegateTask, base: string, today: string): string {
  const due = task.deadline_date
    ? `<span class="due">due ${esc(humanDate(task.deadline_date, today))}</span> · `
    : '';
  const notes = task.notes ? `<div class="notes">${esc(task.notes)}</div>` : '';
  const unblocks =
    task.unblocks > 0
      ? `<p class="unblocks">${esc(task.unblocks)} other ${
          task.unblocks === 1 ? 'thing is' : 'things are'
        } waiting on this</p>`
      : '';
  const calendar = task.deadline_date
    ? `<a class="cal" href="${esc(base)}/task/${esc(task.id)}.ics">Add to calendar</a>`
    : '';
  const flagged = task.needs_attention
    ? '<p class="unblocks">You flagged this for Tal.</p>'
    : '';

  return `<article${task.needs_attention ? ' class="attention"' : ''}>
  <h3>${esc(task.title)}</h3>
  <p class="meta">${due}${esc(task.venture)} · about ${esc(duration(task.estimate_minutes))}</p>
  ${notes}
  ${unblocks}
  ${flagged}
  ${files(task)}
  ${thread(task)}
  <form class="row" method="post" action="${esc(base)}/close">
    <input type="hidden" name="task_id" value="${esc(task.id)}">
    <div>
      <label for="m-${esc(task.id)}">How long did it take? (optional)</label>
      <!-- NEVER pre-filled with the estimate. A pre-filled guess becomes a
           measurement the moment it is submitted, and nothing downstream can
           ever tell it apart from a real one. -->
      <input type="number" id="m-${esc(task.id)}" name="actual_minutes" min="1" max="1440"
             inputmode="numeric" autocomplete="off" placeholder="minutes">
    </div>
    <button type="submit">Mark done</button>
  </form>
  <details>
    <summary>Say something, or flag a problem</summary>
    <form method="post" action="${esc(base)}/comment">
      <input type="hidden" name="task_id" value="${esc(task.id)}">
      <textarea name="body" maxlength="4000" required
                placeholder="What is going on with this one?"></textarea>
      <label><input type="checkbox" name="blocks" value="1" style="width:auto"> I am stuck — this needs Tal</label>
      <button type="submit" class="quiet">Send to Tal</button>
    </form>
  </details>
  ${calendar}
</article>`;
}

function closedCard(task: ClosedTask, base: string): string {
  return `<article>
  <h3>${esc(task.title)}</h3>
  <p class="meta">Marked done. Undo is available for a few more minutes.</p>
  <form method="post" action="${esc(base)}/undo">
    <input type="hidden" name="task_id" value="${esc(task.id)}">
    <button type="submit" class="quiet">Undo</button>
  </form>
</article>`;
}

export interface PageOptions {
  /** `/p/<token>` or `/d/<token>` — every form posts under it. */
  base: string;
  flash?: string | null | undefined;
  /** Where the rotated link lives, when this one is on its grace window. */
  calendarFeedUrl?: string | null;
}

export function renderDelegatePage(
  view: DelegateView,
  closed: readonly ClosedTask[],
  opts: PageOptions,
): string {
  const flash = flashFor(opts.flash);
  const parts: string[] = [];

  parts.push(`<header>
  <h1>Hi ${esc(view.person)}</h1>
  <p>${esc(view.open.length + view.later.length)} open · ${esc(
    view.finished_this_week,
  )} finished in the last 7 days</p>
</header>`);

  if (flash) parts.push(`<div class="flash ${flash.tone}">${esc(flash.text)}</div>`);

  if (view.rotated) {
    parts.push(
      `<div class="banner">Tal sent you a newer link for this. This one keeps working for a
       little while — use the new one from now on.</div>`,
    );
  }

  if (closed.length > 0) {
    parts.push('<h2 class="section">Just finished</h2>');
    parts.push(closed.map((t) => closedCard(t, opts.base)).join(''));
  }

  if (view.open.length === 0 && view.later.length === 0) {
    parts.push(
      `<h2 class="section">Your list</h2><p class="empty">Nothing open right now. Tal will send
       more when there is more.</p>`,
    );
  }

  if (view.open.length > 0) {
    parts.push(
      `<h2 class="section">${view.scope === 'task' ? 'Your task' : 'Now — due in the next week'}</h2>`,
    );
    parts.push(view.open.map((t) => card(t, opts.base, view.today)).join(''));
  }

  if (view.later.length > 0) {
    parts.push('<h2 class="section">Later</h2>');
    parts.push(view.later.map((t) => card(t, opts.base, view.today)).join(''));
  }

  if (view.finished.length > 0 && view.scope !== 'task') {
    // A page that is only ever a demand is a page people stop opening.
    const items = view.finished
      .map((f) => `<li><b>${esc(f.title)}</b> · ${esc(f.on)}</li>`)
      .join('');
    parts.push(
      '<h2 class="section">Done recently</h2>',
      `<article><ul class="past">${items}</ul></article>`,
    );
  }

  if (opts.calendarFeedUrl) {
    parts.push(
      `<h2 class="section">Calendar</h2><p class="empty"><a class="cal"
       href="${esc(opts.calendarFeedUrl)}">Subscribe to your dated work</a> — only tasks with a
       date appear.</p>`,
    );
  }

  // Dates are shown in whichever zone the system actually knows about, and it
  // says which. An unstated timezone silently rendered as Tal's is how somebody
  // misses a deadline by a day and blames themselves.
  parts.push(`<footer>
  <p>Dates shown for ${esc(view.timezone)}${
    view.timezone_source === 'workspace' ? " (Tal's timezone — tell him yours and he will fix it)" : ''
  }. Today is ${esc(view.today)}.</p>
  <p>This page is private to you. Anyone holding its link can see and close this work, so do
     not forward it.</p>
</footer>`);

  return shell(`TaskOS — ${view.person}`, parts.join('\n'));
}

/**
 * What a dead link says.
 *
 * It says which kind of dead, on purpose. "Expired" versus "not found" tells the
 * holder whether to ask for a new link or check they copied the whole thing, and
 * it discloses nothing to somebody who does not already hold the secret.
 */
export function renderGone(reason: 'unknown' | 'malformed' | 'revoked' | 'expired' | 'completed'): {
  status: number;
  html: string;
} {
  const copy: Record<typeof reason, { title: string; body: string }> = {
    unknown: {
      title: 'Link not found',
      body: 'That link does not match anything. Check it copied in full — they are long — or ask Tal for a new one.',
    },
    malformed: {
      title: 'Link not found',
      body: 'That does not look like a TaskOS link. Check it copied in full, or ask Tal for a new one.',
    },
    revoked: {
      title: 'Link closed',
      body: 'Tal closed this link. Ask him for a new one if you still need it.',
    },
    expired: { title: 'Link expired', body: 'This link has expired. Ask Tal for a new one.' },
    completed: {
      title: 'All done',
      body: 'That work is finished and this link has closed itself. Nothing left to do here — thanks.',
    },
  };
  const { title, body } = copy[reason];
  return {
    status: reason === 'unknown' || reason === 'malformed' ? 404 : 410,
    html: shell(
      title,
      `<header><h1>${esc(title)}</h1></header><p class="empty">${esc(body)}</p>`,
    ),
  };
}
