e)** — defines the two-agent mesh, the two-turn create→advance flow, and the probes.
- **`h.buildMesh` (reused)** — constructs the A (orchestrator) + B (specialist) mesh with peerbridge injection.
- **`h.probe` (reused)** — inspects scenario state/outputs for assertions.
- **`probes.mjs` gates (reused)** — `noUnexpectedDelegation`, `refusedWith`, plus store-state assertions.
- **Real framework modules under test (not mocked):** `board/store.js` (persistence), `board/task-state.js` (single-step lifecycle), `board/identity.js` (assignee resolution), `peer-bridge.js` `create_task_for_peer` (task creation).
- **Eval runner (existing)** — picks up scenario `13` alongside `01–12` in the L2 tier.

## Data flow

1. The eval runner builds the mesh (A orchestrator, B specialist) with peerbridge injection.
2. **Turn 1:** A calls `create_task_for_peer` → `peer-bridge.js` → `board/store.js` writes a task assigned to B (`identity.js` resolves the assignee).
3. **Probe:** the scenario reads the real store and asserts the task exists, assigned to B, state `assigned`.
4. **Turn 2:** B calls `list_my_tasks` (sees the task), then `update_my_task` → `task-state.js` advances `assigned → acknowledged` (single step), persisted via `board/store.js`.
5. **Probe:** assert the stored state is now `acknowledged` (or beyond), that B was the one who advanced it (identity), and `noUnexpectedDelegation` holds.
6. The runner reports scenario 13 pass/fail in the L2 results, now covering the board-pipeline integration surface.

## Testing

This idea *is* a test artifact, so "testing" here means validating the scenario itself behaves as an effective, deterministic regression guard:

- **Green on healthy pipeline:** against the current correct board pipeline, scenario 13 passes (task created, advanced one step, B ran).
- **Catches handoff breakage:** a simulated break in `create_task_for_peer` (task not persisted) → scenario 13 fails (task-exists probe).
- **Catches identity regression:** a break in `board/identity.js` (B can't see/own the task) → `list_my_tasks` probe fails.
- **Catches state-machine regression:** a break in `task-state.js` (advancement skips/blocks) → state-advanced probe fails.
- **Single-step respected:** an attempt to advance more than one step is rejected (consistent with `task-state.js`), and the scenario does not falsely pass on it.
- **Determinism:** repeated runs of scenario 13 yield identical results with no daemon dependency (no flakiness from scheduling).
- **Real-store usage:** the scenario reads/writes the file-based store (a mock substitution would be a defect) — verified by the task persisting across turns.
- **Negative path (optional):** a wrong-identity `update_my_task` is `refusedWith` the expected refusal.

## Out of scope

- **Exercising live daemon scheduling** (`board-drive` pickup timing) — the scenario deliberately drives advancement explicitly for determinism; testing the scheduler itself is a separate concern.
- **The conductor workflow + `fanOutToPeers` specialist fan-out** — scenario 13 covers the create→advance **data path**; the orchestrator's internal fan-out reasoning is not asserted here (could be a later scenario).
- **Notification of the completing agent** (step 5) — out of scope for this data-path scenario unless trivially observable via the store.
- **Production code changes** — none; this adds a scenario file only.
- **Mocking the board store** — explicitly disallowed; the scenario must use the real file-based store.
- **Full `assigned → done` multi-step drive** — advancing to `acknowledged` (or beyond) is sufficient to prove the path; exhaustively walking every transition to `done` is optional and not required for the regression guard.
- **Changes to `probes.mjs` or harness primitives** — reuses existing gates; new probe helpers are not in scope (use standard probes).
- **Other untested pipelines** — this targets the orchestrator-board pipeline specifically; coverage gaps in other flows are separate ideas.
