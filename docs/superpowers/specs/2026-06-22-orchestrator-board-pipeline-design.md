# Orchestrator-driven board pipeline — phone task → autonomous work → live status

**Date:** 2026-06-22
**Status:** Design (pending review)
**Builds on:** the mesh task board ([src/board/*](../../../src/board/)), the A2A Task Board view (spec 2026-06-22-a2a-task-board-view-design.md), and the concierge agent (spec 2026-06-21-concierge-mesh-agent-design.md).

## Problem

A phone-initiated A2A board ticket (`create_task_for_peer`, via the concierge's Confirm-gated
`assign_task`) lands in state `assigned` and **sits there forever** — no automation picks it
up. Board tickets are only advanced when a human runs `claude` in the assignee's folder
(the `board-notify` SessionStart hook). So the loop the owner wants — *phone creates a task →
the mesh picks it up, works it, resolves it → both dashboards show the status moving* — is
broken at "picks it up." The Task Board view exists and displays the lifecycle, but nothing
drives tickets through it, and the phone PWA doesn't auto-refresh.

## Goal

Close the loop, **agent-driven and team-based**: a phone task is assigned to the
**orchestrator** (the team lead); the orchestrator picks up its tickets, **coordinates a team
of specialist agents** over A2A (ask-mode) — because a real task (especially a code change)
needs several agents, not one — synthesizes their work, and advances its **own** ticket
`assigned → acknowledged → in-progress → done` with the combined result. The **Task Board
auto-refreshes on both phone and desktop** (the ticket lifecycle) and the **desktop graph view
shows the live team A2A edges** (orchestrator → coder/tester/reviewer/…), so the owner watches
both the ticket *and* the team working.

### Decisions (owner-confirmed)

1. **Channel:** the **board-ticket** path (not GitHub issues), so the just-built Task Board is
   the live status surface and the loop stays purely in-mesh.
2. **Driver = team lead:** the **orchestrator agent** *owns* the ticket and **coordinates a
   team** of specialists (not a single hand-off; "often a code change needs multiple agents").
   The daemon only *triggers* the orchestrator on a schedule (a thin data-tool, per the
   agent-driven principle) — it does no coordination logic itself.
3. **How the team works:** **ask-mode** — the specialists investigate / reason / produce
   outputs (read-only, no repo writes); the orchestrator synthesizes and marks the ticket
   `done`. (`do`-mode execution — real code edits via a coder → tester → reviewer → PR
   team — is the deferred next step; it reuses the existing supervised do pipeline.)
4. **Status:** **both phone + desktop auto-refresh** the Task Board; the desktop **graph view**
   (already live, auto-refreshing) surfaces the team's A2A delegation edges.

### Non-goals (YAGNI)

- No `do`-mode autonomous writes for board tickets (ask-only this round).
- No new GitHub-issue behavior (that pipeline already exists and is unchanged).
- No board-transition activity events in v1 — the auto-refreshing Task Board already shows the
  status moving; emitting `board.*` activity events is a deferred enhancement.
- No change to the recursion/identity/path-guard invariants.

## Architecture

```
 Phone /m → concierge Confirm (assign_task, peer = orchestrator)         [existing verb]
        │  create_task_for_peer → board ticket (assigned, from:concierge → to:orchestrator)
        ▼
 <mesh-root>/mesh/board/tasks/*.json
        ▲ (its own tickets)                            ┌────────────────────────────────────┐
 daemon scheduler ── every ~10m ── delegate job ─────▶ │ orchestrator = TEAM LEAD (ask)      │  [thin trigger]
   "board-drive" (kind:delegate, prompt)               │  list_my_tasks → for each open:     │
                                                        │   update_my_task(acknowledged →     │
                                                        │     in-progress)                    │
                                                        │   assemble a TEAM for the task:     │
                                                        │   delegate_to_peer / fanOutToPeers  │──┐ A2A ask
                                                        │     (ask) to the relevant           │  │ (live graph edges)
                                                        │     specialists                     │  ▼
                                                        │   synthesize their outputs          │  analyst · coder ·
                                                        │   update_my_task(done, result)      │  tester · reviewer · …
                                                        └───────────────┬─────────────────────┘  (each ask, read-only)
                                                                        │ ticket file changes
                                                                        ▼
 GET /api/board/tasks → Task Board (desktop #view-tasks + phone /m Tasks tab), AUTO-REFRESHING
 GET /api/activity    → desktop graph view shows the live orchestrator→specialist team edges
```

### 1. The team lead owns the ticket (no new read verb needed)

Phone "work on X" tasks are assigned **to the orchestrator** (`to: orchestrator`), so the
orchestrator advances its **own** tickets — it reads them with the existing **`list_my_tasks`**
(its `agentmesh_peerbridge`), and the board invariant ("only the `to` agent advances") is
satisfied with zero special-casing. No cross-agent board-read verb is required. (Direct
phone→specialist tickets remain the interactive board-notify path, unchanged.)

### 2. Orchestrator wiring — team peers + the board-drive job

- `dev-mesh/mesh.json`: give the orchestrator `peers` = the team it can pull in
  (`analyst, tester, triager, coder, reviewer, curator, security, maintainer`) so `doctor`
  wires its `agentmesh_peerbridge` (enabling `delegate_to_peer` / `fanOutToPeers` + the board
  verbs). It keeps its existing builtins (`gh-activity-poll`, `daily-report-refresh`).
- `dev-mesh/orchestrator/.agent/schedule.json`: add a **delegate** job:
  ```json
  { "id": "board-drive", "name": "board-drive — pick up own tickets + coordinate the team",
    "kind": "delegate", "cadence": { "kind": "every", "minutes": 10 }, "enabled": true,
    "prompt": "You are the team lead. Call list_my_tasks. For EACH ticket not yet 'done': call update_my_task to mark it 'acknowledged' then 'in-progress'. Decide which specialists the task needs (it usually needs MORE THAN ONE — e.g. a code task needs analyst for approach, coder for the change plan, tester for test impact, reviewer for risks). Delegate to each with delegate_to_peer (mode 'ask') giving the ticket brief and the specific sub-question for that specialist; use fanOutToPeers when several can work in parallel. Synthesize their answers into one result, then call update_my_task to mark the ticket 'done' with that synthesis. If list_my_tasks is empty, do nothing." }
  ```
  The scheduler runs this as an ask delegation (`route: scheduled:board-drive`).
- `dev-mesh/orchestrator/AGENT.md`: add a short "team lead" note (data/persona): it owns
  board tickets assigned to it, pulls in the specialist team to work them, synthesizes, and
  advances its own ticket; it never advances another agent's ticket.

### Collaboration model: conductor workflow + parallel fan-out (not a swarm)

The orchestrator runs a **dependency-ordered workflow** as the conductor, with **parallel
fan-out** for independent sub-questions — *not* a decentralized swarm. The mesh has no swarm
runtime (onward delegation is depth-capped at 3 and ask-only), and real tasks have ordering
(you can't review a change before it's planned), so a conductor workflow is both the natural
fit and the safe/observable one. Pattern the orchestrator follows per ticket:

1. **Sequential where dependent:** e.g. analyst (approach) → coder (change plan) — each stage's
   output feeds the next.
2. **Parallel where independent:** once a plan exists, `fanOutToPeers` (ask, scatter-gather) to
   the reviewers in one shot — e.g. tester (test impact) + reviewer (risks) + security — who
   work concurrently.
3. **Synthesize:** the orchestrator merges all outputs into one ticket result and marks `done`.

This gives swarm-like parallelism *inside* a controlled, accountable workflow. All edges are
the orchestrator's own ask delegations (depth 2), visible live in the graph view.

### 3. The team (existing verbs, prompt-driven; specialists stay ask-only)

The orchestrator coordinates the team with its existing `agentmesh_peerbridge` verbs:
`delegate_to_peer` (one specialist) and `fanOutToPeers` (scatter-gather to several in
parallel, ask-only). Each specialist runs a fresh **ask** A2A session (read-only — no repo
writes), answers its sub-question, and returns; the orchestrator gathers + synthesizes and
writes the single ticket result. Recursion depth: orchestrator→specialist = 2 (within the
depth-3 guard); specialists do not delegate onward for this flow. The team's delegations
appear as **live A2A edges** in the desktop graph view (already rendered + auto-refreshed),
so the owner sees the team working, not just the ticket moving.

### 3b. Concierge routes "work" tasks to the team lead

The concierge's `assign_task` already takes a `peer`. Update the concierge persona
([dev-mesh/concierge/AGENT.md]) so that when the owner asks the mesh to *work on / build /
investigate* something, the proposed `assign_task` targets **`orchestrator`** (the team lead),
not a single specialist. `orchestrator` is already in the concierge's peer set. Single-specialist
hand-offs remain possible but are no longer the default for substantive work.

### 4. Desktop auto-refresh — Task Board re-renders on the poll

`board2.js` already runs an SSE + 30s `refresh()` loop. Extend `refresh()` to re-render the
Task Board when it's the active view:
```js
if (document.querySelector('#view-tasks').classList.contains('on')) renderTasksView(document.querySelector('#view-tasks'));
```
So an open Task Board updates as tickets advance — no manual reload.

### 5. Phone auto-refresh — poll the active data tab

`mobile/app.js`: while the PWA is open, poll the active data tab every ~15s (Status / Alerts /
Tasks), pausing when the document is hidden (`document.visibilityState`). A small pure helper
`pickPoll(view)` returns the loader for the active view; the interval calls it. Chat is never
auto-polled. This makes the phone Tasks tab show the ticket advance live.

## Data flow

phone Confirm `assign_task` (peer=orchestrator) → board ticket `assigned` (to:orchestrator) →
(≤10m) orchestrator `board-drive` delegate job → `list_my_tasks` → `update_my_task` ack →
in-progress → **coordinate the team** (delegate_to_peer / fanOutToPeers, ask) → synthesize →
`update_my_task` done(result) → `/api/board/tasks` reflects each write → Task Board
auto-refreshes on phone + desktop (and the graph view shows the live team edges) → owner sees
`assigned → … → done`.

## Error handling

- No open tickets → orchestrator does nothing (prompt says so); job result `done`, no-op.
- A specialist delegation fails/times out → that sub-result is missing; the orchestrator
  synthesizes from what it got (or leaves the ticket `in-progress` to retry next poll —
  idempotent: `list_my_tasks` still returns it). Failure is data (existing).
- `list_my_tasks` board-unreadable → the orchestrator reports nothing to do; next poll retries.
- Auto-refresh fetch error → the view keeps the last render (no crash); phone poll swallows
  errors (best-effort), like the existing `get()`.
- A specialist that is non-served / unknown → `delegate_to_peer` returns an error result; the
  orchestrator notes it in the synthesis and proceeds with the rest.

## Security / invariants

- **Ask-only end to end** — the orchestrator delegates ask; specialists work ask; no repo writes.
- **Board invariant intact** — the orchestrator advances only its **own** ticket (it is the
  `to`); `from`/`to`/`id`/timestamps framework-set; it never advances another agent's ticket.
- **Agent-driven** — the daemon only *schedules* the orchestrator (thin trigger); the reasoning,
  team selection, and delegation are the agent's. Matches the project principle.
- **Bounded** — orchestrator→specialist is depth 2 (within the depth-3 guard); specialists do
  not delegate onward for this flow.
- Dashboard stays `127.0.0.1` + token + tailnet; auto-refresh is client polling of existing
  gated read routes. No new exposure.

## Testing

- **orchestrator wiring** (`test/dev-mesh-agents.test.js` + a focused test): `mesh.json`
  orchestrator `peers` = the team set; `schedule.json` has the `board-drive` delegate job
  (kind `delegate`, cadence `every`); `doctor` generates the orchestrator's `registry.json`
  peers + `agentmesh_peerbridge` `.mcp.json`. Update the existing assertion that pinned
  `orchestrator.peers === []`.
- **concierge routing** (`test/concierge-*`): an `assign_task` proposal for "work/build"
  defaults `peer` to `orchestrator` (persona-driven; assert the dispatcher accepts
  `orchestrator` as an allowlisted peer).
- **phone poll helper** (`test/mobile-pwa.test.js`): `pickPoll(view)` returns the right loader
  per active tab and `null`/no-op for chat; honors a hidden document.
- **Full L0 suite** green; `deadcode-routes-equivalence` unaffected (no new HTTP route — reuses
  `/api/board/tasks`).
- **End-to-end (live, the goal's real proof):** from the phone, create an `assign_task` ticket
  (→ orchestrator) → within a poll cycle the orchestrator acknowledges it, fans out to the
  specialist team (visible as graph edges), synthesizes, and marks it `done` → the Task Board
  (phone + desktop) shows it reach `done` with the synthesized result. (The work itself is
  LLM-agent behavior; verified live, not unit-tested.)

## File-level summary

| Unit | File | New/changed |
| --- | --- | --- |
| Orchestrator peers (team) | `dev-mesh/mesh.json` | changed |
| Board-drive job + team-lead persona | `dev-mesh/orchestrator/.agent/schedule.json`, `dev-mesh/orchestrator/AGENT.md` | changed |
| Concierge routes work → orchestrator | `dev-mesh/concierge/AGENT.md` | changed |
| Desktop auto-refresh (Task Board on poll) | `src/dashboard/public/board2.js` | changed |
| Phone auto-refresh (active data tab) | `src/dashboard/public/mobile/app.js` | changed |
| Tests | `test/dev-mesh-agents.test.js`, `test/concierge-*`, `test/mobile-pwa.test.js` | changed |
| Docs | this spec; CLAUDE.md note | new + changed |
