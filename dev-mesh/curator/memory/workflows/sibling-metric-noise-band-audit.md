---
slug: sibling-metric-noise-band-audit
status: active
provenance: "PR #758 (2026-07-02), closing #745; PR #761 (2026-07-02), closing #746; follows quick.json#per-metric-noise-band-llm-variance (PR #461)"
---

# Pattern: audit sibling metrics before landing a per-metric noise-band fix

## When to apply

A `mesh-scan` perf-regression is resolved by adding `noiseBandPct` to ONE metric in
`src/mesh-improvement/metrics.js`, and the root cause is **small-sample quantization**
— a mean over a handful of discrete per-task decisions (e.g. routing recall/precision
on a 3-task confusable cell) — rather than real API wall-clock/cost jitter.

## Why it matters

PR #758 widened `recall`'s band (`noiseBandPct: 20`): on a 3-task routing cell a single
flipped decision swings the mean ~33%, so the rolling-median baseline still leaves
~13% of normal-jitter headroom (issue #745, a -13.3% swing with no code change). But
`precision` is computed over the **same task set and denominator** on the same cells —
identical quantization character — and was left on the tight global 10% band. The
PR's own review flagged this as a forward-pointer risk; no follow-up issue was filed.
Within hours, precision perf-regressions piled up ungated and auto-routed as `bug`
(auto-fix-eligible, no human gate): issues #742, #746, #752, #754, #756 — five
concurrent duplicate "precision regressed" issues from repeated mesh-scan runs.

This is a distinct root-cause class from
[[per-metric-noise-band-llm-variance]] (PR #461, `latency_ms`/`cost_usd`): that lesson's
cause is real API wall-clock/cost jitter; this one is small-n quantization (n discrete
pass/fail decisions on a fixed cell → each flipped decision moves the mean by ~1/n).
Same fix mechanism (per-metric `noiseBandPct` in the `METRICS` registry), different
root cause — recognize both when triaging a perf-regression finding.

## Steps

1. Classify the root cause: LLM-latency/cost jitter, or small-n quantization (a mean
   over k discrete decisions on a shared denominator/cell).
2. For quantization causes, enumerate every metric computed over the SAME
   denominator/cell (recall + precision share the identical per-task routing outcomes).
3. Gate ALL sibling metrics with the matching root cause in the SAME PR — do not gate
   one metric and leave the others on the tight global band, even if only one
   currently has an open issue.
4. If scope must stay narrow (fix only the metric named in the triggering issue), open
   the sibling's forward-pointer issue immediately as part of the same PR — a review
   comment that "this should probably get its own issue" does not stop the next
   mesh-scan run from auto-filing duplicate `bug` issues against the ungated sibling.
5. After the gating fix merges, sweep OPEN issues carrying the same finding marker
   (`<!-- mesh-scan:perf:<cell>:<metric> -->`) as any issue the fix PR's `Closes #N`
   references, and close the rest as duplicates too. A merged PR only auto-closes /
   post-merge-reconciles the issue number(s) literally in its `Closes` line
   (`planPostMergeReconcile` keys off `closingIssuesReferences`) — it does not know
   about other open issues that share the same natural key. Confirmed gap: PR #761
   fixed `precision`'s band (closing #746) and its merge-commit body also names
   #743/#744, but three same-key duplicates filed by a second mesh-scan run before the
   fix landed — #742 (`perf:3x-disjoint:precision`, dup of #752), #754
   (`perf:6x-confusable:precision`, dup of #744), #756 (`perf:12x-confusable:precision`,
   dup of #746) — were never referenced anywhere and are still OPEN after the fix
   merged. They will stay open forever unless something explicitly closes them; the
   fix alone only stops the *next* scan from refiling.

## Evidence

Precision perf-regression `bug` issues filed against the ungated metric, two batches
from two separate mesh-scan runs before PR #761 closed the gap: first run (10:19:40Z)
— #742, #743 (recall), #744, #745 (recall), #746; second run (11:30:14Z, same natural
keys as three first-run issues, i.e. the coalesce-by-natural-key intake guard did not
catch these as dups of an already-open issue) — #752, #754, #756. PR #758 closed #745
(recall); PR #761 closed #746 and referenced #743/#744 in its merge body — but #742,
#754, #756 remain open post-fix (step 5).

## Provenance

PR #758 (2026-07-02), closing #745; PR #761 (2026-07-02), closing #746. Related:
`quick.json#per-metric-noise-band-llm-variance` (PR #461),
`quick.json#mir-noise-band-reversion` (PR #477).
