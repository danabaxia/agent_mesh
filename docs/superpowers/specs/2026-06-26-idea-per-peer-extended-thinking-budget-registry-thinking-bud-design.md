# Per-Peer Extended Thinking Budget — Design

## Goal

Add an optional `thinking_effort` field to each peer entry in `registry.json`. When present, the framework passes `--effort <level>` to the spawned `claude -p` for that peer; when absent, no `--effort` flag is added — behavior is unchanged from today. An architect or coder peer can run with `max` or `xhigh` effort (deep reasoning) while a triage or data-retrieval peer runs at `low` (minimal thinking), reducing mesh-wide token cost without any change to routing logic, tool allowlists, or security invariants.

Valid effort levels are the five strings the `claude --effort` flag accepts: `"low"` · `"medium"` · `"high"` · `"xhigh"` · `"max"`. Setting `"low"` is the explicit suppression form — it maps directly to `--effort low`, which minimises extended thinking; absent means no `--effort` flag at all (binary default).

## Motivation

Every `delegate_task` call today uses the binary's default effort/thinking mode. Extended thinking materially improves quality on hard tasks (debugging, architecture, multi-step reasoning) but costs 2–5× more tokens on routine triage/retrieval peers that do not benefit from it. The per-peer model-tier spec (`2026-06-23`) already established the pattern for static, operator-configured spawn-time flags gated through the registry; `thinking_effort` follows the identical registry-gate + anti-spoof + run-record-capture pattern for the `--effort` flag — a separate but parallel operator lever.

Research basis:

- **Aider v0.83+** (June 2026): introduces `/think-tokens` and `/reasoning-effort` per interaction — operators trade cost for quality per task type. Aider v0.86 reports 88% AI-authored code, attributing gains partly to selective extended thinking on architectural decisions.
- **SWE-bench 2026 harness analysis** (digitalapplied.com): scaffold differences including thinking configuration account for a measured 5.2pp quality variance on identical models; extended thinking lifts scores specifically on complex multi-step tasks.
- **OpenHands SDK** (arXiv:2511.03690v1): introduces per-agent `ConfirmationPolicy` + thinking-level controls, showing that configuring reasoning depth per agent role is now industry standard.

None of these require external dependencies — thinking-depth configuration is a spawn-time `--effort` flag.

## Registry shape

```json
{ "peers": [
    { "name": "coder",      "thinking_effort": "max"   },
    { "name": "architect",  "thinking_effort": "xhigh" },
    { "name": "triage",     "thinking_effort": "low"   },
    { "name": "analyst" }
  ]
}
```

