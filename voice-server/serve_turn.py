"""Warm GPU turn server — pluggable STT (local|gemini), Gemini brain, Kokoro TTS,
   auto-follow language, capture-first durability, per-stage timing.
   POST /turn?stt=local|gemini  (default $STT_BACKEND). Brain is Gemini; brain_stream()
   is the extension point for swapping in another model later (Claude etc.)."""
import os, io, re, json, time, datetime, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
import numpy as np, soundfile as sf
from faster_whisper import WhisperModel
from kokoro import KPipeline
from google import genai
from google.genai import types
from outbox import Outbox

for line in open("/opt/voice/.voice-env"):
    line = line.strip()
    if line and "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1); os.environ.setdefault(k, v.strip().strip('"').strip("'"))
CFG = json.load(open("/opt/voice/voice-config.json"))
DEFAULT_STT = os.environ.get("STT_BACKEND", "local")
REPLY_MODE = os.environ.get("REPLY_MODE", "brain")  # 'brain' = Gemini reply; 'ack' = instant cached confirm

print("loading models ...", flush=True)
WHISPER = WhisperModel(os.environ.get("WHISPER_MODEL", "large-v3"), device="cuda", compute_type="int8")
PIPES = {"a": KPipeline(lang_code="a", device="cuda"), "z": KPipeline(lang_code="z", device="cuda")}
GEM = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
OB = Outbox("/opt/voice/turns.db")

GBRAIN = "gemini-2.5-flash"; GSTT = "gemini-2.5-flash-lite"
NOTHINK = types.GenerateContentConfig(thinking_config=types.ThinkingConfig(thinking_budget=0), max_output_tokens=160)
STTCFG = types.GenerateContentConfig(thinking_config=types.ThinkingConfig(thinking_budget=0))
SENT_END = re.compile(r"[.!?。！？\n]"); CJK = re.compile(r"[一-鿿]")
TS = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")
SYS = {
    "en": "You are a warm, smart, hands-free voice assistant the user talks to (often while driving). "
          "ANSWER their question directly and correctly. If you genuinely don't know or can't (e.g. live "
          "info you don't have), say so honestly in one line — NEVER make things up, NEVER dodge the question. "
          "If the user is noting an idea, reminder, or task to remember/do later, CALL record_idea(title, note) "
          "AND give a one-line spoken confirmation that you saved it to the mesh. For questions, chit-chat, "
          "greetings, or commands like 'stop', just respond — do NOT call record_idea. "
          "You are this user's mesh voice assistant and you ALREADY know this mesh's structure and each agent's "
          "role (see the background below). Questions about what an agent does, how they work together, or the "
          "overall picture — answer DIRECTLY from that background, don't call a tool. Only call get_mesh_status "
          "for live numbers (open issues/PRs); only call ask_mesh_agent when the user explicitly says 'ask the X "
          "agent' for that agent's live take (it's slow — first say 'let me check, one moment'). Never say you "
          "can't access the mesh. Today is {date}. "
          "Keep it conversational and brief: 1-2 spoken sentences, plain text, no markdown, lists or emoji. Reply in English.",
    "zh": "你是一个温暖、聪明的免提语音助手，用户经常在开车时和你说话。"
          "直接、正确地回答他的问题。如果你确实不知道或做不到（比如你没有的实时信息），就用一句话老实说不知道——"
          "绝不要瞎编，也绝不要回避问题。如果用户在记一个想法、提醒或要做的事，就调用 record_idea(title, note)，"
          "并用一句话口头确认已经帮他存进 mesh。提问、闲聊、打招呼或「停」这类命令，就只回应、不要调用 record_idea。"
          "你是这个用户的 mesh 语音助手，你已经懂这个 mesh 的结构和每个 agent 的职责（见下方背景知识）。"
          "agent 是做什么的、彼此怎么配合、整体什么情况——这类直接凭背景知识口语回答，不要调工具。"
          "只有要实时数字（未关闭的 issue/PR 数）才调 get_mesh_status；只有用户明确说「问问某某 agent」"
          "想听某个 agent 的现场意见时，才调 ask_mesh_agent（很慢，先说「我问一下，稍等」）。绝不要说你访问不了 mesh。今天是 {date}。"
          "【非常重要】用纯中文口语回答，绝不要在中文句子里堆一长串英文——语音念出来会像中英夹杂。"
          "提到 agent 时用中文说它们的角色（如维护、分析、分类、编码、测试、审查、整理、协调、安全、门房），"
          "或只说数量加一两个重点，别一口气念 10 个英文名；issue 说「待办」、PR 说「合并请求」、mesh 说「你的智能体网络」。"
          "回答要口语、简短：1-2 句话，纯文本，不要 markdown、列表或表情。用中文回复。",
}
WEEK = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]
MESH_TOOLS_URL = os.environ.get("MESH_TOOLS_URL", "http://127.0.0.1:9100")
def _mesh_get(path, timeout=20):
    try:
        with urllib.request.urlopen(f"{MESH_TOOLS_URL}{path}", timeout=timeout) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)[:120]}
