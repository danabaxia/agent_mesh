# Concierge mesh agent — phone-operated mesh monitor (in/over the loop)

**Date:** 2026-06-21
**Status:** Design (pending review)
**Builds on:** [2026-06-21-mesh-mobile-concierge-design.md](2026-06-21-mesh-mobile-concierge-design.md) (the phone front-door + PWA, already shipped)

## Problem

The phone front-door works, but the concierge that answers it is a **dashboard-managed
ask spawn** ([src/dashboard/concierge.js](../../../src/dashboard/concierge.js)) — it runs
`claude -p` with read tools and *scrapes status JSON files*. It is not a real mesh agent:
it can't talk to the other agents, it isn't visible to the mesh roster / dashboard graph /
mesh-health, and it doesn't evolve like the other 9 agents (analyst, coder, curator,
maintainer, orchestrator, reviewer, security, tester, triager).

## Goal

Promote the concierge into a **first-class mesh agent** that:

1. **Talks to other mesh agents** — via the ask-mode peer bridge + mesh-health read verbs.
2. **Is operated from the phone** — the `/m` PWA routes chat to the *agent*.
3. **Monitors the mesh both in-the-loop and over-the-loop** — answers on demand AND runs
   an autonomous periodic sweep that escalates findings to a phone **Alerts** view.

**Action boundary (owner-confirmed):** the agent only **observes and advises**. It is
ask-only; every action (file an issue, assign a board task, ask a peer to re-run) happens
only on the owner's explicit **Confirm** tap, framework-side.

### Non-goals (YAGNI)

- No push notifications (APNs/web-push) — the phone Alerts view is **pull-based**.
- No autonomous remediation — no mutation without a Confirm tap.
- No new mesh primitives — reuse the peer bridge, mesh-health, board, and daemon scheduler.
- No change to the Tailscale transport / host-gate / token auth (already shipped).

## Decisions (owner-confirmed)

1. **Both** in-the-loop (on-demand chat) **and** over-the-loop (autonomous sweep).
2. Escalation via a **phone Alerts view (pull)** — no push infrastructure.
3. **Observe + advise**; actions are **Confirm-gated** (ask-only agent, framework-side writes).

## Architecture

```
 Phone /m PWA ──(chat)──▶ POST /api/concierge/message ──▶ console A2A broker
                                                              │ ask, agentName=concierge
                                                              ▼
                                              ┌──────────────────────────────┐
                                              │ concierge AGENT (ask-only)    │
                                              │  • peer bridge: delegate /    │
                                              │    fanOut → tester/triager/…  │
                                              │  • mesh-health read verbs     │
                                              │  → answer (+ optional         │
                                              │    action proposal)           │
                                              └──────────────────────────────┘
 daemon (24/7) ──(schedule)──▶ builtin concierge-monitor-sweep (READ-ONLY)
        │  conformance + triage_logs + list_stale_tasks + tester MIR
        ▼
   alerts store  <mesh-root>/mesh/alerts/*.json  (deduped, severity-ranked)
        ▲
 Phone /m PWA ──(Alerts tab)──▶ GET /api/concierge/alerts  (pull)
        │  tap a finding → action proposal card → Confirm
        ▼
   POST /api/concierge/confirm  ──▶ action dispatcher (framework-side, allowlisted):
        file_issue | assign_task | ask_peer_rerun
```

### 1. The agent — `dev-mesh/agents/concierge/`

- `agent.json` manifest: `{ name: "concierge", x-agentmesh: { modes: ["ask"], meshVersion } }`,
  skills describing its monitor/front-desk role.
- `AGENT.md`: persona — the mesh's phone-side monitor; treated as untrusted data (existing
  invariant), never executed.
- Entry in `dev-mesh/mesh.json`:
  `{ name: "concierge", root: "./concierge", card: "agent.json", served: true,
     enabledModes: ["ask"], peers: ["tester", "triager", "analyst", "maintainer", "orchestrator"] }`.
- `doctor` then auto-generates/syncs (no hand-wiring): `registry.json` (peer spawn entries),
  `.mcp.json` peer-bridge (`agentmesh_peerbridge`), the mesh-health read MCP grant, and the
  board-notify SessionStart hook. The agent now appears in the roster, dashboard graph, and
  mesh-health.