The `thinking_effort` key is optional on each peer; omission is equivalent to `undefined` (use the binary's default effort behavior). `"low"` is the explicit suppression form — it passes `--effort low` to the spawned `claude -p`, which minimises extended thinking; any of the five valid levels (`"low"` · `"medium"` · `"high"` · `"xhigh"` · `"max"`) are passed through verbatim. The registry is the single authoritative source for effort-level selection — the field never appears in tool arguments.

## Implementation touches

- **`src/a2a/registry.js` (`normalizePeer`)** — accept the optional `thinking_effort` field on each normalized peer (default `undefined` when absent). The registry remains the single authoritative source; the field never surfaces in the model-facing tool description.
- **`src/a2a/peer-bridge.js`** — pass `peer.thinking_effort` into `delegateTask`'s options when building the delegation for that peer.
- **`src/delegate.js`** — accept `{ thinkingEffort }` in the options argument and thread it into `buildClaudeInvocation`.
- **`src/delegate-invocation.js` (`buildClaudeInvocation`)** — when `thinkingEffort` is defined, push `['--effort', thinkingEffort]` onto the `claude -p` argv; when absent, no flag is added. Concrete forms: `"low"` → `['--effort', 'low']`; `"max"` → `['--effort', 'max']`; absent → argv unchanged.
- **Validation (pure)** — `(value) → { ok, normalized } | { error }`: must be one of `"low"` · `"medium"` · `"high"` · `"xhigh"` · `"max"`; any other value → `{ error }` (failure-as-data; the test seam for invalid inputs).
- **Run/metrics record (existing)** — already captures per-hop tokens/cost; the per-peer effort level is now reflected in those numbers (pairs with `quality_per_1k_tokens` and subtree-cost rollup).

## Data flow

1. Operator authors `registry.json`, optionally setting `thinking_effort` per peer.
2. `normalizePeer` reads each peer, preserving the field (or leaving it `undefined`).
3. A `delegate_task` to peer P occurs; `peer-bridge.js` looks up P's normalized entry and passes `peer.thinking_effort` into `delegateTask` options.
4. `delegate.js` receives `{ thinkingEffort }` and threads it to `buildClaudeInvocation`.
5. `buildClaudeInvocation` appends `--effort <level>` **iff** `thinkingEffort` is defined; absent → no flag. Suppression form: `thinkingEffort === "low"` → `['--effort', 'low']`.
6. `claude -p` runs with the chosen effort level; per-hop tokens/cost reflect it and flow into the existing run/metrics record.
7. An invalid value (not one of the five strings) → `status: error` (failure-as-data), handled like any spawn failure.

## Testing

Pure-invocation and integration tests (hermetic):

- **Absent field → no flag:** a peer without `thinking_effort` produces argv with **no** `--effort` (byte-identical to today — regression lock).
- **`"max"` → flag threaded:** `thinking_effort: "max"` → argv contains `['--effort', 'max']`.
- **`"xhigh"` → flag threaded:** `thinking_effort: "xhigh"` → argv contains `['--effort', 'xhigh']`.
- **Suppression form — `"low"`:** `thinking_effort: "low"` → argv contains `['--effort', 'low']` (distinct from absent; this is the explicit suppression form).
- **End-to-end threading:** `registry.json` → `normalizePeer` → `peer-bridge` → `delegate` → `buildClaudeInvocation` carries the value unbroken across all four layers.
- **`normalizePeer` preservation:** preserved when present, `undefined` when absent; no other peer fields altered.
- **Invalid value → error:** a value not in the five-string set (e.g. `"ultra"`, `42`, `null`) → `status: error` (failure-as-data), no throw.
- **Anti-spoof:** a delegating model's tool argument attempting to set/raise `thinking_effort` has **no effect** — only the registry value reaches `--effort`.
- **Mixed peers:** coder (`max`), architect (`xhigh`), triage (`low`), analyst (default) each spawn with the correct (or absent) `--effort`.
- **Metrics reflect effort:** a `max`-effort hop records higher token use than a `low`/default hop on a comparable task (sanity check the flag takes effect).
- **Composition with model tier:** a peer carrying both `model` (#457) and `thinking_effort` threads **both** flags correctly and independently.

## Out of scope

- **Automatic / dynamic effort selection** — choosing effort per-task by difficulty is a follow-on; v1 is **static, operator-configured** per peer.
- **Per-task effort override** — the effort level is per-peer in the registry, not selectable per individual `delegate_task` call (mirrors the model-tier deferral).
- **Mapping numeric token budgets to effort tiers** — if a future CLI flag (`--thinking budget_tokens=N`) ships, that is a separate spec; v1 uses the existing `--effort` flag.
- **Cost-budget enforcement** — capping spend from deep thinking is the budget-guard idea's (#350) domain; this only *sets* reasoning depth.
- **Non-Claude reasoning controls** — the mesh spawns `claude -p`; other providers are out of scope.
- **Coupling to model tier** — `thinking_effort` is independent of `--model` (#457); the two compose but neither implies the other.
- **Auto-tuning effort from quality metrics** — using `quality_per_1k_tokens` to recommend/adjust effort levels is a later analytics concern; this provides the lever, not the controller.
- **Changing default thinking behavior** — peers without the field are unchanged; this never alters the global default.
- **Path-guard / anti-spoof / write-boundary changes** — none; the field rides the existing authoritative registry path.
