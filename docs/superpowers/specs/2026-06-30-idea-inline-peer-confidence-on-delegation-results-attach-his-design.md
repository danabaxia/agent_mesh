# Inline Peer-Confidence on Delegation Results — Design

**Date:** 2026-06-30  
**Status:** draft  
**Issue:** #671  
**Governs:** `src/a2a/peer-bridge.js` · `src/a2a/protocol.js` · `src/dashboard/public/tasks-view.js` · `src/config.js`

## Motivation

When Agent A delegates to Agent B and receives a `status:done` A2A Task result,
it has no inline signal about whether this peer historically delivers on this
type of task. The existing trust data (once issue #597 lands) lives in the Health
view — a monitoring surface queried by humans, not by the calling agent
mid-delegation.

Concrete scenarios:

1. An orchestrator agent auto-accepts a `do`-mode delegation result from a coder
   peer without knowing that peer has a 40% success rate on file-creation tasks —
   the caller would have escalated if it knew.
2. A concierge routing to multiple peers has no programmatic way to prefer the
   historically more reliable one for the current task category.

This is distinct from #597 (peer behavioral trust log): #597 accumulates data and
surfaces it in the Health view for human inspection. The gap here is making that
signal available **at the call site** — on the A2A Task result — so that the
calling agent can act on it inline, without separately querying the health API.

### Research basis

- **Renovate Merge Confidence**: crowdsourced CI outcome signals (age, adoption %,
  passing %) aggregated from 500k+ installed repos and 8 years of PR history are
  surfaced directly on each PR as inline confidence badges — not just on a
  monitoring dashboard. This enables auto-merge policies and drives 60–80% of
  updates to auto-merge safely. Source: docs.renovatebot.com/merge-confidence/
- **A2A Discussion #1631 "Reputation-Aware Agent Discovery"**: 150+ production orgs
  converging on per-skill, transaction-bound attestation at the protocol level
  (referenced in issue #597). Confirms the gap: identity is solved; behavioral
  track record at the call site is not.

## Goal

After every `delegate_to_peer` call completes, attach a `peer_confidence` struct
to the `agentmesh/metrics` block of the returned A2A Task:

```json
{
  "agentmesh/metrics": {
    "peer_confidence": {
      "peer": "coder",
      "passRate90d": 0.87,
      "sampleN": 34,
      "trend": "stable"
    }
  }
}
```

Key constraints:

- **Read-only observability only**: the confidence struct is advisory data on the
  result — it does NOT automatically gate, reject, or re-route delegations. The
  calling agent decides what to do.
- **Builds on #597's data**: reads from the `peer-trust.jsonl` that #597
  introduces. Depends on #597 landing first; `sampleN == 0` → omit the field
  (no phantom data).
- **Protocol-compatible**: a new optional field in the existing `agentmesh/metrics`
  block; existing consumers that don't read it are unaffected.
- **`AGENT_MESH_TRUST_DISABLED=1`** (from #597) suppresses the field when trust
  logging is off.

## Components

- **`peer-confidence-computer` (new, pure)** — a read-only module that takes
  `(peerName, taskCategory)` and returns
  `{ peer, passRate90d, sampleN, trend } | null`. Reads `peer-trust.jsonl` (from
  #597) located under `AGENT_MESH_LOG_DIR`, filters to the 90-day window, computes
  `passRate90d` (successes / total), `sampleN` (total entries), and `trend`
  (`improving` / `declining` / `stable`) from a configurable trailing window. Any
  read error, malformed file, or empty result returns `null` (failure-as-data
  → null, no throw).
- **`peer-bridge.js` integration** — after a `delegate_to_peer` completes, invoke the computer and, if non-null, attach `peer_confidence` to the result Task's `agentmesh/metrics` block before returning to the caller.
- **`agentmesh/metrics` / `normalizeMetrics` (`protocol.js`)** — whitelist the optional `peer_confidence` field so it survives normalization across the A2A boundary.
- **Task Board renderer (dashboard)** — confidence chip from `passRate90d` (+`sampleN` weighting); display-only.
- **Config** — honors `AGENT_MESH_TRUST_DISABLED` (#597); 90-day window length if configurable.

## Data flow

1. Agent A calls `delegate_to_peer(coder, …)`; the delegation runs and returns a `done` Task.
2. Before returning, `peer-bridge.js` calls the peer-confidence computer for `(coder, taskCategory)`.
3. The computer reads `peer-trust.jsonl` (#597), computes `passRate90d` / `sampleN` / `trend`:
   - `sampleN > 0` and trust enabled → produce the struct.
   - `sampleN == 0`, trust disabled, or read error → return `null`.
4. If non-null, the struct is attached to the result Task's `agentmesh/metrics.peer_confidence`; `normalizeMetrics` preserves it across the boundary.
5. Agent A receives the Task with the inline `peer_confidence` and **reasons about it at the call site** — e.g. auto-accept high-confidence results, escalate/re-verify low-confidence ones, prefer the more reliable peer next time. The framework does **not** act on the struct.
6. The Task Board renders a confidence chip from the same field (display only).

## Testing

Pure-computer and bridge-level tests (hermetic, fixture trust log):

- **Struct attached on history:** a peer with `sampleN > 0` → `peer_confidence` present on the result with correct `passRate90d`/`sampleN`/`trend`.
- **No-history omission:** `sampleN == 0` → field **omitted** entirely (no `0` / null phantom).
- **Disabled:** `AGENT_MESH_TRUST_DISABLED=1` → field always omitted.
- **Read error → omit:** a malformed/unreadable `peer-trust.jsonl` → field omitted, **no throw** (failure-as-data).
- **Anti-spoof:** a task argument attempting to inject/forge `peer_confidence` is ignored; only the framework-computed value (from the trust log) can appear.
- **Read-only:** assert the struct's presence/value does **not** alter delegation outcome, gating, or routing (advisory only).
- **Protocol compat:** `normalizeMetrics` preserves `peer_confidence`; a consumer ignoring it is unaffected; an unknown sibling key is still stripped.
- **Trend correctness:** rising/falling/flat fixtures yield `improving`/`declining`/`stable`.
- **Category scoping:** where #597 supports per-category data, the rate reflects the relevant task category; otherwise documented as global.
- **Dashboard chip:** green/yellow/red maps correctly from `passRate90d` and reflects `sampleN` weighting; no mutation.

## Out of scope

- **Automatic gating, rejection, or re-routing** based on confidence — strictly advisory; the calling agent decides. (Any future auto-policy is a separate idea.)
- **Collecting the trust data** — that is #597's job; this consumes `peer-trust.jsonl`, it does not produce it. **Depends on #597 landing first.**
- **Defining task categories / the trust schema** — owned by #597; this reads whatever granularity #597 provides.
- **Peer-to-peer trust negotiation or attestation** — no protocol-level reputation exchange (cf. A2A #1631); this is a local, framework-computed signal on the result.
- **Confidence on anything but completed `delegate_to_peer` results** — not added to fan-out aggregate results, planning passes, or non-delegation Tasks in v1 (natural follow-ons).
- **Mutating trust data from the result path** — read-only; no new writes beyond #597's logging.
- **Wire-protocol changes** — an optional field in the existing `agentmesh/metrics` block only.
- **Path-guard / anti-spoof / no-Bash-in-do / single-root write changes** — all preserved; reads from `AGENT_MESH_LOG_DIR`, framework-computed, no new write surface.

## Security invariants

All four repo invariants are preserved:

- **Anti-spoof**: `peer_confidence` is framework-computed from the trust log, never read from task arguments; a delegating model cannot inject or forge the value.
- **Failure-as-data**: trust-read error or empty result → field omitted, no throw.
- **Single-root write**: reads from `AGENT_MESH_LOG_DIR`; no new write surface introduced.
- **No-Bash-in-do**: file read only; no shell invocation.
