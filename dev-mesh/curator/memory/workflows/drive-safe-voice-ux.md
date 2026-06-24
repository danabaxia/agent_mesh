---
slug: drive-safe-voice-ux
status: active
provenance: "PR #484 (2026-06-24) — feat(voice-demo): hands-free continuous conversation mode (drive-safe)"
---

# Pattern: Drive-Safe (Eyes-Free / Hands-Free) Voice UX

## When to apply

When building a voice feature for a safety-critical or distracted-attention context
(driving, walking, cooking) — any scenario where the user cannot look at the screen
or tap per turn.

## The five design constraints

| Constraint | Mechanism |
|------------|-----------|
| **No per-turn tap** | Energy-VAD detects speech start → auto-capture → auto-speak → auto-resume. One entry tap per session only. |
| **Eyes-free state feedback** | Audible earcons (heard / saved / listening / stopped / resumed) for every state transition. Never rely on a visual indicator the user might miss. |
| **No self-capture** | Mic is paused during model think + TTS speak. The assistant's own audio never feeds back into the next capture window. |
| **Confirm before commit** | For high-stakes operations (filing an idea, sending a message), read back the content and wait for a verbal confirmation word (好/对/yes) before writing. "Saved" ack + earcon fire only on confirmed write. |
| **Honest latency scope** | Sub-300ms end-to-end needs a streaming API (e.g. Gemini Live). Without it, use chunked sentence TTS: synthesize sentence N+1 while sentence N plays. Document this gap as an accepted v1 trade-off in the rubric. |

## Robustness checklist

- [ ] **Watchdog + audio-graph rebuild** — iOS suspends `ScriptProcessor` on tab resume; detect silence after resume and tear-down/rebuild the audio graph.
- [ ] **`visibilitychange` never overrides `busy`** — if the assistant is mid-reply, a foreground event must not restart capture (echo / concurrent turn).
- [ ] **Interrupt token** — a stop word (e.g. `停`) or re-tap cuts the in-flight generation token AND pauses the audio player.
- [ ] **Double-start guard (sync)** — a click handler can fire twice before the first async path settles; guard with a synchronous flag so no leaked mic context or AudioContext is created.
- [ ] **Monologue cap** — bound single-utterance capture length (e.g. 90 s) to prevent OOM on runaway ambient audio.
- [ ] **Shared earcon AudioContext** — one `AudioContext` instance for all earcons; creating per-earcon hits the browser limit on some devices.
- [ ] **Object-URL revocation** — revoke `createObjectURL` blobs after the audio element loads to prevent memory leaks.

## Rubric-grounding

Anchor the spec on published safety research before implementation:
- **NHTSA driver-distraction rule**: visual glances > 2 s / cumulative > 12 s are impaired. Every state transition must be perceivable without a glance.
- **Voice-turn latency targets**: < 300 ms (imperceptible) / < 500 ms (acceptable) / < 800 ms (marginal). Document which tier the build achieves and why.
- **VAD + endpointing**: tune `end-pause` (mid-idea pause grace) and sensitivity as user-facing sliders; do not bake constants.

## What to defer to v2

- **Full barge-in** (talking over the reply): v1 accepts a tap-to-interrupt. True barge-in requires a streaming API that can abort mid-generation; flag it honestly in the rubric and the PR description.

## Testing gate

Gate the PR on:
1. Static validity of the voice JS (`node --check` or equivalent).
2. Existing `mesh-tools.test.js` green (no regression on unrelated mesh surface).
3. A written rubric scorecard capturing which experiential dimensions (fluency / latency feel / drive-safe in practice) require a real-environment test by the owner — do not claim those dims pass without a real drive test.

## Provenance

PR #484 (2026-06-24): hands-free continuous conversation mode with VAD auto-capture,
earcons, chunked-sentence TTS, confirm-before-file, and 9 independent-review bugs
fixed (watchdog / visibilitychange / interrupt token / double-start guard / monologue
cap / shared AudioContext / object-URL revocation / mic-send guard).
