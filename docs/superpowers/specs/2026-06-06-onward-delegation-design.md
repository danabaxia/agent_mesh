# Onward Delegation (worker → peer) — Design

## 1. Goal

Let a folder agent's **worker** delegate to its **peers** during a task — the
headline "Agent A asks Agent B" flow, executed from inside A's running worker
rather than only from an external driver. Today a worker spawned by
`delegate.js` is given only its own read tools and its own read-only `.mcp.json`
servers; `registry.json` is read solely for the startup self-check
(`src/a2a/stdio-server.js:157`). So a worker has **no mechanism to call a peer**,
and the App→Library demo only works if the *caller* (the dashboard console / an
interactive Claude) does the `message/send` itself.

This spec adds onward delegation **without** violating the project's normative
boundaries — especially PROJECT.md §1.6 / line 121: *"modeling 'another agent' as
'an MCP tool' is a category error,"* and *"nested delegation is A2A, not MCP."*

## 2. The category-error tension, and how we resolve it

A headless `claude -p` worker can only act through tools, and a tool surface is
delivered via MCP. So *some* MCP must be involved for a worker to initiate
anything.

The category error the project forbids is **statically registering each peer as
its own distinct MCP capability** — "Library is a tool called `book_lookup`."
That conflates *who you delegate to* (an A2A agent) with *what capability you
have*. We avoid it by exposing exactly **one framework-owned delegation
primitive**, not N peer-as-tool servers:

- A single MCP server — the **peer bridge** — offering generic verbs
  `list_peers` and `delegate_to_peer({ peer, mode, task })`.
- The peer is named as **data** (an argument), not modeled as a tool. The peer
  stays an A2A agent; the bridge's `delegate_to_peer` performs a real A2A
  `message/send` over the existing `createA2AClient`. The worker→bridge hop is
  local MCP; the **bridge→peer hop is A2A** — exactly "nested delegation is A2A."

**This is a normative carve-out, not an appeal to the existing §1.6 compat
shim.** (R1/BLOCKER-1) PROJECT.md §1.6 "A2A↔MCP interop, compat-only" is about
letting *MCP-only callers reach an A2A peer*; it is **not** prior permission for a
worker-visible delegation bridge. This spec therefore **amends PROJECT.md §1.6**
to add an explicit "Worker onward delegation — the framework peer bridge"
paragraph defining this single sanctioned surface and its constraints (done in
the same change as this spec). Without that amendment the design would contradict
the model; with it, the model gains one clearly-bounded delegation primitive.

**Chosen approach vs. alternatives.**
- *(A) One framework peer-bridge MCP exposing a generic delegate verb (CHOSEN).*
  Single primitive, A2A transport, registry-sourced, guards reused.
- *(B) Inject each peer as its own `serve` MCP server in the worker config.*
  Rejected — the literal category error (peer-as-tool) and the deprecated
  MCP-as-transport path.
- *(C) Teach the worker to shell out to `createA2AClient`.* Rejected — needs
  `Bash` in the worker (banned).

## 3. v1 scope decision: onward delegation is ASK-ONLY

(R1/BLOCKER-2 + MAJOR-6) Allowing onward `do` opens two hard problems at once:

1. **Cross-process write serialization.** Each bridge spawns its own peer
   `serve-a2a`; the per-folder `doQueue` (`stdio-server.js`) and the compat
   `SerialQueue` are **process-local**, so two onward `do` calls to the same peer
   root from different bridge processes could run concurrently and corrupt the
   git-snapshot change detection — breaking the single-writable-root invariant.
2. **Audit propagation.** The parent `delegateTask` only computes
   `files_changed` for its own root; a downstream `do` write would be invisible in
   the parent Task's structured channel.

