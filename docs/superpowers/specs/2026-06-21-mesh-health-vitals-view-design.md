# Mesh Health "Vital Signs" View — Design

**Date:** 2026-06-21
**Status:** Draft (brainstorming → spec)
**Topic:** Promote the dashboard's cramped Health panel into a dedicated top-level "Vital Signs" view that answers one question — *is every part of the mesh organism alive and functioning, with no dead mechanisms?* — using passive signals only, with per-agent activity history and a human-readable health report.

---

## 1. Motivation

The mesh is a living system of agents, scheduled jobs, a 24/7 daemon, a task board, and a self-evolve pipeline. Today the only "health" surface is a **foldable panel inside the Graph view** (`graph-view.js`) that reads `heartbeat.json` and renders a findings table for *scheduled jobs only* (failing / overdue / stuck). It cannot tell the user:

- Which **agents** are actually alive vs silently dead.
- What the mesh's **activity history** looks like over time (only an instantaneous live graph exists).
- A plain, readable **health report** ("doctor's report") a human can skim top to bottom.
- Whether non-job "organs" — the task board, the self-evolve pipeline, mesh conformance, and each agent's **cognitive load** (prompt bloat, context headroom, memory hygiene) — are healthy.

`pingAgent` (a real A2A `initialize`/`ping` liveness probe) exists in `src/mesh-health/core.js` but is exposed **only** to the mesh-manager agent over MCP; the dashboard never calls it. The decision for this view (see §3) is **passive signals only** — no new spawns — so liveness is *inferred* from artifacts already on disk, not probed.

**Goal:** a dedicated, demo-quality top-level **Health (Vital Signs)** view that checks all mesh "biological functions" and surfaces any **dead mechanism** — honestly, without false alarms.

---

## 2. Scope

**In scope**

1. A new top-level dashboard view: **Health / Vital Signs**.
2. **Passive liveness** classification per agent (alive / idle / overdue / stuck / failing / dead) inferred from run logs, schedule state, heartbeat, and daemon-log freshness.
3. **Activity history**: per-agent daily-intensity sparklines over a configurable window + a chronological event feed.
4. A rendered **human-readable health report** ("doctor's report").
5. Five **organs** monitored: Agents, Jobs & Daemon, Task Board, Pipeline & Conformance, Cognition.
6. A **pure** health-model module (all classification + report rendering) + a thin disk collector + an extended `/api/health` endpoint + the new frontend view.

**Out of scope (documented follow-ups)**

- **Active probing** (`pingAgent` on a timer / "Check now" button). Deliberately deferred — passive-only chosen. A future spec can add an on-demand probe that feeds the same model.
- **Agent-authored health reports** (a mesh agent reasoning over the metrics and recommending "promote section Y to memory"). This view surfaces metrics + threshold flags only; the *judgment* is left to an agent or the user, per the mesh principle "actions make data, agents reason." A future "Mesh Doctor" agent can consume this same `/api/health` model.
- Changes to the heartbeat daemon loop, escalation routing, or `mesh-health` MCP verbs. This view is a **read-only consumer** of existing artifacts.

---

## 3. Decisions (resolved during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Liveness check | **Passive signals only** | No extra `claude`/A2A spawns; infer from on-disk artifacts. Honest about what passive data can prove (see §5 honesty rule). |
| Activity history | **Per-agent timeline + sparklines** + event feed | Shows trend, not just an instant. Zero-dep inline SVG. |
| Placement | **Dedicated top-level view** | Current panel is a cramped fold inside Graph view. |
| Organs | Agents · Jobs & Daemon · Task Board · Pipeline & Conformance · **Cognition** | Cognition added by user: prompt allocation, context bloat, memory long/short separation, "needs promotion". |
| Cognition treatment | **Surface metrics + threshold flags** | Dashboard measures & flags; promote/split judgment left to agent/user. |
| Architecture | **Pure model + thin collector + dedicated view** (Approach A) | Matches the codebase's "pure core + thin shell" split; every verdict unit-testable. |

---

