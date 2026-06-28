"""Synthetic 'phone': join the LiveKit room, set language, publish a real spoken utterance
(Kokoro), then silence so the agent's VAD ends the turn — and check the agent responds.
Reproduces the live audio path end-to-end WITHOUT a real phone, so I can test/fix myself."""
import asyncio, os, io, wave, sys
import numpy as np
from livekit import rtc, api
from kokoro import KPipeline

LK_URL = "ws://127.0.0.1:7880"
KEY = os.environ.get("LIVEKIT_API_KEY", "devkey")
SECRET = os.environ["LIVEKIT_API_SECRET"]
ROOM = "drive-room"
SR = 24000

def token():
    return (api.AccessToken(KEY, SECRET).with_identity("testphone")
            .with_grants(api.VideoGrants(room_join=True, room=ROOM, can_publish=True, can_subscribe=True))
            .to_jwt())

def synth(text, lang="zh"):
    lc, voice = ("z", "zf_xiaoxiao") if lang == "zh" else ("a", "af_heart")
    Z = KPipeline(lang_code=lc, device="cuda")
    out = []
    for r in Z(text, voice=voice):
        a = getattr(r, "audio", None)
        if a is None and isinstance(r, (tuple, list)): a = r[2]
        out.append(a.detach().cpu().numpy() if hasattr(a, "detach") else np.asarray(a))
    w = np.concatenate(out)
    return (np.clip(w, -1, 1) * 32767).astype("<i2")

async def main():
    text = sys.argv[1] if len(sys.argv) > 1 else "你好，请介绍一下我的 mesh 里有哪些 agent。"
    lang = sys.argv[2] if len(sys.argv) > 2 else "zh"
    pcm = synth(text, lang)
    print(f"[pub] utterance {len(pcm)/SR:.1f}s, lang={lang}", flush=True)

    room = rtc.Room()
    got = {"data": []}
    @room.on("data_received")
    def on_data(d):
        try:
            import json
            m = json.loads(bytes(d.data if hasattr(d, "data") else d).decode())
            got["data"].append(m)
            print(f"[agent->] {m}", flush=True)
        except Exception:
            pass
    @room.on("track_subscribed")
    def on_track(track, pub, p):
        print(f"[pub] subscribed to {p.identity} ({track.kind})", flush=True)

    await room.connect(LK_URL, token())
    print("[pub] connected", flush=True)
    src = rtc.AudioSource(SR, 1)
    track = rtc.LocalAudioTrack.create_audio_track("test-mic", src)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))
    import json
    await room.local_participant.publish_data(json.dumps({"lang": lang}).encode(), reliable=True)
    await asyncio.sleep(0.3)
    await room.local_participant.publish_data(json.dumps({"talk": True}).encode(), reliable=True)  # press
    await asyncio.sleep(0.1)

    # push the speech in 10ms frames (real-time paced) while "holding"
    chunk = int(SR * 0.01)
    for i in range(0, len(pcm), chunk):
        seg = pcm[i:i + chunk]
        if len(seg) < chunk: seg = np.pad(seg, (0, chunk - len(seg)))
        await src.capture_frame(rtc.AudioFrame(seg.tobytes(), SR, 1, len(seg)))
    await asyncio.sleep(1.3)   # let the AudioSource buffer fully drain before releasing (test only)
    await room.local_participant.publish_data(json.dumps({"talk": False}).encode(), reliable=True)  # release
    print("[pub] released, waiting for agent reply…", flush=True)

    for _ in range(120):   # wait up to ~12s
        if any("reply" in m for m in got["data"]): break
        await asyncio.sleep(0.1)
    replies = [m for m in got["data"] if "reply" in m]
    if replies:
        print(f"[RESULT] AGENT RESPONDED ✓  transcript={replies[-1].get('transcript')!r}  reply={replies[-1].get('reply')!r}", flush=True)
    else:
        print(f"[RESULT] NO RESPONSE ✗  (got data: {got['data']})", flush=True)
    await room.disconnect()

asyncio.run(main())
