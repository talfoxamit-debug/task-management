# TaskOS — where things stand

Last verified against production **2026-09-03**. This file exists so the state of the
project survives a conversation ending. Anything important that lives only in a chat
transcript is lost, and this project has already lost things that way.

**Two audiences.** The first section is Tal and needs a Supabase tab, a Vercel tab or a
phone. The second is whichever coding session picks this up next. GitHub issues carry the
full reasoning; this is the index.

---

## Production, as measured

```
GET https://task-management-mcp-u4qh.vercel.app/health
{"ok":true,"service":"taskos-mcp","tokenConfigured":true,"database":"connected",
 "schema":"behind","pendingMigration":"0017",
 "dailyBrief":{"lastRun":"2026-09-02","daysSince":0},
 "cronSecretConfigured":false}
```

Read that endpoint before believing anything below. It is generated from the live database
and this file is not.

| | |
|---|---|
| Database | connected |
| Migrations | **0017 pending.** 0016 is applied — an earlier report saying otherwise was wrong |
| Daily brief | running; last sent 2026-09-02 |
| `CRON_SECRET` | unset, and the brief works anyway (see item 5) |
| Tools exposed | 46 |

---

## Tal's list

### 1. Run `supabase/migrations/0017_engagements.sql` — blocking, 2 min

Supabase → SQL Editor → paste the file → Run. Confirm `/health` flips to `"schema":"ok"`.

Until this runs, `set_engagement` refuses the write with `migration_pending` and every day
falls back to the weekly shape. Nothing else is affected — that is the migration-guard rule
working: **a missing table costs the feature that needs it and nothing else.**

### 2. Record the Miss Michelle relief — 1 min, needs item 1

Say to Claude:

> Set an engagement: "Miss Michelle relief", venture foxsolutions, 2026-08-31 to 2026-09-20,
> note "chief engineer cover".

The day shape has been wrong since 31 Aug. This corrects it and expires by itself on 21 Sep.

### 3. Redeploy, then read `/health` for storage — issue #1 is diagnosed

**Diagnosed on 2026-09-03 and fixed in code.** `PGRST125` is a *PostgREST* error, so Storage
was never reached: `SUPABASE_URL` almost certainly carries a `/rest/v1` suffix, which is the
URL the Supabase dashboard shows for the REST API. The code now reduces it to the origin, so
the value's shape can no longer break uploads.

Nothing to change by hand. After the next deploy:

```bash
curl -s https://task-management-mcp-u4qh.vercel.app/health
```

- `"storage":{"configured":true,"bucketReachable":true}` → documents work.
- `problem` mentions the bucket → create `taskos-documents` in Supabase → Storage.
- anything else → the `problem` string names it.

### 4. Set a `TASKOS_TOKEN` you chose

A generated token was printed into a chat transcript. **Treat it as burned.** Pick your own,
set it in Vercel, redeploy, then re-add the connector as:

```
https://<host>/api/mcp?token=<TASKOS_TOKEN>
```

This server has no sign-in flow; the credential goes in the URL. It answers **403** rather
than 401 to anything unauthenticated, deliberately — a 401 makes MCP clients go hunting for
an OAuth service that does not exist, which is what produced the
`Couldn't register with Task-OS's sign-in service` error.

### 5. `CRON_SECRET` — optional hardening, not a fix

Vercel only sends an `Authorization` header when the secret is set. The brief's route
therefore accepts the `vercel-cron` user-agent when it is unset. **This was the bug that
silenced the morning brief for weeks**: the cron fired twice a day and got 401 both times.
Setting the secret is worth doing; nothing is broken without it.

### 6. Pair your own Telegram — not possible yet

Blocked on issue #6. Delegate pairing works; there is no owner chat.

---

## The build queue

Ordered. The order is not arbitrary — see the notes.

