# Rolling-Window / Median Baseline for MIR High-Variance Ratio Metrics — Design

## Goal

Eliminate false-positive MIR soft-findings caused by single-run noise in high-variance ratio metrics (specifically `quality_per_1k_tokens`). Two levers are evaluated against Phase 0 empirical evidence before any code ships:

- **Lever A (noise-band widening):** Increase `AGENT_MESH_MIR_NOISE_BAND_PCT` to absorb single-run variance. Simple, no algorithm change.
- **Lever B (rolling-window median):** Replace the §10 single-previous-value baseline with a trailing-median computation over the last *W* runs. More principled; requires a per-finding history store carried forward across runs.

Phase 0 evidence gates both levers — no algorithm or band change ships without it.

## Background

PR #321 reverted a rolling-window baseline implementation. The Reviewer blocked merge on two grounds: (1) the change shipped Lever B without the §10/§11 spec amendment that would have authorised it, and (2) no empirical evidence confirmed the -31.6% `quality_per_1k_tokens` drop in PR #318 was run noise rather than a regression.

The Coder (danabaxia) recorded the correct path:
1. Gather variance/CV data for `quality_per_1k_tokens` across ≥3 runs as evidence for the noise premise.
2. Amend §10/§11 of the MIR design spec to promote rolling-window baselines to v1 with rationale.
3. Re-open as a separate PR with evidence and spec amendment included.

This spec is the §10/§11 amendment that step 2 requires. The Phase 0 evidence collection infrastructure (`computeStats` / `median` utilities and the per-finding `history` carry-forward in `baseline.js`) is the Lever B implementation that step 3 enables.

## Components

- **Spec amendment** to `docs/superpowers/specs/2026-06-19-mesh-improvement-report-design.md` §10 and §11 — the authorizing artifact. **Required before any Lever-B code merges.**
- **MIR baseline comparator** (existing, in the MIR report generator) — for Lever A: no logic change, only the configured band value. For Lever B: replaces the single-previous-value lookup with a trailing-median computation plus cold-start fallback.
- **`AGENT_MESH_MIR_NOISE_BAND_PCT`** (existing config) — for Lever A, its default/recommended value changes. For Lever B it is retained and applied around the new median baseline.
- **Run-history reader** (Lever B only) — supplies the trailing *W* run values for the metric to the comparator.

## Data flow

**Phase 0 (gate):**
1. Collect ≥3 recent run values of `quality_per_1k_tokens`.
2. Compute mean/σ/CV and delta distribution.
3. Classify the #318 -31.6% drop as noise vs. regression → decide go/no-go and which lever.

**Lever A runtime:**
1. MIR run produces the current metric value.
2. Comparator compares against the single previous value using the **widened** `AGENT_MESH_MIR_NOISE_BAND_PCT`.
3. Flag only if the delta exceeds the wider band.

**Lever B runtime:**
1. MIR run produces the current metric value.
2. Run-history reader fetches the trailing *W* prior values.
3. Comparator computes the **median** of those *W* values (or falls back to single-previous-value if `< W` runs exist).
4. Current value is compared against the median under `AGENT_MESH_MIR_NOISE_BAND_PCT`.
5. Flag only if the delta from the median exceeds the band.

## Testing

**Phase 0 / evidence:**
- The collector reproducibly computes CV and the delta distribution from a fixed set of run records; assert the classification of a known outlier vs. an in-distribution value.

**Lever A:**
- With the widened band, the #318-style -31.6% single-run swing (shown by evidence to be noise) does **not** flag.
- A regression larger than the new band still flags (band did not blind MIR to real drops).
- Band value is sourced from config; default change is reflected.

**Lever B:**
- **Median smoothing:** a single outlier run within an otherwise stable window does not move the baseline enough to flag (median robustness).
- **Real regression:** a sustained drop across the window shifts the median and **does** flag.
- **Cold start:** with `< W` prior runs, the comparator falls back to §10 single-previous-value behavior — assert identical results to the pre-change baseline.
- **Window boundary:** exactly *W* runs uses the median; *W*-1 uses fallback.
- **Median vs. mean:** a test fixture where mean would mask/exaggerate a change but median behaves correctly, locking the median choice.

**Cross-cutting / governance:**
- **Spec-conformance guard:** a test or CI check asserting that if the rolling-window algorithm is present in code, §11 no longer lists it as deferred (prevents re-introducing the §321 violation — code and spec must agree).

## Out of scope

- **Implementing both levers.** The evidence gate selects exactly one; this spec does not ship band-widening *and* a new baseline algorithm together.
- **Shipping any algorithm change before the Phase 0 evidence and §10/§11 amendment exist.** That is the explicit failure mode of PR #321 and is prohibited here.
- **Smoothing metrics other than the evidenced ratio metric(s).** Only metrics with demonstrated high variance are in scope; non-ratio or low-CV metrics keep the §10 baseline.
- **Adaptive / per-metric dynamic windows or auto-tuned bands.** A single fixed *W* (or single band value) in this iteration; auto-tuning is a later concern.
- **Re-evaluating the #318 fix itself.** This spec governs MIR's noise handling, not the merits of issue #318's mesh-scan change.
- **Anomaly-detection methods beyond median/window** (EWMA, z-score, changepoint detection) — heavier statistical machinery is deferred.
- **Changing what MIR reports or its thresholds for other metrics** beyond the baseline/band mechanism described.
