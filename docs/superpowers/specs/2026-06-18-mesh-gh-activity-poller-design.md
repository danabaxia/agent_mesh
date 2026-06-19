# Mesh self-operations — Phase 2: GitHub-Actions activity poller (the orchestrator agent)

**Date:** 2026-06-18
**Status:** design — approved, pending written-spec review
**Topic:** a dedicated `orchestrator` agent whose scheduled **builtin** job polls GitHub Actions and feeds the dashboard's mesh activity, so the live constellation reflects the cloud society's work.

Phase 2 of the mesh self-operations layer (overall vision + Phase 1 in `2026-06-18-mesh-scheduling-ops-design.md`). Phase 1 (always-on agent-level scheduling, mesh-level visibility) is **merged**. Phase 3 (mesh-level self-healing heartbeat) is a separate spec.

## Problem & goal

The dashboard's live activity graph is empty even though the society is productive, because the work runs in GitHub Actions (cloud) and ephemeral worktrees — neither writes run-logs the dashboard reads (root-caused 2026-06-18). Phase 2 closes that gap: a **dedicated `orchestrator` agent** owns a cheap, scheduler-driven poll of GitHub Actions that turns recent workflow runs into mesh **activity records**, so the constellation animates with CI work.

### Decisions (from brainstorming)
- **Execution: a non-claude "builtin" scheduler job.** The orchestrator owns a scheduled job `{ kind:'builtin', builtin:'gh-activity-poll' }`; the scheduler runs a registered function (mechanical `gh run list`) instead of `delegateTask`. No claude spawn, no tokens. Honors "standard scheduler + agent-owned + cheap".
- **Owner: a new `orchestrator` agent** in `dev-mesh` (role: mesh ops / observability; owns this poll now and the Phase-3 heartbeat later).
- **Visual: orchestrator-as-hub.** Each run becomes an `orchestrator → <role-agent>` activity record; in-progress runs animate an arc + pulse the role-agent; completed runs settle the edge and post a `done` event.

## Architecture

```
 daemon scheduler (Phase 1)                                      dashboard
 ┌──────────────────────────────────────────┐                   ┌────────────────────┐
 │ tick → orchestrator's gh-activity-poll due │                  │ GET /api/activity   │
 │  job.kind==='builtin' → builtins[name](…)  │── gh run list ──▶ workflowToAgent(map)
 │   (registered fn; NO claude, NO tokens)    │── writes ──▶ <ghActivityPath> (records)
 └──────────────────────────────────────────┘                   loadActivitySnapshot ◀┘
                                                                  appends GH records → buildActivity
                                                                  → constellation + event ticker + SSE
```

## Components

### 1. New `orchestrator` agent (`dev-mesh/orchestrator/`)
- `agent.json` + `AGENT.md` (role: "mesh orchestrator — observes the society's GitHub-Actions activity and keeps the scheduled-ops healthy"; ask-only, no peers required).
- Added to `dev-mesh/mesh.json` (`served:true`, `enabledModes:['ask']`); `doctor --apply` seeds the scaffold + wiring.
- `.agent/schedule.json` carries the builtin poll job:
  `{ jobs: [{ id:'gh-activity-poll', name:'GitHub activity poll', kind:'builtin', builtin:'gh-activity-poll', cadence:{ kind:'every', minutes:2 }, enabled:true }] }`.

### 2. Builtin job kind in the scheduler (`src/schedule/scheduler.js`)
- `createScheduler({ meshRoot, runJob, builtins = {}, intervalMs, now })` gains a `builtins` registry: `{ [name]: async ({ agentRoot, agentName, job, meshRoot }) => ({ status:'ok'|'fail', output?, error? }) }`.
- In `executeJob`, when `job.kind === 'builtin'`, dispatch to `builtins[job.builtin]` instead of the delegate `runJob`. Same per-agent lock, same `schedule-state.json` recording (lastStatus/nextRunAt). Unknown builtin → `fail` (recorded, not thrown). Claude jobs are unchanged.

