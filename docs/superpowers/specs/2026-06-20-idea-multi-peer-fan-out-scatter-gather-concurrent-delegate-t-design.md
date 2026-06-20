ing (reused/extended)** — the existing `AGENT_MESH_DEPTH` check, applied once up front against `d+1` for the whole batch.
- **Per-peer result normalizer** — wraps each settled child call into a `FanOutResult`, applies summary truncation, and tags `peer` / `status` / `truncated`.
- **Validation layer** — enforces `mode === "ask"`, `peers.length >= 1 && peers.length <= maxPeers`, all peers registry-resolvable, and depth budget — all before any peer is contacted.

## Data flow

1. Orchestrating LLM calls `fan_out_to_peers({ peers: [p1, p2, p3], mode: "ask", task })`.
2. **Validate (fail-fast, atomic):** `mode === "ask"`? `peers` within `[1, maxPeers]`? Every peer resolvable via `readManagedRegistry`? `currentDepth + 1 <= AGENT_MESH_DEPTH`? Any failure → reject the whole call, contact no peer.
3. **Scatter:** dispatch an `ask` call to each peer concurrently at depth `d+1`, reusing the single-peer ask path.
4. **Gather:** await all child calls to settle. Each yields `ok` (with answer), `error`, or `timeout`. One slow/failed peer does not abort the others.
5. **Normalize:** wrap each settled outcome into a `FanOutResult`, applying per-peer truncation and `truncated` marking.
6. **Return** the array in arrival order to the orchestrating LLM.
7. **Synthesize (model-side):** the LLM reads the array and produces consensus / best-of-N / adversarial reconciliation itself. The framework does nothing here.

## Testing

- **Happy path:** fan-out to 3 valid peers returns 3 `ok` entries, each tagged with the correct `peer` and answer.
- **Arrival-order tagging:** with peers responding at staggered latencies, assert entries appear in settle order and each `peer` tag matches its answer (no cross-attribution).
- **Partial failure:** one peer forced to time out → result has 2 `ok` + 1 `timeout`; the other two answers are intact and present.
- **All-fail vs. fail-fast distinction:** (a) all peers error at runtime → array of 3 `error` entries (call still "succeeds" structurally); (b) one peer name not in registry → whole call rejected, **zero** peers contacted (assert no child dispatch occurred).
- **Depth enforcement:** at `currentDepth == AGENT_MESH_DEPTH`, a fan-out is rejected before dispatch; at `cap - 1`, a fan-out to N peers succeeds and each child is recorded at `d+1`.
- **`maxPeers` cap:** `peers.length > maxPeers` → validation rejection.
- **Mode enforcement:** `mode: "do"` → refused (v2 ask-only); ask→do laundering refusal inherited from the single-peer path (assert a peer cannot escalate to write through fan-out).
- **Spoofing / registry gate:** a `peers` entry that is a plausible-looking but unmarked/unregistered name is rejected; confirm `peers` is treated purely as data (names), never as per-peer tool registrations.
- **Truncation:** an over-budget peer summary is clipped and marked `truncated: true`; under-budget summaries are untouched.
- **Concurrency (timing):** total wall-clock for N peers approximates the slowest single peer, not the sum (guards against accidental serialization).

## Out of scope

- **Do-mode fan-out (v3).** Concurrent write delegation requires N simultaneous write locks and conflict resolution; ask-only here. The `ask→do` refusal is inherited unchanged.
- **Framework-level synthesis.** Combining, voting, or reconciling peer answers stays entirely model-side; the bridge returns raw per-peer data.
- **Per-peer task variants.** v2 broadcasts one identical `task` to all peers. Different task text per peer (a future `tasks: {peer: task}[]` shape) is deferred.
- **Planning DAGs / multi-hop orchestration graphs.** This verb is a single scatter-gather hop, not a dependency graph of delegations.
- **Streaming / incremental result delivery.** Results return as one batch after all peers settle; no partial-as-you-go streaming of entries.
- **Dynamic peer discovery.** `peers` must name peers already in the managed registry; fan-out does not discover or register new peers.
- **Cross-fan-out result caching or deduplication.**
