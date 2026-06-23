he optional `model` field on each normalized peer (default `undefined` when absent). The registry remains the single authoritative source.
- **`src/a2a/peer-bridge.js`** — pass `peer.model` into `delegateTask`'s options when building the delegation for that peer.
- **`src/delegate.js`** — accept `{ model }` in the 5th options argument and thread it into `buildClaudeInvocation`.
- **`src/delegate-invocation.js` (`buildClaudeInvocation`)** — when `model` is present, push `['--model', model]` onto the `claude -p` argv; when absent, emit no `--model` flag (default behavior).
- **Run/metrics record (existing)** — already captures cost/tokens per hop; with tiering, the per-peer model choice is now reflected in those numbers (and pairs with `quality_per_1k_tokens` in #405 and subtree-cost rollup #315).

## Data flow

1. Operator authors `registry.json`, optionally adding `model` to selected peers.
2. `normalizePeer` reads each peer, preserving `model` (or leaving it undefined).
3. A `delegate_task` to peer P occurs; `peer-bridge.js` looks up P's normalized entry and passes `peer.model` into `delegateTask` options.
4. `delegate.js` receives `{ model }` and threads it to `buildClaudeInvocation`.
5. `buildClaudeInvocation` appends `['--model', model]` to the `claude -p` argv **iff** `model` is set; otherwise argv is unchanged.
6. `claude -p` runs on the chosen tier; cost/tokens for that hop reflect the tier and flow into the existing run/metrics record.
7. A bad model ID → spawn fails → `status: error` result, handled as any spawn failure.

## Testing

Pure-invocation and integration tests (hermetic):

- **No `model` field → no flag:** a peer without `model` produces a `claude -p` argv with **no** `--model` (byte-identical to today's invocation — regression lock).
- **`model` field → flag threaded:** a peer with `model: "claude-haiku-4-5-20251001"` produces argv containing `--model claude-haiku-4-5-20251001`.
- **End-to-end threading:** `registry.json` `model` → `normalizePeer` → `peer-bridge` → `delegate` → `buildClaudeInvocation` carries the value unbroken across all four layers.
- **`normalizePeer` preservation:** the field is preserved when present, `undefined` when absent; no other peer fields altered.
- **Bad model ID → error result:** a spawn with an invalid `--model` yields `status: error` (failure-as-data), no exception.
- **Anti-spoof:** a delegating model's tool argument attempting to set/override `model` has **no effect** — only the registry value reaches `--model`.
- **Multiple peers, mixed tiers:** analyst (Haiku), orchestrator (Opus), tester (default) each spawn with the correct (or absent) `--model`.
- **Metrics reflect tier:** a Haiku-tier hop records lower token cost than an equivalent default/Opus hop (sanity check that the flag takes effect).

## Out of scope

- **Automatic / dynamic tier selection** — choosing a peer's model per-task by difficulty (BAMAS/AgentDropout-style routing) is a follow-on; v1 is **static, operator-configured** per peer.
- **Per-task model override** — the tier is per-peer in the registry, not selectable per individual `delegate_task` call.
- **Model-ID validation / allowlist** — the framework passes the operator string through; correctness is the operator's responsibility, with bad IDs degrading to `status: error`.
- **Cost-budget enforcement** — limiting spend based on tier/subtree cost is covered by the budget-guard idea (#350); this only *selects* the tier.
- **Non-Claude models / cross-provider tiering** — the mesh spawns `claude -p`; other providers are out of scope.
- **Per-role prompt or capability changes** — only the model flag changes; a peer's instructions/tools are unchanged.
- **Auto-tuning tiers from `quality_per_1k_tokens`** — using the efficiency metric to *recommend* or *adjust* tiers is a later analytics concern; this provides the lever, not the controller.
- **Anti-spoof / path-guard / write-boundary changes** — none; `model` rides the existing authoritative registry path.