def _mesh_ask(agent, q):
    try:
        body = json.dumps({"agent": agent, "question": q}).encode()
        req = urllib.request.Request(f"{MESH_TOOLS_URL}/ask", data=body, method="POST",
                                     headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=190) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"error": str(e)[:120]}

_DECLS = [
    types.FunctionDeclaration(name="record_idea",
        description="Save a note/idea/reminder/task the user wants remembered or done later. Call ONLY when the "
                    "user is expressing something to capture — NOT for questions, chit-chat, greetings, or commands.",
        parameters=types.Schema(type="OBJECT", properties={
            "title": types.Schema(type="STRING", description="a short 3-8 word title for the idea"),
            "note": types.Schema(type="STRING", description="the idea in the user's own words")}, required=["title"])),
    types.FunctionDeclaration(name="list_mesh_agents",
        description="List the agents in the user's mesh by name. Call when the user asks who/what agents they have.",
        parameters=types.Schema(type="OBJECT", properties={})),
    types.FunctionDeclaration(name="get_mesh_status",
        description="Get the mesh's current status: open GitHub issues and pull requests. Call when the user asks "
                    "about mesh/system status, what's open, recent issues or PRs.",
        parameters=types.Schema(type="OBJECT", properties={})),
    types.FunctionDeclaration(name="ask_mesh_agent",
        description="Ask ONE mesh agent a question and get its answer (read-only — it answers, never does work). "
                    "Slow (10-40s): first tell the user to wait a moment, then call. Use for 'ask the tester/orchestrator…'.",
        parameters=types.Schema(type="OBJECT", properties={
            "agent": types.Schema(type="STRING", description="agent name, e.g. orchestrator, tester, security"),
            "question": types.Schema(type="STRING", description="the question to ask that agent")}, required=["agent", "question"])),
]
ALL_TOOLS = types.Tool(function_declarations=_DECLS)
TOOLCFG = types.GenerateContentConfig(
    thinking_config=types.ThinkingConfig(thinking_budget=0), max_output_tokens=300, tools=[ALL_TOOLS])

def _exec_tool(name, args):
    if name == "list_mesh_agents": return _mesh_get("/agents")
    if name == "get_mesh_status":  return _mesh_get("/status")
    if name == "ask_mesh_agent":   return _mesh_ask(args.get("agent", ""), args.get("question", ""))
    return {"error": "unknown tool"}

def _load_mesh_context():
    """Pull the (static-ish) mesh structure into the system prompt so Gemini UNDERSTANDS
    the mesh and answers structure questions directly — no Claude spawn, no tool call."""
    c = _mesh_get("/context", timeout=8)
    ags = c.get("agents") if isinstance(c, dict) else None
    if not ags:
        return ""
    roles = "；".join(f"{a['name']}（{a.get('role', '')}）" for a in ags if a.get("role"))
    return f"{c.get('summary', '')}\n成员：{roles}。"

