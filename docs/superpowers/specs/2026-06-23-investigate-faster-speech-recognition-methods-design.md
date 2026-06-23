# Investigate Faster Speech Recognition Methods — Design

Resolves issue #425 ("The current speech broadcast is too slow. We need to explore and implement better speech recognition methods to improve the speed of voice interaction").

The [PWA Voice Interaction spec](2026-06-22-pwa-voice-interaction-design.md) shipped bidirectional voice for the mobile concierge using the browser-native Web Speech API. That spec deliberately isolated the STT/TTS engine behind a `createVoiceEngine` interface so the implementation could be swapped. This spec drives the measurement-first investigation to determine whether a faster STT path is warranted and, if so, which engine to adopt.

## Goal

Identify whether the STT stage is the dominant latency contributor in the voice round-trip, and if so, select and integrate a faster server-side STT engine that materially reduces end-to-end latency (p50 target: ≤ 300 ms for STT stage alone) while keeping word-error rate (WER) within an acceptable ceiling on representative voice commands.

## Non-goals

- **Pre-committing to a specific engine before measurement** — which engine wins (if any) is an output of the benchmark, not an input to this spec.
- **Changing the voice UX** — interaction model (push-to-talk, language toggle, readback toggle) is unchanged; this is an engine-speed investigation.
- **Cloud/hosted STT** — the stack is local-first on the M4 (privacy + tailnet); offloading to a cloud API is out of scope.
- **Multilingual / new-language expansion** — targets the owner's existing usage patterns.
- **TTS / "broadcast" optimization** — out of scope *unless* Phase 0 measurement shows TTS is the dominant stage (open question #1).
- **Auth, tailnet HTTPS, or `/m` access-control changes** — unchanged.
- **Hardware changes** — optimization targets the existing M4 (MPS/Neural Engine).

## Deliverables

- **Benchmark comparison matrix** — per-engine measurement of latency (p50/p95) and WER side by side. The decision artifact.
- **Pluggable STT engine interface** — an abstraction over "audio in → transcript out" so engines (current Whisper, `faster-whisper`, `whisper.cpp`, distilled, streaming) are swappable behind one contract.
- **Selected recognition engine adapter** — the integration of whichever engine wins, implementing the interface.
- **Config (`src/config.js`)** — `AGENT_MESH_VOICE_STT_ENGINE` (engine selector, default = winner), model-size/param knobs, and a fallback flag.
- **Voice surface (`/m` PWA + server voice route)** — unchanged UX; consumes the engine interface. Auth/tailnet gating untouched.
- **(Conditional) TTS path** — touched only if Phase 0 shows the "broadcast"/TTS stage is the real bottleneck.

## Data flow

1. **Measurement:** owner uses push-to-talk; instrumentation records per-stage timings → latency table (p50/p95) identifies the dominant stage(s).
2. **Decision gate:** if STT dominates → proceed to candidate benchmarking; if TTS/transport/reasoning dominates → re-scope to that stage (open question #1).
3. **Benchmarking:** the harness runs the clip corpus through each candidate STT engine on the M4 → latency + WER table → select the engine meeting the latency goal within the WER ceiling.
4. **Integration runtime:** owner releases push-to-talk → audio reaches the server → the configured STT engine (selected winner) transcribes → transcript flows into the existing reasoning/concierge spawn → reply text → TTS → playback. Instrumentation continues recording per interaction.
5. **Fallback:** if the new engine errors or is disabled by config, the pipeline falls back to the existing Whisper path.

## Testing

- **Instrumentation correctness:** per-stage timings sum (within tolerance) to the measured end-to-end latency; each stage is attributed.
- **Baseline capture:** the current Whisper path produces a recorded p50/p95 latency and WER on the clip corpus — the comparison floor.
- **Benchmark reproducibility:** the harness yields stable per-engine latency/WER across repeated runs on the M4 (variance reported).
- **Latency improvement:** the selected engine shows a materially lower STT p50/p95 than the Whisper baseline on the corpus.
- **Accuracy guard:** the selected engine's WER stays within the configured ceiling — assert no unacceptable transcription regression on representative commands.
- **Engine interface conformance:** each candidate adapter satisfies the "audio → transcript" contract (same input/output shape).
- **Config switch:** `AGENT_MESH_VOICE_STT_ENGINE` selects the engine; invalid/unset → documented default; fallback flag restores Whisper.
- **Fallback path:** a forced engine failure falls back to Whisper without breaking the voice round trip.
- **Surface unchanged:** push-to-talk UX, auth gating, and tailnet HTTPS behavior are unaffected by the engine swap.

## Out of scope

- **Pre-committing to a specific engine** — the winning method is an output of the benchmark, not an input to this spec.
- **TTS / "broadcast" optimization** — out of scope *unless* Phase 0 measurement shows TTS is the dominant stage (open question #1); if so, it is re-scoped as its own effort using the same benchmark-first method.
- **Reasoning-stage latency** (the concierge/model ask spawn) — measured for attribution but not optimized here; model/prompt latency is a separate concern.
- **Changing the voice UX** (push-to-talk model, continuous listening, wake-word) — the interaction model is unchanged; this is an engine-speed effort.
- **New languages / multilingual recognition** — targets the owner's existing usage; multilingual expansion is separate.
- **Cloud/hosted STT** — the stack is local-first on the M4 (privacy + tailnet); offloading recognition to a cloud API is explicitly not proposed.
- **Auth, tailnet HTTPS, or `/m` access-control changes** — unchanged.
- **Hardware changes** — optimization targets the existing M4 (MPS/Neural Engine); new hardware is out of scope.
