# Board task dependency sequencing — `dependsOn` gate for framework-enforced task ordering

**Date:** 2026-06-22
**Status:** Design (pending review)
**Builds on:** the mesh task board ([src/board/*](../../../src/board/), spec [2026-06-15-mesh-task-handoff-design.md](2026-06-15-mesh-task-handoff-design.md)).

## Problem

The orchestrator `board-drive` daemon fans out work by creating multiple tasks for peer agents: *analyze* → *implement* → *review* in sequence. Today there is no framework-enforced ordering: the *implement* agent can acknowledge and begin before *analyze* is `done`, producing wasted or incorrect downstream work.

The orchestrator can instruct agents to "wait for task X" in the task brief, but the framework provides no structural guarantee. If the *implement* agent misses the instruction or picks up the task early, it may work on stale or incomplete inputs and ultimately produce work that must be discarded.

## Goal

A **`dependsOn` field** stamped at task-creation time that the framework enforces at the `assigned → acknowledged` transition: the dependent task cannot be acknowledged (and therefore cannot be worked) until every listed dependency is `done`. The gate is purely additive — tasks with no `dependsOn` behave exactly as today.

### Decisions

1. **Stamp once at creation, immutable.** `dependsOn` is set by `create_task_for_peer` and cannot be modified post-creation — same anti-spoof principle as `from`/`to`/`id`. No verb can alter or clear it.
2. **`done`-only resolution.** A dependency is resolved only when its task is in the `done` state. No partial or soft deps in v1.
3. **Gate at `assigned → acknowledged` only.** The gate fires at pickup; once a task is `acknowledged`, later transitions are not re-checked. This is the earliest and most useful enforcement point.
4. **Failure is data, not an exception.** A blocked acknowledge returns a structured refusal (`{ error: 'blocked', blockedBy: [...] }`); the task stays `assigned`. No throw.
5. **Create-time validation.** Unknown dep ids, self-references, and cycle-inducing deps are rejected at creation with a structured error; the task is not created.
6. **`blockedBy` is derived, never stored.** At `list_my_tasks` time the board computes the unresolved-deps subset from live task states; it is not persisted in the task record.

### Non-goals

- General planning DAGs or multi-hop orchestration graphs — this is a single ordering gate, not a planner.
- Mutable dependencies — `dependsOn` is set once at creation; adding/removing deps later is not supported in v1.
- Gating transitions beyond `assigned → acknowledged` — later transitions are not dep-gated.
- Cross-mesh dependencies — deps reference tasks on the same board only.
- Auto-cancellation of permanently-blocked tasks — stale-task detection (#219) surfaces them.

## Implementation

### Data model

The task record ([2026-06-15-mesh-task-handoff-design.md](2026-06-15-mesh-task-handoff-design.md) §4) gains one new framework-stamped field:

```json
{
  "id": "orchestrator-coder-001",
  "from": "orchestrator",
  "to": "coder",
  "dependsOn": ["orchestrator-analyst-001"],
  "state": "assigned",
  "created_at": "2026-06-22T00:00:00.000Z",
  "result": null,
  "seen_by_from": false,
  "history": [
    { "state": "assigned", "at": "2026-06-22T00:00:00.000Z", "by": "orchestrator" }
  ]
}
```

- `dependsOn`: array of task ids (strings); **framework-stamped** from the validated `create_task_for_peer` `dependsOn` arg; defaults to `[]`. **Immutable post-creation** — no verb may update or clear it.
- Tasks with `dependsOn: []` (or the field absent for backward-compat) behave exactly as today.

### Components

- **`create_task_for_peer` validation** — accepts an optional `dependsOn: [taskId, ...]` arg; validates each id (task exists on board, not the task being created, no cycle introduced); **stamps the frozen field** on the task record. Unknown id / self-reference / cycle-inducing dep → structured error returned to caller; task not created.
- **`update_my_task` dep-gate (pure, `task-state.js`)** — at the `assigned → acknowledged` transition; emits a structured refusal when blocked.
- **`blockedBy` computation (pure)** — `(task, resolveState) → [taskId]`; the unresolved-deps subset returned by `list_my_tasks`. Read-only, derived.
- **Task Board view (`tasks-model.js` / dashboard)** — surfaces `blockedBy`/`"waiting on N task(s)"` badge in the `assigned` column.

## Data flow

1. Orchestrator creates the *analyze* task (no deps). Then creates *implement* with `dependsOn: [analyzeId]`, and *review* with `dependsOn: [implementId]`.
2. `create_task_for_peer` validates each `dependsOn` (existence/self-ref/acyclicity) and **stamps the frozen field**.
3. The *implement* agent attempts `update_my_task(assigned → acknowledged)`.
4. Enforcement computes `depsResolved`: *analyze* is not yet `done` → **refused**; *implement* stays `assigned`.
5. `list_my_tasks` for the *implement* agent returns `blockedBy: [analyzeId]`; the Task Board shows *implement* with a "waiting on 1 task" badge.
6. The *analyze* task reaches `done`.
7. The *implement* agent retries acknowledge → `depsResolved` now true → passes the dep gate → passes the identity gate → transitions to `acknowledged`. `blockedBy` is now empty; the badge clears.
8. The same sequence gates *review* on *implement*. A dep that never resolves leaves the dependent in `assigned`, visible on the board and caught by stale-task detection (#219).

## Testing

Pure-predicate and verb-level tests (hermetic, temp board):

- **Backward-compat:** a task with no `dependsOn` acknowledges exactly as today.
- **Blocked acknowledge:** dependent whose single dep is `in-progress` → acknowledge refused, task stays `assigned`.
- **Unblocked acknowledge:** once the dep is `done` → acknowledge succeeds (and then passes the identity gate).
- **Multi-dep:** all deps `done` → resolved; one not `done` → blocked; `blockedBy` lists exactly the unresolved subset.
- **Gate ordering:** a blocked task is reported blocked even when called by the wrong identity (dep check precedes identity check); and a resolved-but-wrong-identity call still fails on identity.
- **Creation validation:** unknown dep id → rejected; self-reference → rejected; cycle-inducing dep → rejected; valid deps → stamped.
- **Immutability / anti-spoof:** no verb can alter `dependsOn` post-creation; an attempt to modify it (or to self-clear deps to escape the gate) has no effect.
- **`blockedBy` derivation:** computed read-only from current dep states; reflects live state without being stored.
- **Failure-is-data:** an unresolvable dep keeps the dependent in `assigned` with no throw; assert it surfaces via the board badge and is eligible for stale-task detection.
- **Identity rule unchanged:** only the `to` agent advances a dependency-resolved task.

## Out of scope

- **General planning DAGs / multi-hop orchestration graphs** — this is a single board-scoped ordering gate, not a full planner; the broader DAG remains deferred.
- **Auto-cancellation / auto-reassignment** of permanently-blocked tasks — lifecycle decisions stay agent-driven (stale-task detection #219 surfaces them).
- **Mutable dependencies** — `dependsOn` is set once at creation; adding/removing deps later is not supported in v1.
- **Cross-mesh dependencies** — deps reference tasks on the same board only.
- **Dependency types beyond "must be `done`"** — no soft/optional deps, no "starts-after" vs "finishes-after" variants; a dep is satisfied only when `done`.
- **New board states** — blocked is *not* a state; it is the `assigned` state with unresolved deps.
- **Gating transitions other than `assigned → acknowledged`** — later transitions are not dep-gated (the gate is at pickup).
- **Failure propagation** — a dependency ending in a non-`done` terminal state (e.g. cancelled) leaving dependents permanently blocked is handled by visibility + stale detection, not by automatic cascade cancellation in v1.
- **Anti-spoof / path-guard / write-boundary changes** — none beyond the immutable framework-stamped field.
