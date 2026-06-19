# Mesh self-operations: scheduling + GitHub-activity poller + self-healing heartbeat — design

**Date:** 2026-06-18
**Status:** design — Phase 1 detailed; Phases 2–3 sketched
**Topic:** an always-on mesh self-operations layer — standard agent-level scheduling, a dedicated agent role that polls GitHub Actions into dashboard activity, and a mesh-level self-healing heartbeat.

## Problem & goal

The dashboard's live activity graph is empty even though the society is productive, because the society's work runs in GitHub Actions (cloud) and in ephemeral worktrees — neither writes run-logs to the watched `dev-mesh` agents (root cause confirmed 2026-06-18). More broadly, the 24/7 mesh has **no always-on, observable, self-healing operations layer**: scheduling exists only inside the dashboard (gated behind `--allow-shell`, dies when the dashboard closes), and nothing watches that the scheduled work stays healthy.

**Goal:** a mesh self-operations layer that runs 24/7 in the daemon and is *visible* in the dashboard:
1. **Standard agent-level scheduling** running always-on (not dashboard-bound).
2. A **dedicated "ops" agent role** whose scheduled task polls GitHub Actions and feeds the dashboard's mesh activity.
3. A **mesh-level self-healing heartbeat** that scans all scheduled tasks, reports failures, and remediates.

### Levels (invariant)
- **Schedules are AGENT-level.** Each agent owns its jobs in `<agent>/.agent/schedule.json`; the engine ticks them per agent. There is no mesh-level job list — only the union of agent schedules.
- **The heartbeat is MESH-level.** Exactly one heartbeat (in the daemon) scans *all* agents' schedule state and acts mesh-wide. It is not instantiated per agent.

### Engine location (decided)
The scheduler + heartbeat **engine runs in the always-on dev-society daemon**. The dashboard is a **read-only window** — it reads state + activity that the daemon writes; it never executes scheduled work.

## Build order (decided)
Phased — each its own spec/plan, working software at each step:
- **Phase 1 (this spec, detailed):** always-on standard scheduling infra + mesh-wide dashboard visibility.
- **Phase 2 (sketched):** a dedicated ops-agent role + its scheduled GitHub-Actions poll job that emits mesh activity.
- **Phase 3 (sketched):** the mesh-level self-healing heartbeat.

---

# Phase 1 — Always-on mesh scheduling infra + visibility

## Architecture

Reuse the existing, tested scheduler engine (`src/dashboard/scheduler.js` + `schedule-cadence.js`) — cadences (`daily {at}` / `weekly {day,at}` / `every {minutes≥5}`), per-agent `.agent/schedule.json` defs, `.agent-mesh/schedule-state.json` runtime state, a 30s tick that runs due jobs via `delegateTask` (ask-mode). Phase 1 changes **where it lives and runs**, not its behavior.

```
 dev-society daemon (24/7, scripts/dev-society-daemon.mjs)      dashboard (read-only window)
 ┌─────────────────────────────────────────┐                  ┌─────────────────────────┐
 │ issue-poll loop (existing)               │                  │ GET /api/schedules      │──┐ aggregates
 │ scheduler.start()  ◀── NEW               │                  │ Schedules panel (mesh)  │  │ all agents'
 │   tick 30s → per-agent due jobs          │─ writes ─▶ <agent>/.agent-mesh/schedule-state.json
 │   delegateTask(<dev-mesh/agent>, ask)    │─ writes ─▶ <agent>/.agent-mesh/logs/*.jsonl ◀─┘ (read)
 └─────────────────────────────────────────┘                  └─────────────────────────┘
```

**Activity side-effect (intended):** the daemon runs jobs with `root = dev-mesh/<agent>`, so each run writes a run-log to `dev-mesh/<agent>/.agent-mesh/logs/` — exactly what `loadActivitySnapshot` reads. So Phase 1 also makes the **constellation animate** when scheduled jobs run, fixing the empty-graph symptom for scheduled work.

## Components (each one clear responsibility)

### 1. Relocate the engine to standard mesh infra
Move `scheduler.js` and `schedule-cadence.js` from `src/dashboard/` → **`src/schedule/`** (a neutral, mesh-level module). Mechanical: update imports in `src/dashboard/server.js` and the existing tests; behavior unchanged. Rationale: scheduling is a mesh capability, not a dashboard feature; both the daemon and dashboard import it from a shared location. The engine already depends only on mesh core (`delegateTask`, manifest read) — no dashboard coupling to carry along.

**Interface (unchanged):** `createScheduler({ meshRoot, runJob?, intervalMs? }) → { start, stop, tick, runNow, setEnabled, list }`.

### 2. Daemon integration (the always-on owner)
`scripts/dev-society-daemon.mjs` starts the scheduler on launch and stops it on exit:
```js
import { createScheduler } from '../src/schedule/scheduler.js';
const meshRoot = process.env.DEV_SOCIETY_MESH_ROOT || join(repoRoot, 'dev-mesh');
const sched = createScheduler({ meshRoot });
sched.start();                 // ticks alongside the issue-poll loop
// on shutdown: sched.stop();
```
- New config: `DEV_SOCIETY_MESH_ROOT` (default `<repo>/dev-mesh`).
- The daemon already has `claude` + `gh` auth, so ask-mode jobs run.
- The scheduler tick is independent of the issue-poll loop (separate `setInterval`); a slow job never blocks issue polling and vice-versa.

