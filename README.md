# TaskOS V1

A personal task and attention operating system for Tal (Fox Solutions LLC).

V1 answers exactly one question: **given my real milestones and my real hours,
what is going to slip?**

You reach it by talking to Claude through an MCP connector. There is no LLM in
this code and no Anthropic API key anywhere in it.

```
packages/engine     pure functions, zero I/O — slack, coverage, demand, capacity, score
apps/mcp            the MCP server: 9 tools over streamable HTTP on Vercel
supabase/migrations schema, four triggers, seed data
```

## The two rules that override everything else

1. **`packages/engine` is pure.** No database calls, no fetch, no `Date.now()`.
   Every function takes `today: string` as an explicit argument. This is what
   makes a portfolio a value, a computation reproducible, and the property tests
   possible. Don't break it for convenience.
2. **`fixtures/expected.json` was written by hand** from the spec math, before
   the functions it judges existed. Regenerating it from the code would leave
   the tests confirming only that the code does what the code does.

## Running the tests

```bash
npm install
npm test                 # 366 tests: engine (256) + mcp (110)
npm run typecheck
```

The MCP tests need a local PostgreSQL 16, because the four triggers, the
cycle-prevention walk and the transaction boundary in `commit_tasks` are the
things most likely to be wrong and none of them exist in a mock:

```bash
export PGDATA=/var/lib/taskos-pg
/usr/lib/postgresql/16/bin/initdb -D $PGDATA -U postgres --auth=trust
/usr/lib/postgresql/16/bin/pg_ctl -D $PGDATA -o '-p 5433' -l /tmp/pg.log start

# prove the triggers directly
psql -h localhost -p 5433 -U postgres -d postgres -c 'create database trig'
for f in supabase/migrations/000*.sql; do psql -h localhost -p 5433 -U postgres -d trig -q -f $f; done
psql -h localhost -p 5433 -U postgres -d trig -f supabase/tests/triggers.sql
```

Override the target server with `TEST_PGHOST`, `TEST_PGPORT`, `TEST_PGUSER`.

## Deploying (step 9)

### 1. Database

Any PostgreSQL 15+ works; Supabase is what this was built for. One command
applies the migrations in order and then proves the triggers on the database it
just built:

```bash
./scripts/provision.sh "postgresql://postgres:PASS@db.xxx.supabase.co:5432/postgres"
```

Use the **direct** connection (port 5432) for this — the pooler cannot run the
multi-statement DDL in these migrations. It ends with a summary of what is in the
database and the remaining steps.

Or apply them by hand, **in order**:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0001_schema.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0002_triggers.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0003_seed.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/migrations/0004_unsorted_venture.sql
```

Then confirm the cycle trigger is live on the real database before trusting
anything else — it is the one guard that cannot be checked from the outside:

```bash
psql "$DATABASE_URL" -f supabase/tests/triggers.sql   # ends: ALL TRIGGER TESTS PASSED
```

`0003_seed.sql` and `0004` are idempotent, so re-running them is safe.

### 2. Environment

| variable | what it is |
|---|---|
| `TASKOS_TOKEN` | Bearer token the connector sends. Generate with `openssl rand -hex 32`. |
| `DATABASE_URL` | Postgres connection string. On Supabase use the **transaction pooler** (port 6543) — serverless functions open a connection per invocation. |
| `SUPABASE_URL` | Project URL. Only needed for documents. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key, for Storage. Server-side only — it bypasses RLS, so it must never reach a browser. |
| `CRON_SECRET` | What Vercel signs its own cron invocations with. Without it the morning brief still works (it also accepts `TASKOS_TOKEN`), but set it — an unauthenticated `/api/daily` is a free way for anyone to push messages to your phone. |
| `TASKOS_PUBLIC_URL` | The origin delegation links are built on, e.g. `https://taskos.vercel.app`. Falls back to `VERCEL_PROJECT_PRODUCTION_URL`; without either, `delegate_link` returns a relative path and says so. |

