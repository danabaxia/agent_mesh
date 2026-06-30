 artifact alongside the aggregate report; one entry per (cell, hop).
- **Quality-per-hop scorer (pure)** — given a hop's output and tokens, computes its quality and `quality_per_1k_tokens` consistently with the aggregate scorer (so hops roll up correctly). Pure, table-testable.
- **Finding evidence wiring (report/finding-filer)** — sets `evidence.scorecardPath` on fileable findings to the per-hop scorecard for the affected cell.
- **Aggregate report (unchanged)** — continues to emit the existing top-level metrics; per-hop data is additive beside it.
- **Config** — optional toggle for per-hop capture (default on for multi-peer cells); applies to `3x-disjoint` and `6x-confusable` at minimum.

## Data flow

1. The eval harness runs a multi-peer cell (e.g. `3x-disjoint`).
2. The per-hop collector records, at each boundary:
   - **dispatch** → tokens + routing-quality,
   - each **peer execution** → tokens + per-peer quality,
   - **synthesis** → tokens + synthesized-output quality.
3. The per-hop scorer computes `quality_per_1k_tokens` for each hop; the figures roll up to (and reconcile with) the existing aggregate metric.
4. The scorecard writer emits `<cell>-hops-scorecard.json` next to the aggregate report.
5. The report/finding-filer sets `evidence.scorecardPath` on the fileable `3x-disjoint` finding to that artifact (non-null).
6. A reviewer / MIR opens the per-hop scorecard and localizes the −16.2% regression to dispatch, execution, or synthesis — the regression is now falsifiable and actionable.

## Testing

Pure-scorer and harness tests (hermetic):

- **Per-hop breakdown present:** running `3x-disjoint` and `6x-confusable` produces a per-hop scorecard with dispatch / peer-execution / synthesis entries, each carrying `quality`, `tokens`, `quality_per_1k_tokens`.
- **Roll-up consistency:** per-hop figures reconcile with the existing aggregate `quality_per_1k_tokens` for the cell (no contradictory totals).
- **`scorecardPath` populated:** a fileable finding's `evidence.scorecardPath` is **non-null** and points at the per-hop scorecard (the acceptance criterion / fixes the `null` gap).
- **Additive schema:** existing aggregate metrics and their schema are byte-unchanged; a consumer reading only the aggregate is unaffected (regression lock).
- **Localization fixture:** a synthetic run where quality loss is injected at the synthesis hop yields a per-hop scorecard showing the drop at synthesis (and not dispatch/execution) — proving the telemetry actually localizes.
- **Per-peer attribution:** in the disjoint cell, each peer's execution hop is attributed to the correct peer.
- **Toggle:** disabling per-hop capture reverts to aggregate-only output; no scorecard written, `scorecardPath` behaves as before.
- **Resilience:** a missing/failed hop measurement is recorded as such (no crash, no phantom perfect score).

## Out of scope

- **Diagnosing or fixing the regression** — this provides the drill-down data to localize a regression; deciding and applying the fix is separate analysis/work.
- **Changing aggregate metrics or their schema** — strictly additive; the aggregate `quality_per_1k_tokens` and its computation are unchanged.
- **Per-hop telemetry for single-peer cells** — the value is in multi-peer topologies; single-hop cells gain little and are not the target.
- **Defining new quality scoring methodology** — per-hop uses the existing quality scorer applied at hop granularity; inventing a new score is out of scope.
- **Baseline/budget/noise-band changes** — owned by #412/#324/#433; this feeds them better evidence, it doesn't change gating.
- **Trajectory-level (turn-by-turn) capture** — that's the delegation-trajectory idea (#517); this is hop-boundary granularity, complementary not duplicative.
- **Real-time/streaming per-hop telemetry** — emitted as an artifact post-run, not streamed live.
- **Path-guard / anti-spoof / write-boundary changes** — none; eval-side instrumentation writing a scorecard alongside the existing report.