Rather than solve both now, **v1 onward delegation is ask-only**: the bridge
refuses any `delegate_to_peer` whose `mode !== "ask"` with **`mode_disabled`**
(the bridge disables non-`ask` onward in v1), **before** spawning the peer —
regardless of the parent worker's mode. `readonly_parent` is reserved for its
narrow meaning (an `ask` parent trying to launder a `do` downstream, enforced by
`delegate.js:30` at the peer); the bridge's blanket ask-only policy is a
capability gate, so `mode_disabled` is the honest code and keeps refusal metrics
clean (R2/MAJOR-1). ask chains perform no writes, so (1) and (2) do not arise. `do` onward delegation is an
explicit **non-goal for v1** (§10), deferred behind a cross-process
per-canonical-root write lock and downstream-Task audit propagation. This still
delivers the headline demo (App→Library "find Dune" is an ask chain).

## 4. Components

| Module | Responsibility | Purity |
|---|---|---|
| `src/a2a/peer-bridge.js` | **new** stdio MCP server: `list_peers`, `delegate_to_peer` (ask-only v1); reads the agent's registry via the managed reader, calls peers via `createA2AClient`, maps the peer Task into a tool result | shell |
| `src/a2a/registry.js` (extend) | **new** `readManagedRegistry(root)` that requires `x-agentmesh-generated:true` + a `peers` object and rejects markerless/bare registries before normalization | shell |
| `src/delegate.js` (extend) | when the managed registry has peers, inject the peer bridge into the worker's `--mcp-config` under the reserved name and allowlist it; thread the reserved env into the bridge | shell |
| `src/cli.js` + `bin/agent-mesh.js` (extend) | hidden `serve-peer-bridge <agent-root>` verb to launch the bridge as an MCP server | shell |
| `src/a2a/protocol.js` | reuse Task mapping + `ERROR_CODES` (now includes `mode_disabled`) | pure |

The peer bridge is **framework-owned**, not an entry in the agent's `.mcp.json`
(so it does not violate "declarations are not grants" §2.4 — that governs the
agent's *own* tool servers).

### 4.1 Reserved namespace (R1/MAJOR-5)

The bridge is injected under a reserved MCP server name **`agentmesh_peerbridge`**
(tools surface as `mcp__agentmesh_peerbridge__*`). `grantToolServers` /
`readReadOnlyToolServers` in `delegate.js` MUST **drop any agent-declared
`.mcp.json` server whose name starts with the reserved prefix `agentmesh_`**
before merging, so an author cannot shadow or spoof the framework bridge. The
framework bridge is added to the generated config **after** that filtering. A
collision attempt is logged and the agent server dropped.

## 5. Managed-registry reader (R1/MAJOR-3)

`normalizeRegistry` deliberately accepts markerless `{ peers }` and bare maps
(used by callers with hand-authored registries). The bridge MUST NOT use that lax
path. `readManagedRegistry(root)`:

1. reads `<root>/registry.json`; absent → returns `{ peers: {} }` (no peers).
2. requires top-level `x-agentmesh-generated === true` **and** a `peers` object;
   otherwise → returns `{ peers: {} }` and records a `stale_registry` reason.
3. only then hands the `peers` object to `normalizeRegistry` for spawn shaping.

So "registry is the only peer source" is enforced by the API the bridge uses: a
markerless/tampered registry yields **no** peers; the bridge never spawns an
arbitrary path.

## 6. Control / data flow

```
worker (claude -p, mode=ask|do)
  └─ mcp__agentmesh_peerbridge__delegate_to_peer({ peer:"library", mode:"ask", task:"find Dune" })
        │  (local MCP — the sanctioned §1.6 worker-bridge carve-out)
        ▼
  peer-bridge.js
    ├─ mode !== "ask"  → refuse mode_disabled (no spawn)              [v1]
    ├─ readManagedRegistry(agentRoot) → peer must be present + marked
    └─ createA2AClient(managedPeers).send(peer, message)
        ▼  A2A message/send  (peer env = RESERVED bridge env, see §7)
  library: serve-a2a ──▶ delegate.js ──▶ guards (cycle, depth, mode, boundary) ──▶ worker
        ▼
  final Task ──▶ bridge maps to tool result (status + summary + error_code + log_path)
        ▼
  worker continues, then returns its own Task to the original caller
```

Recursion guard preserved end to end: the bridge spawns the peer with the
worker's **threaded** call env (`entered.env`: call-path extended with the
current root, depth decremented), so `context.js` in the peer detects a cycle
(A→B→A → `cycle`) or exhausted depth (`depth_budget`) exactly as today.

