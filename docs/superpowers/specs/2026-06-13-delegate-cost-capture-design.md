# Delegate Token/Cost Capture — Design

## 1. Goal

Every `delegate_task` spawns `claude -p`, which knows exactly how many tokens it
spent and what it cost — but the mesh throws that away. `delegate.js` writes a
run record with `summary`/`argv`/`stdout`/`stderr` and **no usage field**, and
`buildClaudeInvocationSync` invokes the worker in the CLI's **default text
output** (`['-p', task, '--tools', …]`, no `--output-format`), so the cost
envelope is never even produced.

This spec captures per-hop **tokens, dollars, turns, and API duration** into the
run record and the A2A `Task` metrics block. It is pure observability — the
substrate the performance benchmark (`2026-06-13-mesh-perf-benchmark-design.md`
§9) needs for `cost_usd` / `tokens_total`, and a free win for the dashboard's
activity/cost views.

## 2. Non-goals

- **No budget enforcement.** Capture only; latency-SLO / token-budget *gates*
  are a separate backlog item (perf-bench §12).
- **No model-facing surface change.** The anti-spoof invariant holds — `{ mode,
  task }` is unchanged; cost is read from the CLI's own output, never from tool
  args.
- **No streaming.** The headless worker is a one-shot `-p`; we parse its final
  result envelope, not an NDJSON stream (that path is the dashboard
  session-runner's, `--output-format stream-json --verbose`, and stays separate).
- **No pricing math in-repo.** `total_cost_usd` comes straight from the CLI; the
  mesh never maintains a price table.

## 3. Background — current pipeline

- `src/delegate-invocation.js` `buildClaudeInvocationSync(mode, task, …)` →
  `['-p', task, '--tools', tools.join(',')]`. **No `--output-format`** → text.
- `src/delegate.js` `buildDelegateResult` → `summarizeSpawn(spawnResult)` →
  `tail(spawnResult.stdout)` (raw text).
- The run record (`appendRunLog`, delegate.js:222) has `summary`, `argv`,
  `stdout`/`stderr` tails, `result` — no `usage`.
- The A2A metrics block (`src/a2a/stdio-server.js` `runWithMetrics`) has latency
  fields but no token/cost fields.

## 4. Design

### 4.1 Switch the worker to JSON output

In `buildClaudeInvocationSync`, append `--output-format json`. The CLI then
emits a **single JSON object** on stdout:

```json
{ "type": "result", "subtype": "success", "result": "<final text>",
  "session_id": "…", "num_turns": 3, "duration_ms": 8123, "duration_api_ms": 7044,
  "total_cost_usd": 0.0214,
  "usage": { "input_tokens": …, "output_tokens": …,
             "cache_read_input_tokens": …, "cache_creation_input_tokens": … } }
```

`--output-format json` is compatible with `--resume`/`--session-id`, `--tools`,
`--mcp-config`, `--settings`, and `--permission-mode` (all already passed), so no
other argv changes.

### 4.2 Parse the envelope (with text fallback)

`buildDelegateResult` / `summarizeSpawn` learn a JSON path:

- **Success path**: parse stdout as JSON. `summary` ← `.result` (then `tail`-bounded
  as today); a new `usage` block ← `{ input_tokens, output_tokens,
  cache_read_input_tokens, cache_creation_input_tokens, total_cost_usd, num_turns,
  duration_api_ms }`.
- **Fallback (degrade, never throw)**: if stdout is **not** parseable JSON — a
  timeout truncates it, a non-zero exit prints a bare error, an older CLI ignores
  the flag — fall back to the current text `tail()` for `summary` and set `usage:
  null`. This preserves every existing `status` branch
  (`timeout`/`error`/`done`) untouched; only the parse *source* changes.

A small pure helper `parseResultEnvelope(stdout)` → `{ summary, usage } | null`
keeps this unit-testable without a spawn.

### 4.3 Thread `usage` into the artifacts

- **Run record**: add `usage` to the FINAL `appendRunLog` payload (delegate.js
  ~:222). Absent/`null` when unparseable — same discipline as `files_changed:
  null` for non-git folders.
- **A2A metrics block**: `runWithMetrics` (stdio-server.js) already returns a
  `metrics` object on the Task; add `tokens_in`/`tokens_out`/`tokens_cache`/
  `cost_usd`/`num_turns`/`api_ms`, sourced from the result's `usage`. Null fields
  when unavailable.
- **Result object** (`buildDelegateResult` return): expose `usage` so callers
  (peer-bridge, A2A server) can surface it without re-reading the log.

### 4.4 Dashboard (free, optional)

`src/dashboard/activity-stats.js` already aggregates run durations; with `usage`
present it can sum tokens/$ per agent and per range. Out of scope to *render*
here, but the data lands; the dashboard item can consume it later.

## 5. Observable artifacts touched

| Artifact | Change |
|---|---|
| worker argv | `+ --output-format json` |
| run record (`runs-*.jsonl`) | `+ usage: { input_tokens, output_tokens, cache_*_tokens, total_cost_usd, num_turns, duration_api_ms } | null` |
| A2A `Task.metadata.metrics` | `+ tokens_in/out/cache, cost_usd, num_turns, api_ms` (nullable) |
| `summary` | now sourced from `.result` on the JSON path; identical text otherwise |

## 6. Testing (hermetic, `npm test`)

The existing `createFakeClaude` stub must now emit a JSON envelope on stdout
(extend the fake to print `{ "type":"result", "result": …, "usage": {…},
"total_cost_usd": … }` instead of bare text). Then:

- `parseResultEnvelope` unit tests: valid envelope → `{ summary, usage }`;
  garbage/empty/partial → `null` (fallback exercised).
- `delegate.test.js`: a `done` run record carries the expected `usage`; a
  **timeout** run (truncated/no JSON) carries `usage: null` and the existing
  text-tail summary — proving the fallback and that no status branch regressed.
- `summary` parity: the JSON path's summary equals the model's `.result` text.
- A2A: the returned `Task` metrics block carries the cost fields.

This is the place the perf-bench harness test (§10 there) reads `usage` from, so
it must be solid first.

## 7. Risks & mitigations

- **CLI output-format drift** — field names could change across `claude`
  versions. Mitigation: tolerant parse (read by key, missing → null), never
  assert shape; fallback covers total absence.
- **JSON vs. human-readable summary** — `.result` is the model's final message,
  same content users see; no UX regression. Verified by the summary-parity test.
- **Non-`success` subtypes** (e.g. `error_max_turns`) — treat `.result` if
  present, else fallback; `usage` still captured if present.

## 8. Open decisions

1. `--output-format json` (one object) vs. `stream-json` (NDJSON, like the
   dashboard runner). Proposed **`json`** — the worker is one-shot; we want the
   terminal envelope, not incremental events. Less parsing, no `--verbose`.
2. Whether to also persist `session_id` from the envelope into the run record
   (useful for cross-correlating with transcripts). Proposed: yes, cheap and
   already half-tracked via `--session-id`/`--resume`.
3. Cache-token accounting in the perf benchmark's `tokens_total` — include
   `cache_read`/`cache_creation` or report separately? Defer to perf-bench;
   capture all four fields regardless so the consumer chooses.
