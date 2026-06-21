atively when spawning a child.
- **Budget-check predicate (pure)** — `(accumulatedCost, budget, estimatedFloor?) → { allowed: bool, refusal? }`. Pure and table-testable; isolates the comparison logic from the bridge's I/O.
- **Refusal result shape** — reuses the existing structured refusal contract (`{ status: 'refused', reason, ... }`), with `reason: 'cost_budget_exceeded'`.

## Data flow

1. Operator sets `AGENT_MESH_COST_BUDGET_USD` (or `maxCostUsd`). Unset → guard off, classic pass-through.
2. A delegation chain runs; each hop threads its accumulated `subtree_cost_usd` forward through env as it spawns downstream peers.
3. At hop H, the model invokes `delegate_to_peer`. The bridge reads the **env-threaded** accumulated cost (authoritative; not from tool args).
4. Budget-check predicate compares accumulated cost to the configured budget (and optional floor).
   - **Under budget** → proceed: `createA2AClient.send` spawns the downstream peer as normal.
   - **At/over budget** → **refuse**: return `{ status: 'refused', reason: 'cost_budget_exceeded', ... }`, set `task.metadata.agentmesh/budget_exceeded`, write to the run log. No `SendMessage` is sent — the spend is prevented, not merely recorded.
5. The caller's model receives the structured refusal and incorporates it into its summary (with the budget-exceeded metadata explaining the gap).

## Testing

Pure-predicate and bridge-level tests (no live mesh):

- **No budget configured:** `AGENT_MESH_COST_BUDGET_USD` unset → pass-through; behavior identical to today (regression guard).
- **Budget set, under limit:** accumulated cost below budget → pass-through; `send` is invoked.
- **Budget set, at limit:** `accumulated_cost == budget` → refused (`cost_budget_exceeded`); assert `send` is **not** called.
- **Budget set, over limit:** accumulated cost exceeds budget → refused.
- **Floor reservation (if implemented):** `budget - accumulated < estimated_floor` → refused even though `accumulated < budget`.
- **Refusal shape:** the returned object matches the standard refusal contract with `reason: 'cost_budget_exceeded'`; **no exception is thrown** (failure-is-data).
- **Metadata + logging:** on refusal, `task.metadata.agentmesh/budget_exceeded` is set and a run-log entry is written.
- **Anti-spoof — env not overridable:** a registry peer's `peer.env` attempting to set/lower the accumulated-cost or budget env is ignored; the parent bridge's authoritative value wins (assert a malicious `peer.env` cannot raise the budget or zero the accumulator).
- **Anti-spoof — tool args inert:** a `delegate_to_peer` tool argument purporting to set/raise the budget has no effect.
- **Threading correctness:** across a 3-hop mock chain, the accumulated cost seen at each hop equals the sum of upstream hops' `subtree_cost_usd`.

## Out of scope

- **Do-mode budget enforcement** — v1 is ask-mode only, matching the bridge's current scope.
- **Cost *prediction* / pre-estimation of a downstream hop's spend** — v1 gates on **already-accumulated** cost (and an optional static floor). Estimating an individual hop's future cost before spawning is a follow-on; without it, a single hop can overshoot the budget on its own turn.
- **Per-skill / per-peer differentiated budgets** — v1 is a single per-mesh/per-agent ceiling; finer-grained budgets are later.
- **Mid-hop interruption / cancellation** — the guard prevents *spawning* the next hop; it does not abort an in-flight hop that is already running.
- **Budget enforcement on stdio-only local chains where cost is not threaded** — applies wherever the cost context is threaded; environments not emitting `subtree_cost_usd` simply see a zero/absent accumulator (guard effectively inert).
- **A2A wire-protocol or external API changes** — none; this is internal bridge + config + context only.
- **Dynamic/auto-tuned budgets** (e.g. adapting the ceiling from historical spend) — static operator config only in v1.
- **Single-writable-root / write-boundary changes** — none touched.
