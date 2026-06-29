"""LiveKit voice agent (T13): bridge the phone's continuous mic stream to the tested
turn pipeline. Connects to the room, energy-VAD-segments the caller's speech, POSTs
each turn to the local serve_turn HTTP server (capture-first → STT → Gemini → Kokoro,
which also writes the outbox the Phase-A syncer drains to the Mac), then publishes the
reply audio back into the room + a {transcript,reply} data message.

Reuses the whole tested turn pipeline (serve_turn) — this file is only LiveKit I/O.
Env: LIVEKIT_WS_URL, LIVEKIT_API_KEY/SECRET, LK_ROOM, TURN_URL, VAD_GATE, VAD_END_SIL.
"""
import asyncio
import io
import json
import os
import urllib.parse
import urllib.request
import wave
from collections import deque

import numpy as np
from livekit import api, rtc

from turn_route import build_turn_url

LK_URL = os.environ.get("LIVEKIT_WS_URL", "ws://127.0.0.1:7880")
LK_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
LK_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")
ROOM = os.environ.get("LK_ROOM", "drive-room")
# STT backend is chosen in the PWA (Gemini ☁️ / GPU 🖥️ whisper) and defaults to
# Gemini — an LLM transcriber that handles in-car code-switching and domain terms
# better; whisper stays selectable for low-latency/offline. TURN_URL is just the
# base; build_turn_url() appends the live ?stt=/&lang= per turn.
TURN_URL = os.environ.get("TURN_URL", "http://127.0.0.1:8780/turn")
DEFAULT_STT_UI = os.environ.get("STT_BACKEND_UI", "gemini")

SR = 16000                                            # serve_turn expects 16k mono
GATE = float(os.environ.get("VAD_GATE", "0.022"))     # RMS (0..1) speech threshold (above mic noise floor)
END_SIL = float(os.environ.get("VAD_END_SIL", "0.8")) # seconds of silence => end of turn
MIN_SPEECH = float(os.environ.get("VAD_MIN_SPEECH", "0.5"))   # need this much speech or it's noise
MIN_VOICED = float(os.environ.get("VAD_MIN_VOICED", "0.35"))  # fraction of the clip that must be above GATE


def agent_token():
    return (
        api.AccessToken(LK_KEY, LK_SECRET)
        .with_identity("agent")
        .with_name("Mesh Voice")
        .with_grants(api.VideoGrants(room_join=True, room=ROOM, can_publish=True, can_subscribe=True))
        .to_jwt()
    )


def pcm16_to_wav(samples, sr=SR):
    b = io.BytesIO()
    w = wave.open(b, "wb")
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    w.writeframes(samples.astype("<i2").tobytes()); w.close()
    return b.getvalue()


def post_turn(wav_bytes, url):
    req = urllib.request.Request(url, data=wav_bytes, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), {k: v for k, v in r.headers.items()}


