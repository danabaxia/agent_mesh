/**
 * Voice demo server — LOCAL ONLY (localhost = secure context so the browser mic works).
 *
 * Purpose: let the owner judge the two things they care about, on their OWN voice,
 * with the REAL candidate engines:
 *   1) 朗读自然度 — macOS `say` rendered to WAV, A/B across voices (incl. Premium neural).
 *   2) 听懂准确度 — local whisper.cpp (large-v3-turbo) transcription of bilingual speech.
 *
 * Zero deps. Run:  node voice-demo/server.mjs   then open http://localhost:7099
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync, readFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.VOICE_DEMO_PORT || 7099);

// --- whisper discovery -----------------------------------------------------
function findWhisperBin() {
  for (const b of ['whisper-cli', 'whisper-cpp', 'main']) {
    try { return execFileSync('which', [b], { encoding: 'utf8' }).trim(); } catch {}
  }
  return null;
}
function modelsByName() {
  const dir = join(HERE, 'models');
  const map = {};
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.bin'))) {
      const key = /turbo|large/i.test(f) ? 'accurate' : 'fast';
      map[key] = join(dir, f);
    }
  }
  return map;
}
const WHISPER_BIN = findWhisperBin();
const MODELS = modelsByName();
// Default to the FAST model for snappy push-to-talk; ?model=accurate selects turbo/large.
const MODEL = MODELS.fast || MODELS.accurate || null;
function pickModel(name) { return (name === 'accurate' && MODELS.accurate) || (name === 'fast' && MODELS.fast) || MODEL; }

// --- curated bilingual voices ---------------------------------------------
// The basic `say` voices are robotic; Premium/Enhanced downloads are near-Siri.
// We surface a curated short list + a "has premium?" hint computed at startup.
function listSayVoices() {
  try {
    const out = execFileSync('say', ['-v', '?'], { encoding: 'utf8' });
    return out.split('\n').map((line) => {
      const m = line.match(/^(.+?)\s{2,}([a-z]{2}_[A-Z]{2})\s/);
      if (!m) return null;
      return { name: m[1].trim(), lang: m[2] };
    }).filter(Boolean);
  } catch { return []; }
}
const ALL_VOICES = listSayVoices();
const CURATED = [
  // name candidates in install order of "naturalness"; we keep whatever exists.
  'Meijia', 'Tingting', 'Sinji', 'Li-mu', 'Yu-shu',           // zh
  'Ava (Premium)', 'Samantha', 'Ava', 'Zoe', 'Allison', 'Tom', // en premium-ish
  'Daniel', 'Karen', 'Serena',
];
function curatedVoices() {
  const have = new Map(ALL_VOICES.map((v) => [v.name, v]));
  const picked = [];
  for (const n of CURATED) if (have.has(n)) picked.push(have.get(n));
  // always include any voice whose name says Premium/Enhanced
  for (const v of ALL_VOICES) if (/premium|enhanced/i.test(v.name) && !picked.includes(v)) picked.push(v);
  // fall back to a couple of zh + en if curated list missed
  if (!picked.some((v) => v.lang.startsWith('zh'))) {
    const z = ALL_VOICES.find((v) => v.lang.startsWith('zh')); if (z) picked.push(z);
  }
  if (!picked.some((v) => v.lang.startsWith('en'))) {
    const e = ALL_VOICES.find((v) => v.lang === 'en_US'); if (e) picked.push(e);
  }
  return picked;
}

// --- helpers ---------------------------------------------------------------
function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- Kokoro (local neural TTS, arm64 venv) --------------------------------
const VENV_PY = join(HERE, '.venv', 'bin', 'python');
const KOKORO_OK = existsSync(VENV_PY) && existsSync(join(HERE, 'kokoro_tts.py'));
// Curated bilingual Kokoro voices. lang: 'a' US-EN, 'b' UK-EN, 'z' Mandarin.
const KOKORO_VOICES = [
  { name: 'zf_xiaoxiao', lang: 'z', label: 'Kokoro 晓晓 (中·女)' },
  { name: 'zf_xiaoni',   lang: 'z', label: 'Kokoro 晓妮 (中·女)' },
  { name: 'zm_yunxi',    lang: 'z', label: 'Kokoro 云希 (中·男)' },
  { name: 'zm_yunyang',  lang: 'z', label: 'Kokoro 云扬 (中·男)' },
  { name: 'af_heart',    lang: 'a', label: 'Kokoro Heart (en·f)' },
  { name: 'af_bella',    lang: 'a', label: 'Kokoro Bella (en·f)' },
  { name: 'am_michael',  lang: 'a', label: 'Kokoro Michael (en·m)' },
  { name: 'bf_emma',     lang: 'b', label: 'Kokoro Emma (UK·f)' },
];
// Persistent Kokoro worker: model loads ONCE, requests stream over stdin/stdout,
// cutting per-utterance latency from ~5s (cold spawn) to ~1s. Lazily (re)spawned.
import { spawn } from 'node:child_process';
let kokWorker = null, kokReady = false, kokSeq = 0, kokBuf = '';
const kokPending = new Map();   // id -> { resolve, reject, out }
function startKokoroWorker() {
  if (!KOKORO_OK) return null;
  const w = spawn('arch', ['-arm64', VENV_PY, join(HERE, 'kokoro_worker.py')], { cwd: HERE });
  kokReady = false; kokBuf = '';
  w.stdout.on('data', (d) => {
    kokBuf += d.toString();
    let nl;
    while ((nl = kokBuf.indexOf('\n')) >= 0) {
      const line = kokBuf.slice(0, nl).trim(); kokBuf = kokBuf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { kokReady = true; console.log('kokoro worker ready, device=' + msg.device); continue; }
      const p = kokPending.get(msg.id); if (!p) continue;
      kokPending.delete(msg.id);
      if (msg.error) p.reject(new Error('kokoro: ' + msg.error));
      else { try { p.resolve(readFileSync(p.out)); } catch (e) { p.reject(e); } finally { try { unlinkSync(p.out); } catch {} } }
    }
  });
  w.stderr.on('data', () => {});   // model warnings are noise
  w.on('exit', () => { kokReady = false; kokWorker = null; for (const [, p] of kokPending) p.reject(new Error('kokoro worker exited')); kokPending.clear(); });
  return w;
}
function runKokoro(text, voice, lang) {
  const v = KOKORO_VOICES.find((x) => x.name === voice) || KOKORO_VOICES[0];
  if (!kokWorker) kokWorker = startKokoroWorker();
  if (!kokWorker) return Promise.reject(new Error('kokoro not available'));
  const id = ++kokSeq;
  const out = join(tmpdir(), `vd-kok-${process.pid}-${id}.wav`);
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    kokPending.set(id, {
      out,
      resolve: (buf) => { console.log('kokoro', Math.round(performance.now() - t0) + 'ms (warm)'); resolve(buf); },
      reject,
    });
    kokWorker.stdin.write(JSON.stringify({ id, text: text.slice(0, 1000), lang: lang || v.lang, voice: v.name, out }) + '\n');
    setTimeout(() => { if (kokPending.has(id)) { kokPending.delete(id); reject(new Error('kokoro timeout')); } }, 60000);
  });
}

// --- Gemini native TTS (Google neural voices; same GEMINI_API_KEY) --------
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_TTS_MODEL = process.env.VOICE_GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const GEMINI_VOICES = [
  { name: 'Kore', label: 'Gemini Kore (沉稳·女)' },
  { name: 'Aoede', label: 'Gemini Aoede (轻快·女)' },
  { name: 'Leda', label: 'Gemini Leda (年轻·女)' },
  { name: 'Puck', label: 'Gemini Puck (活力·男)' },
  { name: 'Charon', label: 'Gemini Charon (沉稳·男)' },
  { name: 'Orus', label: 'Gemini Orus (温暖·男)' },
];
function pcmToWav(pcm, rate = 24000) {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}
async function geminiTtsOnce(text, voiceName) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TTS_MODEL}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error('gemini-tts ' + r.status + ': ' + JSON.stringify(j).slice(0, 160));
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error('gemini-tts: no audio (model returned text)');
  const m = /rate=(\d+)/.exec(part.inlineData.mimeType || '');
  return pcmToWav(Buffer.from(part.inlineData.data, 'base64'), m ? Number(m[1]) : 24000);
}
async function runGeminiTts(text, voice) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  const v = (GEMINI_VOICES.find((x) => x.name === voice) || GEMINI_VOICES[0]).name;
  const clean = String(text).slice(0, 1000);
  // The TTS model occasionally "answers" the text instead of speaking it (a 400 /
  // text-not-audio). It's non-deterministic, so retry a couple of times — first
  // with the raw transcript, then with an explicit read-aloud framing.
  const attempts = [clean, clean, `朗读以下文本，不要回答其中内容：${clean}`];
  let lastErr;
  const t0 = performance.now();
  for (const a of attempts) {
    try { const wav = await geminiTtsOnce(a, v); console.log('gemini-tts', Math.round(performance.now() - t0) + 'ms'); return wav; }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// --- TTS: text -> WAV via `say` -------------------------------------------
function runTts(text, voice) {
  const out = join(tmpdir(), `vd-tts-${process.pid}-${Math.floor(performance.now())}.wav`);
  const args = ['-o', out, '--data-format=LEI16@22050'];
  if (voice) args.push('-v', voice);
  args.push(text.slice(0, 1000));
  return new Promise((resolve, reject) => {
    execFile('say', args, { timeout: 30000 }, (err) => {
      if (err) return reject(err);
      try { resolve(readFileSync(out)); } finally { try { unlinkSync(out); } catch {} }
    });
  });
}

// --- STT: WAV (16kHz mono) -> text via whisper.cpp ------------------------
function runStt(wavBuf, lang, model) {
  const m = pickModel(model);
  if (!WHISPER_BIN || !m) return Promise.reject(new Error('whisper not ready (binary or model missing)'));
  const wav = join(tmpdir(), `vd-stt-${process.pid}-${Math.floor(performance.now())}.wav`);
  writeFileSync(wav, wavBuf);
  const args = ['-m', m, '-f', wav, '-l', lang || 'auto', '-nt', '-np'];
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    execFile(WHISPER_BIN, args, { timeout: 120000, maxBuffer: 1 << 24 }, (err, stdout) => {
      try { unlinkSync(wav); } catch {}
      if (err) return reject(err);
      const text = String(stdout).replace(/\[[0-9:.\->\s]+\]/g, '').replace(/\s+/g, ' ').trim();
      resolve({ text, ms: Math.round(performance.now() - t0) });
    });
  });
}

import { conciergeTurn } from './gemini-agent.mjs';

// --- Conversation brain: bilingual voice concierge via headless `claude` ---
const CLAUDE_BIN = process.env.AGENT_MESH_CLAUDE || 'claude';
const CONCIERGE_SYSTEM = [
  'You are a bilingual (中文 / English) VOICE concierge for the owner\'s personal "agent mesh".',
  'Your job: 和 owner 探讨想法，并根据他/她告诉你的知识把想法落成具体任务。',
  'RULES:',
  '- Reply in the SAME language the owner used (中文→中文, English→English; mixed→follow the dominant language).',
  '- This reply is READ ALOUD by TTS. So: 1–3 short spoken sentences. NO markdown, NO bullet lists, NO code, NO emoji.',
  '- When the owner shares an idea, briefly reflect it, propose 1–2 concrete next tasks, then ask ONE question to move forward.',
  '- Be warm, concise, concrete. Never dump options; give a recommendation.',
].join('\n');

function buildDialogPrompt(history, text) {
  const lines = (Array.isArray(history) ? history : []).slice(-10).map((t) =>
    `${t.role === 'assistant' ? 'Concierge' : 'Owner'}: ${String(t.text || '').slice(0, 800)}`);
  lines.push(`Owner: ${text}`);
  lines.push('Concierge:');
  return lines.join('\n');
}

function runConcierge(history, text) {
  const args = ['-p', '--output-format', 'json', '--append-system-prompt', CONCIERGE_SYSTEM, buildDialogPrompt(history, text)];
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    execFile(CLAUDE_BIN, args, { timeout: 120000, maxBuffer: 1 << 24, cwd: HERE }, (err, stdout) => {
      if (err && !stdout) return reject(new Error('claude: ' + err.message.slice(0, 200)));
      let reply = '';
      try { reply = JSON.parse(stdout).result || ''; }
      catch { reply = String(stdout).trim().slice(0, 2000); }
      resolve({ reply: reply.trim(), ms: Math.round(performance.now() - t0) });
    });
  });
}

// --- auth: localhost is open; any non-local host (i.e. over the tailnet) needs
// the token. The console can file issues + spend API, so it must not be an open
// endpoint once exposed. Token via ?t=, cookie `vtoken`, or X-Voice-Token header.
// Stable token: reuse the persisted one across restarts so the phone URL stays
// valid; only generate a fresh one if none exists (or VOICE_TOKEN overrides).
const TOKEN_FILE = join(HERE, '.voice-token');
const TOKEN = process.env.VOICE_TOKEN
  || (existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : '')
  || randomUUID();

// --- session memory: the SERVER owns the conversation per session id, so it
// survives client reload / iOS tab-suspend (the in-memory client array got wiped →
// "随时忘记"). Persisted to disk so a server restart keeps it too. Source of truth.
const SESS_FILE = join(HERE, '.sessions.json');
const SESS_MAX = 60;                 // keep last 60 turns per session
const sessions = (() => {
  try { return new Map(Object.entries(JSON.parse(readFileSync(SESS_FILE, 'utf8')))); } catch { return new Map(); }
})();
let sessT;
function persistSessions() { clearTimeout(sessT); sessT = setTimeout(() => { try { writeFileSync(SESS_FILE, JSON.stringify(Object.fromEntries(sessions))); } catch {} }, 1500); }
function sessHistory(id) { return sessions.get(id) || []; }
function sessAppend(id, role, text) {
  const h = sessions.get(id) || [];
  h.push({ role, text: String(text || '').slice(0, 2000) });
  while (h.length > SESS_MAX) h.shift();
  sessions.set(id, h); persistSessions();
}
function isLocalHost(req) {
  const h = String(req.headers.host || '').split(':')[0];
  return h === '127.0.0.1' || h === 'localhost' || h === '';
}
function tokenOk(req, url) {
  if (url.searchParams.get('t') === TOKEN) return true;
  if (String(req.headers['x-voice-token'] || '') === TOKEN) return true;
  const cookie = String(req.headers.cookie || '');
  return cookie.split(';').some((c) => c.trim() === `vtoken=${TOKEN}`);
}

// --- routes ----------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // Strip an optional /voice mount prefix so the same build works at localhost
    // root AND behind `tailscale serve --set-path=/voice` (whether or not Tailscale
    // strips the prefix itself). Keeps the phone reachable over the tailnet.
    const path = url.pathname.replace(/^\/voice(?=\/|$)/, '') || '/';
    // Gate non-local requests. The static shell ('/' + '/app.js') is ALWAYS served
    // (no secrets in it; the token lives in the user's ?t= URL) so the page loads
    // even if iOS Safari drops the cookie; only the action/cost API routes need the
    // token off-localhost — app.js reads ?t= and sends it as a header on those.
    const local = isLocalHost(req);
    const publicShell = path === '/' || path === '/app.js';
    if (!local && !publicShell && !tokenOk(req, url)) {
      return send(res, 403, 'application/json', JSON.stringify({ ok: false, error: 'token required' }));
    }
    if (req.method === 'GET' && path === '/') {
      // On the tailnet, stamp the cookie from ?t= so subsequent API calls authorize.
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
      if (!local && url.searchParams.get('t') === TOKEN) headers['Set-Cookie'] = `vtoken=${TOKEN}; Path=/; SameSite=Lax`;
      res.writeHead(200, headers);
      return res.end(await readFile(join(HERE, 'public', 'index.html')));
    }
    if (req.method === 'GET' && path === '/app.js') {
      return send(res, 200, 'text/javascript; charset=utf-8', await readFile(join(HERE, 'public', 'app.js')));
    }
    if (req.method === 'GET' && path === '/voices') {
      return send(res, 200, 'application/json', JSON.stringify({
        gemini: GEMINI_KEY ? GEMINI_VOICES : [],
        say: curatedVoices(),
        kokoro: KOKORO_OK ? KOKORO_VOICES : [],
        all: ALL_VOICES.length,
        whisper: { ready: Boolean(WHISPER_BIN && MODEL), bin: WHISPER_BIN, model: MODEL ? MODEL.split('/').pop() : null },
      }));
    }
    if (req.method === 'POST' && path === '/tts') {
      const { text, voice, engine, lang } = JSON.parse((await readBody(req)).toString() || '{}');
      if (!text) return send(res, 400, 'application/json', JSON.stringify({ error: 'no text' }));
      let wav;
      if (engine === 'gemini') {
        // Gemini is the natural default; if it ever fails, fall back so the user
        // still always hears a reply (Kokoro local → macOS say last resort).
        try { wav = await runGeminiTts(text, voice); }
        catch (e1) {
          console.log('gemini-tts failed, falling back:', String(e1.message).slice(0, 120));
          try { wav = await runKokoro(text, 'zf_xiaoxiao', 'z'); }
          catch { wav = await runTts(text); }
        }
      } else if (engine === 'kokoro') { wav = await runKokoro(text, voice, lang); }
      else { wav = await runTts(text, voice); }
      return send(res, 200, 'audio/wav', wav);
    }
    if (req.method === 'POST' && path === '/chat') {
      const { history: clientHistory, text, confirmBeforeFile, session } = JSON.parse((await readBody(req)).toString() || '{}');
      if (!text) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: 'no text' }));
      const sid = String(session || 'default').slice(0, 64);
      // Server-owned history is the source of truth (survives client reload/suspend);
      // fall back to client-sent history only if the server has none for this session.
      const history = sessHistory(sid).length ? sessHistory(sid) : (Array.isArray(clientHistory) ? clientHistory : []);
      const t0 = performance.now();
      console.log(`[chat] ← (sess ${sid.slice(0, 8)}, ${history.length}h) ${String(text).slice(0, 90)}`);
      try {
        const out = await conciergeTurn(history, text, { confirmBeforeFile: !!confirmBeforeFile });   // Gemini + mesh tools (auto 串联)
        sessAppend(sid, 'user', text); sessAppend(sid, 'assistant', out.reply);   // persist the turn
        const ms = Math.round(performance.now() - t0);
        console.log(`[chat] → (${ms}ms) tools=[${(out.actions || []).map((a) => a.name).join(',')}] reply: ${String(out.reply).slice(0, 100).replace(/\n/g, ' ')}`);
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, ...out, ms }));
      } catch (e) {
        console.log(`[chat] ✗ (${Math.round(performance.now() - t0)}ms): ${String(e.message).slice(0, 200)}`);
        throw e;
      }
    }
    if (req.method === 'GET' && path === '/history') {
      const sid = String(url.searchParams.get('session') || 'default').slice(0, 64);
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, turns: sessHistory(sid) }));
    }
    if (req.method === 'POST' && path === '/stt') {
      const lang = url.searchParams.get('lang') || 'auto';
      const model = url.searchParams.get('model') || 'fast';
      const wav = await readBody(req);
      const out = await runStt(wav, lang, model);
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, model, ...out }));
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    send(res, 500, 'application/json', JSON.stringify({ ok: false, error: String(e.message || e) }));
  }
});

// Persist the token so voice-serve.mjs can build the phone URL with ?t=.
try { writeFileSync(join(HERE, '.voice-token'), TOKEN); } catch {}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Voice console  →  http://localhost:${PORT}\n`);
  console.log(`  say voices : ${ALL_VOICES.length} installed, ${curatedVoices().length} curated`);
  console.log(`  whisper    : ${WHISPER_BIN && MODEL ? 'READY (' + MODEL.split('/').pop() + ')' : 'NOT READY'}`);
  console.log(`  token      : ${TOKEN}  (needed only off-localhost / on the phone)`);
  console.log('');
});
