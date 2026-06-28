"""Thin voice ingress — capture → STT → ONE A2A SendMessage → TTS.
   POST /turn?stt=local|gemini  (default $STT_BACKEND).
   NO logic here: no system prompt, no tool loop, no mesh query.
   All reasoning lives in the concierge agent (P1: voice = data ingress only)."""
import os, io, re, json, time, datetime, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
import numpy as np, soundfile as sf
from faster_whisper import WhisperModel
from kokoro import KPipeline
from google import genai
from google.genai import types
from outbox import Outbox
from agent import handle_turn
from a2a_client import A2AHttpClient

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
WHISPER = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3"), device="cuda", compute_type="int8")
PIPES = {"a": KPipeline(lang_code="a", device="cuda"), "z": KPipeline(lang_code="z", device="cuda")}
GEM = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
OB = Outbox("/opt/voice/turns.db")

GSTT = "gemini-2.5-flash-lite"
STTCFG = types.GenerateContentConfig(thinking_config=types.ThinkingConfig(thinking_budget=0))
SENT_END = re.compile(r"[.!?。！？\n]"); CJK = re.compile(r"[一-鿿]")
TS = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")

def detect_lang(t): return "zh" if CJK.search(t or "") else "en"
def cfg_for(key): c = CFG["by_lang"][key]; return c["lang_code"], c["voice"]

def stt_local(p, lang=None):
    # lang ("zh"/"en") forces whisper's language → no hallucinating other languages on unclear audio
    segs, info = WHISPER.transcribe(p, vad_filter=True, language=(lang or None))
    return " ".join(s.text for s in segs).strip(), (getattr(info, "language", "") or "")
def stt_gemini(p, lang=None):
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

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/turn":
            self.send_response(404); self.end_headers(); return
        _q = urllib.parse.parse_qs(u.query)
        stt_b = _q.get("stt", [DEFAULT_STT])[0].lower()
        forced = _q.get("lang", [""])[0].lower()
        forced = forced if forced in ("zh", "en") else ""   # manual UI language lock
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        with open("/tmp/in.wav", "wb") as f: f.write(raw)
        try:
            open("/opt/voice/last_in.wav", "wb").write(raw)   # keep the most recent turn for diagnosis
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
                if stt_b == "gemini":
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

            if stt_b == "gemini":
                def _stt(ref): return stt_gemini(ref, forced)
            else:
                def _stt(ref):
                    nonlocal wlang
                    txt, wlang = stt_local(ref, forced)
                    return txt

            rid = handle_turn(
                "/tmp/in.wav", ts, OB, _stt,
                send_a2a=_client.send, tts=tts,
                context_id=_SESSION_ID, lang=(forced or "zh"),
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
        self.send_header("X-Transcript", urllib.parse.quote(transcript) if REPLY_MODE == "ack" else urllib.parse.quote(transcript))
        self.send_header("X-Reply", urllib.parse.quote(reply))
        self.send_header("X-Timing", urllib.parse.quote(timing))
        self.send_header("Content-Length", str(len(audio))); self.end_headers(); self.wfile.write(audio)

stt_local("/opt/voice/clip16.wav"); synth("a", "am_adam", "ready"); synth("z", "zm_yunyang", "好的")
print(f"WARM 127.0.0.1:8780 — stt={DEFAULT_STT} reply={REPLY_MODE}", flush=True)
HTTPServer(("127.0.0.1", 8780), H).serve_forever()
