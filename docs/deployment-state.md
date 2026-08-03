# TaskOS deployment — state and open items

Generated 2026-07-31 during the Phase 2 deployment. Updated 2026-08-03: the
database, the Telegram bot and the delegation pages are all live.

## Two Vercel projects, one database

| project | Root Directory | serves | env vars |
|---|---|---|---|
| `task-management-mcp-u4qh` | `apps/mcp` | the MCP connector, the Telegram webhook, the delegation pages | `TASKOS_TOKEN`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_*`, `TASKOS_PUBLIC_URL` |
| `task-management-web` | `apps/web` | the read-only dashboard | `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

## Working

- MCP server boots and answers. `/health` returns `ok:true`, `tokenConfigured:true`.
- The auth gate is live: `POST /api/mcp` without a token returns 401.
- The connector is registered in claude.ai; it now exposes 43 tools.
- The dashboard builds and renders; `/` redirects to `/login` when signed out.
- The Telegram webhook answers 200 with a matching secret header.
- The delegation pages are live and unauthenticated: `/p/<token>`, `/d/<token>`,
  `/c/<token>.ics`, and the three POSTs under them.

## Resolved — 1. Database password

**Fixed.** `/health` now reports `"database":"connected"`. The cause was that the
connection string was regenerated after a password reset and never pasted into
Vercel — and an env change does nothing until the project is redeployed. The
required shape is kept below because it is the part that is easy to get wrong.

Required shape:

```
postgresql://postgres.PROJECTREF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
```

- username is `postgres.PROJECTREF`, not `postgres` — the pooler routes on it
- port 6543 (transaction pooler), not 5432
- no square brackets around the password, no quotes, no trailing space
- percent-encode `@ : / ? # & %` in the password (`@` becomes `%40`)

Copy it from Supabase's green **Connect** button → Connection string →
Transaction pooler, and replace only `[YOUR-PASSWORD]`.

Test before pasting into Vercel:

```bash
psql "postgresql://..." -c 'select 1'
```

`1` means correct. "password authentication failed" means the password or its
encoding is wrong. A hang or "could not translate host name" means the ref or
region is wrong.

Then update both projects and redeploy both. Confirm:

```bash
curl -s https://task-management-mcp-u4qh.vercel.app/health
# want "database":"connected"
```

## Open — 2. The magic-link email (dashboard only)

The login form reports "Could not send the link". That call goes from the
browser straight to Supabase, so no Vercel log records it. To get the real
reason: DevTools → Network → click the button → the `otp` request → Response.
The deployed code also prints it to the Console now.

Two likely causes:

- **The redirect URL is not allow-listed.** Sign-in was attempted on a preview
  deployment (`task-management-f28g4fwby-…`), whose hostname changes on every
  push, so no allow-list entry can ever match it. Use the stable domain, and
  set Supabase → Authentication → URL Configuration → Site URL to it with
  `<domain>/auth/callback` in Redirect URLs.
- **The built-in SMTP cap**, a couple of messages an hour on the default mailer.

## Then — grant yourself the workspace

There is no self-signup. After signing in once, so `auth.users` has the row:

```sql
insert into workspace_members (workspace_id, user_id)
select '00000000-0000-0000-0000-000000000001', id
from auth.users where email = 'tal.foxamit@seatophomes.com';
```

Until that row exists, sign-in succeeds and the dashboard shows nothing. That
is the no-fallback rule working, not a bug.

## Delegation, deployed

`TASKOS_PUBLIC_URL` is what `delegate_link` builds links on. It is optional: with
it unset the code falls back to `VERCEL_PROJECT_PRODUCTION_URL`, which Vercel
provides automatically, and with neither it returns a relative path and says so
in the confidence notes. Setting it explicitly is worth doing once, so the value
is visible rather than inferred.

Verified live against production on 2026-08-03:

```bash
curl -sD- -o/dev/null https://task-management-mcp-u4qh.vercel.app/p/tdp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
# 404 with an HTML "Link not found" page, plus
#   cache-control: no-store, private
#   referrer-policy: no-referrer
#   x-robots-tag: noindex, nofollow, noarchive
#   content-security-policy: default-src 'none'; ...; form-action 'self'
```

That 404 is worth more than it looks: the token is well-formed, so reaching
"unknown" means the route resolved it against the production database on an
UNAUTHENTICATED request, which is the one code path the delegate pages have that
nothing else does.

The end-to-end check that still needs Tal's bearer token is minting a real link
with `delegate_link` and opening it.

## What the system still cannot tell you

**Superseded.** Real work is in it now: four active milestones, ~70 open tasks,
two people with stated weeks, and a day allocation. `capacity()` reports an
actual read on an actual week rather than falling back to floors.

What it still does not know is whatever `get_context()` lists under `unknown` —
that array is the current answer to this heading, and it is maintained by the
code rather than by this file.

## The bug that cost the most time, recorded so it is not repeated

Phase 2 added `apps/mcp/src/index.ts` as a barrel for the dashboard and pointed
`package.json` `"main"` at it. Vercel deploys `apps/mcp` as a Node.js server app
and takes its entrypoint from `"main"` — so it booted the barrel, which has no
default export, and every request returned 500. It built, typechecked and
deployed clean; only production failed.

The first fix guessed the cause was filename precedence and renamed the file,
which changed nothing because `"main"` still pointed at it. The fix is that
`main` and `exports["."]` both name `server.ts`, with the barrel on the `./lib`
subpath, asserted by `apps/mcp/test/entrypoint.test.ts`.

The general lesson, which held every time in this deployment: read the runtime
log before changing anything. Every wrong turn here came from inferring a cause
from a symptom instead.
