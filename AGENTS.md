# Agents working in this repository

TaskOS answers exactly one question: given real milestones and real hours, what
is going to slip? Everything here serves that.

## Read first, in this order

1. **README.md** — what this is, the two rules that override your defaults
   (`packages/engine` is pure with zero I/O; fixtures are written by hand from
   the spec, never generated from the implementation), and how it deploys.
2. **docs/QUALITY_SYSTEM.md** — fix classes, not instances. Read before fixing
   or auditing anything.
3. **docs/deployment-state.md** — what is live, what is outstanding, and the
   bugs that cost the most time, recorded so they are not repeated.

`apps/mcp/src/instructions.ts` is a fourth thing worth knowing about but is not
for you: it is the prose sent to Claude sessions that USE TaskOS through the
connector. Changing it changes how every future session behaves, and it is
asserted line by line in `apps/mcp/test/instructions.test.ts`.

## Two things about this repository specifically

**Migrations are applied by hand, and code always ships first.** The test
harness applies every migration in `supabase/migrations`; production does not.
Code must therefore never assume a column exists — see `apps/mcp/src/schema.ts`,
which exists because a deploy that assumed one took down task creation entirely.
`/health` reports which migration is outstanding.

**A test may assert a relationship to today. It may not assert a date.** Absolute
dates in fixtures have broken this suite three times, on days nobody touched the
code, and each break quietly converted a test about dependency slack into a test
about the wall clock.