### 3. The `gh-activity-poll` builtin (`src/dev-society/gh-activity.js`)
- **Pure core** `workflowToAgent(workflowName)` → mesh agent name (mapping table below).
- **Pure core** `runsToActivityRecords(runs, { now })` → activity records (shape §"Activity records").
- **Impure runner** `pollGhActivity({ gh, repo, writeCache, now })` — runs `gh run list --repo <repo> --limit 80 --json databaseId,workflowName,status,conclusion,createdAt,updatedAt,event,headBranch`, keeps a recent window (runs whose `updatedAt` is within `GH_ACTIVITY_WINDOW_MIN`, default 120 min), maps + transforms via the pure helpers, and writes the records array to the cache. The daemon registers this as `builtins['gh-activity-poll']` with `gh`, `repo` (`DEV_SOCIETY_REPO`), and the cache path bound.

### 4. Activity merge (`src/dashboard/server.js` `loadActivitySnapshot`)
- After gathering per-agent run-log records and before `buildActivity(records)`, read the GH-activity cache and **append** its records (preserving their `agent`/`from`/`to` fields — do NOT re-tag like per-agent logs). Cache path: `ghActivityPath` option / `AGENT_MESH_GH_ACTIVITY` env / default `resolve(meshRoot, '..', '.dev-society', 'gh-activity.json')`. Missing/corrupt → skip (degrade to local-only). This is the only dashboard change; it stays generic.

## Activity records (buildActivity contract)
`buildActivity` derives **agent state** from records with an `agent` field (working when no `finished_at`), **edges** from `a2a` records (`from`/`to`; active when no `finished_at`), and **events** from both. So each GitHub run R (workflow W → role-agent A, `createdAt` T, status, conclusion C) produces **two records**:

- **node state** — `{ id:'gh-'+R, agent:A, route:'ci:'+W, started_at:T, finished_at?: <updatedAt when completed> }` → A pulses while running, settles to `done` with a start/done event.
- **edge/event** — `{ id:'gh-'+R+':e', kind:'a2a', from:'orchestrator', to:A, mode:'ci', status:(completed? C : null), started_at:T, finished_at?: <updatedAt when completed>, at:T }` → an active arc orchestrator→A while running; a settled edge + `a2a` event (`reviewer ← orchestrator · ci — success`) on completion.

**Self-loop guard:** when a workflow maps to `orchestrator` itself (e.g. `dogfood`/`health`), emit ONLY the node-state record (skip the `a2a` edge) — an orchestrator→orchestrator arc is meaningless.

The cache is **rewritten in full each poll** with the current window's runs, so a run appears exactly once at its current status — dedup is inherent (no incremental event log to de-duplicate). `buildActivity` already caps events at 40.

## Workflow → agent mapping (convention; pure, table-driven)
`research, intake → analyst` · `backlog → maintainer` · `triage → triager` · `review, review-respond → reviewer` · `curate → curator` · `autofix, ci-sweep, mergefix → coder` · `dogfood, health, memory-automerge, pr-janitor → orchestrator`. A workflow not in the table (or a non-`dev-mesh-*` workflow) → `orchestrator` (the catch-all owner). The mapping keys off the workflow name with the `dev-mesh-` prefix stripped.

## Error handling & safety
- `gh` failure (not-authed/network) → the builtin returns `{status:'fail', error}` → recorded in `schedule-state.json`; the cache keeps its last-good contents. The Phase-3 heartbeat will act on persistent `fail`.
- Records carry only **workflow name, run id, status/conclusion, timestamps, the mapped agent** — no logs, no secrets, no PR bodies.
- The poll is **read-only** GitHub access; it never writes to GitHub.
- `loadActivitySnapshot` tolerates a missing/corrupt cache (local-only activity).

## Testing (hermetic, `node --test`)
- **Pure:** `workflowToAgent` (every mapping arm + catch-all); `runsToActivityRecords` (in-progress → working+active-arc, no `finished_at`; completed → done+settled with conclusion; window filtering; two-records-per-run).
- **Builtin dispatch:** `createScheduler` runs a `kind:'builtin'` job via an injected `builtins` runner (not `delegateTask`); unknown builtin → `fail`; claude jobs unaffected.
- **`pollGhActivity`:** injected `gh` + `writeCache` stubs → writes the expected records for a fixture run set.
- **Merge:** `loadActivitySnapshot` appends planted GH-cache records → `/api/activity` includes the orchestrator edges (route/integration test reusing the activity-route harness).
- **Agent wiring:** the `orchestrator` agent added to `dev-mesh` → `validate`/`doctor` dry-run pass (conformance).

## Scope
Phase 2 = the orchestrator agent + the builtin job kind + the `gh-activity-poll` runner + the activity merge. **Out of scope:** the self-healing heartbeat (Phase 3), and any change to how local A2A activity is captured.
