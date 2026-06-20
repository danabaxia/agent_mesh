# Multi-Peer Fan-Out / Scatter-Gather — Design

## 1. Goal

Extend the peer bridge with a **concurrent fan-out primitive**: one call to `fan_out_to_peers` dispatches a single `ask` to *N* peers simultaneously and returns their answers as a structured array. The orchestrating LLM then synthesizes the results itself — consensus, adversarial reconciliation, best-of-N, etc.

This is the v2 unlock: onward delegation as scatter-gather, not serialized sequential calls. With single-peer `delegate_to_peer` (v1), a model that wants three opinions must call the tool three times in sequence, blocking on each round-trip before issuing the next. `fan_out_to_peers` removes that serialization and surfaces partial failure cleanly.

## 2. Motivation

The existing onward-delegation spec (`2026-06-06-onward-delegation-design.md`) established `delegate_to_peer` as the single-peer ask primitive. That verb is the composition unit; this verb is the scatter primitive. Key use cases:

- **Redundant query / best-of-N:** send the same question to multiple specialist peers and let the orchestrating LLM pick the best answer.
- **Adversarial reconciliation:** query two opposing-domain peers and let the LLM resolve the contradiction.
- **Parallel enrichment:** an orchestrator asks three peer services simultaneously to enrich different aspects of a shared context.

## 3. Goals / Non-goals

### Goals (v2)

- Add `fan_out_to_peers({ peers, mode, task })` to `src/a2a/peer-bridge.js`.
- Dispatch calls to all named peers concurrently (true parallelism via `Promise.allSettled`, not sequential).
- Return a per-peer `FanOutResult` array in arrival order (first settled, first in array).
- Preserve all v1 invariants: registry gate, depth budget, ask-only, anti-spoof, failure-as-data.
- Cap simultaneous fan-out width via `AGENT_MESH_FAN_OUT_MAX_PEERS` (default `8`, defined in `src/config.js`).

### Non-goals (defer to v3 or later)

- **Do-mode fan-out.** Concurrent write delegation requires N simultaneous write locks and conflict resolution; blocked behind the same cross-process write-lock that blocked onward `do` in v1.
- **Per-peer task variants.** v2 broadcasts one identical `task` to all peers. Different task text per peer (a `tasks: {peer: task}[]` map) is deferred.
- **Framework-level synthesis.** Combining, voting on, or reconciling peer answers stays entirely model-side; the bridge returns raw per-peer data.
- **Streaming / incremental result delivery.** Results return as one batch after all peers settle; no partial-delivery stream.
- **Dynamic peer discovery.** `peers` must name peers already in the managed registry; fan-out does not discover or register new peers.
- **Cross-fan-out result caching or deduplication.**
- **Planning DAGs / multi-hop orchestration graphs.** This verb is a single scatter-gather hop, not a dependency graph of delegations.

## 4. `fan_out_to_peers` verb

### 4.1 Input

```typescript
{
  peers: string[];   // 1..maxPeers names, all must be present in the managed registry
  mode:  "ask";      // v2 is ask-only; "do" → mode_disabled refusal
  task:  string;     // the prompt broadcast unchanged to every named peer
}
```

`maxPeers` is controlled by the env var `AGENT_MESH_FAN_OUT_MAX_PEERS` (default `8`). The constant `DEFAULT_FAN_OUT_MAX_PEERS = 8` lives in `src/config.js` alongside `DEFAULT_DEPTH`. This cap guards against accidental O(depth × peers) explosion when a fan-out is nested inside a delegated ask.

### 4.2 Output

An array of `FanOutResult`, one per named peer, in **settlement order** — accumulated then returned as a single batch once all peers have settled (since streaming is out of scope). "Settlement order" means the entry for the first peer whose `Promise.allSettled` slot resolved appears first; peers in `peers` that happen to respond at the same time appear in their input order relative to each other. Each entry:

```typescript
{
  peer:        string;                         // the peer name from the input list
  status:      "ok" | "error" | "timeout";
  answer?:     string;                         // present when status === "ok"
  error_code?: string;                         // present when status === "error" | "timeout"
  log_path?:   string;                         // present when the peer's task logged a file
  truncated?:  boolean;                        // true if answer was clipped to the summary budget
}
```

### 4.3 Errors (fail-fast, atomic — zero peers contacted)

| Condition | Error code |
|---|---|
| `mode !== "ask"` | `mode_disabled` (v2 capability gate) |
| `peers.length < 1` or `peers.length > maxPeers` | `bad_input` |
| Any named peer absent from the managed registry | `bad_input` |
| Registry is unmarked / missing | `bad_input` |
| `currentDepth + 1 > AGENT_MESH_DEPTH` | `depth_budget` |

These are synchronous pre-flight checks: if any fails, the call returns a structured refusal with zero child dispatches.

Runtime failures per peer (after validation passes) are returned as `FanOutResult` entries with `status: "error"` or `status: "timeout"` — they do not abort the other calls.

## 5. Security invariants

