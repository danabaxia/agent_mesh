ompared finding (severity from the evaluator); populates `baseline` and `deltaPct` (no longer null).
- **`eval-perf.mjs` / perf collection** — supplies per-cell p50 metrics to the store and report; reads baseline for the delta.
- **Config (`src/config.js`)** — `AGENT_MESH_PERF_BUDGET_WARN_PCT`, `AGENT_MESH_PERF_BUDGET_ERROR_PCT`, rolling-window length, and a disable flag.
- **Drift-gate wiring** — ensures perf-cell history reaches the existing `mir-slow-drift-trend-gate` (#352).

## Data flow

1. A perf run produces per-cell p50 metrics (`latency_ms`, `cost_usd`, quality).
2. The baseline store loads `perf-baseline.json`.
3. **Per cell/metric:**
   - **No baseline** → cold-start: emit `info` "baseline established"; mark for write.
   - **Baseline exists** → evaluator computes `deltaPct` vs. the **existing** baseline and assigns severity from the budget ratios; emit a finding with populated `baseline` and `deltaPct`.
4. Findings flow through the normal MIR `planIssues` path (file/update/close), now with real deltas; the slow-drift trend gate additionally evaluates per-cell history.
5. **After** comparison, the rolling-update calculator rolls each cell's baseline forward from the trailing window; the store writes the updated `perf-baseline.json` (a reviewable commit).
6. Next run diffs against this baseline — drift is now detectable and distinct from a clean run.

## Testing

Pure-evaluator, store, and integration tests:

- **Cold-start:** no baseline for a cell → `info` "baseline established", baseline written, **no** `warning` `perf-regression` (fixes today's 9-false-warning bug).
- **Within budget:** current p50 within +20% of baseline → no regression finding (or `info`); `deltaPct` populated, not null.
- **Over warn budget:** latency p50 +25% vs. baseline (warn=20%) → `warning` with correct `deltaPct`.
- **Over error budget:** +60% (error=50%) → `error`.
- **Direction-awareness:** latency/cost increase is adverse; quality (`quality_per_1k_tokens`) **decrease** is adverse; improvements never flag.
- **Compare-then-update ordering:** a regressing run is compared against the *old* baseline (flags) **before** the baseline rolls forward (cannot self-mask).
- **Rolling update:** baseline tracks a sustained legitimate shift over the window; a single outlier run does not jerk it (p50/median robustness).
- **Resilience:** missing/malformed `perf-baseline.json` → cold-start, no crash; atomic write integrity.
- **Drift-gate feed:** persisted per-cell history is consumed by the `mir-slow-drift-trend-gate` (#352) — a gradual perf decline trips the trend gate even when each run is within the per-run budget.
- **Config:** custom warn/error budgets and window length honored; disable flag → no gating, no baseline writes.

## Out of scope

- **Auto-remediation of perf regressions** — this detects and files findings; it does not fix or re-route.
- **Per-run baseline (non-rolling) or frozen golden baseline** — v1 is rolling p50 over a window; a manually pinned golden baseline is a possible later option, not this spec.
- **New statistics beyond p50 + ratio budgets** (e.g. percentile envelopes, variance-aware z-scores) — deferred; pairs with the MIR variance work (#324) rather than re-implementing it.
- **Changing how perf metrics are *collected*** — consumes existing `eval-perf.mjs` p50 outputs; collection is unchanged.
- **Backfilling historical baselines** — the baseline starts from the first run after this lands (today's run becomes the cold-start baseline).
- **Non-perf clusters** — this targets the perf cells that currently emit null baselines; other MIR metrics already have baselines.
- **Verification of cited OSS prior art** (`github-action-benchmark`, `pytest-benchmark`/CodSpeed) — from prior knowledge; live confirmation was blocked and should be validated, but the design does not depend on it.
- **Path-guard / anti-spoof / write-boundary changes** — none; the baseline file is a committed repo artifact written by the eval/report tooling.
