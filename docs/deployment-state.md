# TaskOS deployment — state and open items

Generated 2026-07-31 during the Phase 2 deployment.

## Two Vercel projects, one database

| project | Root Directory | serves | env vars |
|---|---|---|---|
| `task-management-mcp-u4qh` | `apps/mcp` | the MCP connector Claude talks to | `TASKOS_TOKEN`, `DATABASE_URL` |
| `task-management-web` | `apps/web` | the read-only dashboard | `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |

## Working

- MCP server boots and answers. `/health` returns `ok:true`, `tokenConfigured:true`.
- The auth gate is live: `POST /api/mcp` without a token returns 401.
- The connector is registered in claude.ai and its nine tools are visible.
- The dashboard builds and renders; `/` redirects to `/login` when signed out.

## Open — 1. Database password

`/health` reports `"database":"authentication_failed"`. The server reaches
Supabase and is rejected at login, so `DATABASE_URL` is wrong on both projects
after the password reset.

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

## Open — 2. The magic-link email

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

## What the system still cannot tell you

No real milestones or tasks have been entered. The seed data is five ventures
with weights, three placeholder milestones and two outcome targets. Until real
work is in it, `capacity()` reports floors and an uncalibrated confidence
object, not a read on an actual week.

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