Without the last two the nine core tools work normally and the four document
tools report that storage is unconfigured, naming the variables. Degraded, not
broken (D8).

The server **fails closed**: if `TASKOS_TOKEN` is unset, every request is
rejected with a 500. An unset secret never means "allow everyone".

**The connector URL must carry `?token=`.** A rejection answers **403, not 401**,
and sends no `WWW-Authenticate`. Both halves matter: an MCP client treats any 401
as an invitation to begin OAuth discovery, and shows *"Couldn't register with
Task-OS's sign-in service"* — an error naming a sign-in service that does not
exist, about a protocol this server does not speak, when the real problem is a
missing query parameter. 403 is also the honest status: the credential is a
static pre-shared token in the URL, and nothing the client can negotiate will
help, which is exactly what 403 means.

### 3. Vercel

The function lives at the repository root, `api/mcp.ts`, and `vercel.json` sits
beside it. **Leave the project's Root Directory at the repository root.** Vercel
resolves functions relative to the Root Directory and reads only the
`vercel.json` found there; a function nested under `apps/mcp/api` is invisible to
it, and it will pick its own entrypoints from whatever TypeScript it can see —
which fails with `Invalid export found in module .../src/server.mjs`.

```bash
vercel link
vercel env add TASKOS_TOKEN production
vercel env add DATABASE_URL production
vercel deploy --prod
```

The endpoint is `POST https://<deployment>/api/mcp`, streamable HTTP, stateless.
`GET` and `DELETE` return 405 — there are no sessions to resume, because a
session id pointing at a dead lambda is worse than no session at all.

### 4. Register the connector

In claude.ai → Settings → Connectors → Add custom connector:

- URL: `https://<deployment>/api/mcp?token=<TASKOS_TOKEN>`
- Authentication: none (the token is in the URL)

The token can travel in the URL **or** in an `Authorization: Bearer` header; the
server accepts either. The URL form exists because the claude.ai custom-connector
form has no field for a static bearer token. That is a genuine tradeoff — URLs
are logged and kept in history in a way headers are not — so treat the connector
URL as the secret it is, and rotate by changing `TASKOS_TOKEN` and
re-registering.

A 401 from this server deliberately omits `WWW-Authenticate: Bearer`. That header
is correct HTTP, but an MCP client reads it as an invitation to start OAuth
discovery and then fails with "Couldn't register with the sign-in service". This
server implements no OAuth, so it must not advertise one.

This step is done in your account and cannot be scripted from here.

### 5. Verify `capacity()` end to end

Locally, against the deployed database:

```bash
TASKOS_TOKEN=... DATABASE_URL=... npm run dev -w @taskos/mcp
```

Or straight at the deployment — a bare `tools/list`, which must be refused
without a token and must list nine tools with one:

