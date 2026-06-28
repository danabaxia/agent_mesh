---
slug: voice-logic-in-mesh-agent
status: active
provenance: "PR #618 (2026-06-28) — docs(governance): voice-logic-in-mesh principles + Codex-reviewed spec"
---

# Pattern: Voice-Ingress-Only + Logic in a Registered Mesh Agent

## When to apply

When building or reviewing any voice/UI service that is connected to a mesh. Any time
reasoning, mesh-querying, idea-classifying, or conversation memory appears *inside* the
voice service, this pattern applies.

Canonical smell: a "brain" module (`serve_turn.py`, an LLM call, a system prompt) lives
**inside** the voice service. That is a P1/P2 violation and must be refactored.

## The governing principle

**A voice/UI service is a data ingress, never logic.**

```
❌ WRONG                                 ✅ CORRECT
────────────────────────────────────     ─────────────────────────────────────────
┌─ Voice service ──────────────────┐     ┌─ Voice service (data only) ──────────┐
│  STT → brain (LLM, sys prompt,  │     │  STT → commit raw turn to outbox     │
│  memory, tool dispatch) → TTS   │     │  └─ A2A SendMessage(transcript) ──▶  │
└──────────────────────────────────┘     └──────────────────────────────────────┘
                                                              │
                                         ┌─ Registered mesh agent ◀────────────┘
                                         │  prompts/system.md  (obeyed)
                                         │  AGENT.md           (data only)
                                         │  memory/            (bounded, framed)
                                         │  tools              (schema-bound)
                                         └─ returns A2A Task → TTS → phone
```

## Split responsibilities

| Layer | Owns | Never does |
|-------|------|-----------|
| **Voice ingress** | PTT capture, STT, outbox commit, A2A SendMessage, TTS play | System prompt, memory, tool dispatch, mesh queries, idea classification |
| **Registered mesh agent** | System prompt (`prompts/system.md`), reasoning, tools, memory | Audio, STT, TTS, LiveKit, session UX |
| **Brain selection** | Agent's own `agent.json` (`x-agentmesh.runner: {kind: "gemini"\|"claude"}`) | Caller-declared override — a peer registry cannot change another agent's brain |

## Implementation checklist

1. **Strip the ingress**: remove `SYS`/`brain_turn`/tool loops/memory from the voice
   server. The ingress's only logic is: proven-silence check, STT-validation, and
   one A2A `SendMessage`.
2. **Capture-first stays in the ingress** (data, not reasoning): commit
   `{captureId, audio_ref, transcript:null, state:captured}` to the outbox
   *before* STT and *before* the A2A call — see [[capture-first-voice-pipeline]].
3. **Register the logic agent** in the mesh: own `prompts/system.md` (obeyed),
   `AGENT.md` (data/description only, length-bounded), `memory/` (bounded, data-framed),
   declared schema-bound tools. Serve it via `serve-a2a`; register it in `mesh.json`.
4. **Agent-owned brain**: set `x-agentmesh.runner: {kind: "gemini"}` in the agent's
   own `agent.json`. A caller's `registry.json` may name the agent as a peer but cannot
   override its runtime. `doctor`/`discover` carry the runner from the served card.
5. **ask-only for the voice-logic agent**: `propose_idea` / `list_agents` / `ask_peer`
   — no direct writes; every write-adjacent action (gh-issue filing) is gated externally.
6. **Enrichment before TTS**: apply any structured enrichment (idea title/note) to the
   captured outbox row *before* TTS — a TTS failure must never strand an applied enrichment.
   Enrichment failures leave an `enrichment_pending` marker (idempotent by `captureId`).

## Anti-patterns

- **System prompt in the voice server** — any `SYS =` / system-prompt string → move it
  to `dev-mesh/<agent>/prompts/system.md`.
- **`record_idea` auto-filing in the ingress** — all writing is a separate gated step;
  the ingress only emits a durable capture row.
- **Caller-set brain** — a registry.json `peer.runner` override is a spoof surface;
  the runner must come from the served card.
- **`AGENT.md` as the obeyed prompt** — it is bounded description *data* for
  `describe_self`; the runner obeys `prompts/system.md` only.

## Testing gate (hermetic, no live model)

- **Negative test**: assert the voice ingress holds **no** system prompt, no tool loop,
  and makes no direct mesh-query beyond the single A2A `SendMessage`.
- **Brain-selection test**: `x-agentmesh.runner:{kind:"gemini"}` on the served card →
  gemini brain; an existing `{command}` ScriptRunner card still resolves; a *caller*
  registry override is silently ignored.
- **ask-only test**: a write / `do`-mode attempt on the logic agent is refused before
  any side effect; `propose_idea` performs no write.
- **Obeyed-prompt vs data**: `prompts/system.md` is what the runner passes as the system
  prompt; a malicious `AGENT.md` / `memory/` entry cannot change tool dispatch.

## Provenance

PR #618 (2026-06-28): codified three governing principles into `CLAUDE.md` and the
full re-architecture spec (`docs/superpowers/specs/2026-06-28-voice-logic-in-mesh-agent-design.md`).
The current MVP violated P1/P2 (`serve_turn.py` brain living inside the voice service);
the spec is the corrective path. Review: 6 Codex (gpt-5.5) rounds, every blocking/major
finding accepted, zero rebuttals.

PR #620 (2026-06-28): **implemented** the full spec. 278/278 JS tests + 18/18 Python tests green;
no live model in the gate (fake brain / fake transport throughout). Key implementation note:
run records from `gemini-agent.js` must carry the exact field names delegate.js uses
(`started_at`, `finished_at`, `route`, `root`) or health-model silently drops all Gemini runs.
This was an Important finding in the final review wave — see `multi-brain-run-record-parity`
in quick.json. Negative test (`test_ingress_no_logic.py`) asserts no system prompt, no tool
loop, and no direct mesh query remain in the voice ingress beyond the single A2A SendMessage.

Source issue: #616 (user-requested: connect voice assistant with all mesh agents on
Windows and Mac via direct A2A routing).
