# In-Session History Condensation — Design

**Status:** spec (authored 2026-06-30)
**Issue:** [#670](../../issues/670)
**Governs:** CLAUDE.md Principles P2–P3 (logic = registered mesh agent · MVP→production spec-first)

## Problem

Long `do`-mode delegations burn disproportionate tokens and can exhaust the worker's context window mid-task, triggering a cold-start rotation that loses continuity. The current response — session rotation at `ROTATE_HEADROOM_PCT` — is a blunt instrument: the new session starts fresh, the worker re-derives context, and the token spend accelerates. Runs exceeding ~60% of the context window are effectively penalized twice: once for their length, again for the continuity loss on rotation.

## Goal

Add **in-session condensation** as a proactive, low-cost intervention before headroom exhaustion forces rotation. When headroom drops below a configurable trigger threshold, the framework compresses the worker's transcript with a cheap model call, reclaiming headroom so the same session can continue without a cold-start. Rotation remains the fallback for fully-exhausted headroom; condensation only delays or prevents it.

## Design

### Components

- **Headroom monitor** — after each tool-call cycle, re-reads the session's context usage and computes `headroomPct = (contextWindow − usedTokens) / contextWindow`.
- **Condenser (framework-owned)** — a framework-issued API call (default model: Haiku via `AGENT_MESH_CONDENSE_MODEL`) with a framework-injected prompt; worker output is treated as **untrusted data only** (never instructions) — the worker cannot alter the condensation prompt or inject content into the framework's summarization instruction.
- **Condensation log** — `.agent-mesh/logs/<id>.condensation.json` with the summary payload and replaced span; surfaced in the run record as `condensation_count` and in the A2A `agentmesh/metrics` block via `normalizeMetrics`.
- **Config knobs** — `AGENT_MESH_CONDENSE_TRIGGER_PCT` (headroom trigger threshold); `AGENT_MESH_CONDENSE_MODEL` (condensation model, default Haiku); `AGENT_MESH_CONDENSE_DISABLED` (opt-out, `1` disables entirely).

### Data flow

1. The `do`-mode worker session is running; after each tool-call cycle the framework reads the session's context usage and computes `headroomPct`.
2. While `headroomPct` remains above `AGENT_MESH_CONDENSE_TRIGGER_PCT`, the session continues normally. When it crosses the threshold — **before** any rotation check — condensation is triggered.
3. The framework captures the current transcript span (all tool calls and model responses since the last condensation or session start), the condenser issues a cheap Haiku call summarizing: original task · completed steps · files changed · remaining work · open questions.
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
- **Anti-spoof:** task text and worker transcript content cannot alter the condenser prompt; the summarization instruction is framework-owned and the worker's output is treated as data, not instructions — a compromised worker transcript cannot inject content into the Haiku call's system prompt.
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
