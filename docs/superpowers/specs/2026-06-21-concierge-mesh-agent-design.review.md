# Review log — concierge mesh agent spec

## Round 1 (2026-06-21) — Codex unavailable

`codex exec` returned `usage limit` on every logged-in account (review + primary);
soonest reset **Jun 24th 2026 7:19 PM** (~3 days). Per codex-spec-review guidance an
exhausted run must not silently become self-review as the *gate*, but the owner has an
active `/goal` and blocking ~3 days is not acceptable. **Decision:** rigorous self-review
now (the existing contracts were mapped from the real code via an Explore pass); re-run the
codex gate after Jun 24 if desired.

### Self-review findings (fixed inline)

- **[MAJOR] §4 sweep — how the daemon builtin gets health.** The builtin is a no-LLM
  function; it must not depend on the mesh-health MCP. Clarified: the builtin **imports
  `src/mesh-health/core.js` directly in-process** (`checkConformance`/`triageLogs`/
  `listStaleTasks`) + MIR, and passes raw inputs to the pure `monitor.js`. The *agent* uses
  the MCP verbs; the *daemon* uses core.js.
- **[MAJOR] §5 actions — board/peer mechanism + identity.** `delegate_to_peer` is a peer-bridge
  verb requiring an agent caller identity; the framework-side dispatcher is not an agent.
  Re-specified: `ask_peer_rerun` reuses the **console A2A broker** (served-only/ask-only gates
  already in place); `assign_task` writes the **board store** directly with framework-stamped
  `from:"concierge"` (board identity is framework-set, per invariant — never from model input);
  `file_issue` keeps the existing gh path. None use the agent's peer-bridge.
- **[MINOR] §4 alerts store — shape.** Resolved the file-per-alert vs rolling-file ambiguity →
  a single atomic `mesh/alerts/alerts.json` (single-writer sweep, read by the route).
- **[MINOR] §4 cadence.** Did not assert a cadence kind the scheduler may not support
  (`interval`); deferred the exact kind to plan time (verify against `src/schedule/*`).

### Verified consistent with actual contracts
- peer bridge ask-only (agent uses ask `delegate_to_peer`/`fanOutToPeers`); mesh-health
  `x-agentmesh.readOnly` grant → ask-mode only; console broker served-only + ask-only (concierge
  is `served:true, enabledModes:["ask"]`); board single-step/`to`-advances + framework-set
  identity; builtin `{status,output|error}` return contract.

No BLOCKERs. Scope held to the stated non-goals (no push, no autonomous remediation, no new
primitives). **VERDICT (self): proceed to user spec review → writing-plans → goal-metrics gate.**
