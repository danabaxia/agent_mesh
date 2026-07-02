---
slug: sibling-metric-noise-band-audit
status: active
provenance: "PR #758 (2026-07-02), closing #745; follows quick.json#per-metric-noise-band-llm-variance (PR #461)"
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

## Evidence

Precision perf-regression `bug` issues open concurrently after PR #758 merged without
a sibling fix: #742, #746, #752, #754, #756. PR #766 (2026-07-02) closed the gap by
gating `precision` the same way, closing #752 — but left #742/#754/#756 open; see
[[close-duplicate-generated-issues]] for that follow-on lesson (the merge-reconcile
convention only closes the literally-referenced issue number, not every duplicate the
scanner had already filed for the same root cause).

## Provenance

PR #758 (2026-07-02), closing #745. Follow-up: PR #766 (2026-07-02), closing #752,
confirmed steps 1-3 of this pattern and surfaced [[close-duplicate-generated-issues]].
Related: `quick.json#per-metric-noise-band-llm-variance`
(PR #461), `quick.json#mir-noise-band-reversion` (PR #477).
