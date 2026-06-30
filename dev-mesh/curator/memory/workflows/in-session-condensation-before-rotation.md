---
slug: in-session-condensation-before-rotation
status: active
provenance: "PR #673 (2026-06-30) — spec: in-session history condensation (#670)"
---

# Pattern: In-Session Condensation Before Rotation — Framework Compresses, Worker Is Data

## When to apply

When a long-running delegated `do`-mode session approaches context headroom limits
and the framework needs to preserve task continuity without losing in-progress work.

Canonical smell: session rotation fires mid-task and the new session restarts cold,
re-deriving context the old session already had. Token burn grows linearly; rotation
is the only fallback.

## The governing principle

**Condensation precedes rotation; the condensation prompt is framework-owned.**

The framework issues a cheap secondary model call (Haiku-class) to compress the
worker's transcript *before* headroom exhaustion triggers rotation. The worker's
output is treated as **untrusted data** — never as instructions — for the condenser
call. The worker is unaware condensation happened. Rotation remains the fallback for
fully-exhausted headroom.

```
headroomPct drops below CONDENSE_TRIGGER_PCT
        │
        ▼
CONDENSER (framework-owned system prompt, injected by framework)
  input:  transcript span — raw DATA, not trusted instructions
  output: structured {task · completed · files · remaining · open-questions}
  model:  cheap (Haiku by default; AGENT_MESH_CONDENSE_MODEL configurable)
        │
        ▼
inject <mesh:condense-summary> into RESUMED session
        (worker continues — unaware condensation happened)
        │
        ▼           ← only if headroom is still exhausted afterward
ROTATION (fallback)
  new session's initial prompt carries latest condensed summary
  → continuity instead of cold start
```

## Key invariants

1. **Framework-owned prompt**: the condensation instruction is injected by the
   framework. A compromised worker transcript cannot alter what the condenser is
   asked to do. The anti-spoof invariant applies here too.
2. **Worker output is data**: the transcript is passed as raw data to the condenser;
   the worker cannot inject instructions into the Haiku system prompt. Wrap with
   REFERENCE framing or equivalent when constructing the condenser call.
3. **Failure is data, not exception**: condenser-call failure → log it, proceed
   without condensation, never throw. Rotation stays available as the safety net.
4. **Condensation precedes rotation, does not replace it**: rotation stays as the
   fallback for fully-exhausted headroom. Condensation only delays or prevents it.
5. **Audit trail**: write `.agent-mesh/logs/<id>.condensation.json`; surface
   `condensation_count` in the run record and `agentmesh/metrics` so the perf
   scorecard can detect compression-induced quality drift over time.
6. **Opt-out**: `AGENT_MESH_CONDENSE_DISABLED=1` restores today's rotation-only
   behavior with zero code change — a required regression lock.

## Anti-patterns

- **Rotation-only**: no condensation → cold-start continuity loss on every long
  delegation. Condensation is the proactive intervention; rotation is the fallback.
- **Worker-visible signals**: if the worker can detect or alter condensation, it can
  poison the summary. Keep the condense step transparent to the worker.
- **Condenser throws on failure**: a failed condenser that aborts the delegation
  violates failure-as-data. Log the failure; proceed without condensation.
- **Condensing short / ask-mode runs**: condensation targets long `do`-mode sessions
  under context pressure. Trivial or ask-mode runs should never hit the trigger.
- **Hardcoded condensation model**: always expose the model as a config knob —
  default cheap (Haiku), but operators may need to adjust for their deployment.
- **Confusing with post-rotation context bundling (#654)**: that reloads context
  into a *new* session. Condensation compresses an *existing* session. Complementary,
  not overlapping.

## Testing gate (hermetic, no live model)

- **Trigger ordering**: condensation fires before any rotation check when
  `headroomPct` crosses `CONDENSE_TRIGGER_PCT`.
- **Framework-owned prompt**: the condenser is called with the framework-injected
  system prompt; worker transcript content cannot alter it (anti-spoof).
- **Failure-as-data**: condenser failure → logs it, proceeds without condensation,
  no throw, rotation still available.
- **Continuity injection**: `<mesh:condense-summary>` block appears in the resumed
  session; the worker receives no signal that condensation occurred.
- **Rotation handoff**: when headroom is fully exhausted, the new session's initial
  prompt carries the latest condensed summary (no cold start).
- **Metrics**: `condensation_count` in run log and `agentmesh/metrics`, increments
  per condensation; `normalizeMetrics` preserves it.
- **Opt-out**: `AGENT_MESH_CONDENSE_DISABLED=1` → no condensation; behavior
  identical to today (regression lock).

## Provenance

PR #673 (2026-06-30): spec for in-session history condensation (Issue #670).

Extends the existing anti-spoof invariant ("AGENT.md is data, never instructions")
to a new surface: the worker's own transcript is data for the framework's condenser,
not a source of instructions. Builds on [[voice-logic-in-mesh-agent]] (framework
owns data flow, ingress is never logic) and the **failure-as-data** invariant
(CLAUDE.md Invariants section).

Research basis: OpenHands SDK v1 `LLMSummarizingCondenser` (50% token reduction,
no SWE-Bench accuracy regression) and SWE-agent observation collapsing.
