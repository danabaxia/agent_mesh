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

import numpy as np
from livekit import api, rtc

LK_URL = os.environ.get("LIVEKIT_WS_URL", "ws://127.0.0.1:7880")
LK_KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
LK_SECRET = os.environ.get("LIVEKIT_API_SECRET", "secret")
ROOM = os.environ.get("LK_ROOM", "drive-room")
TURN_URL = os.environ.get("TURN_URL", "http://127.0.0.1:8780/turn?stt=local")

SR = 16000                                            # serve_turn expects 16k mono
GATE = float(os.environ.get("VAD_GATE", "0.012"))     # RMS (0..1) speech threshold
END_SIL = float(os.environ.get("VAD_END_SIL", "0.8")) # seconds of silence => end of turn
MIN_SPEECH = float(os.environ.get("VAD_MIN_SPEECH", "0.3"))


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


def post_turn(wav_bytes):
    req = urllib.request.Request(TURN_URL, data=wav_bytes, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), {k: v for k, v in r.headers.items()}


class Bridge:
    def __init__(self, room):
        self.room = room
        self.buf = []          # 16k mono int16 chunks of the current utterance
        self.in_speech = False
        self.sil = 0.0
        self.busy = False      # don't capture our own playback / overlap turns
        self.src = rtc.AudioSource(24000, 1)
        self.track = rtc.LocalAudioTrack.create_audio_track("agent-voice", self.src)
        self.published = False

    async def publish(self):
        if not self.published:
            await self.room.local_participant.publish_track(self.track)
            self.published = True

    async def feed(self, samples):   # np int16, 16k mono
        if self.busy or len(samples) == 0:
            return
        rms = float(np.sqrt(np.mean((samples.astype(np.float32) / 32768.0) ** 2)))
        dur = len(samples) / SR
        if rms >= GATE:
            self.in_speech = True; self.sil = 0.0; self.buf.append(samples)
        elif self.in_speech:
            self.buf.append(samples); self.sil += dur
            if self.sil >= END_SIL:
                await self.flush()

    async def flush(self):
        samples = np.concatenate(self.buf) if self.buf else np.zeros(0, "i2")
        self.buf = []; self.in_speech = False; self.sil = 0.0
        if len(samples) / SR < MIN_SPEECH:
            return
        self.busy = True
        try:
            body, H = await asyncio.get_event_loop().run_in_executor(None, post_turn, pcm16_to_wav(samples))
            transcript = urllib.parse.unquote(H.get("X-Transcript", ""))
            reply = urllib.parse.unquote(H.get("X-Reply", ""))
            print(f"[turn] you={transcript!r}  bot={reply!r}", flush=True)
            await self.room.local_participant.publish_data(
                json.dumps({"transcript": transcript, "reply": reply}).encode(), reliable=True)
            await self.publish()
            await self.play_wav(body)
        except Exception as e:
            print("turn error:", e, flush=True)
        finally:
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
        rs = None; in_rate = None
        stream = rtc.AudioStream.from_track(track=track, sample_rate=SR, num_channels=1)
        async for ev in stream:
            f = ev.frame
            samples = np.frombuffer(f.data, dtype="<i2")
            await bridge.feed(samples)

    @room.on("track_subscribed")
    def on_track(track, pub, participant):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            print(f"subscribed to {participant.identity}'s mic", flush=True)
            asyncio.create_task(consume(track))

    @room.on("participant_connected")
    def on_join(p):
        print(f"participant joined: {p.identity}", flush=True)

    await room.connect(LK_URL, agent_token())
    print(f"agent connected to room '{ROOM}' at {LK_URL} — waiting for the phone", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
