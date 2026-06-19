# Schedules panel: run-now button + per-task descriptions — design

**Date:** 2026-06-19
**Status:** design — approved, ready for implementation plan
**Topic:** two additions to the dashboard's mesh-wide Schedules panel — a per-job **Run** button that triggers an immediate run (via the daemon), and a **description** shown for each scheduled task.

## Problem & goal

The Schedules panel (`#sec-sched` → `/api/schedules`, the mesh-wide read-only view) lists each agent's scheduled jobs (name · cadence · last run · next run · status) but:
1. There is **no way to run a job on demand** — you wait for its cadence. The existing per-agent run route (`POST /api/agent/:name/schedule/:id/run`) calls `scheduler.runNow`, which only exists when the **dashboard owns the scheduler** (`--allow-shell`). In the normal **daemon-owned** setup, that route can't reach the scheduler — so there's no working run-now.
2. Each row shows only a terse `name`; there is **no description** of what the task does.

**Goal:** a **Run** button per job that works in the daemon-owned setup (runs within ≤30s), and a **description** surfaced per task.

### Decisions (from brainstorming)
- **Run-now = mark-due, daemon executes.** The button re-arms the job's `nextRunAt` to *now* in `schedule-state.json`; the daemon's scheduler (30s tick) runs it on its next tick. The daemon stays the **single executor**; the dashboard only writes a "due" marker (data, not execution) — exactly how the heartbeat already re-arms overdue jobs. "Run now" = within ≤30s.
- **Description = new optional `description` field + smart fallback.** Add `description` to the job def; when absent, fall back to a delegate job's `prompt` first line, else empty. Seed the existing dev-mesh builtin jobs with a description.
- **Enabled jobs only.** The re-arm runs via the daemon's due-rule (`enabled && !running && nextRunAt ≤ now`), so for a **disabled** job the Run button is greyed ("enable first") — no force-run-disabled in v1.

## Architecture

```
 dashboard (read-only window)                          daemon (single executor, 30s tick)
 ┌───────────────────────────────────────┐
 │ Schedules panel: ▶ Run per job         │
 │   POST /api/schedules/run {agent,id}   │── markJobDue → writes ──▶ <agent>/.agent-mesh/schedule-state.json
 │   (re-arm nextRunAt = now)             │                                   │ (nextRunAt ≤ now)
 │ description shown under each name       │                          daemon tick runs it ≤30s
 │   from list-all `description`           │── reads ◀── schedule.json defs (description field)
 └───────────────────────────────────────┘
```

Pure core (`markJobDue`, `describeJob`) + thin shell (the route's fs read/write). No new executor — the daemon's existing tick does the running.

## Components

### 1. `src/schedule/run-now.js` (new, PURE)
- `markJobDue(state, id, now = new Date()) → newState` — returns a shallow-cloned state object with `state[id] = { ...state[id], nextRunAt: now.toISOString(), running: false }`. If `id` not present, creates `{ nextRunAt: now.toISOString(), running: false }`. Pure, no I/O.
- `describeJob(job) → string` — the description with fallback: `job.description` (trimmed) → else `firstLine(job.prompt)` (a delegate job's prompt, first non-empty line, length-bounded) → else `''`. Pure.

### 2. `src/schedule/list-all.js` (modify)
Add `description: describeJob(job)` to each pushed job object (so the mesh-wide `/api/schedules` carries it). No other field changes.

### 3. `src/dashboard/server.js` — `POST /api/schedules/run` (new)
- Body `{ agent, id }` (JSON). Authenticated like the other `/api/*` routes (cookie + same-origin).
- Resolve the agent from the manifest (`agent` must be a real served agent — reject unknown). Read `<meshRoot>/<agentRoot>/.agent-mesh/schedule-state.json` (tolerant — `{}` if missing). Verify `id` is a real job in that agent's `.agent/schedule.json` and is **enabled** (else `409 {error:'disabled'}` / `404 {error:'unknown job'}`).
- Apply `markJobDue(state, id, now)`, atomic-write the state file (mkdir-p), return `202 {queued:true, runsWithinMs: 30000}`.
- If a dashboard-owned `scheduler` is present (`--allow-shell`), ALSO call `scheduler.runNow(agent, id)` for immediacy (best-effort) — but the re-arm is the universal mechanism.
- **Path safety:** writes only `schedule-state.json` under the resolved agent root inside the mesh — never an arbitrary path; the `agent`/`id` are validated against the manifest + defs, not used to build arbitrary paths.

### 4. `src/dashboard/public/graph-view.js` + `graph-view.css` (modify)
In `loadSchedules`'s row rendering (`#gv-sched`):
- **Run button** (`▶`) per row → `POST /api/schedules/run {agent, id}` → on 202, show a transient "queued…" on the row; the row's last-run/status updates on the next `/api/schedules` poll (the panel already refreshes). **Disabled** (greyed, tooltip "enable to run") when the job is `!enabled` or already `running`.
- **Description** rendered under the job name (muted, single line, `title` = full text). Omitted cleanly when empty.
Matches board2.css paper theme; reuse `esc()` for all strings.

### 5. `dev-mesh/orchestrator/.agent/schedule.json` (modify)
Seed `description` on the two jobs:
- `gh-activity-poll` → `"Poll GitHub Actions runs into live mesh activity"`.
- `daily-report-refresh` → `"Refresh the daily PR / issue / token report cache"`.

## Data flow & error handling
Click → POST → validate (auth, known enabled job) → `markJobDue` → atomic state write → 202. The daemon's next tick (≤30s) finds the job due and runs it; its result lands in `schedule-state.json` + the activity log, surfaced on the next panel poll. Errors are data: unknown agent/job → 404; disabled → 409; a write failure → 500 with a message (the only non-tolerant path, since the user expects feedback). The button never blocks the panel; a failed POST shows a transient error on the row.

## Invariants
- **Daemon remains the single executor.** The dashboard writes only a "due" marker; it never runs a job itself (unless it already owns the scheduler via `--allow-shell`, the existing carve-out).
- **Controlled write only.** The route writes a single framework-owned `schedule-state.json` under a manifest-validated agent root — no arbitrary paths, authenticated.
- **Re-arm is safe + idempotent.** Setting `nextRunAt = now` just makes the job due; the daemon's one-job-at-a-time lock prevents a double-run; clicking twice is harmless.
- **Run-now honors `enabled`.** A disabled job is not run (button greyed) — consistent with the daemon's due-rule.

## Testing (hermetic, `node --test`)
- `test/schedule-run-now.test.js` — pure `markJobDue` (sets nextRunAt=now + running:false, clones, creates-if-absent) + `describeJob` (description → prompt-first-line → '' fallback, length cap).
- `test/schedule-list-all.test.js` (extend) — the mesh-wide list now includes `description` per job (seeded + fallback).
- `test/schedules-run-route.test.js` — `POST /api/schedules/run`: a known enabled job → 202 + `nextRunAt` re-armed to ~now in the state file; unknown agent/job → 404; disabled job → 409; auth required. Mirrors `schedules-route.test.js`.
- Panel (Run button + description) verified visually (browser screenshot) in the verification task.

## Deferred
- **Force-run a disabled job** (one-off run bypassing `enabled`) — v1 requires enabling first.
- **Truly instant run** (daemon file-watcher instead of the 30s tick) — the brainstorm's alternative; ≤30s is accepted for v1.
- A per-job **last-N-runs history** view — out of scope.
