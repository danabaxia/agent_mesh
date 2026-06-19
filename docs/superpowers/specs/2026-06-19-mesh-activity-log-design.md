# Mesh unified activity log — design

**Date:** 2026-06-19
**Status:** design — approved, ready for implementation plan
**Topic:** one durable, normalized, local event stream of all agent activity, surfaced by a foldable, filterable dashboard panel.

## Problem & goal

The mesh already logs a lot of activity, but it is **scattered** across heterogeneous files: per-agent run logs (`<agent>/.agent-mesh/logs/*.jsonl`), the dev-society ledger (`.dev-society/ledger.jsonl`), `gh-activity.json`, `heartbeat.json`, per-agent `schedule-state.json`, and the daemon's free-text stdout (`daemon.out.log`). There is **no single chronological, structured "everything that happened" log** you can scroll and filter.

**Goal:** a unified, append-only **activity event log** — `<repo>/.dev-society/activity-YYYY-MM-DD.jsonl` — that every local component appends a normalized event to, plus a Graph-view panel that displays it on demand, filtered (by agent / type / time) or in full.

### Decisions (from brainstorming)
- **New unified event log** (not a read-time aggregation of the existing logs): one canonical normalized stream.
- **Daily-rotated files** with a prune sweep (default keep 30 days).
- **Display:** a foldable "Activity Log" panel in the dashboard's Graph view, filterable, ⤢-maximizable.
- **Honest scope:** cloud GitHub-Actions work (autofix, **auto-merge**, review…) can't write the local file directly, so it enters the log via the **gh-activity poll** (~5-min latency). Local daemon events are real-time. The unified log is a HIGH-LEVEL event stream — granular per-run detail stays in the existing per-agent run logs, linked by `ref`.

## Architecture

A small **pure-core + thin-shell** module `src/activity-log/`, plus ~5 emit calls in the daemon and a read route + panel in the dashboard. The activity log is **write-only from emitters, read-only from the dashboard** — they share only the on-disk JSONL files.

```
 local daemon (24/7)                                    dashboard (read-only)
 ┌──────────────────────────────────────┐             ┌──────────────────────────┐
 │ issue loop   → recordActivity(...)    │             │ GET /api/activity-log    │
 │ scheduler    → recordActivity(...)    │── append ─▶ .dev-society/activity-<date>.jsonl
 │ heartbeat    → recordActivity(...)    │             │   ?agent=&type=&since=   │
 │ gh-activity  → recordActivity(...)    │             │   &limit=                │
 │ daily prune  → pruneActivity(30d)     │             │ Activity Log panel       │
 └──────────────────────────────────────┘             └──────────────────────────┘
```

## Event schema (normalized — one shape for everything)
```js
{ ts, source, agent?, type, level, summary, ref?, detail? }
```
- `ts` — ISO-8601 timestamp (string).
- `source` — emitter: `'daemon' | 'scheduler' | 'heartbeat' | 'gh-activity'`.
- `agent` — the dev-mesh agent the event is about (e.g. `'coder'`), when applicable; else omitted.
- `type` — dotted event type (taxonomy below).
- `level` — `'info' | 'warn' | 'error'`.
- `summary` — one-line human-readable headline (length-bounded).
- `ref` — optional short reference (`'#98'`, `'pr#124'`, run id, job id).
- `detail` — optional small object (e.g. `{ status, files, logPath }`); not rendered in the row, available on expand.

## Components (one responsibility each)

### 1. `src/activity-log/event.js` (new, PURE)
`formatEvent({ source, agent?, type, level?, summary, ref?, detail? }, { now }) → event` — validates/normalizes (defaults `level:'info'`, stamps `ts = now().toISOString()`, trims `summary` to `MAX_ACTIVITY_SUMMARY` chars, drops empty optionals). Pure; the single place the event shape is defined. A matching `filterEvents(events, { agent, type, since, level })` pure predicate-filter used by both the reader and tests.

### 2. `src/activity-log/log.js` (new, impure — injectable)
- `recordActivity(input, { dir, now }) → void` — `formatEvent` then **append** one line to `join(dir, 'activity-' + <date> + '.jsonl')` (mkdir-p). **Fail-safe: wrapped in try/catch that swallows + (best-effort) warns — logging must NEVER break a daemon loop.**
- `readActivity({ dir, agent?, type?, since?, limit = 200, maxFiles = 14, readFile?, listDir? }) → event[]` — list `activity-*.jsonl`, sort by date descending, and scan files newest-first — those whose date `>= since`'s date when `since` is set, else the most recent `maxFiles` — accumulating parsed lines (skip malformed) until `limit` filtered events are collected. Apply `filterEvents`, return newest-first, capped to `limit`. Tolerant: missing dir / unreadable file → `[]`. The bounded file scan keeps a long-running log cheap to query.
- `pruneActivity({ dir, keepDays = 30, now }) → { removed:string[] }` — delete `activity-*.jsonl` whose date is older than `keepDays`.

