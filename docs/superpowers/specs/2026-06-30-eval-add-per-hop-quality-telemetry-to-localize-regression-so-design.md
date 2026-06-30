# Eval: Add Per-Hop Quality Telemetry to Localize Regression Source in Multi-Peer Topologies — Design

**Date:** 2026-06-30
**Status:** Design (pending review)
**Issue:** #677

## Goal

The fileable `perf:3x-disjoint:quality_per_1k_tokens` regression (−16.2%) and the non-fileable 6x-confusable dip (−7.7%) both have `evidence.scorecardPath: null` — no drill-down data exists to distinguish whether quality loss originates at **dispatch** (wrong peer selected), **execution** (peer response is verbose or off-target), or **synthesis** (orchestrator wastes tokens re-summarizing). Without per-hop instrumentation the regression is unfalsifiable.

Extend the eval harness to record `quality_per_1k_tokens` at each hop boundary (dispatch → peer → result) and emit a per-hop scorecard alongside the aggregate report. A reviewer or MIR can then open the scorecard and localize any regression to the hop that caused it — making the signal actionable rather than just observable.

## Components

- **Per-hop collector** — instruments the eval harness at each hop boundary (dispatch / peer-execution / synthesis) to record the tokens consumed and a quality signal; raw hop records are consumed by the scorer and scorecard writer.
- **Scorecard writer** — emits `<cell>-hops-scorecard.json` as an artifact alongside the aggregate report; one entry per (cell, hop).
- **Quality-per-hop scorer (pure)** — given a hop's output and tokens, computes its quality and `quality_per_1k_tokens` consistently with the aggregate scorer (so hops roll up correctly). Pure, table-testable.
- **Finding evidence wiring (report/finding-filer)** — sets `evidence.scorecardPath` on fileable findings to the per-hop scorecard for the affected cell.
- **Aggregate report (unchanged)** — continues to emit the existing top-level metrics; per-hop data is additive beside it.
- **Config** — `AGENT_MESH_PERF_PER_HOP_DISABLED` (unset; set to `1` to suppress per-hop capture and revert to aggregate-only output); applies to `3x-disjoint` and `6x-confusable` cells at minimum. Default is on for multi-peer cells.

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
- **Roll-up consistency:** per-hop `quality_per_1k_tokens` figures reconcile with the existing aggregate using a weighted-average formula (`sum(quality_i * tokens_i) / sum(tokens_i)`); the reconciliation allows for framework-overhead slack (metadata / context-passing tokens not attributed to any hop) — strict token-sum equality is not required, only that the weighted quality is within a small tolerance (e.g. ±1%).
- **`scorecardPath` populated:** a fileable finding's `evidence.scorecardPath` is **non-null** and points at the per-hop scorecard (the acceptance criterion / fixes the `null` gap).
- **Additive schema:** existing aggregate metrics and their schema are byte-unchanged; a consumer reading only the aggregate is unaffected (regression lock).
- **Localization fixture:** a synthetic run where quality loss is injected at the synthesis hop yields a per-hop scorecard showing the drop at synthesis (and not dispatch/execution) — proving the telemetry actually localizes.
- **Per-peer attribution:** in the disjoint cell, each peer's execution hop is attributed to the correct peer.
- **Toggle:** disabling per-hop capture (`AGENT_MESH_PERF_PER_HOP_DISABLED=1`) reverts to aggregate-only output; no scorecard written, `scorecardPath` behaves as before.
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