```bash
curl -sS -X POST https://<deployment>/api/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# expect 401

curl -sS -X POST https://<deployment>/api/mcp \
  -H "authorization: Bearer $TASKOS_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Then, through Claude: *"I have about 25 hours this week — what's going to slip?"*

## The tools

| tool | what it does |
|---|---|
| `capture(text)` | Raw text to the inbox, no parsing. One item per line. |
| `process_inbox()` | Proposes venture, project, criticality, context, estimate, value. Writes nothing. |
| `commit_tasks(tasks[])` | Writes confirmed tasks plus dependency edges by title, in one transaction. |
| `set_milestone(...)` | An event **you** control. Drives demand. |
| `set_outcome_target(...)` | A result **someone else** decides. Drives no demand, ever. |
| `capacity(available_hours)` | **The main tool.** What is going to slip. |
| `venture_status(slug)` | One venture: milestones with slack and coverage, blockers, indicators, top 5. |
| `list_tasks(filter)` | Filtered list, max 15 with a true total. |
| `close(task_id, ...)` | Marks done. Records actual time per D6. |
| `attach_document(...)` | Store a small file inline (≤5MB) against a venture/project/milestone/task. |
| `create_upload_link(...)` | A URL to upload anything larger to. The document is `pending` until it arrives. |
| `list_documents(filter)` | What is attached and to what. Confirms pending uploads. |
| `get_document(id)` | A short-lived signed URL to read one. |
| `suggest_improvement(...)` | An agent tells Tal what this system is missing. |
| `list_suggestions(filter)` | What has been reported, worst and most-repeated first. |
| `resolve_suggestion(id, ...)` | Tal marks something planned, built or declined. |
| `get_context()` | **Call this first.** The whole situation in one call, plus what it does *not* know. |
| `link_tasks(links[])` | Dependency edges between tasks that already exist. |
| `next_actions(available_minutes, ...)` | What to pick up in the slot you actually have. |
| `set_day_allocation` / `get_day_allocation` | Which venture owns which day, and its flex budget. |
| `update_task(...)` | Change fields on an existing task. Null clears, absent leaves alone. |
| `kill_task(id, reason)` | It should never have been on the list. Not the same as done. |
| `reopen_task(id)` | Undo a close, clearing the recorded actual. |
| `snooze_task(id, ...)` | Defer, and count. Three snoozes means it needs a decision. |
| `close_many(closures[])` | An evening's closes in one call. |
| `list_ventures` / `set_venture` | Enumerate, create, rename, retune. |
| `list_milestones` | Everything, including the stale rows nothing else surfaces. |
| `delete_milestone` / `delete_outcome_target` | Refuses by default when work is attached. |
| `create_person` / `list_people` | Makes the assignee field usable, and shows delegated load. |
| `move_milestone(id, venture)` | Move a milestone between ventures, tasks included. `set_milestone` cannot. |
| `delegate_link(person, ...)` | Mint a secret link to a page where somebody else does the work. |
| `list_delegation_links` / `revoke_delegation` | What is in circulation, and killing it. |
| `delegation_inbox(...)` | What came back: comments, and who is blocked and for how long. |
| `comment_on_task(id, body)` | Tal answering, in the thread the delegate is reading. |

Every response carries a `confidence` object: `{ calibrated, balancingActive,
coverageByMilestone, notes }`. Read the notes before treating a number as
settled — the system states its own uncertainty rather than presenting guesses
as facts.

## Documents

Files attach to the work they belong to. The bytes live in a **private**
Supabase Storage bucket (`taskos-documents`); the `documents` table holds only
metadata. Reads go through signed URLs that expire in 15 minutes by default and
an hour at most — a public bucket would make every contract readable forever by
anyone who ever saw a link.

**Why two upload tools rather than one.** MCP tool arguments are JSON, so bytes
can only reach a tool as base64. That works for a spec or a small PDF and cannot
work for a deck. `attach_document` takes inline content up to 5MB;
`create_upload_link` returns a URL the file goes to directly, browser to
Supabase, with the service key never leaving the server. The tool descriptions
are what stop Claude reaching for the wrong one.

**Pending is a real state, not a bug.** Storage sends no callback when an upload
finishes, so a document created by `create_upload_link` is `pending` until the
server next reconciles against the bucket — which `list_documents` does, for the
whole workspace prefix, in one request. A pending document means "a link was
issued and no file has arrived", and saying so is better than defaulting to
`stored` and listing files that do not exist. A row whose object has since been
deleted becomes `missing` the first time anyone asks to read it.

Two guards live in migration 0007, both proven by tests: a document may not
reference another workspace's venture, project, milestone or task, and its
`storage_path` must begin with its own workspace id — which is what the bucket
policy authorises on.

## Telegram

Capture from your phone. `POST /api/telegram` on the same server.

It does four things — capture text to the inbox verbatim, store a photo or file
against your work, answer `/week`, and list `/next`. Deliberately nothing else:
anything needing judgement (which venture, what estimate, what blocks what)
stays in the Claude conversation, because that is where judgement is. A bot that
parsed "urgent yachtyhub thing by friday" into fields would be guessing, and the
inbox stops being trustworthy the moment it guesses.

`/hours 25` records a normal working week so `/week` never has to be given the
number. It stays unset until stated: an assumed 40-hour week produces a
confident answer to a question nobody asked, so with nothing on record the bot
asks rather than guesses.

`/week` leads with the answer in words — "this week does not fit, you are 6h
short" — and shows the arithmetic underneath. When no tasks are attached to any
milestone it says it cannot answer and why, rather than reporting the
technically-true "clear, 20h spare" that an empty system produces.

**Two independent gates, both required.** A Telegram bot answers whoever finds
it, so:

1. `TELEGRAM_WEBHOOK_SECRET` — Telegram echoes it in a header, proving the
   request came from Telegram and not from someone who guessed the URL.
2. `TELEGRAM_ALLOWED_CHAT_IDS` — a comma-separated list of chat ids. Anything
   else is dropped in silence, without a reply: telling a stranger the bot
   exists and rejected them is more than they need.

An empty allow-list means *nobody*, and the server refuses to start the bridge
rather than defaulting to everybody. That is the one misconfiguration that would
silently open this to the world.

| variable | what it is |
|---|---|
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32`. Not the same value as `TASKOS_TOKEN`. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | your numeric chat id; message @userinfobot to find it |

