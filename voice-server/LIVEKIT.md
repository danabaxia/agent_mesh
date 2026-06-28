# Phase B — LiveKit streaming voice (status + run-book)

Phase B replaces the demo's HTTP turn server (push-to-talk + sox VAD) with a
**continuous WebRTC stream**: phone ⇄ LiveKit ⇄ a voice agent on the box. The
capture-first durability core (Phase A) is reused unchanged — the agent calls the
same `handle_turn(...)` so an STT/LLM failure still never loses the idea.

## Done (pure code + box standup, tested)

- **Token mint (T10–11):** `token_mint.py` (`mint(identity, room, ttl_s=60)` → short
  room-scoped microphone-only JWT) + `mint_server.py` (bearer-gated `POST /token` →
  `{token,url,room}`, bind 127.0.0.1). Tests: `test_token_mint.py`, `test_mint_server.py`
  (run on the box where `livekit-api`+PyJWT live).
- **LiveKit standup (Spike-3):** `livekit-server` 1.13.2 installed; dev server verified
  live (`livekit-server --dev --bind 0.0.0.0` → :7880 signaling, 7881 TCP, 7882 UDP).
  `livekit.agents` 1.6.4 + `livekit.rtc` present. Token validated against the running server.
- **Phone PWA (T14):** `web/index.html` + `web/app.js` — fetch a token from `/token`,
  join the room (LiveKit JS UMD from CDN), publish mic continuously, play the agent's
  audio reply, render transcript/reply from data messages.

## Standup (box, WSL)

```sh
livekit-server --dev --bind 0.0.0.0           # dev keys: devkey / secret
LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
TOKEN_MINT_SECRET=<device secret> LIVEKIT_WS_URL=ws://<box>:7880 \
  python3 mint_server.py                       # POST /token
```

Serve `web/` over the tailnet HTTPS name (secure context required for `getUserMedia`),
mirroring the `/m` PWA. Open `https://<mac>.ts.net/voice/?t=<device secret>` on the phone.

## Next — the agent (T13), needs the phone in the loop

`agent.py` already holds the tested capture-first ordering core. T13 adds the LiveKit
`entrypoint(ctx)` using the `livekit-agents` 1.6.4 `AgentSession`:

- VAD + end-of-turn detection (`pip install livekit-plugins-silero`).
- On end-of-turn: write the captured audio segment to disk (`audio_ref`), then
  `handle_turn(audio_ref, ts, outbox, stt, brain, tts)` with the demo's adapters —
  faster-whisper STT, Gemini brain, Kokoro **streaming** TTS (first chunk immediately).
- Publish the TTS audio back into the room + a data message `{transcript, reply}`.
- The Phase A syncer drains the outbox to the Mac exactly as before.

This is integration-tested against the phone (a real mic publisher), so it's built and
tuned in that loop — the **"need the phone" point** in the demo-first plan.

## Then — media plane (T15), driving profile + notices (T16), acceptance (T17)

Per Spike-1: mirrored WSL networking vs native; open the LiveKit UDP range
(7882…) in Windows Defender Firewall; prefer direct tailnet UDP, DERP-degrade
explicitly. Spoken next-session notices use the ready `notices(outbox)`.