MESH_CONTEXT = _load_mesh_context()
HISTORY = []   # rolling [(role,text)] dialogue memory for the single phone user
ACK_TEXT = {
    "en": ["Got it, noted.", "Noted and syncing.", "Got it, saved.", "Okay, captured."],
    "zh": ["好的，记下了。", "好的，正在同步。", "记下了，正在同步。", "好嘞，已记下。"],
}

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

def brain_stream(key, transcript):
    """yield reply text chunks. EXTENSION POINT: swap this body to use a different
       model (Claude etc.) later; the rest of the turn loop is backend-agnostic."""
    t = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date()  # user is in China (UTC+8)
    datestr = f"{t.isoformat()} {WEEK[t.weekday()]}" if key == "zh" else t.strftime("%A %B %d, %Y")
    sys = SYS[key].replace("{date}", datestr)
    for ev in GEM.models.generate_content_stream(model=GBRAIN, config=NOTHINK,
              contents=f'{sys}\n\nUser said: "{transcript}"\nReply:'):
        yield (ev.text or "")

def brain_turn(key, transcript):
    """Multi-hop function-calling brain. Returns (reply_text, idea|None). Tools: record_idea
    (local, mesh-bound capture) + list_mesh_agents/get_mesh_status/ask_mesh_agent (via mesh-tools)."""
    t = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).date()
    datestr = f"{t.isoformat()} {WEEK[t.weekday()]}" if key == "zh" else t.strftime("%A %B %d, %Y")
    sys_full = SYS[key].replace("{date}", datestr)
    if MESH_CONTEXT:
        sys_full += ("\n\n【你的 mesh 背景知识——回答 mesh 结构/成员/职责问题时直接用，不必每次都去查工具；"
                     "只有要实时数据(状态、issue 数)或要听某个 agent 的具体意见时才用工具】\n" + MESH_CONTEXT)
    cfg = types.GenerateContentConfig(
        thinking_config=types.ThinkingConfig(thinking_budget=0), max_output_tokens=300,
        tools=[ALL_TOOLS], system_instruction=sys_full)
    contents = [types.Content(role=r, parts=[types.Part(text=tx)]) for r, tx in HISTORY[-8:]]
    # hard per-turn language lock: overrides the conversation history's language inertia
    # (English turn after Chinese turns must still get an English reply, and vice-versa).
    tag = "（务必用中文回答这一句，无论前面是什么语言）" if key == "zh" else "(Reply to THIS message in English, regardless of earlier turns.)"
    contents.append(types.Content(role="user", parts=[types.Part(text=f"{transcript}\n\n{tag}")]))
    idea = None
    def remember(reply):
        HISTORY.append(("user", transcript)); HISTORY.append(("model", reply))
        if len(HISTORY) > 16: del HISTORY[:len(HISTORY) - 16]
    for _hop in range(4):
        resp = GEM.models.generate_content(model=GBRAIN, config=cfg, contents=contents)
        cand = resp.candidates[0]
        calls = [p.function_call for p in cand.content.parts if getattr(p, "function_call", None)]
        if not calls:
            text = "".join(p.text for p in cand.content.parts if getattr(p, "text", None)).strip()
            text = text or ("好的。" if key == "zh" else "Okay.")
            remember(text)
            return text, idea
        contents.append(cand.content)
        for fc in calls:
            a = dict(fc.args or {})
            if fc.name == "record_idea":
                idea = {"title": (a.get("title") or "")[:120], "note": (a.get("note") or transcript)[:1000]}
                result = {"saved": True, "title": idea["title"]}
            else:
                result = _exec_tool(fc.name, a)
            contents.append(types.Content(role="user",
                parts=[types.Part.from_function_response(name=fc.name, response=result)]))
    fb = "好的。" if key == "zh" else "Okay."
    remember(fb)
    return fb, idea

def synth(lc, voice, text):
    out = []
    for r in PIPES[lc](text, voice=voice):
        a = getattr(r, "audio", None)
        if a is None and isinstance(r, (tuple, list)): a = r[2]
        out.append(a.detach().cpu().numpy() if hasattr(a, "detach") else np.asarray(a))
    return np.concatenate(out) if out else np.zeros(1, "float32")