## 4. Architecture

```
on-disk artifacts ──► health-collect.js (thin shell: file I/O, try/degrade)
                            │  raw inputs
                            ▼
                       health-model.js (PURE) ──► HealthReport
                            │                       buildHealthReport(...)
                            │                       renderHealthReport(model) → markdown
                            ▼
                   GET /api/health (extended) ──► public/health-view.js (new top-level view)
```

Deliberate split, mirroring the existing codebase convention (pure core unit-provable, thin impure shell touches the filesystem):

### 4.1 `src/dashboard/health-model.js` (NEW — pure, no I/O)

The heart of the feature. All band logic and rendering; fully unit-testable.

```js
// Pure. now is injected; never reads Date.now itself except via caller.
buildHealthReport({
  agents,           // [{ name, served, hasEnabledJobs, folderPaths }]
  runRecords,       // per-agent deduped run records (timestamps, state, status)
  scheduleStates,   // per-agent schedule-state.json contents
  heartbeat,        // parsed heartbeat.json (findings, summary, openEscalations)
  boardTasks,       // non-terminal board task records
  activityEvents,   // .dev-society/activity-*.jsonl events (windowed)
  cognitiveStats,   // per-agent { promptBytes, memoryShortBytes, memoryLongBytes, headroomPct, lastRotateAt, lastDigestAt }
  daemon,           // { lastTickAt, logMtime }
  pipeline,         // { openIssues, openPRs, drainTrend, conformance? }
  now,              // injected epoch ms
  thresholds,       // resolved bands (see §7)
}) => HealthReport

renderHealthReport(model) => string   // human-readable markdown "doctor's report"
```

`HealthReport` shape:

```js
{
  generatedAt,                 // ISO (from injected now)
  overall: 'nominal' | 'warn' | 'critical',
  organs: {
    agents:   { status, counts: { alive, idle, overdue, stuck, failing, dead } },
    jobs:     { status, findings, summary, openEscalations },   // from heartbeat
    board:    { status, staleTasks: [...] },
    pipeline: { status, openIssues, openPRs, drainTrend, conformance },
    cognition:{ status, flags: [...] },
  },
  agentVitals: [               // one row per agent (liveness grid)
    { name, liveness, lastSeenAt, recentRuns, recentFailures,
      expectedCadence: bool, cognition: { promptBytes, headroomPct, memorySeparation, flags } }
  ],
  activityHistory: {           // for sparklines
    days: ['2026-06-14', ...],            // window, oldest→newest
    perAgent: { [name]: [counts...] },    // aligned to days
    events: [ { ts, agent, type, level, summary } ]  // chronological feed (capped)
  },
  report: { markdown }         // renderHealthReport output
}
```

### 4.2 `src/dashboard/health-collect.js` (NEW — thin shell)

Reads the artifacts and assembles raw inputs, then calls the pure model. **Every read is try/degrade — missing or corrupt file ⇒ empty/neutral, never throws.** Sources (all already on disk):

- Per-agent run logs `<agent>/.agent-mesh/logs/<prefix>-YYYY-MM-DD.jsonl` (deduped via existing helpers) → `runRecords`, activity buckets.
- Per-agent `<agent>/.agent-mesh/schedule-state.json` → `scheduleStates`, `hasEnabledJobs`.
- `.dev-society/heartbeat.json` → `heartbeat`.
- `.dev-society/activity-YYYY-MM-DD.jsonl` (windowed) → `activityEvents`.
- `.dev-society/daily-report-*.json` + `.dev-society/mir/mir-*.json` → `pipeline`.
- Daemon log mtime (`.dev-society/daemon.log`) → `daemon.logMtime`; `heartbeat.generatedAt` → `daemon.lastTickAt`.
- Board task files `<mesh-root>/mesh/board/tasks/` → `boardTasks`.
- **Cognitive byte sizes** — `stat`/read length of each agent's `AGENT.md`, `CLAUDE.md`, and memory files (long-term vs short-term, by the project's memory-dir convention) → `cognitiveStats`. Context headroom trend from existing token-usage / session-provenance data already surfaced by `/api/tokens`.

