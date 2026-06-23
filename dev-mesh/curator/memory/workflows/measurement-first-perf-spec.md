---
slug: measurement-first-perf-spec
status: active
provenance: "PR #427 (2026-06-23) — Investigate faster speech recognition methods"
---

# Pattern: Measurement-First Spec for Performance Investigations

## When to apply

When a perf complaint arrives ("X is too slow") and the target feature already
hides its implementation behind a pluggable interface. Do not pre-commit to a
solution in the spec; the winning approach is a **benchmark output**, not an
input.

## Why it matters

Pre-committing to an engine or approach in a spec skips the phase-0 measurement
that would reveal whether the suspected stage is even the bottleneck. PR #427
deliberately deferred the STT engine selection to a benchmark decision artifact,
leaving the "which engine wins" question as an output of the investigation.
This keeps the spec honest, avoids wasted implementation effort, and produces a
reproducible decision record.

## The four-phase structure

| Phase | Gate | Output |
|-------|------|--------|
| **0 — Measure** | Always the first step | Per-stage latency table (p50/p95); identifies the dominant stage |
| **1 — Decision gate** | Is the suspected stage the bottleneck? | Proceed to benchmarking, or re-scope to the real bottleneck |
| **2 — Benchmark candidates** | Pluggable interface already exists | Latency + WER (or equivalent quality metric) per candidate |
| **3 — Select winner** | Meets latency goal within quality ceiling | The selected adapter + config knob; fallback to old path |

## Required pre-conditions

- The feature's implementation is behind a **pluggable interface** (e.g.
  `createVoiceEngine`) — if not, a separate interface-extraction spec precedes
  this one.
- A **clip corpus** (or equivalent test fixture) exists for reproducible
  benchmarking; if not, define it in the spec as a deliverable.

## Non-goal rule

The spec MUST list "pre-committing to a specific engine/approach" as a
**Non-goal**. This is a hard signal to reviewers that the spec is correctly
measurement-first, not a solution in disguise.

## Testing checklist

- [ ] Baseline capture: existing path produces a recorded p50/p95 before any candidate is run.
- [ ] Benchmark reproducibility: harness yields stable per-candidate results across repeated runs.
- [ ] Latency improvement: selected candidate shows materially lower p50/p95 than baseline.
- [ ] Quality guard: selected candidate stays within the quality ceiling (WER, accuracy, etc.).
- [ ] Interface conformance: each candidate adapter satisfies the same "in → out" contract.
- [ ] Config switch: env var selects the engine; invalid/unset → documented default.
- [ ] Fallback path: forced failure falls back to the prior implementation without breaking the feature.

## Provenance

PR #427 (2026-06-23): Analyst-authored spec for faster STT, resolving issue
#425 ("speech broadcast too slow"). The spec was filed without pre-committing
to any engine, using the pluggable `createVoiceEngine` interface established by
the prior PWA Voice Interaction spec (2026-06-22).
