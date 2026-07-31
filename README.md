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

Without the last two the nine core tools work normally and the four document
tools report that storage is unconfigured, naming the variables. Degraded, not
broken (D8).

The server **fails closed**: if `TASKOS_TOKEN` is unset, every request is
rejected with a 500. An unset secret never means "allow everyone".

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

It does three things — capture text to the inbox verbatim, store a photo or file
against your work, and answer `/capacity 25`. Deliberately nothing else:
anything needing judgement (which venture, what estimate, what blocks what)
stays in the Claude conversation, because that is where judgement is. A bot that
parsed "urgent yachtyhub thing by friday" into fields would be guessing, and the
inbox stops being trustworthy the moment it guesses.

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

No Telegram bot, no cron, no scheduling, no Google Calendar (available hours are
an argument), no day packing, no delegation pages, no Asana sync, no verification
integrations, no web UI. V1 had to be usable the night it was built.

Two consequences worth naming rather than hiding:

- **Milestone expiry is called, not scheduled.** `capacity()` runs
  `taskos_expire_milestones()` at the top of every call, so a past-due milestone
  cannot keep drawing demand from a date that has gone. There is no cron.
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
