# Dynamic Board — Live Agent Activity & Conversation — Design

## 1. Goal

Make the dashboard board **dynamic**: when an agent is actively running a task,
its card shows live work status and its current action, and the **graph shows the
conversation directly** — active delegation edges light up and carry the relayed
prompt → answer as it resolves. This is the deferred "v2 live lighting"
(dashboard spec §10), now scoped. **Observe-only** (user decision): no run
controls, preserving the read-only-dashboard promise.

## 2. Model & key decisions

- **Activity is log-derived via `fs.watch`** (user decision). **Prerequisite
  runtime change (R1/BLOCKER):** today `createRunLog()` only computes a path and
  the log file is written **once, at the end** (`src/log.js`, `delegate.js:62-85`)
  — so there is no in-flight record to observe. This spec adds a **start log**:
  `delegate.js` (and the fast-path executor) write an initial
  `{ id, started_at, mode, task, state:"started", … }` **before** spawning, then
  **finalize** it atomically at completion (add `finished_at`, `status`,
  `summary`). With that:
  - start log present, no `finished_at` → agent **working** (with its current task);
  - finalized → **done** (with summary + status).
  No cross-process event plumbing needed; it works across the whole spawn tree
  (orchestrator, workers, fast-path — see §6). The start-log write is the only
  runtime change this spec requires.
- **Animated edges + transcript bubbles** (user decision): the graph correlates a
  parent's in-flight task with a child log appearing under a peer root and
  **lights that edge**, showing the relayed task and (on completion) the answer.
- **Observe-only**: status + activity feed + graph conversation; no cancel/re-run.

## 3. Components

| Module | Responsibility | Purity |
|---|---|---|
| `src/log.js` + `src/delegate.js` (extend) | **prerequisite:** write a **start log** before spawn/fast-path and finalize it at completion, stamped with `id`/`contextId`/`parentRunId`/`route` (enables in-flight + deterministic edges) | shell |
| `src/dashboard/activity.js` | **new pure** transform: a set of parsed run-log records → per-agent activity state + ordered events + derived edges (by `parentRunId`) + the redaction allow-list | **pure** |
| `src/dashboard/watcher.js` (extend) | also watch `<agent>/.agent-mesh/logs/*.json`; on create/change, read+parse the (small) log and push an `activity` event | shell |
| `src/dashboard/server.js` (extend) | `GET /api/activity` snapshot (behind the existing auth/same-origin gate) + SSE `activity` events alongside the existing `change` events | shell |
| `src/dashboard/public/app.js` (extend) | render live: card pulse + current-task line; graph edge animation + transcript bubbles; a small activity feed | asset |

## 4. Data flow

```
delegate.js createRunLog (start)  ─┐
fast-path / orchestrator run logs ─┤→ <agent>/.agent-mesh/logs/*.json
delegate.js writeRunLog (end)     ─┘
        │ fs.watch (create/modify)
        ▼
watcher → parse log (id/parentRunId/contextId/started_at/finished_at/mode/task/summary/status)
        → activity.js: agent states + events + edges (deterministic parentRunId → child.id)
        │ SSE: event: activity  data: { agents:[...], edges:[...], events:[...] }  (redacted, §7)
        ▼
browser: card pulse + task line · graph active-edge animation + transcript bubbles · feed
```

## 5. Activity model (`activity.js`, pure)

Input: parsed log records `{ id, agent, started_at, finished_at?, mode, task,
status?, summary?, route?, contextId, parentRunId? }`.

**Correlation is by id, not by text+time (R1/MAJOR-7) — with a concrete
propagation channel (R2/BLOCKER).** Matching a parent task string to a child log
within a time window is nondeterministic under concurrent/duplicate prompts. The
runtime instead threads an explicit run id through **every** delegation path:

1. **Stamp.** `delegateTask` (and the fast-path executor) generate a stable
   `runId` at start and write it as `id` in the start log.
2. **Propagate.** When an agent delegates onward — via the worker **peer bridge**,
   the **orchestrator** send, or a **fast-path** send — the outgoing A2A message
   carries `metadata["agentmesh/parent_run_id"] = <caller runId>` (plus the shared
   A2A `contextId`). This is framework-set metadata, not model-emitted.
3. **Receive.** The peer's `serve-a2a` reads `agentmesh/parent_run_id` from the
   incoming message and passes it into its `delegateTask`, which records it as
   `parentRunId` in the child's start log.

Edges are then derived **only** from `parentRunId → child.id` — never text/time.
(`stdio-server` → `delegateTask` gains a `parentRunId` parameter sourced from the
message metadata; the peer-bridge/orchestrator set it on outgoing sends.)

Output:
- `agents[]`: `{ name, state: "idle"|"working"|"done", currentTask?, lastSummary?, since }`
  (latest record per agent within a recency window; `working` if no `finished_at`).
- `edges[]`: `{ from, to, task, answer?, active }` — from `parentRunId` links, not
  text/time guessing.
- `events[]`: a bounded, time-ordered feed for the activity panel.

Pure and unit-testable from fixture log records — no I/O.

## 6. Interaction with orchestration/fast-path

The orchestration spec requires its **routing decision** and **fast-path tool
call** to also write run logs (orchestration §6). So the board narrates *both*
paths uniformly: a fast-path hop shows as a short `working → done` with
`route:"tool"`; a full-agent hop shows the longer worker run. No board-side
special-casing — it reads whatever logs appear.

## 7. Security

- Same **auth cookie + same-origin/host-port gate** as every other dashboard
  route; `/api/activity` and the SSE stream are not exempt.
