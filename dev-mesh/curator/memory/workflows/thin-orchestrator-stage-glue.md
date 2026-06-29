---
slug: thin-orchestrator-stage-glue
status: active
provenance: "PR #650 (2026-06-29) — spec: Phone-to-PR Idea Processing (#644)"
---

# Pattern: Thin Orchestrator as Stage Glue

## When to apply

An idea pipeline has all necessary stages (capture → spec → build → PR) but ideas
stall at each handoff: no agent sequences them, no state survives the boundary, and
the originator never learns where their idea is.

## Why it matters

Adding new capabilities doesn't fix stalls; the stages already exist. The missing
layer is a **thin orchestrator** that owns the per-item state record and advances
items through existing stages, while preserving every human gate along the way.
PR #650 codified this pattern for the Phone-to-PR pipeline.

## The pattern

Three additive pieces — no stage is modified:

1. **Origin tagging (at ingress):** mark items entering the conveyor so the
   orchestrator can pick them up and route status back to the originator.
   Non-tagged items continue through their normal pipeline unchanged.

2. **Durable state record:** `capture_id → issue → spec → PR`. Resumable and
   queryable. The orchestrator advances this record as each stage completes;
   failures surface at the exact stop point rather than silently stalling.

3. **Status pushback (at egress):** route stage-transition events back to the
   originator's surface (phone, Slack, email). The originator sees progress
   without polling.

## Human gate invariant

**Automation advances toward the gate, never past it.**

The conveyor ends at an opened PR — not a merged one. Every existing human approval
checkpoint is preserved. The only new automation is the sequencing logic between
stages; each gate still requires a human action to unblock.

## What NOT to add

- New build capability — reuse existing stage implementations unchanged.
- Multi-item batching — single-item conveyor in v1.
- Gate removal — automation-past-a-gate is explicitly out of scope.
- Retry/fallback for failed stages — surface the failure to the originator; the
  human decides next action.

## Testing checklist

- **Happy path:** item advances `capture → spec → approve → build → PR opened` with
  state record correctly linking all artifacts.
- **Approval gate preserved:** build does NOT run until the human confirms.
- **Origin tagging:** only tagged items enter the conveyor; untagged items follow
  the normal pipeline unchanged.
- **Failure surfacing:** a forced stage failure pushes status to the originator and
  does not silently stall; state record reflects the stop point.
- **Resumability:** a partially-progressed item can be queried and resumed.

## Related patterns

- `safe-autofix-do-worker` — autonomous do-mode pipeline with budget cap and
  fork-PR guard; complementary for the build stage of this pattern.
- `agent-reasoning-host-action-split` — agent emits JSON; host builtin applies
  side effects; the same cognitive/side-effect split applies inside each stage.