class Bridge:
    def __init__(self, room):
        self.room = room
        self.buf = []          # 16k mono int16 chunks of the current utterance
        self.in_speech = False
        self.sil = 0.0
        self.busy = False      # don't capture our own playback / overlap turns
        self.preroll = deque() # rolling ~400ms before speech, so the onset isn't clipped
        self.preroll_n = 0
        self.lang = os.environ.get("DEFAULT_LANG", "en")   # manual UI language lock (zh|en)
        self.stt_backend = DEFAULT_STT_UI                  # UI STT model lock (gemini|local)
        self.talking = False   # push-to-talk: capture only while the user holds the button
        self.src = rtc.AudioSource(24000, 1)
        self.track = rtc.LocalAudioTrack.create_audio_track("agent-voice", self.src)
        self.published = False

    async def publish(self):
        if not self.published:
            await self.room.local_participant.publish_track(self.track)
            self.published = True

    async def send(self, obj):
        try:
            await self.room.local_participant.publish_data(json.dumps(obj).encode(), reliable=True)
        except Exception:
            pass

    async def feed(self, samples):   # np int16, 16k mono
        # push-to-talk: capture EVERYTHING while the user holds the button — no VAD guessing,
        # so silence/noise never triggers and STT never hallucinates on near-silent audio.
        if self.busy or not self.talking or len(samples) == 0:
            return
        self.buf.append(samples)

    def _voiced_fraction(self, samples):
        win = int(SR * 0.02)
        if len(samples) < win:
            return 0.0
        n = voiced = 0
        for i in range(0, len(samples) - win, win):
            seg = samples[i:i + win].astype(np.float32) / 32768.0
            n += 1
            if np.sqrt(np.mean(seg * seg)) >= GATE:
                voiced += 1
        return voiced / max(1, n)

    def _trim(self, samples):
        # drop leading/trailing near-silence so STT never hallucinates on held-too-long silence
        if len(samples) == 0:
            return samples
        win = int(SR * 0.02)
        e = np.array([np.sqrt(np.mean((samples[i:i + win].astype(np.float32) / 32768.0) ** 2))
                      for i in range(0, max(1, len(samples) - win), win)])
        voiced = np.where(e >= 0.012)[0]
        if len(voiced) == 0:
            return np.zeros(0, "<i2")
        start = max(0, (voiced[0] - 5) * win)            # keep ~100ms margin
        end = min(len(samples), (voiced[-1] + 6) * win)
        return samples[start:end]

    async def flush(self):
        samples = np.concatenate(self.buf) if self.buf else np.zeros(0, "i2")
        self.buf = []
        samples = self._trim(samples)
        if len(samples) / SR < 0.25:   # accidental tap / no speech — ignore
            return
        self.busy = True; spoke = False
        try:
            url = build_turn_url(TURN_URL, self.stt_backend, self.lang)
            body, H = await asyncio.get_event_loop().run_in_executor(None, post_turn, pcm16_to_wav(samples), url)
            transcript = urllib.parse.unquote(H.get("X-Transcript", ""))
            reply = urllib.parse.unquote(H.get("X-Reply", ""))
            idea = urllib.parse.unquote(H.get("X-Idea", ""))
            if len(transcript.strip()) < 2:        # empty/garbled -> stay silent, NEVER nag "say again"
                print(f"[skip] empty transcript ({len(samples) / SR:.1f}s)", flush=True)
                return
            print(f"[turn] you={transcript!r}  bot={reply!r}  idea={idea!r}", flush=True)
            spoke = True
            await self.publish()
            await self.send({"speaking": True})        # phone mutes its mic -> no echo loop
            await self.send({"transcript": transcript, "reply": reply, "idea": idea, "stt": H.get("X-STT", "")})
            await self.play_wav(body)
        except Exception as e:
            print("turn error:", e, flush=True)
        finally:
            if spoke:
                await asyncio.sleep(0.5)            # let the phone's playback buffer drain
                await self.send({"speaking": False})
            self.buf = []; self.in_speech = False; self.sil = 0.0
            self.preroll.clear(); self.preroll_n = 0
            self.busy = False

    async def play_wav(self, wav_bytes):
        w = wave.open(io.BytesIO(wav_bytes), "rb")
        sr = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        chunk = int(sr * 0.01)                         # 10ms frames
        for i in range(0, len(pcm), chunk):
            seg = pcm[i:i + chunk]
            if len(seg) < chunk:
                seg = np.pad(seg, (0, chunk - len(seg)))
            await self.src.capture_frame(rtc.AudioFrame(seg.tobytes(), sr, 1, len(seg)))


async def main():
    room = rtc.Room()
    bridge = Bridge(room)

    async def consume(track):
        stream = rtc.AudioStream.from_track(track=track, sample_rate=SR, num_channels=1)
        try:
            async for ev in stream:
                try:
                    samples = np.frombuffer(ev.frame.data, dtype="<i2")
                    await bridge.feed(samples)
                except Exception as e:
                    print("feed error:", repr(e), flush=True)
        except Exception as e:
            print("stream error:", repr(e), flush=True)

    @room.on("track_subscribed")
    def on_track(track, pub, participant):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            print(f"subscribed to {participant.identity}'s mic", flush=True)
            asyncio.create_task(consume(track))

    @room.on("participant_connected")
    def on_join(p):
        print(f"participant joined: {p.identity}", flush=True)

    @room.on("data_received")
    def on_data(data):
        # the PWA's 中/EN toggle sends {"lang":"zh"|"en"} — lock the turn language
        try:
            payload = data.data if hasattr(data, "data") else data
            m = json.loads(bytes(payload).decode())
            if m.get("lang") in ("zh", "en"):
                bridge.lang = m["lang"]
                print(f"language set to {bridge.lang}", flush=True)
            # the PWA's Gemini/GPU toggle sends {"stt":"gemini"|"local"} — lock the STT model
            if m.get("stt") in ("gemini", "local"):
                bridge.stt_backend = m["stt"]
                print(f"stt backend set to {bridge.stt_backend}", flush=True)
            if "talk" in m:
                if m["talk"]:
                    bridge.talking = True; bridge.buf = []      # start capturing this utterance
                else:
                    bridge.talking = False                       # released -> process the full clean clip
                    asyncio.create_task(bridge.flush())
        except Exception:
            pass

    await room.connect(LK_URL, agent_token())
    print(f"agent connected to room '{ROOM}' at {LK_URL} — waiting for the phone", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
