# Quality system — fix classes, not instances

Installed 2026-08-14. Read this before fixing or auditing anything.

This exists because of a measurement taken on a sibling repository. Twenty-one
audit passes raised about 679 findings, and the list felt unbounded — every pass
found more, so every pass implied the next one would too. It was not unbounded.
Those 679 findings collapsed to roughly **12 recurring root causes**. In the
newest pass, 47% of confirmed findings traced to two of them, and three of its
four "blockers" were one defect seen from three angles.

Two things kept the list growing:

**Every fix patched an instance and left the class open.** The nineteenth
occurrence of a defect family gets fixed exactly as carefully as the first, and
the twentieth still ships, because nothing about fixing one row prevents the
next one.

**Every automated guard was a text search over source code.** That is a
structural blind spot, not an oversight: a missing database constraint, a
permission granted to the wrong role, a column nobody revoked, a table full of
rows in the wrong state — none of these appear in any file, so no grep over the
repository can see them. Whole defect families were invisible to CI *by
construction*, and their absence from CI read as their absence from the system.

## The one rule

**Fix the class, not the instance. A fix is not done until something automatic
would catch the next instance.**

Where a fix enumerates — a list of the four call sites, the three tables, the
five files — prefer replacing the enumeration with a rule. An enumerated list is
correct on the day it is written and silently incomplete on the day something is
added to it.

## What "done" means

All four. Anything less is **"instance patched"**, and you say so in those words.

1. **The instance is fixed.**
2. **The class is named** — which family this belongs to.
3. **Siblings were searched for**, and either fixed or listed. A family is never
   one row. If the search returns one, either the search was wrong or it is not
   a family yet; say which.
4. **A guard exists.** If a guard is genuinely impossible, write down *why*, and
   what a human checks instead.

Reporting "fixed" when only step 1 is true is how a defect gets fixed twice, by
two different people, each believing it was closed.

## The guard ladder

Prefer the highest rung you can actually reach.

**1. A database constraint or trigger.** Cannot be bypassed by any code path, any
future agent, or anyone writing SQL by hand. This repository already leans on
this: cycle prevention in `task_dependencies`, the cross-workspace guards in
0007 and 0011, `check ((scope = 'owner') = (person_id is null))` in 0015. A
constraint is the only guard that holds when the next writer has never read this
document.

**2. A build-time check that blocks the deploy.** Ship it as a **RATCHET against a
checked-in baseline**, so it fails only on something *new*. This is the part
that gets skipped and it is the part that decides whether the guard survives: a
check that fails on 41 pre-existing sites is disabled within a day, and then you
have neither the guard nor the fix. Commit the baseline, fail on additions to
it, and shrink it as the backlog closes.

**3. A runtime assertion that alerts.** Weaker, because it fires after the fact
and only if somebody is listening — and a scheduled job that silently stops
delivering is itself one of the most common defect families anywhere. If you
build one of these, the alert path needs its own guard.

**4. A documented human step.** The weakest rung. Use it only when 1–3 are truly
impossible, and write down what makes them impossible, because that reason
usually expires.

## Rules for auditing

- **Never report an absence you did not instrument for.** Say "unverified"
  instead. "No instances found" and "I did not look" must never render as the
  same sentence.
- **An empty result is not a clean result.** Prove the check works — plant a
  violation and watch it fail — before reporting all-clear. An empty result from
  a broken query is indistinguishable from good news.
- **Verify against production, not a local build.** Unset local environment
  variables manufacture blockers that do not exist, and local schemas drift from
  the live one in exactly the direction that hides real problems.
- **The live system of record is the authority.** Never generated type files.
  They go stale, and they go stale silently.
- **Adversarially verify.** Hand every finding to a skeptic instructed to refute
  it. Measured refutation rates run about 20%, and reached 79% in one pass. An
  unrefuted list is roughly a third noise, and the noise is not randomly
  distributed — confident-sounding findings survive longest.
- **Deduplicate before counting**, and report **two numbers**: findings raised,
  and distinct classes. One number alone is either alarming or reassuring, and
  which one is an accident of how the pass was chunked.
- **Audit the guards themselves.** They are code. Prove each one fails on a
  planted violation. A guard nobody has seen fail is a guard nobody has tested.

## Rules for reporting

- **"Fixed"** means the class is closed and guarded. Otherwise say **"instance
  patched"**.
- **"Live"** means verified in production. Not committed. Not merged. Not
  deployed-and-assumed.
- **Always publish what you did NOT verify.** An audit without that list is
  marketing.

## The defect-class registry

**This table is deliberately empty.**

Defect families are specific to a codebase and must be discovered from its own
history. Copying a family list from another repository imports that
repository's blind spots and teaches you to look where its bugs were rather than
where yours are. `docs/audit-of-audits.md` is the prompt that discovers them
here, once there is enough history to discover them from.

**The rule for adding a family: the same KIND of bug seen twice is a class.**
Not the same bug twice — the same *kind*. Two different columns missing the same
sort of constraint is a family; the same column fixed twice is a regression.

An entry requires, **in the same commit as the fix**:

- a one-line name;
- at least two instances, each with `file:line` or a query as evidence;
- a candidate guard, and its rung on the ladder above.

Adding a family later, from memory, is how the evidence gets lost and the
family becomes an opinion.

| # | Family | Recurrence | Guard that would close it |
|---|--------|------------|---------------------------|
| _(empty — discover from this repo's own history; see the rule above)_ | | | |
