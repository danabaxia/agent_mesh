"""Thin voice ingress — capture → STT → ONE A2A SendMessage → TTS.
   POST /turn?stt=local|gemini  (default $STT_BACKEND).
   NO logic here: no system prompt, no tool loop, no mesh query.
   All reasoning lives in the concierge agent (P1: voice = data ingress only)."""
import os, io, re, json, time, datetime, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
import numpy as np, soundfile as sf, wave
from faster_whisper import WhisperModel
from kokoro import KPipeline
from google import genai
from google.genai import types
from outbox import Outbox
from agent import handle_turn
from a2a_client import A2AHttpClient
from audio_gate import has_speech, wav_samples
from stt_bias import stt_prompt
from turn_input import parse_turn_request

for line in open("/opt/voice/.voice-env"):
    line = line.strip()
    if line and "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1); os.environ.setdefault(k, v.strip().strip('"').strip("'"))
CFG = json.load(open("/opt/voice/voice-config.json"))
DEFAULT_STT = os.environ.get("STT_BACKEND", "local")

CONCIERGE_A2A_URL = os.environ.get("CONCIERGE_A2A_URL", "http://127.0.0.1:8781/rpc")
_client = A2AHttpClient(CONCIERGE_A2A_URL)
_SESSION_ID = os.environ.get("LK_ROOM", "drive-room")   # stable per-session context_id for conversation memory

print("loading models ...", flush=True)
WHISPER = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3"), device="cuda", compute_type="float16")
PIPES = {"a": KPipeline(lang_code="a", device="cuda"), "z": KPipeline(lang_code="z", device="cuda")}
GEM = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
OB = Outbox("/opt/voice/turns.db")

GSTT = "gemini-2.5-flash-lite"
STTCFG = types.GenerateContentConfig(thinking_config=types.ThinkingConfig(thinking_budget=0))
SENT_END = re.compile(r"[.!?。！？\n]"); CJK = re.compile(r"[一-鿿]")
TS = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")

def detect_lang(t): return "zh" if CJK.search(t or "") else "en"
def cfg_for(key): c = CFG["by_lang"][key]; return c["lang_code"], c["voice"]

# STT vocabulary bias lives in stt_bias.stt_prompt(lang) — domain terms + the
# agent roster so whisper stops guessing unrelated homophones ("coder"->"road").
def stt_local(p, lang=None):
    # lang ("zh"/"en") forces whisper's language → no hallucinating other languages on unclear audio
    samples, sr = wav_samples(p)
    if not has_speech(samples, sr):
        return "", ""                        # no real speech → don't let whisper invent text
    # Anti-hallucination params (research 2026-06-28): vad_filter (Silero) drops non-speech;
    # condition_on_previous_text=False stops cross-chunk drift; beam_size=1 + temperature=0
    # avoid creative sampling; no_speech/log_prob/compression thresholds discard low-confidence
    # and repetitive (hallucinated) segments.
    segs, info = WHISPER.transcribe(
        p, vad_filter=True, language=(lang or None),
        beam_size=1, temperature=0, condition_on_previous_text=False,
        no_speech_threshold=0.6, log_prob_threshold=-1.0, compression_ratio_threshold=2.4,
        initial_prompt=stt_prompt(lang),
        vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=400))
    return " ".join(s.text for s in segs).strip(), (getattr(info, "language", "") or "")
def stt_gemini(p, lang=None):
    samples, sr = wav_samples(p)
    if not has_speech(samples, sr):
        return ""                            # no real speech → skip the LLM (it would confabulate)
    hint = {"zh": " The audio is in Chinese (Mandarin); transcribe in Chinese characters.",
            "en": " The audio is in English; transcribe in English."}.get(lang, "")
    r = GEM.models.generate_content(model=GSTT, config=STTCFG, contents=[
        types.Part.from_bytes(data=open(p, "rb").read(), mime_type="audio/wav"),
        "Transcribe this audio verbatim." + hint + " Output ONLY the spoken words — "
        "no timestamps, no time codes, no speaker labels, no preamble, no quotes."])
    return re.sub(r"\s{2,}", " ", TS.sub("", (r.text or "")).strip()).strip()

