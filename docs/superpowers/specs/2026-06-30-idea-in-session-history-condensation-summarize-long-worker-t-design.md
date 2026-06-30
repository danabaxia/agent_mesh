, the condenser issues a cheap Haiku call summarizing: original task · completed steps · files changed · remaining work · open questions.
4. The structured summary is written to `.agent-mesh/logs/<id>.condensation.json`; `condensation_count` increments.
5. The summary is injected as a `<mesh:condense-summary>` block into the **resumed** session — the worker continues with reclaimed headroom and preserved continuity; the worker is unaware.
6. If headroom is later **fully exhausted**, rotation fires as today — but the new session's initial prompt carries the latest condensed summary (continuity instead of a cold start).
7. **On condenser failure:** log it, proceed without condensation (eventual rotation remains the safety net) — no throw.
8. The perf scorecard reads `condensation_count` over runs to detect compression-induced drift.

## Testing

Hermetic tests with a mocked condenser model and simulated headroom:

- **Trigger ordering:** condensation fires when `headroomPct` crosses `AGENT_MESH_CONDENSE_TRIGGER_PCT` and **before** any rotation; with the trigger above the rotation threshold, condensation always precedes rotation.
- **Summary structure:** the condenser is called with the framework-injected prompt and produces the five structured fields (task/completed/files/remaining/open-questions).
- **Continuity injection:** the `<mesh:condense-summary>` block is inserted into the **resumed** session; the worker continues without a model-facing signal that condensation occurred.
- **Headroom reclaimed:** post-condensation context is materially smaller; delegation proceeds further before any rotation than it would have without condensation.
- **Audit log:** `.agent-mesh/logs/<id>.condensation.json` is written with the summary and replaced span.
- **Metrics:** `condensation_count` appears in the run log and `agentmesh/metrics`, increments per condensation; `normalizeMetrics` preserves it.
- **Forced-rotation handoff:** when headroom is fully exhausted, rotation still fires and the new session's initial prompt carries the latest condensed summary (no cold start).
- **Failure-as-data:** a condenser-call failure logs and proceeds without condensation; **no throw**; rotation remains available.
- **Opt-out:** `AGENT_MESH_CONDENSE_DISABLED=1` → no condensation, behavior identical to today (regression lock).
- **Anti-spoof:** task text cannot alter the condenser prompt; the summarization instruction is framework-owned.
- **Model config:** `AGENT_MESH_CONDENSE_MODEL` selects the condensation model (default Haiku); the **worker** model is unchanged.

## Out of scope

- **Replacing session rotation** — condensation *delays/prevents* rotation; rotation stays the fallback for fully-exhausted headroom. (`ROTATE_HEADROOM_PCT` / session generations unchanged.)
- **Post-rotation context bundling (#654)** — that re-loads context into a *new* session; this compresses an *existing* one. Complementary, not overlapping.
- **Worker-visible condensation controls** — the worker is unaware condensation happened; no model-facing API for it.
- **Condensing ask-mode or short runs** — targets long `do`-mode delegations under context pressure; trivial runs never hit the trigger.
- **Guaranteeing zero quality impact** — the design *monitors* for drift via `condensation_count`; it does not claim summarization is lossless. (The OpenHands "no regression" result is cited, not assumed for this implementation.)
- **Choosing/tuning the condensation model beyond a config default** — Haiku default is configurable; auto-selecting the cheapest adequate model is a later concern.
- **Multi-level / recursive condensation** (summarizing summaries) — single-level in v1.
- **Cross-hop condensation propagation** — each delegated run condenses its own transcript; sharing summaries up a multi-hop chain is out of scope.
- **Anti-spoof / single-root-write / no-Bash-in-do changes** — all preserved; condenser is an API call, logs under `AGENT_MESH_LOG_DIR`, framework-injected prompt.