## 7. Reserved env for bridge-spawned peers (R1/MAJOR-4)

`stdio-client.js`'s `peerEnv` currently protects only `AGENT_MESH_PATH` and
`AGENT_MESH_DEPTH`, letting an operator-authored `registry.json` `peer.env`
override other security-relevant vars. For **bridge** spawns this is widened: the
bridge sets the following **authoritatively from its own process env** and
**strips them from any `peer.env`** before spawn (a reserved deny-list):

- `AGENT_MESH_PATH`, `AGENT_MESH_DEPTH` — recursion identity/budget.
- `AGENT_MESH_MODE` — set to `ask` in v1 (the chain mode); prevents a
  registry-authored `do` escalation.
- `AGENT_MESH_MESH_ROOT`, `AGENT_MESH_MESH_CEILING` — global-layer + walk-up
  ceiling, so peer.env cannot redirect the obeyed mesh layer or lift the ceiling.

Implementation: a `RESERVED_BRIDGE_ENV` set applied in the bridge's spawn path
(either a bridge-specific client option or a dedicated reserved-env merge),
covering the vars above. Non-reserved `peer.env` keys (e.g. tool API config) pass
through unchanged.

## 8. Mode policy (read-only chains stay read-only)

- v1: `delegate_to_peer` accepts `mode:"ask"` only; any other value →
  `mode_disabled` refusal at the bridge, before spawning.
- The peer's own two-layer gate still applies independently: the peer must allow
  `ask` in both its `agent.json` capability and its mesh `enabledModes`, else the
  peer returns `mode_disabled` (surfaced verbatim).

## 9. Security & invariants (must hold)

- **Anti-spoof preserved.** Bridge model-facing args are `{ peer, mode, task }`.
  Call-path/depth/mode/ceiling come only from the bridge process env (set by
  `delegate.js`), never from tool input.
- **Registry is the only peer source.** Enforced by `readManagedRegistry` (§5):
  markerless/absent/tampered → no peers.
- **No new writable surface.** v1 is ask-only; the bridge writes nothing, adds no
  `--add-dir`, and never widens a peer's boundary. Peers still run under their own
  path-guard and single-writable-root rule.
- **Reserved namespace + env.** §4.1 + §7 stop an author/operator from spoofing
  the bridge or overriding security env via `.mcp.json` / `registry.json`.
- **Bash still banned;** `--strict-mcp-config` retained (worker gets only its
  granted read-only servers **plus** the framework bridge).
- **Default-off symmetry.** No marked peers → no bridge injected → no behavior
  change; existing single-agent tests unaffected.

## 10. Error handling (failure-as-data)

- Unknown peer / markerless registry → tool result describing a `refused`-shaped
  outcome (`peer not in registry`), not an exception.
- Non-`ask` onward mode → `mode_disabled` tool result, no spawn (the bridge's
  v1 ask-only capability gate; distinct from `readonly_parent` laundering).
- Peer returns `rejected`/`failed`/`timeout` → surfaced verbatim to the worker as
  the tool result, **preserving** `status.state`, `agentmesh/error_code`, and
  `agentmesh/log_path` (R1/MAJOR-6 — even though v1 onward is ask-only and
  `files_changed` is null, the downstream status/error/log are propagated so the
  audit trail is not lost). No auto-retry.
- Bridge spawn failure → `spawn_failed` tool result; the worker's own task still
  completes and reports it.

## 11. Testing

- **Managed reader:** marked `{peers}` → peers; markerless/bare/absent → empty.
- **Bridge unit (hermetic, fake peer):** `list_peers` reflects the managed
  registry; `delegate_to_peer(ask)` routes a `message/send` and returns the final
  Task fields; unknown peer → refusal.
- **Ask-only gate:** `delegate_to_peer(do)` → `mode_disabled`, **no peer
  spawn** (assert the fake client was never constructed), for both ask- and
  do-mode parent workers.
