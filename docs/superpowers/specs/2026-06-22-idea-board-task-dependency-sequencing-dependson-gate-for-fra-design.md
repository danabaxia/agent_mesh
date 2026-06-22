knowledged` transition; emits a structured refusal when blocked.
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
