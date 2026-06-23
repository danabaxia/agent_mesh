lting audio chunk to the client, in order, while later sentences are still arriving. Manages per-chunk retry and Kokoro-fast fallback.
- **Client audio queue (`voice-demo/` front-end)** — receives ordered audio chunks (over the existing transport / SSE), enqueues, and plays gaplessly in sequence; begins playback on the first chunk.
- **Transport** — streams text deltas (optional, for on-screen text) and ordered audio chunks to the client; reuses the demo's existing streaming channel where possible.
- **Fallback controller** — detects stream/TTS errors and routes the turn to Stage A single-shot + batch TTS or Kokoro-fast.
- **Latency instrumentation** — records time-to-first-audio and full-turn latency per interaction to verify the ≤3 s acceptance target.

## Data flow

1. User finishes speaking/typing → local Whisper produces the transcript (unchanged).
2. Server calls Gemini `streamGenerateContent` with the transcript; any auto mesh-tool calls (`file_mesh_task`/`get_mesh_status`/repo read+search) are handled as in Stage A.
3. Text deltas stream in; the segmenter accumulates and emits the **first complete sentence** as soon as it's ready.
4. The TTS orchestrator synthesizes sentence 1 immediately and ships its audio chunk to the client **while** sentences 2…N continue generating.
5. The client audio queue plays sentence 1's audio (~2–3 s after the user finished), then plays subsequent chunks in order as they arrive.
6. On any stream/TTS error → fallback controller degrades the turn (single-shot + batch TTS, or Kokoro-fast) so it still completes.
7. Instrumentation logs time-to-first-audio for the turn.

## Testing

- **Time-to-first-audio (acceptance):** for a short reply, first audio begins **≤3 s** after the user finishes — assert against recorded instrumentation on representative turns.
- **Overlap correctness:** TTS of sentence 1 starts before the full reply finishes generating (pipelining actually happens, not just reordered serial work).
- **Ordering:** audio chunks play in reply order regardless of per-chunk TTS timing variance (queue preserves sequence).
- **Voice unchanged:** synthesized audio still uses Gemini TTS — no fallback-to-Kokoro on the happy path (naturalness acceptance).
- **Mesh-tool behavior:** `file_mesh_task` / `get_mesh_status` / repo read+search still fire correctly within a streamed turn (no regression vs. Stage A).
- **Segmentation:** multi-sentence replies split into the expected units; a boundary-less buffer flushes on timeout rather than stalling.
- **Stream-error fallback:** a simulated `streamGenerateContent` failure falls back to single-shot + batch TTS; the turn still completes audibly.
- **TTS-error fallback:** a simulated chunk TTS failure retries then falls back to Kokoro-fast for the remainder; ordering preserved.
- **Short-reply cap:** replies remain within the existing cap (shallow queue).
- **Latency non-regression:** full-turn latency is no worse than Stage A even though first-audio is much earlier.

## Out of scope

- **Gemini Live / realtime bidirectional native audio** — unavailable with the current key; revisit if a Live-access key becomes available. Stage B does not implement barge-in/interruption.
- **Interruptibility (barge-in)** — letting the user cut off playback mid-reply is a Live-tier feature, not part of Stage B.
- **Replacing local Whisper STT** — ruled out (Gemini STT slower + less accurate); STT stage is unchanged.
- **Changing the voice / TTS provider or naturalness** — still Gemini TTS; no voice change.
- **New API keys or models** — Stage B uses the existing `GEMINI_API_KEY` and current models only.
- **Changing the agent's reasoning, tools, or reply content** — only delivery timing (streaming + chunked TTS) changes.
- **Productionizing beyond `voice-demo/`** — spec/impl belongs with the demo surface; integration into the main `/m` PWA is a separate effort.
- **STT-side latency work** — covered by the related research idea #425; Stage B targets the reply→audio path.
