# Per-Delegation Cost Budget Guard — Design

## 1. Goal

Prevent unbounded token spend in a single delegation session. Cross-hop cost rollup
(PR #328, `subtree_cost_usd` in Task metadata) makes the mesh cost-observable; this
design makes it cost-governable. An operator sets `AGENT_MESH_COST_BUDGET_USD` and
any subsequent `delegate_to_peer` / `fan_out_to_peers` that would exceed it returns a
structured `cost_budget_exceeded` refusal — the same shape as other refusals — instead
of spawning.

## 2. Non-goals

- **No inter-session budget carry-over.** The accumulator is per bridge-process (i.e.
  per `claude -p` invocation); when the session ends, the counter resets. Persistent
  budget quotas (monthly/daily spend limits) are out of scope.
- **No model-facing cost signal.** The worker sees the refusal text; it does not see
  the raw accumulated USD or the configured limit.
- **No billing integration.** The guard uses the `subtree_cost_usd` field that
  `parseResultEnvelope` already captures from the `claude -p` JSON output — not a
  live Anthropic billing API call.
- **No budget for the outer (parent) delegation.** The guard applies only to
  **outgoing** `delegate_to_peer` calls made by a worker; it does not gate the
  parent's call to the worker itself.
- **No change to do-mode semantics.** The guard applies to ask-mode; do-mode
  delegations go through the same check (no special case).

## 3. Mechanism

### 3.1 Config

New env var: `AGENT_MESH_COST_BUDGET_USD` (string, optional; unset → no guard).

Parsed in `src/config.js` alongside the existing numeric env vars:

```js
export function readCostBudget(env = process.env) {
  const raw = env?.AGENT_MESH_COST_BUDGET_USD;
  if (!raw) return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
}
```

`null` means no budget — the existing code path is entirely unchanged.

The env var is added to `RESERVED_BRIDGE_ENV` in `peer-bridge.js` so that
`registry.json`'s `peer.env` cannot override it.

### 3.2 Per-process accumulator in `createBridge`

`createBridge()` is called once per `claude -p` bridge spawn. Add a per-instance
accumulator inside the closure:

```js
export function createBridge({ root, env = process.env, ... } = {}) {
  const costBudget = readCostBudget(env);   // null → disabled
  let accumulatedCostUsd = 0;               // resets at process exit (per-session scope)

  // ... existing listPeers, delegateToPeer, fanOutToPeers ...
}
```

### 3.3 Budget check (pre-flight, before every `delegate_to_peer` call)

Inserted after the existing depth-exhaustion check (before client spawn):

```js
if (costBudget !== null && accumulatedCostUsd >= costBudget) {
  return refuseLogged('cost_budget_exceeded',
    `session cost budget ($${costBudget.toFixed(4)}) reached after ` +
    `$${accumulatedCostUsd.toFixed(4)} of peer spend; delegation refused.`);
}
```

The check uses `>=` so exactly hitting the budget also refuses (safe rather than
permissive). The error code `cost_budget_exceeded` is distinct from all existing
codes (`mode_disabled`, `bad_input`, `readonly_parent`, `lock_timeout`,
`spawn_failed`, `depth_exhausted`).

### 3.4 Accumulation (post-completion)

After `client.send` returns a successful Task result, extract the subtree cost from
the mapped result and add it to the accumulator. This is the same `subtree_cost_usd`
field that is already logged in the run log:

```js
const taskResult = await client.send(peer, message);
const mapped = mapTask(peer, taskResult);
// ... existing logging ...

// Accumulate cost for budget guard (already available in mapped result).
if (typeof mapped.subtree_cost_usd === 'number') {
  accumulatedCostUsd += mapped.subtree_cost_usd;
}
return mapped;
```

Accumulation happens even when the child task's `status` is `timeout` or `error` —
any tokens burned by the child are real costs that count toward the budget.

### 3.5 `fan_out_to_peers` integration

`fanOutToPeers` calls `delegateToPeer` per peer in parallel. The budget check in
`delegateToPeer` runs before each spawn; since the accumulator is shared and updates
happen after each `await client.send` resolves, a concurrent fan-out may issue
slightly over-budget (all concurrent calls pass the pre-flight check before any
accumulation happens). This is acceptable in v1: the over-run is bounded by the
fan-out cap (`AGENT_MESH_FAN_OUT_MAX_PEERS`), and a conservative operator can
account for it by setting the budget lower. A stricter approach (pre-reserve cost
before spawn) requires cost estimation, which is out of scope.

### 3.6 Logging

The `refuseLogged` path used for the budget check already writes a `rejected` record
with `error_code: cost_budget_exceeded` to the run log. No new log fields.

## 4. Invariants upheld

- **Anti-spoof**: the budget comes from env/config (framework-owned), not tool
  arguments. `AGENT_MESH_COST_BUDGET_USD` is added to `RESERVED_BRIDGE_ENV`, so
  `registry.json` `peer.env` cannot override it.
- **Failure is data**: `cost_budget_exceeded` returns the same structured refusal
  shape as every other bridge refusal — `{ status: 'refused', error_code, summary }`.
  Not an exception; the caller's summary explains the missing delegation.
- **Single writable root**: no filesystem writes.
- **No Bash in do**: no spawn involved in the guard itself.

## 5. Tests

New cases in `test/peer-bridge.test.js` (hermetic; injectable `createClient` and
`env`):

| Scenario | Expected |
|---|---|
| no `AGENT_MESH_COST_BUDGET_USD` in env | guard disabled; delegation proceeds unchanged |
| budget = `0.10`, accumulated = 0 | first delegation proceeds |
| budget = `0.10`, accumulated = 0.09, next child costs 0.05 | delegation proceeds (pre-flight sees 0.09 < 0.10); accumulated → 0.14 after |
| budget = `0.10`, accumulated = 0.10 | delegation refused with `cost_budget_exceeded` |
| budget = `0.10`, accumulated = 0.15 (over) | delegation refused |
| `AGENT_MESH_COST_BUDGET_USD` set in `peer.env` | `RESERVED_BRIDGE_ENV` blocks override; parent-env budget still enforced |
| child task returns `status: error` | cost still accumulated; subsequent check may refuse |
| child task returns no `subtree_cost_usd` | accumulator unchanged; delegation not refused |
| `fan_out_to_peers` with 3 peers, budget reached before third | first two proceed, third refused (concurrent over-run is acceptable) |

## 6. Risks

- **Concurrent fan-out over-run**: as noted in §3.5, parallel fan-out may slightly
  exceed budget. Operators should set the budget with headroom (e.g., `budget =
  max_expected * 0.9`) when using fan-out.
- **Cost under-reporting**: `subtree_cost_usd` comes from `parseResultEnvelope`; if
  the child times out before the envelope is written, the field is null and the cost
  is not accumulated. The guard is a best-effort heuristic for timeout paths.
  Acceptable: timeout paths are already structured as failures.
- **Per-session scope**: the bridge process per-`claude -p` scope means a multi-turn
  interactive session does NOT accumulate across turns — each turn spawns a fresh
  bridge. This is consistent with the existing per-session scoping of depth and path,
  and should be documented alongside the env var.
