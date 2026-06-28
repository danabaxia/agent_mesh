# Review log — voice-logic-in-mesh-agent

Codex (gpt-5.5, xhigh, read-only) ⇄ Claude, independent-review loop.

## Round 1 — VERDICT: CHANGES_REQUESTED (3 BLOCKER, 6 MAJOR) — all accepted, fixed (no rebuttals)

| # | sev | finding | resolution |
|---|-----|---------|------------|
| 1 | BLOCKER | AGENT.md as both obeyed prompt and "untrusted data" | obeyed prompt → `prompts/system.md`; AGENT.md = bounded description data only (both brains) |
| 2 | BLOCKER | ask-only contradicts `record_idea` writing a gh issue | agent only `propose_idea` (no write); filing = separate gated step |
| 3 | BLOCKER | capture-first durability ambiguous once record_idea moves to agent | capture-first stays in the **ingress** (commit raw turn before A2A); agent enriches against `captureId` |
| 4 | MAJOR | `SendMessage({text,sessionId,lang})` not A2A v1 shape | exact mapping: `parts=[text]`, `contextId`, `metadata.agentmesh/{mode,lang,captureId}` + tests |
| 5 | MAJOR | "sibling of delegate.js" bypasses mode gates/logs/metrics/recursion/timeout/parity | route through a **shared A2A runner** (stdio+http); brain is a swappable step |
| 6 | MAJOR | caller registry declaring `runtime:"gemini"` is a spoof surface | runtime is **agent-owned** (`agent.json x-agentmesh.runner`); caller registries ignored + test |
| 7 | MAJOR | `mesh_tools_server` over reverse SSH bypasses grant model | `ask_peer` via the **framework peer bridge**; read tools as schema-bound allowlisted adapters |
| 8 | MAJOR | memory/session unbounded, not restart-safe/injection-safe | reuse session/memory pattern: TTL+size caps, durable, data-framed, concurrency + tests |
| 9 | MAJOR | invariants lack negative coverage | added L0 negatives: ingress-has-no-logic, http parity, runtime-override-ignored, ask-only-no-write |

## Round 2 — VERDICT: CHANGES_REQUESTED (1 BLOCKER, 1 MAJOR) — both accepted, fixed

| # | sev | finding | resolution |
|---|-----|---------|------------|
| 1 | BLOCKER | capture still after STT / drops garbled transcripts → violates raw-turn durability | capture-first now saves `audio_ref` + `{transcript:null,state:captured}` **before STT** (reuse `handle_turn` Task-12 ordering); only proven silence dropped; STT-fail leaves a captured row; test added |
| 2 | MAJOR | `x-agentmesh.runner:"gemini"` collides with existing `{command}` ScriptRunner schema; modes in wrong file | discriminated `x-agentmesh.runner:{kind:"gemini"}` (additive, `{command}` preserved); `x-agentmesh.modes` in card + `enabledModes` in `mesh.json`; collision test added |

## Round 3 — VERDICT: CHANGES_REQUESTED (1 BLOCKER) — accepted, fixed

| # | sev | finding | resolution |
|---|-----|---------|------------|
| 1 | BLOCKER | leftover: Error-handling said "empty transcript → no capture", contradicting capture-first | empty/garbled (real audio) stays captured + re-transcribable, skip only A2A; full-drop only on proven silence |

## Round 4 — VERDICT: CHANGES_REQUESTED (1 BLOCKER, 1 MAJOR) — both accepted, fixed

| # | sev | finding | resolution |
|---|-----|---------|------------|
| 1 | BLOCKER | "below MINDUR" as proven silence would drop short real utterances pre-capture | proven silence = no captured frames / energy-confirmed no-speech, never a duration threshold; short real audio still captured |
| 2 | MAJOR | A2A failures return as Task data; ingress assumed a reply artifact | require `TASK_STATE_COMPLETED` + reply artifact before TTS/enrich; rejected/failed/no-artifact → fallback, capture unchanged |

## Round 5 — VERDICT: CHANGES_REQUESTED (1 BLOCKER) — accepted, fixed

| # | sev | finding | resolution |
|---|-----|---------|------------|
| 1 | BLOCKER | leftover `below MINDUR` in the Error-handling line (round-4 fix missed this location) | same fix applied: proven silence = no captured frames / energy-confirmed no-speech, never a duration threshold; duration may skip A2A, never skips capture |

## Round 6 — confirmation pass — VERDICT: CHANGES_REQUESTED (1 MAJOR, 2 MINOR) — all accepted, fixed

The round-5 BLOCKER was confirmed resolved (0 `MINDUR` references remain). Codex surfaced three *new* quality refinements (no safety regressions; the core invariants — capture-first, A2A Task-state gating, agent-owned runner, ask-only — have been stable since rounds 3–4):

| # | sev | finding | resolution |
|---|-----|---------|------------|
| 1 | MAJOR | enrichment applied after TTS with no failure path → a TTS/apply failure could strand a completed idea proposal | apply enrichment **before & independent of** TTS; on apply failure mark `enrichment_pending` (idempotent by `captureId`, re-applied on next sync); added TTS-failure + apply-failure error bullets + tests |
| 2 | MINOR | STT `attach_transcript` ran before the empty/garbled check | validate the **candidate** transcript first; only a valid candidate is attached/forwarded; empty/garbled stays `transcript:null` |
| 3 | MINOR | negative test "no mesh call" contradicts the one required concierge `SendMessage` | reworded: "no system prompt / no tool loop / no direct mesh-query/list/status/peer call **beyond the single concierge A2A `SendMessage`**" |

## Convergence

Round cap (5) reached and exceeded by one confirmation pass. The three security invariants Codex flagged in round 1 (AGENT.md-as-data, ask-only/no-write, agent-owned runtime) plus the capture-first durability ordering have been stable and unchallenged since round 4; round 6 produced only quality refinements, all accepted and folded in. **Finalized.** No unresolved disagreements; no rebuttals were needed across the whole loop (every Codex finding was correct and accepted).
