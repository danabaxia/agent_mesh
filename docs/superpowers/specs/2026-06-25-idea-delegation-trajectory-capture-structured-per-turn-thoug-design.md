t size cap.

## Data flow

1. A delegation spawns `claude -p … --output-format stream-json`.
2. The CLI emits newline-delimited events as the run proceeds.
3. For each line, the stream classifier produces a `thought` / `tool_use` / `tool_result` / `run_end` event (or skips unrecognized lines).
4. The trajectory writer sanitizes, bounds, and appends each event to `<run-id>-trajectory.jsonl` in `AGENT_MESH_LOG_DIR` — streaming, so partial runs leave a partial trajectory.
5. On the terminal event, `parseResultEnvelope` extracts the result/usage envelope exactly as today → the existing `<run-id>.jsonl` aggregate log and cost capture are written unchanged.
6. **Later/offline:** `triage_logs` reads trajectories and emits `kind: "trajectory"` findings; the eval harness (if opted in) reads them for path-efficiency and stuck-loop scoring.
7. **Future (out of scope):** the trajectory JSONL serves as the substrate for mid-run replay/resume and training-data export.

## Testing

Pure-classifier, writer, and integration tests (hermetic, using recorded stream-json fixtures — no live model):

- **Event classification:** a fixture stream of model thoughts, tool calls, and tool results is classified into the correct `thought` / `tool_use` / `tool_result` / `run_end` sequence with monotonic `seq`.
- **Terminal-envelope parity:** with `stream-json`, `parseResultEnvelope` extracts the same result/usage envelope it would have from `--output-format json` (no regression in aggregate log or cost capture).
- **Aggregate-log unchanged:** the `<run-id>.jsonl` content is identical (modulo expected fields) whether streaming is on or off.
- **Partial trajectory on failure:** a stream truncated mid-run (timeout/crash) still yields a valid partial `<run-id>-trajectory.jsonl` ending without a `run_end` — diagnosable.
- **Sanitization & truncation:** a secret-bearing tool result is redacted; an oversized payload is truncated with `truncated: true`.
- **Malformed-line resilience:** an unparseable stream line is skipped; the writer does not crash and continues.
- **Disable flag:** `AGENT_MESH_TRAJECTORY_DISABLED` reverts to single-shot JSON; no trajectory file written; behavior matches pre-change.
- **`triage_logs` trajectory findings:** a fixture with a tool-retry loop yields a `kind: "trajectory"` stuck-loop finding; a shallow single-turn run yields the shallow-run finding; a healthy trajectory yields none.
- **Eval opt-in:** with trajectory reading enabled, path-efficiency (turns-to-solution) is computed; with it disabled, eval behaves exactly as before.
- **Ordering/sequence integrity:** events are persisted in stream order with consistent `seq`/`ts`.

## Out of scope

- **Mid-run replay / pause / resume / fork** — the trajectory JSONL is the *foundation* for these; implementing replay is explicitly future scope.
- **Training-data export pipeline** — trajectories *enable* demonstration export, but building the export/fine-tuning pipeline is separate.
- **Wire-protocol or model-facing changes** — none; this is server-side stdout instrumentation only. A2A Task shapes and the peer bridge are untouched.
- **Changing aggregate cost/usage capture** — `2026-06-13-delegate-cost-capture` semantics are preserved unchanged; this is additive per-turn data.
- **Real-time streaming of trajectory to callers** — this writes a file for offline consumption; live SSE of trajectory events to a caller is a different concern (cf. the A2A SSE idea).
- **Cross-hop trajectory stitching** — each delegated run gets its own trajectory file; assembling a unified multi-hop trajectory tree across A→B→C is a later enhancement.
- **A UI/viewer for trajectories** — the deliverable is the structured data + triage/eval signals; a visualization surface is out of scope.
- **Retroactive trajectories for past runs** — capture begins going forward; historical runs have no trajectory.
- **Path-guard / anti-spoof / write-boundary changes** — none; writes go to `AGENT_MESH_LOG_DIR` like existing logs.
