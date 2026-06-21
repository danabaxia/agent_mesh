# Cross-Hop Delegation Cost Rollup — Design

## Goal

`delegate-cost-capture` (spec `2026-06-13-delegate-cost-capture-design.md`) captures
per-hop cost into both the run record and the A2A `agentmesh/metrics` block:
`total_cost_usd`, `tokens`, `num_turns`, and `api_ms` for every `delegate_task` spawn.

In a multi-hop chain **A → B → C**, however, A's Task reflects only B's own spawn cost
— C's cost, which B incurred via `delegate_to_peer`, is invisible to A. The L4 perf
benchmark must correlate across N run-log directories to compute total chain cost;
a caller cannot enforce a budget without seeing the full subtree cost.

This spec adds **`subtree_cost_usd`** to `agentmesh/metrics`: the hop's own cost plus
the Σ `subtree_cost_usd` of all downstream peer Tasks. The accumulation point is
`peer-bridge.js`, which already receives each downstream Task. The result is one field
on the top-level Task representing full chain cost — no cross-log correlation required.

## Background

### Why now

The L4 perf benchmark (`eval-perf.mjs`) is live and already tries to Σ hop costs from
run logs — requiring reads across N agent root directories. Subtree rollup makes that
sum accurate and free: one field on the root Task.

MIR cost-analysis can then flag expensive delegation *chains*, not just expensive
individual hops. Multi-peer fan-out (#185) will make deep chains more common,
increasing the value of accurate subtree cost.

Research context: MetaGPT AFlow (ICLR 2025 oral, top 1.8%) and ChatDev Puppeteer
(NeurIPS 2025) both show 30–50% cost reduction from topology optimization — achievable
only when the orchestrator has accurate whole-chain cost signal.

### Backward compatibility

`peer-bridge.js` reads `subtree_cost_usd` from each downstream Task and falls back to
`total_cost_usd` when the field is absent (older peers that have not yet emitted it).
This produces a best-effort sum — a conservative undercount proportional to legacy
sub-chains, which disappears as peers upgrade.

## Components

- **`src/a2a/peer-bridge.js`** — the accumulation point. On receiving each downstream peer Task during a hop's execution, read `agentmesh/metrics.subtree_cost_usd` (fallback `total_cost_usd`), accumulate, and set `subtree_cost_usd` on the parent Task before `delegateTask` builds it. This is the only place the rollup arithmetic lives. Apply the same `numberOrZero` guard used by `normalizeMetrics` to each accumulated value — a misbehaving peer returning a negative or non-finite `subtree_cost_usd` must not undercount the parent's rollup.
- **`src/a2a/protocol.js` `normalizeMetrics`** — whitelist `subtree_cost_usd` so it is preserved through metrics normalization and not stripped at the protocol boundary.
- **`scripts/eval-perf.mjs`** — change the `cost_usd` derivation to read the top-level Task's `subtree_cost_usd` directly; drop (or keep as a fallback for legacy logs) the multi-directory summation.
- **Metrics shape (`agentmesh/metrics`)** — gains an optional `subtree_cost_usd` alongside the existing `total_cost_usd` / `tokens` / `num_turns`. No existing field changes meaning.

## Data flow

1. **Leaf hop C** executes, emits `agentmesh/metrics` with `total_cost_usd = c`. Because C delegated to no one, the bridge sets `subtree_cost_usd = c`.
2. **Hop B** delegated to C via `delegate_to_peer`. B's bridge receives C's Task, reads `subtree_cost_usd = c` (or falls back to C's `total_cost_usd`). B's own hop cost is `b`. Before building B's result Task, the bridge sets B's `subtree_cost_usd = b + c`.
3. **Hop A** delegated to B. A's bridge receives B's Task, reads `subtree_cost_usd = b + c`. A's own hop cost is `a`. A's Task gets `subtree_cost_usd = a + b + c`.
4. **`normalizeMetrics`** preserves `subtree_cost_usd` at each serialization boundary.
5. **`eval-perf.mjs`** reads the root (A) Task's `subtree_cost_usd = a + b + c` as the chain cost — one field, no cross-log correlation.
6. **MIR / any caller** can now read whole-chain cost from the top-level Task to detect expensive delegation *chains*, not just expensive *hops*.

## Testing

- **3-hop chain correctness (primary):** mock A → B → C with known hop costs `a`, `b`, `c`. Assert the root Task's `subtree_cost_usd == a + b + c`, B's `== b + c`, C's `== c`.
- **Single hop:** a hop with no downstream delegation → `subtree_cost_usd == total_cost_usd`.
- **Fan-out (multi-child):** a hop B delegating to two peers C and D → B's `subtree_cost_usd == b + subtree(C) + subtree(D)` (forward-compatibility with #185; this test case may need to be marked pending until #185 merges).
- **Legacy-peer fallback:** a downstream Task carrying only `total_cost_usd` (no `subtree_cost_usd`) → parent correctly falls back and sums without throwing.
- **Mixed-version chain:** newer A → older B (emits only `total_cost_usd`) → newer C → assert the documented degradation (B's sub-chain treated per fallback), no crash, no over-count.
- **`normalizeMetrics` preservation:** a metrics block with `subtree_cost_usd` survives normalize/serialize round-trip; an unknown sibling key is still stripped (whitelist integrity).
- **Missing/zero cost:** a hop with absent or `0` `total_cost_usd` contributes 0, not `NaN`/`undefined`.
- **Negative/non-finite guard:** a peer returning a negative or non-finite `subtree_cost_usd` is clamped to 0 by `numberOrZero`, never propagated upward.
- **`eval-perf.mjs` integration:** given a top-level Task with `subtree_cost_usd`, the `cost_usd` cell equals that value and does **not** depend on reading N run-log directories.

## Out of scope

- **Budget enforcement (v3-ish follow-on).** Refusing or aborting a delegation when projected subtree cost would exceed a budget is explicitly deferred; v1 is observability only.
- **Per-hop budget thresholds / alerts** beyond exposing the field.
- **Retroactive backfill** of `subtree_cost_usd` into historical run logs — the field exists going forward only.
- **Token / `num_turns` subtree rollups.** This spec rolls up cost only; subtree token and turn aggregation can mirror this design later but are not included.
- **Changing per-hop `total_cost_usd` capture** — the existing delegate-cost-capture mechanism is untouched.
- **Workflow/topology optimization itself** (the AFlow/Puppeteer-style search). This provides the accurate signal such optimization would require; it does not implement the optimizer.