# pre-synthesize the canned acks once (reply voices) so 'ack' mode adds ~0 TTS time
_n = [0]
ACKS = {k: [(t, synth(*cfg_for(k), t)) for t in ACK_TEXT[k]] for k in ACK_TEXT}

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
        rid = OB.capture("/tmp/in.wav", datetime.datetime.utcnow().isoformat() + "Z")
        wlang = ""
        try:
            if stt_b == "gemini":
                transcript = stt_gemini("/tmp/in.wav", forced)
            else:
                transcript, wlang = stt_local("/tmp/in.wav", forced)
        except Exception:
            transcript, wlang = stt_local("/tmp/in.wav", forced); stt_b = "local(fallback)"
        t_stt = time.perf_counter()
        OB.attach_transcript(rid, transcript)
        # Manual UI language lock wins; else fall back to CJK/whisper auto-detect.
        if forced:
            key = forced
        else:
            key = "zh" if (CJK.search(transcript or "") or str(wlang).startswith("zh")) else "en"
        lc, voice = cfg_for(key)
        parts = []; t_first = None; t_first_audio = None; idea = None
        if len(transcript.strip()) < 2:   # empty/garbled capture — don't feed the LLM noise
            lc, voice = cfg_for("zh"); reply = "抱歉，没听清，请再说一遍。"
            parts = [(reply, synth(lc, voice, reply))]; t_first = t_stt; t_first_audio = time.perf_counter()
        elif REPLY_MODE == "ack":
            reply, w = ACKS[key][_n[0] % len(ACKS[key])]; _n[0] += 1
            t_first = t_stt; parts = [(reply, w)]; t_first_audio = time.perf_counter()
        else:
            try:
                reply, idea = brain_turn(key, transcript)
            except Exception:
                reply, idea = ("好的，记下了。" if key == "zh" else "Got it, noted."), None
            if idea:
                OB.attach_enrichment(rid, {"idea": idea})   # mesh-bound: synced + filed as an issue
            t_first = time.perf_counter()
            buf = reply
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
            fb = "好的，已经帮你记下来了，正在同步。" if key == "zh" else "Got it, your idea is noted and syncing."
            parts = [(fb, synth(lc, voice, fb))]; t_first_audio = time.perf_counter()
        reply = " ".join(p[0] for p in parts); wav = np.concatenate([p[1] for p in parts])
        t_end = time.perf_counter()
        b2 = io.BytesIO(); sf.write(b2, wav, 24000, format="WAV"); audio = b2.getvalue()
        ms = lambda a, b: int(1000 * (b - a))
        timing = (f"stt={ms(t0, t_stt)} brain1st={ms(t_stt, t_first or t_stt)} "
                  f"ttfa={ms(t0, t_first_audio or t_end)} total={ms(t0, t_end)} "
                  f"replydur={len(wav)/24000:.1f}s")
        self.send_response(200); self.send_header("Content-Type", "audio/wav")
        self.send_header("X-STT", stt_b); self.send_header("X-Lang", key); self.send_header("X-Voice", voice)
        self.send_header("X-Idea", urllib.parse.quote(idea["title"]) if idea else "")
        self.send_header("X-Transcript", urllib.parse.quote(transcript))
        self.send_header("X-Reply", urllib.parse.quote(reply))
        self.send_header("X-Timing", urllib.parse.quote(timing))
        self.send_header("Content-Length", str(len(audio))); self.end_headers(); self.wfile.write(audio)

stt_local("/opt/voice/clip16.wav"); synth("a", "am_adam", "ready"); synth("z", "zm_yunyang", "好的")
try:  # warm the brain so the FIRST real turn isn't a cold ~2s Gemini call
    list(brain_stream("en", "warm up")); list(brain_stream("zh", "预热"))
except Exception: pass
print(f"WARM 127.0.0.1:8780 — stt={DEFAULT_STT} reply={REPLY_MODE}", flush=True)
HTTPServer(("127.0.0.1", 8780), H).serve_forever()