### 3. Mesh-wide visibility (dashboard, read-only)
- **`GET /api/schedules`** (new, mesh-level): aggregates every served agent's `.agent/schedule.json` defs merged with `.agent-mesh/schedule-state.json` state into one list:
  `{ schedulerOwner: 'daemon'|'dashboard'|'none', jobs: [{ agent, id, name, cadence, cadenceLabel, enabled, lastRunAt, lastStatus, lastSummary, nextRunAt, running }] }`.
  Pure aggregation reusing the existing per-agent merge logic; reads files only. `schedulerOwner` is derived simply: `'dashboard'` when the dashboard started its own scheduler (`--allow-shell`, owned), otherwise `'daemon'` (the expected production case — the route does not probe the daemon; "daemon" means "not this dashboard"), and `'none'` when there are no agents/jobs. It is informational (shows the UI who runs the jobs); no new lock/marker file is introduced in Phase 1.
- **Schedules surface**: a section in the dashboard's Graph view (a foldable section like Tokens/Issues) listing the jobs grouped by agent — agent · name · cadence · last run (ok/fail pill) · next run · running. **Read-only** in Phase 1 (display, not control).

### 4. Single-owner safety
Exactly one process executes scheduled jobs. The daemon owns it. The dashboard must **not** also tick:
- The dashboard's scheduler stays **off** (the existing `--allow-shell` gate already keeps it off unless explicitly enabled; we add a clear rule + `/api/schedules` reports `schedulerOwner` so the UI can show who's running it).
- `schedule-state.json`'s existing **stale-running cleanup** + per-agent in-flight lock already guard against a crashed run; with a single owner there is no cross-process double-run. Defs (`.agent/schedule.json`) remain plain files the daemon reads each tick, so editing them (by hand or a future API) is picked up without a restart.

## Data flow & error handling
Daemon tick → per-agent due check → `delegateTask(agentRoot, ask, prompt)` → run-log written + `schedule-state.json` updated (`lastStatus: ok|fail`, `lastSummary`, `nextRunAt`, `running:false`). A non-`done` delegate outcome (timeout/error/refused) is recorded as `fail` **state**, never thrown — the Phase-3 heartbeat consumes these. The dashboard only ever reads; a missing/corrupt state or defs file degrades to "no jobs" for that agent (never an error).

## Testing (hermetic, `node --test`)
- **Repoint** existing `test/schedule-cadence.test.js` + `test/schedule-routes.test.js` imports to `src/schedule/` (no behavior change).
- **New** `test/daemon-scheduler.test.js`: the daemon wires `createScheduler` (injected stub) — `start()` on launch, `stop()` on shutdown, independent of the issue loop. Stubbed; no real `claude`/`gh`.
- **New** `test/schedules-route.test.js`: `GET /api/schedules` aggregates multiple agents' defs+state into the mesh list (planted fixture files), and reports `schedulerOwner`. Mirrors `schedule-routes.test.js` harness.

## Phase 1 invariants
- Schedules are agent-level; `/api/schedules` is a read-only mesh-wide *aggregation*, not a mesh job store.
- Engine runs in the daemon only; the dashboard never executes jobs (single owner).
- Reuse the existing cadence/state semantics verbatim — Phase 1 is a relocation + daemon host + a read view, not a rewrite.

---

# Phase 2 — Dedicated GitHub-Actions poller (sketch)

A dedicated **ops agent role** (a new `dev-mesh` agent, e.g. `monitor`) owns an agent-level scheduled job (`every {minutes:N}`) that polls GitHub Actions and feeds mesh activity:
- The job runs `gh run list --json databaseId,workflowName,status,conclusion,createdAt,event,headBranch` (read-only; no secrets).
- A **workflow→agent mapping** (convention: `dev-mesh-<role>` → that role's agent; non-mesh workflows → the `monitor` agent) turns runs into `buildActivity`-shaped records: `{ agent, id:'gh-<runId>', route:'github-actions:<workflow>', started_at, finished_at, status }`.
- Records are merged into the activity source so `/api/activity` + the SSE surface them under the mesh (a2a-lane / timeline / constellation).
- Open design questions for the Phase-2 spec: whether the poll is a cheap mechanical step owned-by-the-agent vs a full `claude` ask each tick; exact merge point (extend `loadActivitySnapshot` vs a synthetic SSE emit); dedupe of already-seen runs.

# Phase 3 — Mesh-level self-healing heartbeat (sketch)

One **mesh-level** heartbeat in the daemon (single instance, not per-agent) periodically scans **all** agents' `schedule-state.json`:
- **Detect:** jobs that are `fail`, stuck (`running:true` with a stale lock), or overdue (`nextRunAt` long past). Reuse / extend `src/mesh-health/core.js` `triageLogs` (it already reads schedule-state per agent).
- **Report:** a mesh health surface in the dashboard (and the existing health alert path).
- **Heal:** bounded remediation — clear stale `running`, re-arm overdue jobs, re-run a transient `fail` (capped retries), escalate persistent failures rather than loop. Remediation actions and their safety bounds are the Phase-3 spec's main content.
