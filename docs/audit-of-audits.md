# Audit of audits — discovering this repo's defect families

A reusable prompt. Run it when this repository has accumulated enough audit and
bug-fix history to have families worth naming, and put what it finds in the
registry table in `docs/QUALITY_SYSTEM.md`.

**In a young repo with no audit history, skip the run.** Start with the empty
table and add a family the first time the same kind of bug appears twice. A
discovery pass over four fixes invents patterns rather than finding them, and an
invented family is worse than no family: it directs the next search at a shape
that was never there.

---

## The prompt

> You are auditing the AUDITS, not the code.
>
> **Work READ-ONLY.** Change nothing. Fix nothing. Open no pull request. Your
> output is a document.
>
> **You are looking for the root causes behind bugs that have ALREADY been
> found.** You are not looking for new bugs. If you find one, note it in a
> single line at the end and move on — chasing it is how this pass turns into
> another ordinary audit and produces no answer to the question that matters.
>
> ### Read the whole corpus first
>
> - every findings, audit and review document in the repository;
> - the issue tracker, open and closed;
> - pull request review comments, which is where refutations live and where the
>   reasoning behind a rejected finding is usually the only record;
> - every commit whose message contains "fix", and the diff, not just the
>   subject line.
>
> ### Report, in this order
>
> **1. A plain-language answer, first, for a non-technical reader deciding
> whether this work is finishable.** Two paragraphs, no jargon. The question
> they are actually asking is "does this end, or does it go on forever?" — answer
> that before anything else.
>
> **2. The corpus.** Number of passes, findings raised, findings that stood,
> findings refuted, and the refutation rate. Per pass and overall.
>
> **3. Duplication, measured.** Within a single pass and across passes. State
> the method you used to judge two findings the same, so somebody can disagree
> with it.
>
> **4. The families.** For each: a one-line name, instance count, the span of
> passes it appears across, first sighting, last sighting, and — the question the
> whole exercise exists to answer — **whether ONE mechanical check could catch
> the entire family**, and what that check would be.
>
> **5. A direct numeric answer to: is this unbounded, or a few systemic causes?**
> Findings raised versus distinct classes. Say the second number out loud.
>
> **6. The fixed-but-incomplete list.** Findings marked resolved where the class
> is still open: the instance was patched, no guard exists, and siblings were
> never searched for. **This is usually the most valuable section in the
> document**, because every row on it is a bug that will be re-found, re-diagnosed
> and re-fixed by somebody who does not know it has happened before.
>
> **7. Every existing guard, and what it structurally CANNOT see.** Not whether
> each guard passes — what is outside its reach by construction. A grep over
> source cannot see a missing database constraint, a permission granted to the
> wrong role, or a table full of rows in the wrong state. Name those blind spots
> explicitly; they are where the invisible families live.
>
> **8. Harness artifacts.** Any place a past pass manufactured findings rather
> than discovering them — unset local environment variables read as production
> outages, generated type files read as the live schema, a check whose empty
> result was reported as a clean result. These inflate the corpus and, worse,
> they are the findings most likely to be "fixed".
>
> **9. Close with a "not verified" list.** What you could not check, and why.
>
> ### Standing rules
>
> - Never report an absence you did not instrument for. Say "unverified".
> - An empty result is not a clean result. Prove your query works before
>   reporting a zero.
> - Verify against the live system of record, never generated artifacts.
> - Deduplicate before counting, and always report both numbers.
