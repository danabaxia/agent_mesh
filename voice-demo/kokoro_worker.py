#!/usr/bin/env python3
"""Persistent Kokoro TTS worker — loads the model ONCE, then serves many requests
over stdin/stdout so per-utterance latency drops from ~5s (cold spawn) to ~1s.

Protocol (newline-delimited JSON):
  in : {"id": <n>, "text": "...", "lang": "a|b|z", "voice": "af_heart", "out": "/tmp/x.wav"}
  out: {"id": <n>, "ok": true, "out": "/tmp/x.wav"}   or   {"id": <n>, "error": "..."}
A single READY line is printed once the model/device is up.
"""
import sys, json
import soundfile as sf
import numpy as np

def main():
    device = 'cpu'
    try:
        import torch
        device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    except Exception:
        pass
    from kokoro import KPipeline

    pipelines = {}            # lang_code -> KPipeline (built lazily, kept warm)
    def pipe(lang):
        if lang not in pipelines:
            pipelines[lang] = KPipeline(lang_code=lang, device=device)
        return pipelines[lang]

    # Warm the most common path (Mandarin) so the first real request is fast.
    try: pipe('z')
    except Exception: pass

    print(json.dumps({"ready": True, "device": device}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            parts = [a for _, _, a in pipe(req.get("lang", "z"))(req["text"], voice=req["voice"])]
            if not parts:
                raise RuntimeError("no audio")
            audio = np.concatenate(parts) if len(parts) > 1 else parts[0]
            sf.write(req["out"], audio, 24000)
            print(json.dumps({"id": req.get("id"), "ok": True, "out": req["out"]}), flush=True)
        except Exception as e:
            rid = None
            try: rid = json.loads(line).get("id")
            except Exception: pass
            print(json.dumps({"id": rid, "error": str(e)[:300]}), flush=True)

if __name__ == "__main__":
    main()