Point Telegram at it once:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://<deployment>/api/telegram",
       "secret_token":"'"$TELEGRAM_WEBHOOK_SECRET"'",
       "allowed_updates":["message"]}'
```

**The webhook answers 200 to everything it accepts, including its own failures.**
Telegram retries any update it does not get a 200 for, with backoff, for hours —
so a 500 from a transient database error turns one captured note into several.
Problems come back as a reply message instead. The single exception is a bad
secret header, which gets a 401 and no processing at all; answering 200 there
would make the endpoint a free way for anyone to drive the bot.

Files over 20MB are refused because Telegram will not serve them to a bot, and
files over 5MB are pointed at `create_upload_link` instead. The reply says which.

## The morning brief

08:00 in `settings.active_tz`, every day the allocation says is a working day.
`POST`-free: Vercel Cron hits `GET /api/daily`, which composes the message from
the engine and pushes it to `TELEGRAM_ALLOWED_CHAT_IDS`.

**No model writes it.** Every number in it is one the engine already computed.
That is the same rule the rest of the system follows, and it is why the brief can
be trusted at a glance rather than re-checked.

It leads with what is due and what is blocked, not with a greeting — a brief
whose first line is pleasant is a brief that gets swiped away. Then: what to pick
up first in the hours actually on record, what is drafted and waiting on
judgement, who is blocked and for how long, and the milestones inside a
fortnight. If the weekly hours are not on record the "first" section is omitted
entirely and the brief says so, rather than answering from an invented number.

**Three things about the schedule are not obvious:**

- **DST.** Vercel evaluates cron in UTC with no timezone option, so 08:00 in New
  York is 12:00 UTC in summer and 13:00 UTC in winter. There are therefore *two*
  schedules, and the route decides which one is actually the local morning.
  Pinning one UTC hour would silently deliver at 07:00 for five months a year.
- **One per local day.** Both schedules fire daily, so one is always wrong — and
  on Vercel's Hobby plan a cron triggers *within the hour*, not on the minute, so
  the right one can arrive late. The send window is deliberately wide (08:00 to
  11:59 local) to absorb that, and an idempotency receipt keyed on the local date
  is what stops a wide window becoming two messages. The receipt is written
  *before* the send: a killed invocation should cost one missed brief, never a
  duplicate every morning.
- **The day off comes from the data.** Saturday is skipped because
  `day_allocation.is_working_day` says so, not because the cron excludes it.
  Change it with `set_day_allocation` and the brief follows, no redeploy.

On a non-working day it sends **nothing** — not a message saying there is
nothing. A notification on a day off trains you to ignore the ones on the days
that matter.

To see it without sending: `GET /api/daily?dry=1&force=1` with your bearer token
returns the exact text.

## Delegation

Tal has roughly 28 usable hours a week. Othman and Saar have about 48 between
them. Moving one task across that line beats any amount of re-ranking, and until
now assigning a task told the assignee nothing at all.

**The shape: a secret link, no account, no app, no invite.** They open a page,
see only their own work, mark it done, say what they are stuck on. Nothing runs
on a schedule, because nothing here needs to.

| route | what it is |
|---|---|
| `GET /p/<token>` | A person's whole open queue. |
| `GET /d/<token>` | One task. |
| `GET /c/<token>.ics` | A read-only calendar feed that can close nothing. |
| `POST /p/<token>/close` `…/comment` `…/undo` | The only three state changes a delegate can make. |
| `GET /p/<token>/task/<id>.ics` | Add-to-calendar for one task. |

**The link IS the credential.** No password, no second factor, because requiring
either is what stops a collaborator ever using the thing. That trade is only
acceptable because of how narrow the reach is: exactly one person's own assigned
work. Not the portfolio, not another person's tasks, not `capacity()`, not the
slip ranking. A leaked link is a contained incident, not a breach.

**Only the hash is stored.** The plaintext exists once, in the response to
`delegate_link`, and is never written down again. A database dump, a backup or a
screenshot of a query yields nothing that works. The cost is that "resend me that
link" is impossible, which is why rotation has a grace window and is a
first-class operation rather than an afterthought.

**One link per task, gone 90 minutes after it is approved.** Ninety rather than
zero because the minute after "done" is exactly when the undo gets used and the
receipt gets read; a link that dies on the tap turns every mis-tap into a message
to Tal. The rule is computed from `tasks.closed_at` at read time rather than
stamped onto the token, and that is what makes undo work: there is nothing to put
back, because undoing the close removes the thing the ninety minutes was measured
from. Expiry is enforced on read throughout, which turns "this platform has no
cron" from a constraint into a property — there is no window in which a dead link
still works because a job has not run.

**A GET never mutates.** WhatsApp, Telegram, Slack, iMessage and every mail
scanner fetch a URL the moment it is pasted. A GET that closed a task would mean
sending the link completed the work. So every mutation is a POST answering 303,
and `list_delegation_links` reports a fetch count that is explicitly *not* a
read — `last_action` is the only signal that is definitely a person.

**"I'm stuck" writes a comment and sets `needs_attention_at`. It does not change
status.** `waiting` is in `DEMAND_EXCLUDED_STATUSES`, so a delegate marking
themselves blocked would drop the minutes out of demand while coverage still
counted the task, and `capacity()` would report a *lighter* week because somebody
got stuck. That is the worst failure mode available here and it would have looked
like good news.

**Delegated actuals are quarantined.** `tasks.actual_by_person_id` records who
volunteered a duration, and a non-null value keeps it out of the calibration
table. Calibration exists to correct *Tal's* estimating; Othman taking 120
minutes on a 90-minute task is evidence about Othman.

Other things the page does not do: it never renders what a task unblocks as
titles, only as a count, because the page is built to be forwarded and the leak
would widen with graph density. It never shows one delegate another delegate's
comments, because threads survive reassignment. It never pre-fills the duration
field with the estimate, because a pre-filled guess becomes a measurement the
instant it is submitted. And `delegate-data.ts` never calls `loadPortfolio` or
the engine — a person-scoped subset would starve `computeCoverage` below the 60%
threshold and produce confidently wrong slack on an unauthenticated request.

The page is server-rendered with **zero JavaScript**, escaped at every
interpolation, and carries `no-referrer` plus a content policy that forbids
loading anything external — so the token sitting in the page's own URL has no
outbound request to leak into.

What comes back reaches Tal two ways: a Telegram push at the moment it happens
(to `TELEGRAM_ALLOWED_CHAT_IDS`, never to a delegate's chat id), and
`delegation_inbox`, which does **not** mark anything read just because it was
listed — an agent that reads the comments and then loses the conversation would
otherwise have consumed the only notification Tal was going to get.

## next_actions, and the four rules in it

Every task already carried `context`, `energy` and `estimate_minutes`, and
nothing read them. `list_tasks` returns one global ranking, so at 2pm with
ninety minutes and no energy left, the top of the list was a 720-minute
`deep_work` task — correct as a ranking, useless as an answer.

Four rules, and the reasoning matters more than the code:

1. **A task with open blockers is excluded, not down-ranked.** Suggesting work
   that cannot be started is the fastest way to make a list untrustworthy.
2. **Energy is a hard constraint; context is a soft one.** Mismatched energy
   produces bad work, which has to be redone. Mismatched context produces slow
   work, which merely costs time. So low energy excludes high-energy tasks
   outright, while a context mismatch only lowers the ranking.
3. **A task bigger than the slot is still returned**, marked `partial` with a
   suggested chunk. The 720-minute item is often the most important thing in the
   system, and a size filter makes it permanently invisible — the more it
   matters, the bigger it is, the less it would ever be suggested.
4. **Every action carries a one-line `why`.** A ranked list without reasoning is
   a list; with it, it is a recommendation somebody can disagree with.

### The day allocation

Whole days belong to ventures. That rule lived only in conversation and had
already caused planning errors. `day_allocation` records it, with a **flex**
budget per day — because a Seatop day still has to absorb the Yathub thing that
catches fire, and a rule with no give is abandoned the first time it is
inconvenient.

Two properties that make it survive contact with a real week:

- **Flex is spent by closing off-plan work, never by asking what to do.** A
  budget consumed by the question would be gone before any of it was worked.
- **Negative slack surfaces even at zero flex**, flagged `flex_exceeded`. Never
  hide a fire behind a budget.

No rollover: unspent flex does not accumulate into a licence to spend a whole
day off-plan later.

## On required hours being a rate

`capacity()` reports `required` as hours **per week**, and it is not capped at
`usable`. When a milestone is four days out, its remaining work over its window
is a large weekly rate — 38 hours in 4 days really is ~66 h/wk. That looks like
inflation and is not: the arithmetic is right, and capping the rate at `usable`
would drive the deficit to zero and report a comfortable week during a fire.

The fix is to publish the ingredients beside it rather than flatten it:
`required_hours_total`, `horizon_days` and `deficit_hours_total`, plus
`hours_freed_total` on each slip candidate. The totals are what a person can act
on; the rate is what the engine compares against a weekly capacity.

## get_context, and why it exists

Every number `get_context()` returns was already reachable — in about six calls
and a conversation. That was the problem. Each session began by rebuilding the
same picture from scratch, so the person spent their time teaching the system
rather than being helped by it.

It returns the ventures with their weights and shares, the people with their
working weeks and current load, the active milestones with slack and coverage,
the week and its deficit, and — the part that matters most — an **`unknown`**
list of what the system has not been told. Someone's working week that was never
stated, a milestone attached to an inactive venture, a milestone with no tasks
on it. The instructions tell agents to read that list and ask, never to fill it
in from guesswork.

It also reports **delegated capacity**: the sum of everyone's stated hours. In a
system where one person has ~28 usable hours behind ~48 hours of execution
capacity, that ratio is the whole shape of the problem, and it took a manual
tally to see.

## Correction

The first sixteen tools could **create** and **complete** and nothing in
between, so every mistake was permanent: a wrong estimate, a task filed as
recurring that is not, a milestone superseded by reality. That is not a missing
convenience. Real use of a task system is mostly correction, and one whose
mistakes cannot be repaired stops being trusted the first time it is wrong.

**`update_task` is a partial update, and null is not absent.** Only supplied
fields change; an explicit `null` clears a nullable one. Collapsing those two
would make it impossible to remove a deadline without rewriting the whole task.

**`kill` is not `close`, and the difference is not cosmetic.** `close` means it
happened and feeds calibration; `kill` means it should never have been on the
list. Closing a mistaken task teaches the estimator from a fiction, which
corrupts every future estimate in that context. `reopen_task` clears the
recorded actual by default for the same reason.

**`delete_milestone` refuses by default when tasks are attached**, returning the
count and the ids. Detaching work silently is how a critical path disappears
without anyone noticing.

**`link_tasks` closes a gap that quietly cost coverage.** `commit_tasks`
resolves `depends_on` and `blocks` by title, but only among the tasks in that
same call — so work added after a chain existed could never join it. Adding five
tasks to a milestone without edges *lowers* its coverage, and under 60% the
engine suppresses its slack entirely. `link_tasks` takes ids or exact titles,
refuses an ambiguous title rather than guessing (wiring the wrong critical path
is invisible afterwards), and reports what it did to each affected milestone's
coverage.

**`list_milestones` flags the two conditions that make a slip ranking read as
nonsense**: an active milestone with no attached tasks, which frees nothing when
slipped, and one whose venture is inactive, whose demand is silently not
counted.

**People exist so delegation can be measured.** `commit_tasks` always refused an
unknown assignee, correctly, but nothing could create one — so ownership was
being carried in the notes field in capital letters. `hours_per_week` is what
turns a name into a constraint.

### On the duplicate dependency edges

Reported as duplicate rows; they were not. `task_dependencies` has
`primary key (task_id, blocks_task_id)` and the insert uses `on conflict do
nothing`, so declaring the same edge from both `blocks` and `depends_on` always
wrote exactly one row. The returned `edges` array listed it twice — a reporting
bug, now deduplicated before both insert and report. Nothing was inflating
coverage or slack, and there is nothing to clean up.

## Feedback from the agents using it

Tal builds this. The agents using it are the ones who meet its edges — a tool
that cannot express what the conversation needs, an answer that does not answer
the question, a limit they had to work around. Before `suggest_improvement`,
every one of those observations died with the conversation that produced it.

Two properties keep it useful rather than a suggestion box nobody reads:

**It is never work.** Feedback about the tool takes no share of the week, drives
no demand and cannot appear in a slip ranking. Filing it as a task would corrupt
the one question this system exists to answer, so it lives in its own table and a
test asserts `capacity()` stays at zero required hours with suggestions on file.

**Re-reporting counts rather than duplicates.** A unique index on the title turns
a second report into `occurrences: 2`, which is stronger evidence than two rows
and cannot be inflated by an eager reporter. The worst severity ever reported
sticks — something once blocking does not become low because a later report
caught it on a good day — and a *declined* item reopens itself when hit again,
because being hit twice is new information.

The instructions tell agents to file **from the occasion**, with what they were
attempting, and then to say one sentence about it and carry on. A request without
its occasion is a wish; with it, it is evidence.

`/ideas` in Telegram lists what is open, because the moment Tal is most likely to
think about what to build next is not when he is at a desk.

## Things worth knowing before you change anything

**`pressure` appears in `computeDemand` and nowhere else.** Task-level urgency
must not also multiply by deadline proximity. The same signal applied twice,
multiplicatively, pushes one task to ~16x normal and erases four ventures from
the output.

**Coverage below 60% disables slack for that milestone.** An incomplete
dependency graph produces confidently wrong slack, which is the worst failure
mode in the design — a milestone with three of its ten blockers wired up reports
comfortable slack right until it misses. Below the threshold, demand falls back
to a slack-free formula *and* pressure is held at 1.0, so untrustworthy slack
cannot reach demand by either route.

**`CHAIN_HOURS_PER_DAY = 6`.** The slack walk subtracts a chain length in *days*
from a due date while tasks carry estimates in *minutes*, so exactly one
conversion constant is unavoidable. Six hours is a full day of real output for
one person running five ventures, not an eight-hour fiction. It is exported and
named so every slack figure can be re-derived by hand.

**Shares clamp once, then renormalise once.** That is spec-literal, and it means
renormalising after a floor-raise can push a venture back *under* its floor. The
engine reports that in `confidence.notes` rather than iterating to a fixed point.
`fixtures/expected.json` asserts it happens to seatop and foxsolutions.

**The `unsorted` venture is deliberately inactive.** `capture()` cannot know a
venture and `tasks.venture_id` is `NOT NULL`, so inbox items park against a
holding venture. `computeDemand` skips inactive ventures, which is what stops the
inbox from taking a share of your week.

**Recurring work is overhead, not demand (D5).** It is subtracted from available
hours before the buffer, never added to what a milestone requires, and it never
appears on a critical path. Missed recurrences do not accumulate.

## What V1 deliberately does not have

No scheduling in the sense that matters — TaskOS still never tells you what hour
to do something. No Google Calendar as an input (available hours are an
argument), no day packing, no Asana sync, no verification integrations. V1 had to
be usable the night it was built.

The Telegram bot, the delegation pages, the read-only dashboard and the 08:00
brief were built after that first night and have their own sections above. The
brief means there IS a cron now, so the second consequence below is the one that
changed: milestone expiry is still called rather than scheduled, and that is
still deliberate.

Two consequences worth naming rather than hiding:

- **Milestone expiry is called, not scheduled.** `capacity()` runs
  `taskos_expire_milestones()` at the top of every call, so a past-due milestone
  cannot keep drawing demand from a date that has gone — so it stays correct
  without anything running on a timer, and the morning brief's cron is not load-
  bearing for it.
- **Outcome indicators count events, nothing more.** With no verification
  integrations, an indicator with no recorded events reports `null` — "nothing
  has been recorded" — never `0`, which would read as evidence of zero activity.

## The dashboard (apps/web)

Read-only Next.js page showing what `capacity()` and `venture_status()` already
compute. Entry stays conversational through Claude; a page that cannot write
cannot corrupt anything.

It imports `loadPortfolio` and the engine pipeline from `@taskos/mcp` rather
than querying for itself. If it computed its own numbers, the UI and Claude
would eventually disagree about what is going to slip and there would be no way
to tell which was right.

### Deploying it

A **second** Vercel project, same repository, **Root Directory `apps/web`**,
against the same database.

| variable | what it is |
|---|---|
| `DATABASE_URL` | the same transaction-pooler string the MCP server uses |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the publishable/anon key (safe in a browser) |

`apps/web/vercel.json` pins `"framework": "nextjs"`. That is not decoration.
Vercel's framework detection can land on **Other** for a project whose Root
Directory points into a workspace, and **Other** means "serve a static `public/`
folder" — so the build compiles perfectly, prints its route table, and then dies
with `No Output Directory named "public" found`. Pinning it in the repository
means the setting cannot be lost to a dashboard edit or a re-import. Settings in
`vercel.json` take precedence over the dashboard, so nothing needs changing
there.

Also add the deployment's callback to **Supabase → Authentication → URL
Configuration → Redirect URLs**:

```
https://<the-web-deployment>/auth/callback
```

Without it Supabase refuses the redirect and the magic link lands nowhere.

Then, once per person who should have access — there is no self-signup, by
design:

```sql
-- after they have signed in once, so auth.users has them
insert into workspace_members (workspace_id, user_id)
select '00000000-0000-0000-0000-000000000001', id
from auth.users where email = 'them@example.com';
```

A signed-in user with no membership row sees nothing. There is deliberately no
fallback to "the first workspace": that fallback is how a stranger ends up
looking at somebody else's ventures.

### Why the build script says `--webpack`

`@taskos/engine` and `@taskos/mcp` are TypeScript **source** in sibling
workspaces using NodeNext resolution, where a file imports its sibling as
`./load.js`. TypeScript maps that back to `./load.ts`; bundlers do not unless
told, and the `extensionAlias` that tells them is webpack configuration.
