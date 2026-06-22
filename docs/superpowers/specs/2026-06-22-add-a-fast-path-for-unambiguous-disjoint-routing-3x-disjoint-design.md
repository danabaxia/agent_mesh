# Fast-Path for Unambiguous (Disjoint) Routing — Design

## Problem

The `3x-disjoint` benchmark cell — three peers with clearly non-overlapping intent
declarations — burns **~30s per routing call** and spends one full LLM deliberation
turn when the answer is obvious: only one peer has any matching intents, the others
have none. Paying an LLM turn for a structurally unambiguous decision wastes latency
and cost with zero quality benefit.

## Goal

Short-circuit the LLM deliberation step in `routing.js` when the intent-match
evidence is unambiguous: one peer's declared intents clearly match the task and no
other peer's intents do. The fast-path must be:

- **Cheap** — string operations only; no model call.
- **Conservative** — fires only when the gap is wide enough; falls through on any
  ambiguity.
- **Lossless** — the selected peer must be the same peer the deliberative router
  would have chosen; no quality regression.
- **Observable** — both paths record `route_via` telemetry so the benchmark can
  attribute wins and detect drift.

## Scoring mechanism

The pre-deliberation match score for a peer is **the character-length of its longest
matching intent phrase** (case-insensitive substring match against the task, using
the same `includes()` test as `routeByRules`), or **0** if none of its declared
intents appear in the task.

This signal is cheap and already-available: `routeByRules` already finds the longest
matching intent phrase within the first matching peer; the fast-path extends that scan
to **all** peers simultaneously.

**Fast-path predicate** — given a ranked list of (peer, score) pairs:

1. Leader score > 0 (at least one peer has a matching intent).
2. Leader score − runner-up score ≥ `AGENT_MESH_ROUTE_FASTPATH_MARGIN`.

If both conditions hold → fast-path fires; the leader is selected directly without an
LLM turn. Otherwise → fall through to deliberation.

**Margin default and the disjoint case.** The conservative default sets
`AGENT_MESH_ROUTE_FASTPATH_MARGIN` equal to the leader score itself (i.e., the
runner-up must be 0). This means the fast-path fires only when the routing is
**perfectly disjoint** — one peer matches, nobody else does — which is the exact
pattern that the `3x-disjoint` benchmark documents as the over-spend. Operators can
lower the margin to catch near-disjoint layouts once the default is validated.

**Why phrase length is the right signal.** Longer matched phrases are more specific
(e.g. `"find book in catalog"` is a stronger signal than `"find"`). The length gap
between two matched phrases measures how much more specifically one peer declared
ownership of this task type. A peer with a 20-char match and all others at 0 is
categorically unambiguous; a peer with a 6-char match and a second peer at 5 is not
(too close, deliberation needed).

## Components

| Module | Responsibility | Purity |
|---|---|---|
| `src/routing.js` | **new** `scorePeers(task, peers)` → `[{name, score}]` ranked by intent-phrase-length score; **new** `fastPathPeer(task, peers, margin)` → `{target, score} \| null` — applies the predicate above; used by `orchestrator.js` before the LLM fallback | pure |
| `src/orchestrator.js` | before the LLM deliberation turn, call `fastPathPeer`; if it returns a target, construct the route decision without spawning `claude -p`; tag `route_via: 'fastpath'` on the result | shell |
| **Config (`src/config.js`)** | `AGENT_MESH_ROUTE_FASTPATH_MARGIN` (confidence margin), optional absolute floor, and `AGENT_MESH_ROUTE_FASTPATH_DISABLED` escape hatch; sane conservative defaults |
- **Route-decision telemetry** — records `route_via: 'fastpath' | 'deliberation'` (and the margin) into the run/metrics record so the perf benchmark can attribute wins and detect drift.
- **Perf benchmark hook (`eval-perf.mjs`)** — surfaces the fast-path attribution and the `3x-disjoint` latency/cost delta against the baseline.

## Data flow

1. A delegation request arrives; the router assembles candidate peers and their pre-deliberation match scores.
2. The fast-path predicate evaluates the candidates/scores against the configured margin:
   - **disjoint or clear winner** → fast-path fires: select that peer directly, skip deliberation, tag `route_via: 'fastpath'`.
   - **ambiguous/confusable** → fall through to the existing deliberative router, tag `route_via: 'deliberation'`.
3. Either way, the chosen peer flows into the **unchanged** delegation path (send, metrics capture, result handling).
4. Route telemetry (`route_via`, margin) is recorded with the run.
5. `eval-perf.mjs` reads the telemetry: `3x-disjoint` should now show sharply lower `latency_ms`/`cost_usd` with precision/recall still 1.0; confusable cells should be unchanged (still deliberated).

## Testing

Pure-predicate and integration tests, plus a perf-regression check:

- **Disjoint fires:** a `3x-disjoint`-style candidate set (one clear match) → predicate returns `fastPath: true` with the correct peer.
- **Confusable does not fire:** a `6x-confusable`-style set with no clear winner → predicate returns `fastPath: false`; deliberation path is taken.
- **Margin boundary:** top vs. runner-up gap exactly at `AGENT_MESH_ROUTE_FASTPATH_MARGIN` → assert the chosen `>`/`>=` semantics are locked.
- **Equivalence:** for a disjoint case, the fast-path-selected peer equals the peer the deliberative router would have chosen (no behavior change in *outcome*, only in *path*).
- **Downstream identity:** a fast-path delegation produces the same delegation/metrics shape as a deliberative one to the same peer.
- **Telemetry:** `route_via` is recorded correctly for both paths.
- **Disable flag:** `AGENT_MESH_ROUTE_FASTPATH_DISABLED` → predicate never fires; pure deliberation restored (regression lock).
- **Perf assertion (paired with #1 baseline):** `3x-disjoint` `latency_ms`/`cost_usd` drop materially vs. baseline while `precision`/`recall` stay 1.0 and `wasted_hops` stays 0; confusable cells unchanged.
- **No-quality-loss guard:** an integration test asserting precision/recall on the disjoint cell is unchanged after enabling the fast-path.

## Out of scope

- **A new model call to compute routing confidence.** The fast-path must use a *cheap, already-available* pre-deliberation signal; introducing an LLM-based confidence scorer would reintroduce the cost it aims to cut. If no cheap signal proves sufficient, that is a gating finding to resolve before implementation.
- **Changing the deliberative router itself.** The deliberation path is unchanged; the fast-path only short-circuits *before* it.
- **Routing quality improvements on confusable layouts.** This targets the *easy* over-spend; improving hard-case quality is a separate concern.
- **Multi-peer fan-out interaction.** Fast-path is single-route selection; its behavior under fan-out (#185) is not addressed here.
- **Dynamic / learned thresholds.** v1 uses static configured margins; auto-tuning the margin from historical accuracy is deferred.
- **Caching of routing decisions** across requests — out of scope.
- **Verification of the cited OSS prior art** (RouteLLM, semantic-router) — claims are from prior knowledge; live confirmation was blocked this session and should be validated, but the design does not depend on it.
- **Path-guard / anti-spoof / write-boundary changes** — none; this is internal routing logic plus telemetry and config.
