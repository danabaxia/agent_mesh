---
slug: close-duplicate-generated-issues
status: active
provenance: "PR #766 (2026-07-02), closing #752; same gap also observed after PR #758 (2026-07-02), closing #745"
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
every cell's duplicate for that metric — but nothing closes them. Left alone these
accumulate indefinitely and invite redundant fix PRs against issues a merged PR
already resolved.

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

## Evidence

`recall` duplicates left open after PR #758: #755, #757.
`precision` duplicates left open after PR #766: #742, #754, #756 (plus a redundant
in-flight fix PR #748 opened against #742).

## Provenance

PR #766 (2026-07-02), closing #752. Prior instance: PR #758 (2026-07-02), closing
#745. Related: [[sibling-metric-noise-band-audit]].