| # | Issue | Why here |
|---|---|---|
| ✅ | [#1 `attach_document` 404s](https://github.com/talfoxamit-debug/task-management/issues/1) | **Diagnosed and fixed 2026-09-03.** Awaiting a deploy to confirm against production. Unblocks step 3 of #5 |
| 2 | [#2 recurring completion history](https://github.com/talfoxamit-debug/task-management/issues/2) | **Has a date on it.** The 20 Sep handover deliverable *is* the maintenance log, and the history does not exist to draft it from |
| 3 | [#6 owner Telegram chat](https://github.com/talfoxamit-debug/task-management/issues/6) | The scheduler half is already live. Pairs with #2: a recurring item can currently neither notify nor record |
| 4 | [#3 contacts who are not delegates](https://github.com/talfoxamit-debug/task-management/issues/3) | Four such people appeared in two days and all live in free-text notes |
| 5 | [#4 archive instead of delete](https://github.com/talfoxamit-debug/task-management/issues/4) | Three milestones already deleted with their reasoning unrecoverable |
| 6 | [#5 money and tax](https://github.com/talfoxamit-debug/task-management/issues/5) | Largest, and blocked at step 3 by #1. Live 2026-10-15 milestone |
| — | [#7 multi-session context](https://github.com/talfoxamit-debug/task-management/issues/7) | **Decide before building.** May be a git problem in a TaskOS costume |
| — | [#8 dashboard magic link](https://github.com/talfoxamit-debug/task-management/issues/8) | Broken since day one; everything has routed around it |
| — | [#9 date-fixture debt](https://github.com/talfoxamit-debug/task-management/issues/9) | Guarded. Drain **opportunistically**, never as a sweep |

---

## Shipped, and why it was built that way

The reasoning matters more than the feature list. These are the decisions a future session
would otherwise re-litigate or quietly undo.

**Engagements** (`0017`, `day-shape.ts`). A dated override of the weekly shape. The work was
not the table — it was that **four call sites read `day_allocation` directly**, and teaching
one would produce a system that disagrees with itself about what today is. Nothing reads
that table now; everything asks `resolveDayShape`. Overlaps resolve **shortest-wins**,
because "most specific" is predictable and creation order is not.

**The morning brief** (`daily.ts`). Arithmetic only — no model writes it. Leads with what is
due and what is blocked, never a greeting. Says what it does not know. Nothing is sent on a
non-working day, because a notification on a day off trains you to ignore the ones that
matter.

**The day plan** (`day-plan.ts`). Chains dependent work *inside* the day, which
`next_actions` deliberately does not. Books `ai_preparable` tasks at **review** length — so
the plan is only honest if the drafting actually happens.

**Delegation links.** One state transition per delegate. "I'm stuck" writes a comment and a
flag and **never changes status** — `waiting` is demand-excluded, so it would make the week
look *lighter*. Delegated actuals are quarantined from calibration.

**The schema-drift guard** (`schema.ts`, `/health`). Written after an outage: a deploy put
`ai_preparable` into the `commit_tasks` INSERT while 0014 was unrun, so **every task write
failed** and a planning session was lost. It typechecked and the whole suite passed, because
the test harness applies every migration and production does not. `schema-drift.test.ts`
keeps a database deliberately one migration behind. The guard was later extended to
`is_nullable`, because 0015 *relaxes* a column rather than adding one — a guard that only
covers the shape of the last bug is not a guard.

**`required_hours_per_week` is not capped at usable.** Recommended twice, declined twice.
Capping drives the deficit to zero during a fire and reports a comfortable week. The right
fix was the one shipped: report `required_hours_total`, `horizon_days` and
`deficit_hours_total` beside the rate, so the number a person can act on is present without
falsifying the one that is arithmetically correct.

**The quality system** (`docs/QUALITY_SYSTEM.md`). Fix the class, not the instance. A fix is
not done until something automatic would catch the next one.

**`SUPABASE_URL` is reduced to its origin** (`storage.ts`). The document store was unusable
for three days because the value carried a `/rest/v1` suffix, so every Storage call landed
on PostgREST and returned `PGRST125` — an error naming a component nobody was using. A
project URL never has a meaningful path, so taking the origin repairs every wrong value
instead of enumerating the wrong suffixes seen so far.

## The suggestion list, tidied

Six of eleven open suggestions were already built. Four are now marked `done` with the
commit that closed them — `next_actions`, `day_allocation`, `get_context`, engagements.

Two are **partial and deliberately left open** for Tal to decide:

- `f8aa9981` *required_hours_per_week inflates* — the reported half shipped
  (`required_hours_total`, `horizon_days`, `deficit_hours_total`, `hours_freed_total`). The
  requested **cap at usable was declined twice**, because capping drives the deficit to zero
  during a fire.
- `264543c7` *no scheduler and no owner chat* — the scheduler shipped as the morning brief.
  The owner chat has not been built; it is issue #6.

---

## Rules this project keeps relearning

- **Read the actual state before changing anything.** The cron 401, the PGRST125 diagnosis
  and the entrypoint 500 were each settled by reading a log or reproducing against
  production. Every wrong turn came from inferring a cause from a symptom.
- **An empty result is not a clean result.** Prove a check works — plant a violation and
  watch it fail — before reporting all-clear.
- **A missing migration must cost one feature, not the system.** Guard new columns with
  `hasColumn`, and add them to `EXPECTED_COLUMNS` in the same commit.
- **Do not build what was not asked for.** Two features were built unasked and one was
  thrown away. Ask first.