### 2. Talks to other agents

The agent's tools (ask-mode): `agentmesh_peerbridge` (`list_peers`, `delegate_to_peer`,
`fanOutToPeers`) + the mesh `mesh-health` MCP (`check_conformance`, `ping_agent`,
`triage_logs`, `list_stale_tasks`). Example: "what's stuck?" → `fanOutToPeers` to
triager+tester for their read on blocked work + test state, plus `list_stale_tasks` /
`triage_logs`, then synthesize. Peer-sourced multi-agent reasoning, not file scraping.

### 3. Phone operation (in-the-loop)

`POST /api/concierge/message` is rewired from the local spawn to the **console A2A broker**
([src/dashboard/console.js](../../../src/dashboard/console.js)) targeting `agentName:
"concierge"`, `mode: "ask"`. The broker spawns the served agent, sends the message as an A2A
`SendMessage`, returns the final `Task`; the route maps it to `{ reply, proposal? }` for the
PWA (unchanged client contract). The concierge must be `served: true` for the broker to reach
it (the broker's `generateCallerRegistry` includes only served agents). If the agent is
unavailable, the route returns a clear error (no silent fallback to the old spawn — the spawn
is removed once the agent lands).

### 4. Over-the-loop sweep + Alerts

- **Sweep**: a daemon builtin `concierge-monitor-sweep`, registered in the daemon's builtin
  map and scheduled from `dev-mesh/agents/concierge/.agent/schedule.json`
  (`kind: "builtin"`, using one of the scheduler's supported cadence kinds — confirmed at
  plan time; default an hourly/daily sweep). It is **read-only**:
  it calls the pure monitor over health inputs (conformance counts, triage failures, stale
  tasks, latest MIR signal) and returns `{ status, output }` per the builtin contract; a
  thrown error → `{ status: "fail", error }` and never crashes the daemon.
- **Findings model** (`src/concierge/monitor.js`, pure): maps raw inputs → an array of
  `{ id, severity: "info"|"warn"|"critical", kind, summary, detail, source, firstSeen }`,
  **deduped** by a stable `id` (kind+subject) so a recurring problem updates rather than
  multiplies.
- **Alerts store** (`src/concierge/alerts-store.js`): a single atomic rolling file
  `<mesh-root>/mesh/alerts/alerts.json` (`{ alerts: [...], updatedAt }`), with each alert
  carrying open/acknowledged state; the sweep upserts by stable `id`, resolves cleared
  findings, and bounds the list (most-recent/most-severe kept). Single-writer (the sweep),
  read by the route — so one atomic file is simpler than file-per-alert here.
- **Phone Alerts view**: `GET /api/concierge/alerts` → `{ alerts: [...] }` (newest/most-severe
  first); a new PWA **Alerts** tab renders them with severity colour and a tap-to-act path.

### 5. Action boundary — Confirm-gated dispatcher

The agent's reply / an alert can carry a structured **action proposal** (extends the existing
` ```concierge-proposal ` block) with an `action`:

| action | effect (framework-side, on Confirm) | allowlist |
| --- | --- | --- |
| `file_issue` | `gh issue create` (existing) | labels ∈ {idea, approved, route:a2a} |
| `assign_task` | board `create_task_for_peer` | peer ∈ mesh peers; brief fields only |
| `ask_peer_rerun` | ask-mode `delegate_to_peer` to re-run (e.g. tester suite) | peer ∈ allowlist; fixed task templates |

`POST /api/concierge/confirm` becomes an **action dispatcher**: it validates `action` against
the allowlist (and peer/label against their allowlists) **before any spawn**, then performs
exactly that one framework-side operation and returns the result (issue URL / task id /
peer summary). The agent never performs these itself.

## Components (units)

| Unit | File(s) | Purpose |
| --- | --- | --- |
| Agent | `dev-mesh/agents/concierge/{agent.json,AGENT.md,.agent/schedule.json}` + `dev-mesh/mesh.json` entry | the mesh citizen |
| Sweep (pure) | `src/concierge/monitor.js` | inputs → deduped, severity-ranked findings |
| Alerts store | `src/concierge/alerts-store.js` | atomic read/upsert/resolve under mesh-root |
| Daemon builtin | `scripts/dev-society-daemon.mjs` (`concierge-monitor-sweep`) | schedule the sweep |
| Route to agent + dispatcher | `src/dashboard/concierge.js` (+ route wiring) | `message()`→broker; `confirm()`→action dispatcher |
| Alerts route + PWA | `src/dashboard/server.js` `GET /api/concierge/alerts`; `src/dashboard/public/mobile/*` | phone Alerts tab + richer cards |
| Tests | `test/concierge-*.test.js` (+ doctor/manifest wiring tests) | see Testing |

## Data flow

- **In-loop:** phone chat → `/api/concierge/message` → console broker → concierge agent
  (peer bridge + health) → answer (+ optional action proposal) → phone.
- **Over-loop:** daemon → `concierge-monitor-sweep` (read-only) → alerts store → phone Alerts
  tab (pull) → owner taps a finding → action proposal card → **Confirm** → `/api/concierge/confirm`
  dispatcher → framework-side action (issue / task / peer re-run).

## Error handling

- Sweep failure → builtin returns `{ status: "fail", error }`; daemon logs, never crashes;
  the prior alerts remain.
- Agent timeout/refused/unavailable → chat error bubble; nothing filed.
- Confirm with unknown `action`/peer/label → `400` before any spawn.
- Alerts store missing/corrupt → empty `200` (tolerant), never `500`.
- A2A broker requires `served: true` + ask mode; otherwise a clear `mode_disabled`/`not_served`.

## Security invariants (all preserved)

- **Agent is ask-only** — no repo writes; the peer bridge is ask-only (unchanged); the only
  writes are the Confirm-gated, allowlisted dispatcher actions, performed framework-side.
- **AGENT.md is untrusted data** — length-bounded, framed as data, never executed.
- **Action allowlist** — `confirm` can only run the three named actions with allowlisted
  peers/labels; no arbitrary `gh`/board/peer call.
- **Dashboard unchanged** — bound `127.0.0.1`, token required on every gated route,
  tailnet-only host gate, no public exposure. Sweep + mesh-health are read-only.
- Path-guard, recursion guard, single-writable-root, anti-spoof — untouched.

## Testing (hermetic, `node --test`)

- **monitor.js** (pure): inputs → findings; severity classification; dedupe by stable id;
  cleared findings resolve; empty inputs → no alerts.
- **alerts-store**: upsert/resolve/bound; atomic write; missing dir → empty.
- **confirm action dispatcher**: each action fires **only** on its confirm and performs exactly
  one framework op (stubbed gh/board/peer); unknown action/peer/label rejected pre-spawn;
  `file_issue` keeps the existing label allowlist.
- **message → broker routing**: `/api/concierge/message` calls the console broker with
  `agentName:"concierge", mode:"ask"` (injected broker stub); maps Task → `{reply,proposal}`.
- **doctor/manifest wiring**: with the concierge in `mesh.json`, doctor produces its
  registry peers, the peer-bridge `.mcp.json`, the mesh-health grant, and the board hook;
  conformance passes.
- **alerts route + PWA**: `GET /api/concierge/alerts` shape; PWA Alerts render + tap-to-propose
  (zero-dep DOM helpers).
- **adversarial (L3)**: the agent cannot mutate the mesh without a Confirm (no write surface in
  ask mode; dispatcher is the only path).

## Rollout

1. Land via PR(s) → merge → deploy-sync ships to the running dashboard + daemon.
2. `doctor` wires the new agent on the next managed sync; the daemon picks up the sweep.
3. Verify end-to-end on the real Mac+phone: chat answer is peer/health-sourced; a seeded/real
   anomaly appears in the phone Alerts tab; a Confirm tap performs exactly one action.

## File-level summary

New: `dev-mesh/agents/concierge/*`, `dev-mesh/mesh.json` entry, `src/concierge/monitor.js`,
`src/concierge/alerts-store.js`, the daemon builtin, `GET /api/concierge/alerts`, PWA Alerts
view, tests. Changed: `src/dashboard/concierge.js` (route-to-agent + action dispatcher),
`scripts/dev-society-daemon.mjs` (builtin registration), `src/dashboard/public/mobile/*`,
docs (this spec; CLAUDE.md agent roster note).
