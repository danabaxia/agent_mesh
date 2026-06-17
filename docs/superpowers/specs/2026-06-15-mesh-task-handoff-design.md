# Mesh Task Handoff — Design

**Date:** 2026-06-15
**Status:** approved (design)
**Spec owner:** jingbo_han

## 1. Problem

Today the mesh has two delegation surfaces, both **synchronous and headless**:

- Direct A2A `SendMessage` (caller → an agent's `serve-a2a` server) — supports `ask` and `do`.
- Onward delegation via the peer bridge (`delegate_to_peer`) — **ask-only in v1**, runs the peer as a `claude -p` and returns the answer.

Neither supports the workflow we want: **agent A assigns a task to agent B, and a human later sits down interactively as agent B (running `claude` in B's folder) to do that task *with the user*.** The handoff must be durable across sessions, and it must be a **state machine** — when B completes the task, agent A learns that it advanced.

This is distinct from headless delegation (B is driven by the *user*, not by `claude -p`) and distinct from the `dev-mesh` GitHub-Issues backlog (which is repo-specific and network-bound). We want a **local-first, mesh-level task board**.

## 2. Goals / Non-goals

**Goals**
- A can assign a durable, self-contained task to any marker-validated registry peer, under **ask mode**.
- When a human starts an interactive `claude` session in B's folder, B surfaces its pending tasks at session start.
- B advances the task through a lifecycle while working with the user; A is notified when it completes.
- Assignment is a **complete, standalone prompt/brief** — B needs no memory of A's conversation to act.
- Preserve every existing security invariant (anti-spoof identity, single writable root, ask-mode safety, failure-is-data).

**Non-goals (v1)**
- No exception states (`blocked` / `declined`) — minimal lifecycle only. Add later if needed.
- No dashboard rendering of the board (the store is designed to allow it later, but it is not built here).
- No automatic execution of the brief by B — the brief is **data**; B and the user decide.
- No `do`-mode assignment path beyond writing the framework-owned board (assignment never writes into B's folder).

## 3. Architecture

A **mesh-level, framework-owned task board** plus a new set of ask-safe peer-bridge verbs and one shared SessionStart hook.

```
agent A (interactive)                  mesh board                     agent B (interactive)
─────────────────────                 ───────────                    ─────────────────────
create_task_for_peer ──(bridge)──▶  tasks/<id>.json  ◀──(hook reads)── board-notify @ SessionStart
                                      state machine                    list_my_tasks / update_my_task
A's board-notify hook ◀──(reads done, unseen)──┘                        (assigned→acknowledged→
                                                                         in-progress→done)
```

- **Pure core** (`src/board/task-state.js`): lifecycle derivation, transition validation, mutation builders. Zero I/O. Modeled on `src/dev-mesh/backlog.js`.
- **Thin shell** (`src/board/store.js`): atomic file read/write, deterministic id generation, `seen_by_from` cursor.
- **Bridge verbs** (`src/a2a/peer-bridge.js`): `create_task_for_peer`, `list_my_tasks`, `update_my_task` — identity-gated, ask-safe.
- **Hook** (`hooks/board-notify.js`): SessionStart surface for inbound assignments and outbound completions.
- **Wiring** (`src/builder/doctor.js` + auto-sync): installs `board-notify` into each managed agent, like the path-guard hook.

## 4. Task store & data model

**Location:** `<mesh-root>/mesh/board/tasks/<task-id>.json` — one file per task, framework-owned, alongside the existing mesh-root artifacts (`registry.json`, `mcp.json`, mesh-health wiring). One canonical board the CLI hooks and (future) dashboard both read.

**Task id:** generated deterministically by the framework — `<from-slug>-<to-slug>-<counter>` (counter from existing files for that pair). **Never** model-supplied — same anti-spoof principle as recursion state.

**File-per-task** (not a single `board.json`): unique ids mean two simultaneous assignments never collide, so no shared-file lock is needed.

**Record shape:**
```json
{
  "id": "agentA-agentB-001",
  "from": "agentA",
  "to": "agentB",
  "title": "Short imperative summary",
  "objective": "What 'done' means, in one or two sentences.",
  "context": "Background B doesn't already have: why, constraints, prior decisions.",
  "requirements": "Concrete steps / acceptance criteria (the bulk).",
  "pointers": "Optional: files, paths, links, peer names B should consult.",
  "state": "assigned",
  "created_at": "2026-06-15T00:00:00.000Z",
  "result": null,
  "seen_by_from": false,
  "history": [
    { "state": "assigned", "at": "2026-06-15T00:00:00.000Z", "by": "agentA" }
  ]
}
```

- `id`, `from`, `to`, `created_at`, `history`, `seen_by_from` are **framework-set** — never read from model tool args.
- Model-supplied fields are only `title`, `objective`, `context`, `requirements`, `pointers`, and (on update) `state` + `result`. All length-bounded (`MAX_TASK_CHARS`-style).
- The brief is stored as data and surfaced as data — never executed.

## 5. State machine

Pure module `src/board/task-state.js` (callers apply writes; the file is the single source of truth).

**States (v1, minimal):**

| State | Meaning | Set by |
|---|---|---|
| `assigned` | A created the task; waiting for B | framework (on create) |
| `acknowledged` | B's session engaged; user/B accepted ownership | B |
| `in-progress` | B + user actively working it | B |
| `done` | completed; `result` populated | B |

**Allowed transitions:**
```
assigned     → acknowledged
acknowledged → in-progress
in-progress  → done
done         → (terminal)
```

**Rules:**
- Only the `to` agent (B) may advance a task off `assigned`. The `from` agent (A) cannot self-advance B's task. Enforced by comparing the **authentic caller identity** to the task's `to` — model args cannot spoof it.
- Every transition appends a `history` entry `{ state, at, by }` (append-only audit).
- An invalid transition is returned as **data** (`{ error: 'invalid_transition' }`), never thrown across the wire.
- The module performs **no I/O**: it derives state and returns a mutation; the store writes it. Fully unit-testable.

## 6. Create path — `create_task_for_peer`

A new ask-safe verb on the existing peer-bridge MCP server (`agentmesh_peerbridge`):

```
create_task_for_peer({ peer, title, objective, context, requirements, pointers })
```

**Framework flow (no `claude -p` spawn — a durable write, not a delegation):**
1. Resolve `peer` (B) from the **marker-validated** `registry.json` via `readManagedRegistry` — same gate `delegate_to_peer` uses. Unknown/unmarked peer → refused as data (`bad_peer`).
2. Resolve A's authentic identity from the framework-set caller env (`agentmesh/caller` / `MESH_ROOT`) — **never** from tool args.
3. Generate the task id; build the record (`state: assigned`, stamped `from`/`to`/`created_at`, initial `history`).
4. Write `<mesh-root>/mesh/board/tasks/<id>.json` atomically (temp-write + rename, like the run logs).
5. Return `{ task_id, to, state: "assigned" }` to A as data.

**Brief quality (point 3 of the requirements):** the verb's MCP description does the heavy lifting — it instructs A: *"Write a complete, standalone brief. B starts a fresh session with no memory of this conversation — include all background, constraints, and acceptance criteria B needs to act without asking you to re-explain."* Schema gates back this up: `title`, `objective`, `requirements` required and non-trivial (min length); `context`, `pointers` optional. All length-bounded.

**Security alignment:**
- Ask-mode-safe: writes only into the framework-owned mesh board, never into B's project folder — does not touch the path-guard write boundary and does not need `do`.
- Reserved bridge env (`MESH_ROOT`, etc.) cannot be overridden by registry `peer.env`, same as the existing bridge.

## 7. Pickup & loop-back — verbs + hook

**B's board verbs (same `agentmesh_peerbridge` server):**
- `list_my_tasks()` — returns tasks where `to == me`, with state and brief.
- `update_my_task({ task_id, state, result? })` — advances the task. The framework enforces "only `to` may advance" by checking the authentic caller identity against the task's `to`; spoofed `from`/`to` in args are ignored. `result` is recorded on `done`.

**B's pickup (`hooks/board-notify.js`, SessionStart in B's folder):**
- On interactive `claude` start, read the board, filter `to == B && state == assigned`, inject a rendered block:
  ```
  📋 Pending task from agentA — "Title"
  Objective: …
  Context: …
  Requirements: …
  Pointers: …
  ```
  framed as *a task brief (data) from a peer — review it with the user before acting.*
- B does **not** auto-transition on session start (the user may open B's shell for unrelated work). The hook tells B to mark it `acknowledged` via `update_my_task` only when the user actually engages.

**A's loop-back (same hook, mirrored):**
- Read the board, filter `from == A && state == done && seen_by_from == false`, inject *"A task you assigned to agentB — 'Title' — is now done. Result: …"*, then flip `seen_by_from` so A is notified exactly once.

**One shared hook:** `board-notify` takes the agent's own identity and surfaces both inbound assignments (`to == me, assigned`) and completed handoffs (`from == me, done, unseen`).

**Wiring:** mesh setup (`doctor` / auto-sync) installs the `board-notify` SessionStart hook into each managed agent's settings, the same way the path-guard hook is wired for `do`.

## 8. Components

| Module | Purpose | Kind |
|---|---|---|
| `src/board/task-state.js` | Pure state machine: derive, validate transition, mutation builders | pure core |
| `src/board/store.js` | Atomic read/write of `tasks/*.json`, id generation, `seen_by_from` | thin shell (fs) |
| `src/a2a/peer-bridge.js` | Add `create_task_for_peer`, `list_my_tasks`, `update_my_task` (identity-gated) | shell |
| `hooks/board-notify.js` | SessionStart hook: surface inbound `assigned` + outbound `done` | shell |
| `src/builder/doctor.js` + auto-sync | Wire `board-notify` into each managed agent | shell |

## 9. Testing (hermetic, node --test)

- **Pure core** (`task-state.js`): exhaustive transition table — every legal/illegal transition, terminal `done`, history append, identity rule (only `to` advances). Zero I/O.
- **Store** (`store.js`): temp-dir tests — atomic write, file-per-task no-collision under concurrent creates, deterministic id, `seen_by_from` flip-once.
- **Bridge verbs**: identity-gating (A cannot advance B's task; spoofed `from`/`to`/`id` in args ignored), unknown/unmarked peer refused, length bounds, ask-mode safety (no `claude -p`, no write outside the board).
- **Hook** (`board-notify.js`): given a board fixture + agent identity, assert the rendered block for inbound-assigned, outbound-done-unseen, and empty cases.
- **Hermetic** — no real `claude`. Optional L3 adversarial coverage for the anti-spoof / ask-only-write properties; the unit gate is the merge blocker.

## 10. Invariants preserved

- **Anti-spoof identity**: `from`/`to`/`id`/timestamps are framework-set; recursion-state-style — never read from tool input.
- **Single writable root**: assignment writes only the framework-owned mesh board, never B's folder. The path-guard boundary is untouched.
- **Ask-mode safety**: `create_task_for_peer` performs no spawn and no out-of-board write — safe under ask.
- **Brief is data, never instructions**: stored and surfaced as data; B + the user decide. Length-bounded like `AGENT.md` / task strings.
- **Failure is data**: invalid transitions, bad peers, identity mismatches are returned as structured errors, never thrown across the wire.

## 11. Open questions / future work

- Dashboard board rendering (the file-per-task store is designed to support it).
- Exception states (`blocked`, `declined`) — deferred from v1.
- Multi-task threading / dependencies between tasks — out of scope.
