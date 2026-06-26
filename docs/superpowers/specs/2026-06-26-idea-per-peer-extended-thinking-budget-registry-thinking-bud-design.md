`, emit the suppression form; when absent, no flag.
- **Validation (pure)** — `(value) → { ok, normalized } | { error }`: numeric, non-negative; the test seam for failure-as-data.
- **Run/metrics record (existing)** — already captures per-hop tokens/cost; the per-peer thinking budget is now reflected in those numbers (pairs with `quality_per_1k_tokens` and subtree-cost rollup).

## Data flow

1. Operator authors `registry.json`, optionally setting `thinking_budget_tokens` per peer.
2. `normalizePeer` reads each peer, preserving the field (or leaving it `undefined`).
3. A `delegate_task` to peer P occurs; `peer-bridge.js` looks up P's normalized entry and passes `peer.thinking_budget_tokens` into `delegateTask` options.
4. `delegate.js` receives `{ thinkingBudgetTokens }` and threads it to `buildClaudeInvocation`.
5. `buildClaudeInvocation` appends `--thinking budget_tokens=N` **iff** defined and `> 0`; `0` → suppression form; absent → no flag.
6. `claude -p` runs with the chosen reasoning depth; per-hop tokens/cost reflect it and flow into the existing run/metrics record.
7. An invalid value → `status: error` (failure-as-data), handled like any spawn failure.

## Testing

Pure-invocation and integration tests (hermetic):

- **Absent field → no flag:** a peer without `thinking_budget_tokens` produces argv with **no** `--thinking` (byte-identical to today — regression lock).
- **Positive value → flag threaded:** `thinking_budget_tokens: 10000` → argv contains `--thinking budget_tokens=10000`.
- **Zero → suppression:** `thinking_budget_tokens: 0` emits the no-extended-thinking form (distinct from the absent case), per the chosen suppression semantics.
- **End-to-end threading:** `registry.json` → `normalizePeer` → `peer-bridge` → `delegate` → `buildClaudeInvocation` carries the value unbroken across all four layers.
- **`normalizePeer` preservation:** preserved when present, `undefined` when absent; no other peer fields altered.
- **Invalid value → error:** negative/non-numeric → `status: error` (failure-as-data), no throw.
- **Anti-spoof:** a delegating model's tool argument attempting to set/raise `thinking_budget_tokens` has **no effect** — only the registry value reaches `--thinking`.
- **Mixed peers:** coder (10000), architect (16000), triage (0), analyst (default) each spawn with the correct (or absent) `--thinking`.
- **Metrics reflect budget:** a high-budget hop records higher token use than a suppressed/default hop on a comparable task (sanity check the flag takes effect).
- **Composition with model tier:** a peer carrying both `model` (#457) and `thinking_budget_tokens` threads **both** flags correctly and independently.

## Out of scope

- **Automatic / dynamic thinking-budget selection** — choosing budget per-task by difficulty is a follow-on; v1 is **static, operator-configured** per peer.
- **Per-task thinking override** — the budget is per-peer in the registry, not selectable per individual `delegate_task` call (mirrors the model-tier deferral).
- **Validating against a hardcoded max budget** — operator-supplied value is passed through; correctness is the operator's responsibility, with bad values degrading to `status: error`.
- **Cost-budget enforcement** — capping spend from deep thinking is the budget-guard idea's (#350) domain; this only *sets* reasoning depth.
- **Non-Claude reasoning controls** — the mesh spawns `claude -p`; other providers are out of scope.
- **Coupling to model tier** — `thinking_budget_tokens` is independent of `--model` (#457); the two compose but neither implies the other.
- **Auto-tuning budgets from quality metrics** — using `quality_per_1k_tokens` to recommend/adjust budgets is a later analytics concern; this provides the lever, not the controller.
- **Changing default thinking behavior** — peers without the field are unchanged; this never alters the global default.
- **Path-guard / anti-spoof / write-boundary changes** — none; the field rides the existing authoritative registry path.
