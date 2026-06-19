# Mesh self-operations Phase 3 — mesh-level self-healing heartbeat — design

**Date:** 2026-06-18
**Status:** design — approved, ready for implementation plan
**Topic:** an always-on, mesh-level heartbeat in the dev-society daemon that scans every agent's scheduled-job health, surfaces it on the dashboard, applies minimal-safe self-heal, and escalates persistent problems to a de-duped GitHub issue.

Builds on Phase 1 (always-on scheduling infra) and Phase 2 (GitHub-activity poller / orchestrator agent). Parent vision: `docs/superpowers/specs/2026-06-18-mesh-scheduling-ops-design.md` (§ Phase 3 sketch).

## Problem & goal

The 24/7 mesh now schedules and runs work always-on (Phase 1) and reflects cloud activity on the dashboard (Phase 2). But **nothing watches that the scheduled work stays healthy.** A scheduled job can fail every run, stop arming (a corrupt/missing `nextRunAt`), or wedge with a stale `running` lock — and today that degrades silently. There is no mesh-wide health view and no escalation path.

**Goal:** one mesh-level heartbeat, running 24/7 in the daemon, that:
1. **Detects** unhealthy scheduled jobs across all agents (failing / overdue / stuck).
2. **Reports** a mesh-wide health snapshot the dashboard surfaces.
3. **Self-heals** the narrow, safe set of conditions (clear a stale lock; re-arm an overdue job).
4. **Escalates** persistent/unrecoverable problems to a **de-duped GitHub issue**, feeding the society's existing issue-poll → triage → autofix loop so the mesh fixes its own broken scheduled jobs through the normal PR flow.

