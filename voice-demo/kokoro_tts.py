#!/usr/bin/env python3
"""Kokoro TTS one-shot: text -> WAV. Called by the node demo server.

Usage: kokoro_tts.py <out.wav> <lang_code> <voice> <<< text-on-stdin

lang_code: 'a' American English, 'b' British English, 'z' Mandarin Chinese.
voice    : e.g. af_heart / am_michael (en), zf_xiaobei / zm_yunxi (zh).

Model weights download from HuggingFace on first run, then cache. A persistent
pipeline cache keyed by lang_code avoids reloading per call within one process,
but this is invoked one-shot per request for the demo (simple > fast).
"""
import sys
import soundfile as sf

def main():
    out_path, lang_code, voice = sys.argv[1], sys.argv[2], sys.argv[3]
    text = sys.stdin.read().strip()
    if not text:
        print("no text", file=sys.stderr); sys.exit(1)

    # Prefer MPS (Apple GPU) when available; fall back to CPU.
    device = None
    try:
        import torch
        device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    except Exception:
        device = 'cpu'

    from kokoro import KPipeline
    pipeline = KPipeline(lang_code=lang_code, device=device)

    import numpy as np
    audio_parts = []
    for _, _, audio in pipeline(text, voice=voice):
        audio_parts.append(audio)
    if not audio_parts:
        print("no audio", file=sys.stderr); sys.exit(2)
    audio = np.concatenate(audio_parts) if len(audio_parts) > 1 else audio_parts[0]
    sf.write(out_path, audio, 24000)
    print(f"ok device={device} samples={len(audio)}", file=sys.stderr)

if __name__ == "__main__":
    main()