- **Anti-spoof preserved.** `peers` is a list of names (data), never per-peer tool registrations. Call-path, depth, mode, and ceiling come only from the bridge process env, never from tool input.
- **Registry gate.** Every name in `peers` is validated against `readManagedRegistry` before any child is dispatched. A name absent from the registry, or a markerless registry, fails the whole call with zero partial dispatch.
- **Single writable root.** Fan-out is ask-only (v2); no write delegation, no new `--add-dir`, no boundary widening.
- **Depth enforcement.** `currentDepth + 1 <= AGENT_MESH_DEPTH` is checked once before the batch — all peers run at depth `d+1`. A fan-out at the depth ceiling is rejected before contacting any peer.
- **Reserved env.** Per-peer spawns inherit the same `RESERVED_BRIDGE_ENV` threading from the v1 spec — `AGENT_MESH_MODE`, `AGENT_MESH_PATH`, `AGENT_MESH_DEPTH`, `AGENT_MESH_MESH_ROOT`, `AGENT_MESH_MESH_CEILING`.
- **Failure is data.** A peer timeout or error does not abort the other calls; it becomes a `FanOutResult` entry. The overall call "succeeds" structurally so long as validation passed.
- **`maxPeers` cap.** `AGENT_MESH_FAN_OUT_MAX_PEERS` limits the fan-out width so an operator cannot inadvertently cause O(depth × peers) combinatorial depth explosions.

## 6. Components

| Component | Responsibility |
|---|---|
| `src/a2a/peer-bridge.js` | **new** `fan_out_to_peers` handler; dispatches all peers concurrently via `Promise.allSettled`, reusing the per-peer path of `delegateToPeer`; collects settled results into a `FanOutResult[]` |
| **Depth checking (reused/extended)** | the existing `AGENT_MESH_DEPTH` check, applied once up front against `d+1` for the whole batch. |
| **Per-peer result normalizer** | wraps each settled child call into a `FanOutResult`, applies summary truncation, and tags `peer` / `status` / `truncated`. |
| **Validation layer** | enforces `mode === "ask"`, `peers.length >= 1 && peers.length <= maxPeers`, all peers registry-resolvable, and depth budget — all before any peer is contacted. |

## 7. Data flow

1. Orchestrating LLM calls `fan_out_to_peers({ peers: [p1, p2, p3], mode: "ask", task })`.
2. **Validate (fail-fast, atomic):** `mode === "ask"`? `peers` within `[1, maxPeers]`? Every peer resolvable via `readManagedRegistry`? `currentDepth + 1 <= AGENT_MESH_DEPTH`? Any failure → reject the whole call, contact no peer.
3. **Scatter:** dispatch an `ask` call to each peer concurrently at depth `d+1`, reusing the single-peer ask path.
4. **Gather:** await all child calls to settle via `Promise.allSettled`. Each yields `ok` (with answer), `error`, or `timeout`. One slow/failed peer does not abort the others.
5. **Normalize:** wrap each settled outcome into a `FanOutResult`, applying per-peer truncation and `truncated` marking.
6. **Return** the array in settlement order to the orchestrating LLM. All peers have settled before the array is returned (no streaming); settlement order is the order in which `Promise.allSettled` resolved each slot, not the original `peers` input order.
7. **Synthesize (model-side):** the LLM reads the array and produces consensus / best-of-N / adversarial reconciliation itself. The framework does nothing here.

## 8. Testing

- **Happy path:** fan-out to 3 valid peers returns 3 `ok` entries, each tagged with the correct `peer` and answer.
- **Arrival-order tagging:** with peers responding at staggered latencies, assert entries appear in settle order and each `peer` tag matches its answer (no cross-attribution).
- **Partial failure:** one peer forced to time out → result has 2 `ok` + 1 `timeout`; the other two answers are intact and present.
- **All-fail vs. fail-fast distinction:** (a) all peers error at runtime → array of 3 `error` entries (call still "succeeds" structurally); (b) one peer name not in registry → whole call rejected, **zero** peers contacted (assert no child dispatch occurred).
- **Depth enforcement:** at `currentDepth == AGENT_MESH_DEPTH`, a fan-out is rejected before dispatch; at `cap - 1`, a fan-out to N peers succeeds and each child is recorded at `d+1`.
- **`maxPeers` cap:** `peers.length > maxPeers` → validation rejection.
- **Mode enforcement:** `mode: "do"` → `mode_disabled` refusal (v2 ask-only); confirm zero child dispatches on refusal.
- **Spoofing / registry gate:** a `peers` entry that is a plausible-looking but unmarked/unregistered name is rejected; confirm `peers` is treated purely as data (names), never as per-peer tool registrations.
- **Truncation:** an over-budget peer summary is clipped and marked `truncated: true`; under-budget summaries are untouched.
- **Concurrency (timing):** total wall-clock for N peers approximates the slowest single peer, not the sum (guards against accidental serialization).

## 9. Out of scope

- **Do-mode fan-out (v3).** Concurrent write delegation requires N simultaneous write locks and conflict resolution; ask-only here. The `ask→do` refusal is inherited unchanged.
- **Framework-level synthesis.** Combining, voting, or reconciling peer answers stays entirely model-side; the bridge returns raw per-peer data.
- **Per-peer task variants.** v2 broadcasts one identical `task` to all peers. Different task text per peer (a future `tasks: {peer: task}[]` shape) is deferred.
- **Planning DAGs / multi-hop orchestration graphs.** This verb is a single scatter-gather hop, not a dependency graph of delegations.
- **Streaming / incremental result delivery.** Results return as one batch after all peers settle; no partial-as-you-go streaming of entries.
- **Dynamic peer discovery.** `peers` must name peers already in the managed registry; fan-out does not discover or register new peers.
- **Cross-fan-out result caching or deduplication.**
