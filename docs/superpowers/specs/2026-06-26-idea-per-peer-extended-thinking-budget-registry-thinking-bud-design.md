# Per-Peer Extended Thinking Budget — Design

## Goal

Add an optional `thinking_budget_tokens` field to each peer entry in `registry.json`. When present and `> 0`, the framework passes `--thinking budget_tokens=N` to the spawned `claude -p` for that peer; when `0`, the suppression form is emitted (extended thinking explicitly disabled); when absent, no flag is added — behavior is unchanged from today. An architect or coder peer can run with deep reasoning while a triage or data-retrieval peer stays at the default, reducing mesh-wide token cost without any change to routing logic, tool allowlists, or security invariants.

## Motivation

Every `delegate_task` call today uses the binary's default thinking mode. Extended thinking materially improves quality on hard tasks (debugging, architecture, multi-step reasoning) but costs 2–5× more tokens on routine triage/retrieval peers that do not benefit from it. The per-peer model-tier spec (`2026-06-23`) already established the pattern for static, operator-configured spawn-time flags gated through the registry; `thinking_budget_tokens` follows the identical registry-gate + anti-spoof + run-record-capture pattern for a separate but parallel flag (`--thinking`).

Research basis:

- **Aider v0.83+** (June 2026): introduces `/think-tokens` and `/reasoning-effort` per interaction — operators trade cost for quality per task type. Aider v0.86 reports 88% AI-authored code, attributing gains partly to selective extended thinking on architectural decisions.
- **SWE-bench 2026 harness analysis** (digitalapplied.com): scaffold differences including thinking configuration account for a measured 5.2pp quality variance on identical models; extended thinking lifts scores specifically on complex multi-step tasks.
- **OpenHands SDK** (arXiv:2511.03690v1): introduces per-agent `ConfirmationPolicy` + thinking-level controls, showing that configuring reasoning depth per agent role is now industry standard.

None of these require external dependencies — thinking-depth configuration is a spawn-time `--thinking` flag.

## Registry shape

```json
{ "peers": [
    { "name": "coder",      "thinking_budget_tokens": 10000 },
    { "name": "architect",  "thinking_budget_tokens": 16000 },
    { "name": "triage",     "thinking_budget_tokens": 0 },
    { "name": "analyst" }
  ]
}
```

The `thinking_budget_tokens` key is optional on each peer; omission is equivalent to `undefined` (use the binary's default thinking behavior). `0` is a distinct, valid value meaning "explicitly suppress extended thinking." The registry is the single authoritative source for thinking-budget selection — the field never appears in tool arguments.

## Implementation touches

- **`src/a2a/registry.js` (`normalizePeer`)** — accept the optional `thinking_budget_tokens` field on each normalized peer (default `undefined` when absent). The registry remains the single authoritative source; the field never surfaces in the model-facing tool description.
- **`src/a2a/peer-bridge.js`** — pass `peer.thinking_budget_tokens` into `delegateTask`'s options when building the delegation for that peer.
- **`src/delegate.js`** — accept `{ thinkingBudgetTokens }` in the options argument and thread it into `buildClaudeInvocation`.
- **`src/delegate-invocation.js` (`buildClaudeInvocation`)** — when `thinkingBudgetTokens` is defined and `> 0`, push `['--thinking', 'budget_tokens=N']` onto the `claude -p` argv; when `0`, emit the suppression form; when absent, no flag.
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
