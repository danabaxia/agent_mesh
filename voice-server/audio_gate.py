"""Pre-STT speech gate (pure, numpy-optional).

The durable fix for STT hallucination (research 2026-06-28): a recognizer — whether
whisper or an LLM — *cannot return empty*, so on too-short / near-silent / too-quiet
clips it invents plausible text ("三个一元，一个五角…"). The fix is to reject such
clips BEFORE any transcriber sees them. This is a coarse energy + duration gate; the
recognizer's own VAD (Silero via faster-whisper `vad_filter`) handles finer
speech/non-speech classification on what passes.
"""
import wave

try:
    import numpy as _np
except Exception:  # numpy is present on the GPU box; the gate degrades to stdlib for tests
    _np = None


def _overall_rms_and_voiced(samples, sr, win_s, floor):
    """Return (overall_rms, voiced_fraction) with samples normalized to [-1, 1]."""
    n = len(samples)
    if n == 0:
        return 0.0, 0.0
    win = max(1, int(win_s * sr))
    if _np is not None:
        x = _np.asarray(samples, dtype=_np.float32) / 32768.0
        overall = float(_np.sqrt(_np.mean(x * x)))
        nf = n // win
        if nf == 0:
            return overall, 0.0
        frames = x[:nf * win].reshape(nf, win)
        fr = _np.sqrt((frames * frames).mean(axis=1))
        return overall, float((fr >= floor).mean())
    import math
    def rms(seq):
        return math.sqrt(sum((s / 32768.0) ** 2 for s in seq) / len(seq)) if seq else 0.0
    overall = rms(samples)
    voiced = total = 0
    for i in range(0, n - win, win):
        if rms(samples[i:i + win]) >= floor:
            voiced += 1
        total += 1
    return overall, (voiced / total if total else 0.0)


def has_speech(samples, sr, min_dur_s=0.4, rms_floor=0.012, min_voiced_frac=0.08):
    """True only if the clip is long enough AND loud enough AND has a minimum fraction
    of voiced frames — i.e. plausibly contains real speech. A clip that fails this is
    dropped (transcribed as "") so the recognizer never hallucinates over it."""
    if len(samples) < int(min_dur_s * sr):
        return False
    overall, voiced = _overall_rms_and_voiced(samples, sr, 0.03, rms_floor)
    return overall >= rms_floor and voiced >= min_voiced_frac


def wav_samples(path):
    """Read a 16-bit PCM WAV → (samples, sample_rate). numpy array if available, else array('h')."""
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    if _np is not None:
        return _np.frombuffer(raw, dtype="<i2"), sr
    import array
    a = array.array("h")
    a.frombytes(raw)
    return a, sr