### Scope decisions (from brainstorming)
- **Detect + report + escalate**, with *minimal safe* auto-heal only. The daemon-bound heartbeat **cannot revive a dead daemon** (that is launchd/systemd `KeepAlive`'s job), and the Phase-1 scheduler **already** re-runs jobs on cadence and clears its own in-process stale locks. So the heartbeat's genuine added value is **observability + escalation**, not aggressive remediation. Explicitly **out of scope for v1:** auto-retry-out-of-cadence, auto-disable of chronically-failing jobs, force-restart of running jobs. Escalate those instead.
- **Escalation channel = GitHub issue** (de-duped), not a passive dashboard-only alert and not a mesh board task (dev-mesh agents run in CI, not interactive sessions, so board pickup is unreliable; the issue-poll loop is always running and already turns issues into PRs).

### Levels (invariant, unchanged from the parent spec)
- **Schedules are AGENT-level** (each agent owns `<agent>/.agent/schedule.json`).
- **The heartbeat is MESH-level** — exactly one instance in the daemon, scanning *all* agents. It is **not** an agent-scheduled job and **not** instantiated per agent.

## Architecture

A **third loop** in the dev-society daemon, independent of the issue-poll loop and the Phase-1 scheduler tick. Deliberate pure-core / impure-shell split:

```
 dev-society daemon (24/7, scripts/dev-society-daemon.mjs)        dashboard (read-only window)
 ┌───────────────────────────────────────────────┐              ┌──────────────────────────┐
 │ issue-poll loop        (existing, ~60s)        │              │ GET /api/health   ◀── NEW │
 │ scheduler tick         (Phase 1, 30s)          │              │ Health panel (Graph view)│
 │ heartbeat tick   ◀── NEW (~5m)                 │              └───────────┬──────────────┘
 │   listAllSchedules(meshRoot)  ── read ──▶ <agent>/.agent-mesh/schedule-state.json
 │   assessMeshHealth(jobs,now)  (pure)           │                          │ reads
 │   apply heals  ── write ──▶ schedule-state.json (clear stale / re-arm)    │
 │   write snapshot ──▶ <repo>/.dev-society/heartbeat.json ──────────────────┘
 │   escalate ──▶ gh issue (create/comment/close, de-duped by marker)        │
 └───────────────────────────────────────────────┘
```

- **Pure core** (`assessMeshHealth`) holds all the classification + heal/escalate decision logic and is unit-provable with zero I/O.
- **Impure shell** (`runHeartbeat` + the daemon loop) does the fs reads/writes and `gh` calls behind injected functions.
- The heartbeat shares no state with the scheduler beyond the on-disk `schedule-state.json` files; it never calls the scheduler's in-memory API. Heals are plain idempotent state-file writes the scheduler reads on its next tick.

## Components (one clear responsibility each)

### 1. `src/mesh-health/heartbeat.js` (new) — PURE assessment
```
assessMeshHealth({ jobs, now, thresholds, prev }) → {
  findings:   [{ agent, jobId, condition, severity, detail, since, seenCount, consecutiveFailures? }],
  heals:      [{ agent, jobId, action:'clear_stale'|'rearm', reason }],
  escalations:[{ agent, jobId, condition, key, action:'open'|'update'|'close', body }],
  summary:    { ok, failing, overdue, stuck, escalated },
}
```
- Input `jobs` is the `listAllSchedules({ meshRoot }).jobs` shape (already mesh-wide): `{ agent, id, name, cadence, enabled, lastRunAt, lastStatus, lastSummary, nextRunAt, running, consecutiveFailures }`.
- `thresholds`: `{ failThreshold, overdueGraceMs, staleMs, escalateAfter }`.
- `prev` is the previous heartbeat snapshot (read from `heartbeat.json`, or `null` on the first tick) so the assessor decides escalation `open`/`update`/`close` **deterministically** from carried state. Pure: no clocks except the injected `now`. **Persistence is counted explicitly:** each finding carries `seenCount` = `(matching prev finding by key).seenCount + 1`, or `1` if new (`since` is set to `now` on first sight, else carried from `prev`). This makes "persisted across ≥ `escalateAfter` heartbeats" a simple `seenCount >= escalateAfter` test with no reliance on wall-clock arithmetic against the interval.
- **Classification** per job (only `enabled` jobs are assessed; disabled jobs are reported `ok`/ignored):
  - `stuck`  — `running === true` and `now - Date.parse(lastRunAt) > staleMs`.
  - `overdue` — `running !== true` and `nextRunAt` parses and `now - Date.parse(nextRunAt) > overdueGraceMs`.
  - `failing` — `consecutiveFailures >= failThreshold`.
  - else `ok`. (A job can be both `failing` and `overdue`; precedence for the single reported `condition`: `stuck` > `failing` > `overdue`. Both still counted in `summary`.)
- **Heal decisions:** `stuck` → `clear_stale`; `overdue` → `rearm`. (`failing` has no safe auto-heal → escalation only.)
- **Severity:** `warn` while `seenCount < escalateAfter`; `error` once `seenCount >= escalateAfter` (the escalation trigger).
- **Escalation decisions:** a finding with `seenCount >= escalateAfter` → `escalations` entry with `action:'open'` if it was not already escalated in `prev`, else `action:'update'`. A `(agent,jobId,condition)` that was escalated in `prev` but is no longer a finding this tick → `action:'close'`. `key` is the stable de-dupe key `mesh-heartbeat:<agent>/<jobId>/<condition>`. (The snapshot persists which keys are currently escalated so `open`-vs-`update`-vs-`close` is decided purely from `prev`.)

### 2. `src/mesh-health/heartbeat-runner.js` (new) — IMPURE orchestration
```
runHeartbeat({ meshRoot, now, thresholds,
               listSchedules, readSnapshot, writeSnapshot,
               applyHeal, openIssue }) → { status:'ok'|'fail', summary?, error? }
```
- `listSchedules(meshRoot)` → jobs (defaults to `listAllSchedules`); `readSnapshot()`/`writeSnapshot(snap)` → the `.dev-society/heartbeat.json` prev/next; `applyHeal({agent,jobId,action})` → mutates that agent's `schedule-state.json` (clear `running:false`, or recompute `nextRunAt` via `computeNextRun(cadence, now)`); `openIssue({key,action,title,body})` → `gh` create/comment/close.
- Flow: read prev snapshot → `listSchedules` → `assessMeshHealth({jobs,now,thresholds,prev})` → for each heal `applyHeal(...)` → build the new snapshot `{ generatedAt, summary, findings, escalations }` and `writeSnapshot` → for each escalation `openIssue(...)`. Whole body in try/catch → `{status:'fail', error}` (never throws).
- **Ordering guarantee:** snapshot is written **before** issues are opened, so a `gh` failure still leaves the dashboard an accurate health view; issue routing retries next heartbeat (the dedup makes it idempotent).

### 3. Scheduler extension — `consecutiveFailures` counter
`src/schedule/scheduler.js`: when writing `schedule-state.json` after a run, set `consecutiveFailures` = `(prev||0)+1` on `fail`, or `0` on `ok`. Needed because **builtin jobs write no run-log** (the gh-activity-poll builtin returns a status the scheduler records as `lastStatus` only), so a failure streak cannot be derived from logs — it must live in state. Additive field; absent → treated as `0`. The existing stale-running cleanup and all other state semantics are unchanged.

### 4. Daemon wiring — `scripts/dev-society-daemon.mjs`
- Inside the existing `if (!once && !selftest)` guard (where the Phase-1 scheduler is started), add a heartbeat `setInterval(tick, HEARTBEAT_INTERVAL_MS)`, stored in a `heartbeat` handle; clear it in the SIGTERM/SIGINT shutdown alongside `sched.stop()`.
- The tick calls `runHeartbeat` with:
  - `writeSnapshot` → `writeFileSync(<repo>/.dev-society/heartbeat.json, json)` (path: `process.env.AGENT_MESH_HEARTBEAT_FILE || join(repoRoot,'.dev-society','heartbeat.json')`).
  - `readSnapshot` → read that file (or `null`).
  - `applyHeal` → atomic write of the agent's `schedule-state.json`.
  - `openIssue` → `gh issue list/create/comment/close` via the daemon's `gh` helper, repo `cfg.repo`, with a `mesh-heartbeat` label and the hidden marker token for dedup.
- The heartbeat loop is independent: a slow/failed heartbeat never blocks issue-polling or scheduling, and vice-versa.

### 5. Dashboard `/api/health` + Health panel
- **`GET /api/health`** (new, read-only): reads `process.env.AGENT_MESH_HEARTBEAT_FILE || resolve(meshRoot,'..','.dev-society','heartbeat.json')`, returns `{ generatedAt, summary, findings, escalations }` (or `{ summary:{...zero}, findings:[] }` when absent/corrupt — never 500). Same default-path agreement pattern as Phase 2's gh-activity cache (daemon `repoRoot/.dev-society` == dashboard `resolve(meshRoot,'..','.dev-society')`).
- **Health panel** in the Graph view: a foldable section (matching board2.css paper theme, per the dashboard UI prefs) listing findings grouped by severity — agent · job · condition · since · heal applied · escalation status (with a link to the GitHub issue when escalated). Read-only display; green/empty state when all healthy.

### 6. Config (`src/config.js`)
| Var | Default | Meaning |
|---|---|---|
| `AGENT_MESH_HEARTBEAT_INTERVAL_MS` | `300000` (5m) | heartbeat tick period |
| `AGENT_MESH_HEARTBEAT_FAIL_THRESHOLD` | `3` | consecutive fails → `failing` |
| `AGENT_MESH_HEARTBEAT_OVERDUE_GRACE_MS` | `900000` (15m) | how far past `nextRunAt` → `overdue` |
| `AGENT_MESH_HEARTBEAT_STALE_MS` | `1800000` (30m) | `running` age → `stuck` |
| `AGENT_MESH_HEARTBEAT_ESCALATE_AFTER` | `2` | consecutive heartbeats a finding must persist before a GitHub issue is opened |
| `AGENT_MESH_HEARTBEAT_FILE` | `<repo>/.dev-society/heartbeat.json` | snapshot path (shared daemon-write / dashboard-read) |

`0` for `INTERVAL_MS` disables the heartbeat (parity with the existing `*_HEADROOM_PCT=0` disable convention).

## Data flow & error handling
Heartbeat tick → read prev snapshot → `listAllSchedules` → `assessMeshHealth` (pure) → apply heals (idempotent state writes) → write new snapshot → route escalations (de-duped `gh` issue). A non-healthy job is **data**, never an exception. Any tick-level failure (fs, `gh`, parse) is caught, logged, and the loop continues; the snapshot from the last good tick remains for the dashboard. The dashboard endpoint degrades to an empty health view on a missing/corrupt snapshot.

### De-dup contract (escalation idempotency)
- One stable key per ongoing problem: `mesh-heartbeat:<agent>/<jobId>/<condition>`.
- `openIssue({key,action})`:
  - `open` → `gh issue list --search "<key> in:body state:open"`; if none, `gh issue create` with the marker `<!-- <key> -->` in the body + a `mesh-heartbeat` label; if one exists, treat as `update`.
  - `update` → `gh issue comment` on the existing issue with the latest detail (rate-limited: only when the detail materially changes, e.g. failure count crosses a boundary — avoids comment spam).
  - `close` → `gh issue close` with a "resolved by heartbeat" comment when the condition clears.
- Net invariant: **at most one open `mesh-heartbeat` issue per (agent, job, condition)** at any time.

## Testing (hermetic, `node --test`)
- **`test/heartbeat-assess.test.js`** — pure `assessMeshHealth`: table-driven over ok/failing/overdue/stuck (incl. boundary times at exactly the threshold), condition precedence (stuck>failing>overdue), severity escalation across `prev`, heal decisions (`clear_stale`/`rearm`), and escalation `open`/`update`/`close` transitions driven by `prev`. Zero I/O.
- **`test/heartbeat-runner.test.js`** — `runHeartbeat` with injected `listSchedules`/`readSnapshot`/`writeSnapshot`/`applyHeal`/`openIssue` + `now`: asserts heals are applied to the right jobs, snapshot shape + ordering (snapshot written before issues), dedup (same problem two ticks → one `open` then one `update`), clear-on-recovery (`close`), and that an `openIssue` throw degrades to `{status:'fail'}` without losing the snapshot.
- **`test/scheduler-failcount.test.js`** — the `consecutiveFailures` counter increments on `fail`, resets on `ok`, defaults to 0; existing scheduler tests still pass (no regression to delegate/builtin dispatch).
- **`test/heartbeat-daemon.test.js`** — daemon-wiring lint (regex, like Phase 2): heartbeat interval registered inside the guard, cleared on shutdown, snapshot path present; `--selftest` still starts nothing.
- **`test/health-route.test.js`** — `GET /api/health`: plant a `heartbeat.json` → assert the synthesized payload; missing/corrupt file → empty health, never 500. Mirrors the Phase-2 `activity-gh-merge` harness (token bootstrap → cookie).

## Phase 3 invariants
- The heartbeat is **mesh-level, single-instance, in the daemon** — never per-agent, never in the dashboard (the dashboard only reads `/api/health`).
- Heals are limited to **idempotent state-file writes** (clear stale lock, re-arm overdue). No out-of-cadence retries, no auto-disable, no process restarts in v1.
- Escalation is **de-duped** — at most one open `mesh-heartbeat` issue per (agent, job, condition); it auto-closes when the condition clears.
- A heartbeat failure is **data, not an exception** — it never crashes the daemon or its sibling loops, and the last good snapshot stays available to the dashboard.
- Read paths are **tolerant**: missing/corrupt state or snapshot degrades to "no findings" / "no health data", never an error.

## Deferred (not in Phase 3)
- Aggressive remediation (out-of-cadence retry with backoff, auto-disable, force-restart) — revisit once real failure patterns are observed.
- Health of non-scheduled mesh concerns (agent reachability via `ping_agent`, conformance drift) — `triageLogs`/`pingAgent`/`checkConformance` already exist read-only and could feed a later, richer health surface; Phase 3 stays focused on **scheduled-job** health.