### 4.3 `GET /api/health` (EXTENDED)

Currently returns the raw heartbeat snapshot `{ generatedAt, summary, findings, openEscalations }`. Extend to return the full `HealthReport`. **Backward compatibility:** the heartbeat fields stay reachable nested under `organs.jobs` (`findings` / `summary` / `openEscalations`), and the existing Graph-view Health panel is re-pointed to read `organs.jobs` (or kept reading the top level via a thin compatibility shim that preserves the old keys at the root). Endpoint never 500s — on total collector failure it returns a minimal `{ overall:'unknown', organs:{}, agentVitals:[], ... }`.

### 4.4 `src/dashboard/public/health-view.js` (NEW — frontend)

Dedicated top-level view registered in the dashboard nav (sibling to Graph view). Styled to match `board2.css`; **foldable + maximizable panels; responsive, interactive charts** (per established dashboard UI prefs). Zero-dependency inline-SVG sparklines, consistent with `net-graph.js`. Sections in §6.

---

## 5. The five organs & passive judgment

| Organ | Passive signal | Healthy / Warn / Dead |
|---|---|---|
| **Agents** | newest run-log ts, schedule-state freshness, heartbeat findings | **Honesty rule (below).** Agent with *enabled jobs* has a known cadence → `overdue`/`stuck`/`failing` ⇒ **dead mechanism**. Agent with *no jobs* (on-demand/interactive) → `idle (Nd since last activity)`, informational — never falsely "dead". |
| **Jobs & Daemon** | `heartbeat.json` findings + daemon-log mtime | Daemon "beating" if log touched within `DAEMON_STALE_MS`; jobs `failing`/`overdue`/`stuck` straight from heartbeat. A stale daemon log = the **heart itself stopped** → critical. |
| **Task Board** | non-terminal task records, age vs `BOARD_STALE_MS` | Task in `assigned`/`acknowledged`/`in-progress` older than stale threshold = stuck handoff (work that entered and never advanced). |
| **Pipeline & Conformance** | daily-report + MIR trend; last conformance snapshot if present | Drain stalled (open issues/PRs not moving across snapshots) or conformance drift ⇒ warn. |
| **Cognition** | agent-folder byte sizes, context-headroom trend, memory long/short presence | Prompt over `PROMPT_SOFT_BYTES`, headroom below threshold, or no long/short memory separation ⇒ **flag** (data only; promote/split judgment left to agent/user). |

### Honesty rule (the "no dead mechanisms" guarantee)

Passive signals **can** prove *"a mechanism that should be beating has stopped"*:
- an **enabled scheduled job overdue** far past its grace window,
- the **daemon log gone stale**,
- a **board task stuck** beyond the stale threshold.

These are reported as **dead mechanisms** with confidence.

Passive signals **cannot** prove an idle, on-demand agent is dead (no expected cadence to miss). For those the view shows **"idle — Nd since last activity"**, informational, never a false "dead" alarm. This keeps the view trustworthy: a red "dead" marker always means a real stopped mechanism. (A future active-probe follow-up can resolve idle↔dead ambiguity for on-demand agents.)

`overall` rolls up: any **dead mechanism** ⇒ `critical`; any organ `warn` (flags, drain stall, board stale) ⇒ `warn`; else `nominal`.

---

## 6. Page layout (dedicated view)