- **Redaction policy, made precise (R1/MAJOR-8; extended R2/MAJOR-4).** "Never a
  file path" can't be literally guaranteed for free text, so the policy is
  structural + a scrub, applied uniformly to **every** emitted object:
  - **Structural allow-list** — the payload emits only
    `agents:[{name,state,route,currentTask,lastSummary,since}]`,
    `edges:[{from,to,task,answer,active}]`, `events:[{kind,agent,text,at}]`. The
    log's filesystem fields — `log_path`, `stdout`, `stderr`, `files_changed` — are
    **never** emitted on any of them.
  - **Free-text scrub + cap** — a single `redactText()` pass (size-cap +
    `isSensitivePath`-pattern masking of `.env`/`*.pem`/key-file substrings) is
    applied to **every** free-text field: `agents.currentTask`/`lastSummary`,
    `edges.task`/`answer`, and `events.text`. No transcript/feed field bypasses it.
  Tests assert (a) none of `log_path`/`stdout`/`stderr`/`files_changed` appears
  anywhere in the payload, and (b) a planted secret filename is masked in **each**
  of agent, edge, and event text (nested leakage tests).
- Observe-only: no new write/control endpoint.
- The existing coarse `change`-event filename redaction is unchanged; this is a
  separate, additive `activity` channel with its own structural allow-list above.

## 8. Error handling

- Malformed/partial log (mid-write) → skipped this tick; the next change re-reads
  it (logs finalize quickly).
- SSE drop → the existing poll fallback re-fetches `/api/activity`.
- A `working` record with no matching completion after a timeout window → shown as
  `working (stale)` rather than stuck-forever; reconciled when the log finalizes.

## 9. Testing

- **activity.js (pure):** fixture logs → correct states (working vs done);
  **edges from `parentRunId` links** (deterministic); two concurrent tasks with
  **identical task text** still resolve to the correct edges via id (R1/MAJOR-7);
  recency window honored.
- **watcher/SSE (tmp mesh):** writing a **start log** (no `finished_at`) emits an
  `activity` event with `state:"working"`; finalizing emits `done` with summary.
- **redaction (R1/MAJOR-8 + R2/MAJOR-4):** the `activity` payload contains **no**
  `log_path`/`stdout`/`stderr`/`files_changed` on agents, edges, OR events; a
  secret filename planted in text is **masked in each of** `agents.currentTask`/
  `lastSummary`, `edges.task`/`answer`, and `events.text` (nested leakage); a secret
  file change still emits no path.
- **correlation propagation (R2/BLOCKER):** a parent delegate stamps `runId`;
  the child's start log records `parentRunId` from `agentmesh/parent_run_id`
  metadata across the bridge, orchestrator, and fast-path sends; edges derive only
  from `parentRunId → child.id` (assert no edge without an id link).
- **size-cap:** an oversized task/summary is truncated in the event.
- **start-log runtime change:** a delegate writes a start log before spawn and
  finalizes it; a crashed/killed worker leaves a start log that the board shows as
  `working (stale)` until reconciled.
- **frontend (light):** an `activity` event pulses the card and lights the edge;
  cleared on `done`.

## 10. Build increments

1. **Start-log + correlation + activity model + API** — the
   `src/log.js`/`delegate.js` start-log change (stamp `id`/`route`); thread
   `agentmesh/parent_run_id` through `stdio-server`→`delegateTask` and the
   bridge/orchestrator/fast-path sends → child `parentRunId`; `activity.js` (pure,
   with `redactText`) + `/api/activity` + watcher reads `.agent-mesh/logs` + SSE
   `activity` events; tests.
2. **Live frontend** — card pulse + current-task line; graph active-edge animation
   + transcript bubbles; activity feed; SSE wiring + poll fallback.

## 11. Non-goals (v1)

- No run controls (cancel/re-run) — observe-only.
- No mid-token streaming of a worker's output (Task is still request→final); the
  "conversation" shown is task → final answer per hop, not token-by-token.
- No persistence/history view beyond a bounded recent window.

## Review log

- **R0 (draft):** initial design.
- **R1 (codex; 1 BLOCKER / 2 MAJOR on this spec — all accepted):**
  - BLOCKER (no in-flight log exists — `createRunLog` only returns a path) →
    added the **start-log** runtime prerequisite (§2/§3/§5/§10): write a start log
    before spawn, finalize at completion.
  - MAJOR-7 (text+time edge correlation is nondeterministic) → deterministic
    **`parentRunId`/`contextId`** correlation stamped on logs (§5/§9).
  - MAJOR-8 ("never a file path" vs emitting text) → precise **structural
    redaction allow-list** (omit `log_path`/`stdout`/`stderr`/`files_changed`;
    size-cap + path-scrub task/summary) with leakage tests (§7/§9).
- **R2 (codex; 1 BLOCKER / 1 MAJOR on this spec — accepted):**
  - BLOCKER (correlation channel underspecified; §4 still said text+window) →
    fixed the §4 diagram and specified the concrete **`agentmesh/parent_run_id`**
    propagation through `stdio-server`→`delegateTask` and every delegation send;
    edges only from `parentRunId → child.id` (§5/§9/§10).
  - MAJOR-4 (redaction missed `edges`/`events` text) → `redactText` applied to
    **every** emitted free-text field (agents/edges/events) with nested leakage
    tests (§7/§9).
- **R3 (codex):** `VERDICT: APPROVED` — no actionable findings. **Consensus reached** (8 → 4 → 0 across three rounds).
