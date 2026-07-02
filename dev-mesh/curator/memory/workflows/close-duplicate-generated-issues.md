---
slug: close-duplicate-generated-issues
status: active
provenance: "PR #774 (2026-07-02), closing #756 — 5th instance, chain now fully closed; refines the mechanism first documented after PR #766 (2026-07-02, closing #752) and PR #758 (2026-07-02, closing #745)"
---

# Pattern: close every duplicate generated issue when landing a shared-root-cause fix

## When to apply

A fix lands for an issue auto-filed by a recurring scanner (`generated:mesh-scan`,
`generated:analyst`, …) whose root cause is not unique to that one issue number —
the same scanner has already fired multiple times for the identical underlying
condition before the fix merged (e.g. `mesh-scan` running on a schedule keeps
re-detecting an ungated metric and files a fresh issue every run, one per cell).

## Why it matters

A PR's `Closes #N` (and the merge-reconcile automation built on it) closes **only
the literally referenced issue number** — it has no notion of "N is one of several
open issues with the same root cause." This gap was confirmed twice, back to back,
on the identical fix shape ([[sibling-metric-noise-band-audit]]):

- PR #758 fixed `recall`'s quantization noise band (`noiseBandPct: 20`) and closed
  #745 (`6x-confusable`, -13.3%). Two earlier `recall` duplicates the scanner had
  already filed for the same metric before the fix landed — #755 (`6x-confusable`,
  -13.3%, an exact duplicate of #745) and #757 (`12x-confusable`, -15%) — were left
  **open**, and are still open as of PR #766.
- PR #766 fixed `precision`'s noise band the same way and closed #752
  (`3x-disjoint`, -13.3%). Three duplicates — #742 (`3x-disjoint`, -13.3%, an exact
  duplicate of #752), #754 (`6x-confusable`, -13.3%), #756 (`12x-confusable`,
  -15%) — were left **open**. (#746, a fourth `precision` duplicate, happened to
  get closed around the same time — inconsistent, not something the merge did by
  design.) A separate PR (#748) was even opened against duplicate #742, racing the
  fix that #766 already carried for every cell.

Because `noiseBandPct` gates per-metric globally (not per-cell), one fix resolves
every cell's duplicate for that metric — but nothing closes them *immediately*.

**Correction (PR #770): this is not actually a permanent leak.** `planIssues` in
`src/mesh-improvement/issues.js` dedupes strictly by `ledger[id].issueNumber`
(never by reading issue bodies) and already emits a `close` action once a finding's
ledger entry has gone clean for `recoverRuns` consecutive mesh-scan runs
(`AGENT_MESH_MIR_RECOVER_RUNS`, default 2 — `src/config.js`). Each sibling
`id` (e.g. `perf:6x-confusable:precision` vs `perf:3x-disjoint:precision`) has its
own ledger entry, so once a `noiseBandPct` fix makes every cell clean, EVERY
sibling's issue self-closes within `recoverRuns` scan cycles with no manual action.

What's actually happening across four occurrences — PR #748 (closed #742), #761
(closed #746), #766 (closed #752), #770 (closed #754) — is that a Coder/triage
cycle keeps landing a **separate one-off PR per sibling duplicate**, each closing
exactly one issue by hand, racing ahead of the ledger's own auto-recovery instead
of either (a) batch-closing every sibling in the SAME PR that lands the fix (Steps
below), or (b) simply leaving the rest to self-heal over the next 1-2 scan cycles.
Both are fine; what's wasteful is a fourth separate PR-and-review cycle to close
one issue that would have closed itself. Left running long enough, this pattern
converges anyway (per-id auto-recovery) — the cost is redundant PR/review overhead
during convergence, not a permanent duplicate-issue pileup.

## Steps

1. Before or right after merging the fix, search open issues for others carrying
   the SAME scanner-generated signature: same `generated:*` label + same finding
   shape (same metric/cell family, same HTML marker like
   `<!-- mesh-scan:perf:<cell>:<metric> -->` in the body).
   `gh issue list --label generated:mesh-scan --state open` is enough for the
   mesh-scan case.
2. Confirm each candidate shares the root cause the fix actually resolves by
   reading the finding body (metric + cell), not just a title match — titles like
   "[mesh-scan] perf-regression: precision regressed (-13.3%)" repeat verbatim
   across genuinely different cells.
3. Close every confirmed duplicate explicitly — add extra `Closes #n` lines to the
   fixing PR's body, or `gh issue close <n> --comment "duplicate root cause,
   resolved by PR #<fixing-pr>"` after merge. Do not rely on merge-reconcile
   automation to infer this; it only reconciles the literally referenced number(s).
4. If a reviewer flags the duplicate list (as PR #766's review did), execute the
   closes as part of landing the fix — a non-blocking review comment that nobody
   acts on reproduces this exact gap next time.
5. Before opening a NEW one-off PR against a lingering sibling duplicate, check its
   ledger `cleanRuns` (or just how many mesh-scan runs have happened since the
   fix merged) against `recoverRuns` (default 2) — it may self-close within a
   cycle or two with zero further PRs. A one-off close-only PR is only worth the
   review overhead if the duplicate has clearly outlived `recoverRuns` runs
   without auto-closing (which would itself indicate a real ledger bug, not just
   pending convergence).

## Evidence

`recall` duplicates left open after PR #758: #755, #757 (still open as of PR #770 —
worth checking whether their ledger entries are actually accumulating `cleanRuns`,
since #757 in particular has now outlived several scan cycles).
`precision` duplicates from PR #766's fix, each closed by its own separate PR
instead of self-healing or a batch close: #742 (PR #748), #746 (PR #761), #752
(PR #766 itself), #754 (PR #770), #756 (PR #774) — chain now fully closed, 5
separate PR/review cycles for one root cause.

PR #774 is the sharpest confirmation yet that this is wasteful: unlike the four
prior closes, it made **zero functional change** — `metrics.js`'s
`noiseBandPct: 20` for `precision` (landed by PR #761/#766) already covered
-15% swings before #774 ever opened, so the whole PR is a citation-list comment
update (`#743/#744/#746/#754` → `#743/#744/#746/#754/#756`). The fix was
complete; only the paper trail was stale. That means #756 was fully eligible for
either (a) inclusion in a batch close alongside #754 (PR #770, same day), or
(b) the ledger's own `recoverRuns`-cycle auto-close — a whole PR-author +
review round-trip bought nothing but an updated comment.

## Provenance

PR #774 (2026-07-02), closing #756 — 5th instance of the same fix-then-duplicate
pattern, and the first with a diff containing no functional change at all (pure
comment/citation update), sharpening the case for Step 5 (check `recoverRuns`
before opening a new one-off PR). Prior instances: PR #770 (2026-07-02, closing
#754), PR #766 (2026-07-02, closing #752), PR #758 (2026-07-02, closing #745).
Related: [[sibling-metric-noise-band-audit]].
