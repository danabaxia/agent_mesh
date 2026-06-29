# Phone-to-PR Idea Processing — design

**Status:** design (brainstormed 2026-06-29)
**Governs:** CLAUDE.md Principles P1–P3 (voice = data ingress · logic = registered mesh agent · MVP→production spec-first)

## Problem

Phone-captured ideas stall. The mobile concierge captures an idea and files it as an `idea` issue, but nothing moves it forward automatically: spec drafting, approval, build, and PR opening all require a human to manually sequence the pipeline. The friction kills most captured ideas before they become PRs.

## Goal

Build a **phone-to-PR conveyor**: once the owner approves the spec on the phone, a phone-origin idea automatically advances through analyst spec-drafting → phone approval tap → branch-isolated do-mode build → PR opened, with the PR link and stage-transition status pushed back to the phone. Every existing stage is reused unchanged; this spec adds only the orchestration glue, origin tagging, and phone surfacing.

## Design

New components:

- **Origin tagging (mobile concierge)** — marks phone-captured ideas so the conveyor can pick them up and route status back to the originating phone session.
- **Phone-to-PR orchestrator** — the conveyor that advances a phone-origin idea through intake → spec → approval → build → PR, owning the per-idea state record. Reuses existing stage components; adds no new build capability.
- **State record** — `capture_id → issue → spec → PR` linkage; resumable, queryable for phone status.
- **Phone approval surface (reused/extended)** — presents the spec/impact plan (pairing with #518's planning pass) for a confirm tap on the phone; approve → build, reject → stop.
- **Status notifier (phone)** — pushes stage transitions and the final PR link back to the phone.
- **Existing stages (reused, unchanged):** idea intake, analyst spec drafting, branch-isolated do-mode build, PR creation.

## Data flow

1. Owner captures an idea on the phone → concierge creates a **phone-origin** idea issue; state record opens (`capture_id` linked).
2. The orchestrator drives the idea into spec drafting (analyst) → a design spec is produced and linked in the state record.
3. The spec/impact plan (via planning-pass #518) is surfaced to the **phone** for a confirm tap.
   - **Reject** → flow stops, status pushed to phone, no build.
   - **Approve** → proceed.
4. Branch-isolated do-mode build runs → **opens a PR**, linked to the issue and the state record.
5. The PR (and subsequent status) is pushed back to the **phone**; the owner sees the captured idea become a PR.
6. Stage failures at any point surface to the phone as status, not silent stalls.

## Testing

Hermetic, stage-level and orchestration tests:

- **End-to-end (happy path):** a phone-origin idea advances capture → spec → approve → build → **PR opened**, with the state record correctly linking `capture_id → issue → spec → PR`.
- **Approval gate preserved:** the build **does not run** until the phone confirm tap; reject → no build, flow stopped, status surfaced.
- **Phone-origin tagging:** only phone-captured ideas enter the conveyor; non-phone ideas follow the normal pipeline unchanged.
- **Planning-pass integration (#518):** the impact plan is surfaced to the phone before approval, not a raw task string.
- **Branch isolation inherited:** the build's writes land on a scratch branch (no regression to existing do-mode safety).
- **Failure surfacing:** a forced spec/build failure pushes a status back to the phone and does not silently stall; the state record reflects the stop point.
- **Resumability:** the state record allows a partially-progressed idea to be queried/resumed; the owner can see where any captured idea is.
- **PR linkage:** the opened PR references the originating issue/capture.
- **No new build capability:** assert the conveyor reuses existing stages (orchestration only), not a parallel build path.

## Out of scope

- **Removing the human approval gate** — automation is *to* the phone, not *past* it; the confirm tap (and §5.3-style approval) is preserved. Fully unsupervised idea→PR is explicitly excluded.
- **Auto-merging the PR** — the flow ends at an **opened, linked PR**; review/merge remains the existing (human/agent) gated process.
- **Building new spec/build/PR capability** — reuses analyst spec drafting, branch-isolated do-mode, and PR creation; this is orchestration + phone surfacing only.
- **Voice-capture/STT quality improvements** — transcript fidelity is a separate concern (voice-latency / STT ideas); this consumes whatever the capture produces.
- **Non-phone origination** — targets phone-captured ideas; the general pipeline for other origins is unchanged.
- **Multi-idea batching / prioritization from the phone** — single-idea conveyor in v1.
- **Handling ideas that need clarification** (like a garbled capture) — those route to the normal disambiguation path, not auto-converted to a PR.
- **Path-guard / anti-spoof / write-boundary changes** — none; inherits existing stage boundaries.
