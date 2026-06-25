s `confidence`/`ambiguities` to escalate low-confidence plans to a human rather than auto-executing.
- **Config** — optional auto-proceed policy thresholds (e.g. auto-execute only on `confidence: high` + risk below a bar); a disable flag.

## Data flow

1. A caller (orchestrator/concierge) invokes `plan_peer_task({ peer, task })`.
2. The bridge validates the peer (existing registry gate) and **force-spawns ask mode** with the `<planning-pass>` suffix appended; the `task` is passed as data.
3. The worker inspects the codebase (read-only — ask mode prohibits writes) and returns a JSON plan.
4. The plan parser extracts/validates it into `PlanResult` (malformed → structured error, not a crash).
5. The plan is surfaced on the task board / concierge for approval, including `files_to_change`, `risks`, `ambiguities`, `confidence`, and the planning-pass `usage`.
6. **Routing:** `confidence: low` / non-empty `ambiguities` → escalate to human; otherwise present for confirm (or auto-proceed if policy permits).
7. **Decision:**
   - **Approve** → `delegate_to_peer` in do-mode with the same task (then post-do validation #509 / branch isolation #458 apply as usual).
   - **Reject** → close the task; **no writes** occurred at any point.

## Testing

Pure-parser and bridge-level tests (hermetic):

- **Ask-mode enforcement:** `plan_peer_task` always spawns ask mode; a caller attempt to request do-mode is ignored/refused — assert no write capability during planning.
- **Plan schema:** a well-formed worker response parses into a complete `PlanResult` with all plan fields populated.
- **Malformed output:** a worker returning prose / partial / non-JSON → structured `status: error` (or `confidence: low` with raw preserved), **no throw** (failure-as-data).
- **Confidence routing:** `confidence: "low"` (or non-empty `ambiguities`) → routing hook flags for human escalation, not auto-execute.
- **Approve → do-mode:** an approved plan triggers `delegate_to_peer` in do-mode with the original task.
- **Reject → no writes:** a rejected plan closes the task and performs zero writes (assert no do-mode spawn).
- **Suffix provenance:** the `<planning-pass>` suffix is framework-injected; the caller's `task` is treated as data and cannot suppress/alter the plan-only instruction (anti-spoof).
- **Cost shape:** the planning-pass `usage` is captured and is materially cheaper than an equivalent do-mode run (sanity check the value proposition).
- **Composition:** after approval, post-do validation (#509) and branch isolation (#458) still apply unchanged.
- **Registry gate:** an unknown/unregistered peer is rejected before any spawn.

## Out of scope

- **Executing the plan / performing writes** — `plan_peer_task` never writes; do-mode execution remains the separate `delegate_to_peer` step after approval.
- **Guaranteeing the plan matches the eventual do-mode output** — the plan is an advisory pre-execution estimate, not a binding contract; verifying actual output against the plan is post-do validation's (#509) domain, not this verb's.
- **Auto-approval as the default** — v1 surfaces plans for human/caller approval; any auto-proceed is an explicit, conservative, config-gated policy (high confidence + low risk only).
- **Multi-round plan negotiation** — a single planning pass per call; iterative clarify-replan loops are a later enhancement.
- **Do-mode fan-out planning** — plans a single peer/task; planning across a multi-peer fan-out is out of scope.
- **Replacing post-do validation or branch isolation** — this is an additive *pre*-do layer; the other two are unchanged and complementary.
- **A bespoke plan-visualization UI** — reuses the existing task-board/concierge surfaces to render the plan; a dedicated viewer is out of scope.
- **Wire-protocol changes** — a new bridge verb only; A2A Task shapes and model-facing surfaces are unchanged.
- **Path-guard / anti-spoof / write-boundary changes** — none; relies on the existing ask-mode write prohibition and registry gate.