### 3. Daemon wiring (`scripts/dev-society-daemon.mjs`)
Add `recordActivity(...)` at the high-value points (each one line, fail-safe):
- **Issue loop** (`runOneTask`): `issue.picked` (when an eligible issue is taken), `delegate.start`/`delegate.done` for the Coder and Reviewer (agent + status), `pr.opened` (with the PR number from the `\/pull\/(\d+)` capture), `task.error` on failure.
- **Scheduler**: pass an `onJobResult({ agent, job, result })` hook into `createScheduler` (additive option) so every scheduled job run emits a `job.run` event (ok/fail + summary). One wiring point covers gh-activity-poll, daily-report-refresh, and any future job.
- **Heartbeat**: from the heartbeat tick result, emit `heartbeat.finding` (per finding, on the tick that first sees it), `heartbeat.heal`, `heartbeat.escalate` (open/close). Reuse the assess output already computed.
- **gh-activity poll**: when `pollGhActivity` writes new run records, also `recordActivity` an event per newly-seen run (`source:'gh-activity'`, `agent` from `workflowToAgent`, `type:'ci.run'`, `ref:'run#<id>'`) — dedupe against the last-seen run id so each run is logged once. This is how cloud work (incl. auto-merge) enters the stream.
- **Prune**: call `pruneActivity({ dir, keepDays })` on daemon startup and once a day (cheap; reuse the heartbeat or a dedicated interval).

`dir` default: `process.env.AGENT_MESH_ACTIVITY_DIR || join(repoRoot, '.dev-society')` (same dir as the other dev-society state). All emit points are inside the existing `!once && !selftest` guard / live loops, so `--selftest`/`--once` never write activity.

### 4. Dashboard `GET /api/activity-log` (`src/dashboard/server.js`)
Read-only route: `?agent=&type=&since=&limit=` → `readActivity({ dir: process.env.AGENT_MESH_ACTIVITY_DIR || resolve(meshRoot,'..','.dev-society'), ...filters })`. Returns `{ events:[…], agents:[…distinct…], types:[…distinct…] }` (the distinct lists populate the filter dropdowns). Tolerant: missing dir → `{ events:[], agents:[], types:[] }`, never 500. Same default-path agreement as gh-activity/heartbeat (daemon `repoRoot/.dev-society` == dashboard `resolve(meshRoot,'..','.dev-society')`).

### 5. Dashboard "Activity Log" panel (`src/dashboard/public/graph-view.js` + css)
A foldable section (mirrors the Health/Schedules panels, board2.css paper theme):
- **Filters:** agent dropdown · type dropdown · time-range (today / 24h / 7d / all) — populated from the route's `agents`/`types`.
- **List:** reverse-chronological rows — `time · source/agent · type · summary` (+ `ref` chip, level-colored). Paginated / capped (e.g. 200, "load more" or rely on filters); the existing ⤢ maximizes for the "show all" case.
- **Refresh:** on the same cadence as the other panels (re-fetch with the active filters). Tolerant of fetch failure ("activity log unavailable").

### 6. Config (`src/config.js`)
`DEFAULT_ACTIVITY_KEEP_DAYS = 30` · `MAX_ACTIVITY_SUMMARY = 240`. Env: `AGENT_MESH_ACTIVITY_DIR` (shared write/read dir override), `AGENT_MESH_ACTIVITY_KEEP_DAYS`.

## Data flow & error handling
emitter → `recordActivity` (fail-safe append) → daily JSONL → dashboard `readActivity` (tolerant parse/filter) → panel. A malformed line is skipped, never fatal. A write failure is swallowed (best-effort warn to daemon stdout) so the daemon's real work never breaks. The route degrades to empty on any read error.

## Invariants
- **Logging never breaks work:** `recordActivity` is fail-safe; an append error is swallowed.
- **Write-only emitters, read-only dashboard:** they share only the JSONL files; the dashboard never writes the log.
- **Selftest/once never emit:** all emit points are in the live daemon loops.
- **High-level stream, not a firehose:** one event per meaningful action (issue picked, delegate done, job ran, heartbeat finding, cloud run seen) — NOT per log line; granular detail stays in the per-agent run logs, linked by `ref`.
- **Bounded:** daily rotation + 30-day prune keeps disk in check.

## Testing (hermetic, `node --test`)
- `test/activity-event.test.js` — pure `formatEvent` (defaults, ts stamping, summary truncation, dropped optionals) + `filterEvents` (agent/type/since/level, combined).
- `test/activity-log.test.js` — `recordActivity` appends a parseable line to the dated file (injected `dir`/`now`); fail-safe on an un-writable dir (no throw); `readActivity` reads + filters + caps + newest-first across multiple dated files, skips malformed lines, tolerates missing dir; `pruneActivity` removes only files older than keepDays.
- `test/activity-log-route.test.js` — `GET /api/activity-log` returns planted events + distinct agents/types; filters via query params; missing dir → empty, 200 (mirrors the Phase-2/3 route tests).
- `test/activity-log-daemon.test.js` — daemon-wiring lint: `recordActivity` is called in the issue loop / scheduler hook / heartbeat / gh-activity poll, and `pruneActivity` is wired; `--selftest` emits nothing.

## Deferred
- A CLI `agent-mesh activity-log [--agent --type --since]` dump (the brainstorm's option C) — easy follow-up if headless review is wanted.
- Folding the granular per-agent run logs into the unified stream (kept separate by design; linked via `ref`).
- Live push (SSE) of new events to the panel — Phase 1 polls like the other panels.