- **Reserved namespace:** an agent `.mcp.json` server named
  `agentmesh_peerbridge` (or `agentmesh_*`) is dropped, not granted; the
  framework bridge still present and functional.
- **Reserved env:** a `registry.json` `peer.env` setting
  `AGENT_MESH_MODE=do`/`AGENT_MESH_MESH_CEILING=/` is overridden by the bridge's
  authoritative values (assert the spawn env).
- **Recursion:** A→B→A via the bridge → `cycle`; depth exhaustion →
  `depth_budget`.
- **delegate.js wiring / default-off:** peers present → reserved bridge in config
  + allowlisted; no peers → neither present.
- **Audit propagation:** a peer failure's `error_code`/`log_path` appear in the
  bridge tool result.
- **Opt-in real-`claude` e2e (`AGENT_MESH_E2E=1`):** App worker asked "find Dune"
  calls `delegate_to_peer("library","ask",…)` → "shelf 3" → App formats it; then
  re-validate the dashboard console demo (console → App → Library).

## 12. Build increments

1. **Reader + bridge core** — `readManagedRegistry` + `peer-bridge.js` +
   `serve-peer-bridge` CLI + unit tests (fake peer, ask-only gate, marker,
   reserved env). No `delegate.js` change yet.
2. **Worker wiring** — `delegate.js` injects the reserved bridge + allowlist +
   reserved-env threading + reserved-namespace filtering; recursion/default-off
   tests.
3. **E2E + demo** — opt-in real-`claude` App→Library test; re-validate the
   dashboard console demo (chat `app` → "find Dune" → "shelf 3").

## 13. Non-goals (v1)

- **Onward `do` delegation** — deferred behind a cross-process
  per-canonical-root write lock + downstream-Task `files_changed` propagation.
- No HTTP A2A transport (stdio binding only).
- No live mid-stream delegation events (Task stays request→final-Task; dashboard
  onward-edge "lighting" remains derived-after-the-fact).
- No broadening of `do`-mode tool grants or re-enabling `Bash`.

## Review log

- **R0 (draft):** initial design (single framework bridge, A2A transport).
- **R1 (codex, 7 findings: 2 BLOCKER / 4 MAJOR / 1 MINOR — all accepted):**
  - BLOCKER-1 (compat-shim overreach) → §2 reframed as an explicit **PROJECT.md
    §1.6 amendment** (carve-out), and PROJECT.md edited to match.
  - BLOCKER-2 (cross-process `do` serialization) → §3 **v1 is ask-only**; onward
    `do` moved to non-goals behind a cross-process lock.
  - MAJOR-3 (lax registry normalizer) → §5 **`readManagedRegistry`** marker gate.
  - MAJOR-4 (peerEnv only guards PATH/DEPTH) → §7 **reserved bridge env**
    (MODE/MESH_ROOT/MESH_CEILING added).
  - MAJOR-5 (bridge namespace collision) → §4.1 **reserved `agentmesh_` prefix**,
    drop colliding agent servers.
  - MAJOR-6 (onward `do` audit loss) → resolved by ask-only v1; §10 still
    **propagates** downstream `status`/`error_code`/`log_path`.
  - MINOR-7 (`mode_disabled` not in taxonomy) → PROJECT.md error set updated.
- **R2 (codex, 1 MAJOR — accepted):** v1 ask-only refusal used `readonly_parent`,
  which has a narrow laundering meaning and would pollute refusal metrics for a
  `do`-mode parent → changed to **`mode_disabled`** (a capability gate) across
  §3/§8/§10; `readonly_parent` reserved for genuine ask→do laundering.
- **R3 (codex, 1 MINOR — accepted):** the §6 control-flow diagram still showed
  `readonly_parent`; changed to `mode_disabled` to match §3/§8/§10.
- **R4 (codex):** `VERDICT: APPROVED` — no actionable findings. **Consensus
  reached** (7 → 1 → 1 → 0 findings over four rounds); user also approved.