1. **Vital-signs banner** — overall verdict ("All systems nominal" / "N issues" / "CRITICAL: M dead mechanisms") + per-organ status pills (Agents · Jobs · Board · Pipeline · Cognition).
2. **Liveness grid** — per-agent card/row: liveness badge (alive/idle/overdue/stuck/failing/**dead**), last-seen, recent run count, recent failures. Color-coded; dead = red.
3. **Activity history** — per-agent daily-intensity sparklines over the window (`HISTORY_DAYS`) + a chronological event feed (reuses `activity-log` data with agent/type/level filters).
4. **Cognitive vital signs** — per-agent table: prompt/memory bytes (with soft-limit bar), context-headroom trend, memory-separation flag, last rotate/digest time.
5. **Health report** — the rendered `renderHealthReport()` markdown, a plain doctor's report a human can read top to bottom.

---

## 7. Configuration (env, all optional; defaults in `src/config.js`)

| Var | Default | Meaning |
|---|---|---|
| `AGENT_MESH_HEALTH_AGENT_STALE_MS` | `3_600_000` (1h) | Last-activity age → agent considered stale (warn band for idle display). |
| `AGENT_MESH_HEALTH_AGENT_DEAD_MS` | `86_400_000` (24h) | Age past which a **job-bearing** agent's silence is treated as dead (combined with overdue job, per honesty rule). |
| `AGENT_MESH_HEALTH_DAEMON_STALE_MS` | `900_000` (15m) | Daemon-log mtime age → daemon heart stopped. |
| `AGENT_MESH_HEALTH_PROMPT_SOFT_BYTES` | `16_384` | Per-agent prompt/AGENT.md+CLAUDE.md soft size limit → cognition flag. |
| `AGENT_MESH_HEALTH_HEADROOM_WARN_PCT` | `25` | Context-headroom below this → cognition flag (reuses the rotate-headroom convention). |
| `AGENT_MESH_HEALTH_HISTORY_DAYS` | `14` | Activity-history window for sparklines. |

Reuses existing thresholds where present: heartbeat bands (`AGENT_MESH_HEARTBEAT_*`), board stale (`AGENT_MESH_BOARD_STALE_MS` / `DEFAULT_BOARD_STALE_MS`).

---

## 8. Testing

| Layer | Test | Covers |
|---|---|---|
| Pure model | `test/health-model.test.js` | Band classification per organ; **honesty rule** (job-bearing overdue ⇒ dead; jobless silent ⇒ idle, never dead); `overall` rollup; activity bucketing; `renderHealthReport` output; **missing/empty/corrupt-input degradation** (every input optional → neutral result). |
| Collector | `test/health-collect.test.js` | Tolerant disk reads against a temp fixture mesh (missing files, corrupt JSON → degrade); cognitive byte-size measurement; window selection. |
| Endpoint | dashboard server test | `/api/health` returns the extended shape; never 500 on missing artifacts; backward-compat keys present for the old Graph-view panel. |

All within the hermetic L0 suite (`node --test`, zero deps). No real-`claude` needed — this view is pure artifact reading. CI gate = `run-all-tests.mjs`.

---

## 9. Risks & mitigations

- **False "dead" alarms erode trust.** → Honesty rule (§5): "dead" only for a missed known cadence / stopped daemon / stuck task; idle agents shown as idle.
- **Reading many agent folders is slow.** → Collector caps the activity window, reuses already-deduped run-record helpers, and `stat`s (not full-reads) where only size is needed; results are computed per request but cheap (no spawns).
- **Backward compat with the existing Graph-view panel.** → `/api/health` keeps heartbeat keys reachable; panel re-pointed in the same change, covered by the endpoint test.
- **Cognition memory-separation convention varies per agent.** → Use the project's memory-dir convention; absence ⇒ a flag, not an error.

---

## 10. File-change summary

**New**
- `src/dashboard/health-model.js` (pure: `buildHealthReport`, `renderHealthReport`)
- `src/dashboard/health-collect.js` (thin shell: disk → raw inputs → model)
- `src/dashboard/public/health-view.js` (dedicated view)
- `test/health-model.test.js`, `test/health-collect.test.js`

**Modified**
- `src/dashboard/server.js` — extend `GET /api/health` to serve the full `HealthReport` (compat keys preserved).
- `src/dashboard/public/graph-view.js` — re-point the existing Health panel to `organs.jobs` (or link it into the new view).
- dashboard nav/index — register the top-level Health view.
- `src/config.js` — new `AGENT_MESH_HEALTH_*` defaults.
- `CLAUDE.md` — document the new view + endpoint shape + config.
