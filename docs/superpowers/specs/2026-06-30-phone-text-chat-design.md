# Phone text-chat input — design

**Status:** design (brainstormed 2026-06-30, approved: through-the-voice-stack + speak+show + bubbles)
**Governs:** CLAUDE.md P1 (voice/text = data ingress only; logic lives in the concierge mesh agent)

## Goal

Let the owner also talk to the concierge by **typing** on the phone PWA, not only by voice — one shared conversation. A typed message is another input into the **existing turn pipeline**, skipping only STT; the reply is **spoken (TTS) and shown**, exactly like a voice turn. Chat renders as **bubbles**.

## Non-goals (YAGNI)

- A separate text-only mode / a path independent of LiveKit (chosen against: text rides the voice stack so it shares session + speaks replies).
- Muting TTS for typed replies (they are spoken + shown).
- Message-history persistence beyond the existing in-page log; markdown rendering.

## Architecture (P1: ingress moves data, concierge holds logic)

```
📱 type → publishData({text}) over the LiveKit data channel
   → agent_livekit on_data: {text} branch → text_turn(text)   (respects the busy lock)
   → POST serve_turn /turn?…&text=<t>  (empty body; SKIP STT)
   → handle_turn: transcript = t → concierge (A2A SendMessage) → TTS
   → reply audio + {transcript,reply} data msg back
   → PWA renders user + bot BUBBLES, plays the spoken reply   (existing reply path)
```

## Components

**A — `voice-server/turn_input.py` (new, pure, testable).** `parse_turn_request(query) -> {mode, text, stt, lang}` where `query` is the parsed query dict (`{k:[v]}`). `text` present & non-empty → `mode:'text'` (bounded to 4000 chars); else `mode:'audio'`. `stt`/`lang` normalized as today. No I/O — unit-tested.

**B — `voice-server/serve_turn.py` (`/turn`).** Use `parse_turn_request`. When `mode=='text'`: skip audio preprocess/clip-save, and in the brain path make the `_stt` closure **return the provided text** (skip real STT). Everything after STT (capture, A2A concierge call via `handle_turn`, TTS, `X-Transcript`/`X-Reply` headers) is unchanged. The `ingress-no-logic` guard still holds (this is plumbing, not logic).

**C — `voice-server/agent_livekit.py`.** Add `Bridge.text_turn(text)`: mirror `flush()` — set `busy`, `post_turn(b"", build_turn_url(...)+"&text="+quote(text))`, then the same publish path (`speaking` mute-toggle, `{transcript,reply,idea,stt}` data msg, `play_wav`). `on_data` gains a `{text}` branch → `asyncio.create_task(bridge.text_turn(m["text"]))`. Empty/whitespace or `busy` → ignored.

**D — PWA (`web/index.html` + `web/app.js`).**
- **Bubbles:** replace the `you:`/`bot:` line styles with chat bubbles — user right-aligned (accent), bot left-aligned (dark). `log(who, text)` emits a `.msg.<who>` bubble.
- **Input bar:** a text field + send (➤) button below the log; matches the dark/pill theme.
- **Send:** on ➤/Enter (when connected) → `publishData({text})`, **optimistically render the user bubble**, set `pendingText`, clear the field.
- **Dedupe:** the reply data msg carries `transcript` = the typed text; when `m.transcript === pendingText`, skip re-rendering it (clear `pendingText`) and render only the bot bubble. Voice turns (no `pendingText` match) render `transcript` as the user bubble as today.

## Error handling (failure = data)

- serve_turn text turn reuses `handle_turn`'s fallback (returns the "can't reach assistant" reply text) — never throws out.
- `text_turn` wraps in try/except like `flush()`; a failure logs and clears `busy`, never crashes the agent.
- Empty typed message → ignored client-side and agent-side.

## Testing (repo posture)

- **Python unittest:** `voice-server/test_turn_input.py` for `parse_turn_request` (text present → text mode + bounded; absent → audio; stt/lang defaults & normalization; oversize text truncated). `serve_turn.py` stays `py_compile`-checked; the existing `test_ingress_no_logic.py` guard still passes (no brain logic added).
- **PWA JS:** untested (matches existing `app.js`); `node --check` for parse.
- No new runtime dependencies.
