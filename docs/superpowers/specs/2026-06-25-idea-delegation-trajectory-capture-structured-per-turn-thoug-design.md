# Delegation Trajectory Capture — Structured Per-Turn TAO JSONL

## Goal

Every `delegate_task` run currently captures only the final result envelope
(summary, usage) and discards intermediate per-turn events — the model's
reasoning steps (thoughts), tool invocations (actions), and tool responses
(observations). This spec captures those events into a structured
`<run-id>-trajectory.jsonl` file alongside the existing run log, enabling
stuck-loop detection, path-efficiency scoring, and a foundation for future
replay.

## Motivation

Three concrete gaps the trajectory closes:

1. **Debugging**: when a delegated run loops, times out, or produces a wrong
   answer, operators have only the final summary and stderr tail. A TAO
   trajectory lets you reconstruct exactly what the agent tried.
2. **Eval scoring**: the performance benchmark
   (`2026-06-13-mesh-perf-benchmark-design.md` §9) scores answer quality but has
   no measure of *how efficiently* the agent reached it. Trajectory enables
   turns-to-solution and tool-retry counts.
3. **Replay / training substrate** (out of scope here): a JSONL of thought →
   action → observation triples is the standard format for demonstration data and
   future mid-run fork/resume.

## Background

- **Cost capture** (`2026-06-13-delegate-cost-capture-design.md`): the worker
  runs with `--output-format json`, which emits a single JSON object at exit.
  `parseResultEnvelope(stdout)` parses that object to extract summary and usage.
  Open Decision #1 there explicitly chose `json` over `stream-json` because "the
  worker is one-shot; we want the terminal envelope, not incremental events."
- **Dashboard session-runner**: uses `--output-format stream-json --verbose` for
  live interactive sessions, emitting newline-delimited event objects. That path
  stays separate.
- **Why this spec reverses that choice for trajectory runs**: per-turn TAO events
  are only available via `stream-json`. There is no mechanism to obtain
  intermediate thoughts and tool calls from the `json` path — it emits only the
  final aggregate. Trajectory capture therefore switches the worker to
  `--output-format stream-json` when the feature is active, and adapts
  `parseResultEnvelope` accordingly. The cost-capture decision was made without
  trajectory in mind; this spec extends it.

## Design

When trajectory capture is active (the default; disabled by
`AGENT_MESH_TRAJECTORY_DISABLED=1`):

- The worker is spawned with `--output-format stream-json` instead of
  `--output-format json`.
- The NDJSON stream is consumed line by line. Each line is classified and either
  appended to the trajectory file or ignored (unrecognized lines are skipped
  without error).
- **`parseResultEnvelope` is adapted**: instead of parsing stdout as a single
  JSON object, it scans the NDJSON stream for the terminal result line (the line
  whose `type` is `"result"`) and extracts `result` / `usage` from it. The
  terminal result line carries the same fields as the `json` envelope — summary
  and usage output are byte-for-byte identical to the pre-change path; only the
  parsing strategy changes (single-object parse → scan-last-result-line).
- When the flag is set, the worker uses `--output-format json` unchanged — no
  trajectory file is written and `parseResultEnvelope` uses its current
  single-object parse path. Behavior is identical to pre-change.

Each trajectory event payload is sanitized and subject to a configurable output
size cap.

## Data flow

1. A delegation spawns `claude -p … --output-format stream-json`.
2. The CLI emits newline-delimited events as the run proceeds.
3. For each line, the stream classifier produces a `thought` / `tool_use` /
   `tool_result` / `run_end` event (or skips unrecognized lines).
4. The trajectory writer sanitizes, bounds, and appends each event to
   `<run-id>-trajectory.jsonl` in `AGENT_MESH_LOG_DIR` — streaming, so partial
   runs leave a partial trajectory.
5. On the terminal event, the **adapted** `parseResultEnvelope` scans the NDJSON
   stream for the line with `type: "result"` and extracts the result/usage
   envelope from it (replacing the single-object parse). The existing
   `<run-id>.jsonl` aggregate log and cost capture are written unchanged — same
   data, different parse path.
6. **Later/offline:** `triage_logs` reads trajectories and emits
   `kind: "trajectory"` findings; the eval harness (if opted in) reads them for
   path-efficiency and stuck-loop scoring.
7. **Future (out of scope):** the trajectory JSONL serves as the substrate for
   mid-run replay/resume and training-data export.

## Testing

Pure-classifier, writer, and integration tests (hermetic, using recorded
stream-json fixtures — no live model):

- **Event classification:** a fixture stream of model thoughts, tool calls, and
  tool results is classified into the correct `thought` / `tool_use` /
  `tool_result` / `run_end` sequence with monotonic `seq`.
- **Terminal-envelope parity:** with `stream-json`, the adapted
  `parseResultEnvelope` extracts the same result/usage envelope it would have
  from `--output-format json` (no regression in aggregate log or cost capture).
- **Aggregate-log unchanged:** the `<run-id>.jsonl` content is identical (modulo
  expected fields) whether streaming is on or off.
- **Partial trajectory on failure:** a stream truncated mid-run (timeout/crash)
  still yields a valid partial `<run-id>-trajectory.jsonl` ending without a
  `run_end` — diagnosable.
- **Sanitization & truncation:** a secret-bearing tool result is redacted; an
  oversized payload is truncated with `truncated: true`.
- **Malformed-line resilience:** an unparseable stream line is skipped; the
  writer does not crash and continues.
- **Disable flag:** `AGENT_MESH_TRAJECTORY_DISABLED` reverts to single-shot
  JSON; no trajectory file written; behavior matches pre-change.
- **`triage_logs` trajectory findings:** a fixture with a tool-retry loop yields
  a `kind: "trajectory"` stuck-loop finding; a shallow single-turn run yields the
  shallow-run finding; a healthy trajectory yields none.
- **Eval opt-in:** with trajectory reading enabled, path-efficiency
  (turns-to-solution) is computed; with it disabled, eval behaves exactly as
  before.
- **Ordering/sequence integrity:** events are persisted in stream order with
  consistent `seq`/`ts`.

## Out of scope

- **Mid-run replay / pause / resume / fork** — the trajectory JSONL is the
  *foundation* for these; implementing replay is explicitly future scope.
- **Training-data export pipeline** — trajectories *enable* demonstration export,
  but building the export/fine-tuning pipeline is separate.
- **Wire-protocol or model-facing changes** — none; this is server-side stdout
  instrumentation only. A2A Task shapes and the peer bridge are untouched.
- **Changing aggregate cost/usage capture** — `2026-06-13-delegate-cost-capture`
  semantics are preserved unchanged; this is additive per-turn data.
- **Real-time streaming of trajectory to callers** — this writes a file for
  offline consumption; live SSE of trajectory events to a caller is a different
  concern (cf. the A2A SSE idea).
- **Cross-hop trajectory stitching** — each delegated run gets its own trajectory
  file; assembling a unified multi-hop trajectory tree across A→B→C is a later
  enhancement.
- **A UI/viewer for trajectories** — the deliverable is the structured data +
  triage/eval signals; a visualization surface is out of scope.
- **Retroactive trajectories for past runs** — capture begins going forward;
  historical runs have no trajectory.
- **Path-guard / anti-spoof / write-boundary changes** — none; writes go to
  `AGENT_MESH_LOG_DIR` like existing logs.
