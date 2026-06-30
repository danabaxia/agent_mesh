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