def synth(lc, voice, text):
    out = []
    for r in PIPES[lc](text, voice=voice):
        a = getattr(r, "audio", None)
        if a is None and isinstance(r, (tuple, list)): a = r[2]
        out.append(a.detach().cpu().numpy() if hasattr(a, "detach") else np.asarray(a))
    return np.concatenate(out) if out else np.zeros(1, "float32")

ACK_TEXT = {
    "en": ["Got it, noted.", "Noted and syncing.", "Got it, saved.", "Okay, captured."],
    "zh": ["好的，记下了。", "好的，正在同步。", "记下了，正在同步。", "好嘞，已记下。"],
}

# pre-synthesize the canned acks once (reply voices) so 'ack' mode adds ~0 TTS time
_n = [0]
ACKS = {k: [(t, synth(*cfg_for(k), t)) for t in ACK_TEXT[k]] for k in ACK_TEXT}

REPLY_MODE = os.environ.get("REPLY_MODE", "brain")   # 'brain' = A2A agent reply; 'ack' = instant cached confirm

def preprocess_audio(raw):
    """Gain-normalize + light trim before STT — quiet/noisy phone audio (low SNR,
    long PTT holds) transcribes far better after RMS normalization. Raw is kept for diagnosis."""
    with wave.open(io.BytesIO(raw), "rb") as w:
        sr = w.getframerate(); pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
    x = pcm / 32768.0
    win = int(0.02 * sr); floor = 0.015
    if len(x) > win:
        e = np.array([np.sqrt(np.mean(x[i:i+win]**2)) for i in range(0, len(x)-win, win)])
        v = np.where(e >= floor)[0]
        if len(v): x = x[max(0,(v[0]-5)*win):min(len(x),(v[-1]+6)*win)]
    rms = float(np.sqrt(np.mean(x*x))) + 1e-9
    x = np.clip(x * min(0.15/rms, 6.0), -1, 1)
    out = (x * 32767).astype("<i2")
    b = io.BytesIO(); ww = wave.open(b, "wb"); ww.setnchannels(1); ww.setsampwidth(2); ww.setframerate(sr); ww.writeframes(out.tobytes()); ww.close()
    return b.getvalue()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/turn":
            self.send_response(404); self.end_headers(); return
        _q = urllib.parse.parse_qs(u.query)
        req = parse_turn_request(_q, default_stt=DEFAULT_STT)
        stt_b = req["stt"]; forced = req["lang"]; text_in = req["text"]   # text_in set → typed turn, skip STT
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        if text_in:
            with open("/tmp/in.wav", "wb") as f: f.write(b"")   # typed turn: no audio, STT is skipped below
        else:
            try: clean = preprocess_audio(raw)
            except Exception: clean = raw
            with open("/tmp/in.wav", "wb") as f: f.write(clean)
            try:
                open("/opt/voice/last_in.wav", "wb").write(raw)   # keep the most recent turn for diagnosis
                import glob
                os.makedirs("/opt/voice/clips", exist_ok=True)
                open(f"/opt/voice/clips/{int(time.time()*1000)}.wav","wb").write(raw)
                for old in sorted(glob.glob("/opt/voice/clips/*.wav"))[:-24]: os.remove(old)
            except Exception:
                pass
        t0 = time.perf_counter()
        ts = datetime.datetime.utcnow().isoformat() + "Z"
        wlang = ""
        parts = []; t_first = None; t_first_audio = None; reply = ""; idea_title = ""

        if REPLY_MODE == "ack":
            # Fast ack path: skip the A2A call; capture + STT + cached audio only
            rid = OB.capture("/tmp/in.wav", ts)
            try:
                if text_in:
                    transcript = text_in; wlang = ""     # typed turn — skip STT
                elif stt_b == "gemini":
                    transcript = stt_gemini("/tmp/in.wav", forced)
                    wlang = ""
                else:
                    transcript, wlang = stt_local("/tmp/in.wav", forced)
            except Exception:
                transcript, wlang = stt_local("/tmp/in.wav", forced); stt_b = "local(fallback)"
            t_stt = time.perf_counter()
            OB.attach_transcript(rid, transcript)
            key = forced if forced else ("zh" if (CJK.search(transcript or "") or str(wlang).startswith("zh")) else "en")
            lc, voice = cfg_for(key)
            reply, w = ACKS[key][_n[0] % len(ACKS[key])]; _n[0] += 1
            t_first = t_stt; parts = [(reply, w)]; t_first_audio = time.perf_counter()
        else:
            # Brain path: capture → STT → ONE A2A SendMessage (handle_turn) → TTS
            spoken = {}
            def tts(text):
                spoken["reply"] = text

            if text_in:
                def _stt(ref): return text_in       # typed turn — skip STT, use the message as-is
            elif stt_b == "gemini":
                def _stt(ref): return stt_gemini(ref, forced)
            else:
                def _stt(ref):
                    nonlocal wlang
                    txt, wlang = stt_local(ref, forced)
                    return txt

            rid = handle_turn(
                "/tmp/in.wav", ts, OB, _stt,
                send_a2a=_client.send, tts=tts,
                context_id=_SESSION_ID, lang=(forced or "en"),
                fallback=("Sorry, I can't reach the assistant right now." if (forced or "en")=="en" else "抱歉，连不上助手，稍后再试"),
            )
            t_stt = time.perf_counter()

            # Recover transcript + enrichment from outbox for response headers
            row = OB.get(rid) or {}
            transcript = row.get("transcript") or ""
            enrichment_raw = row.get("enrichment")
            enrichment = json.loads(enrichment_raw) if enrichment_raw else {}
            idea_obj = enrichment.get("idea") if isinstance(enrichment, dict) else None
            idea_title = idea_obj.get("title", "") if isinstance(idea_obj, dict) else ""

            reply_text = spoken.get("reply", "")
            if not reply_text:
                reply_text = "抱歉，连不上助手，稍后再试"

            # auto-detect language for TTS from transcript
            if forced:
                key = forced
            else:
                key = "zh" if (CJK.search(transcript or "") or str(wlang).startswith("zh")) else "en"
            lc, voice = cfg_for(key)

            t_first = time.perf_counter()
            buf = reply_text
            while True:
                m = SENT_END.search(buf)
                if not m: break
                s = buf[:m.end()].strip(); buf = buf[m.end():]
                if s:
                    parts.append((s, synth(lc, voice, s)))
                    if t_first_audio is None: t_first_audio = time.perf_counter()
            if buf.strip():
                parts.append((buf.strip(), synth(lc, voice, buf.strip())))
                if t_first_audio is None: t_first_audio = time.perf_counter()

        if not parts:
            fb = "抱歉，连不上助手，稍后再试"
            lc, voice = cfg_for("zh")
            parts = [(fb, synth(lc, voice, fb))]; t_first_audio = time.perf_counter()
            if REPLY_MODE != "ack":
                transcript = ""
                key = "zh"

        reply = " ".join(p[0] for p in parts); wav = np.concatenate([p[1] for p in parts])
        t_end = time.perf_counter()
        b2 = io.BytesIO(); sf.write(b2, wav, 24000, format="WAV"); audio = b2.getvalue()
        ms = lambda a, b: int(1000 * (b - a))
        timing = (f"stt={ms(t0, t_stt)} brain1st={ms(t_stt, t_first or t_stt)} "
                  f"ttfa={ms(t0, t_first_audio or t_end)} total={ms(t0, t_end)} "
                  f"replydur={len(wav)/24000:.1f}s")
        self.send_response(200); self.send_header("Content-Type", "audio/wav")
        self.send_header("X-STT", stt_b); self.send_header("X-Lang", key if REPLY_MODE == "ack" or parts else "zh"); self.send_header("X-Voice", voice if REPLY_MODE == "ack" or parts else "")
        self.send_header("X-Idea", urllib.parse.quote(idea_title) if idea_title else "")
        self.send_header("X-Transcript", urllib.parse.quote(transcript))
        self.send_header("X-Reply", urllib.parse.quote(reply))
        self.send_header("X-Timing", urllib.parse.quote(timing))
        self.send_header("Content-Length", str(len(audio))); self.end_headers(); self.wfile.write(audio)

stt_local("/opt/voice/clip16.wav"); synth("a", "am_adam", "ready"); synth("z", "zm_yunyang", "好的")
print(f"WARM 127.0.0.1:8780 — stt={DEFAULT_STT} reply={REPLY_MODE}", flush=True)
HTTPServer(("127.0.0.1", 8780), H).serve_forever()
