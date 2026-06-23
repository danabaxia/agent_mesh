/* Mesh 语音助手 — clean phone client. Talk or type → Gemini discusses + auto-drives
   the mesh (files tasks / reads status) → natural voice reply. */
const $ = (id) => document.getElementById(id);
const api = (p) => new URL(String(p).replace(/^\//, ''), document.baseURI).href;
// ?t= token (phone/tailnet auth) → header on every API call (iOS cookie-drop safe).
try { const t = new URLSearchParams(location.search).get('t'); if (t) localStorage.setItem('voice_token', t); } catch {}
const VTOKEN = (() => { try { return localStorage.getItem('voice_token') || ''; } catch { return ''; } })();
const authHdr = (h = {}) => VTOKEN ? { ...h, 'X-Voice-Token': VTOKEN } : h;

// ---- voices / status ----
async function loadVoices() {
  let r; try { r = await fetch(api('voices'), { headers: authHdr() }).then((x) => x.json()); } catch { r = null; }
  if (!r) { $('dot').style.background = '#e5484d'; return; }
  const opt = (engine, name, label, lang = '') => `<option value="${engine}|${name}|${lang}">${label}</option>`;
  const gem = (r.gemini || []).map((v) => opt('gemini', v.name, '✨ ' + v.label));
  const kok = (r.kokoro || []).map((v) => opt('kokoro', v.name, '🧠 ' + v.label, v.lang));
  const say = (r.say || []).map((v) => opt('say', v.name, '🔊 ' + v.name + ' · ' + v.lang));
  $('voice').innerHTML = (gem.length ? `<optgroup label="自然(Gemini)">${gem.join('')}</optgroup>` : '')
    + (kok.length ? `<optgroup label="本地(Kokoro)">${kok.join('')}</optgroup>` : '')
    + `<optgroup label="系统(say)">${say.join('')}</optgroup>`;
}

// ---- TTS (iOS-safe playback) ----
// iOS Safari blocks Audio.play() outside a user gesture. The reply audio arrives
// async (after the chat round-trip), so we reuse ONE <audio> element and "unlock"
// it on the user's tap (mic/send); later programmatic play() on that same element
// is then allowed.
const player = new Audio();
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  try {
    player.muted = true;
    player.play().then(() => { player.pause(); player.muted = false; audioUnlocked = true; }).catch(() => { player.muted = false; });
  } catch {}
}
async function speak(text) {
  if (!text || !text.trim()) return;
  const [engine, voice, lang] = ($('voice').value || 'gemini|Kore|').split('|');
  try {
    const res = await fetch(api('tts'), { method: 'POST', headers: authHdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ text, voice, engine, lang }) });
    if (!res.ok) { setStatus('语音合成失败'); return; }
    player.src = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'audio/wav' }));
    await player.play().catch((e) => setStatus('点一下🔈播放（' + e.name + '）'));
  } catch (e) { setStatus('语音失败：' + e.message); }
}

// ---- mic capture → 16kHz mono WAV (whisper-ready) ----
let audioCtx, stream, source, proc, chunks = [], recording = false;
const HZ = 16000;
function downsample(buf, inRate) {
  if (HZ >= inRate) return buf;
  const ratio = inRate / HZ, len = Math.round(buf.length / ratio), out = new Float32Array(len);
  let oi = 0, ii = 0;
  while (oi < len) { const next = Math.round((oi + 1) * ratio); let s = 0, n = 0; for (; ii < next && ii < buf.length; ii++) { s += buf[ii]; n++; } out[oi++] = n ? s / n : 0; }
  return out;
}
function encodeWav(samples) {
  const b = new ArrayBuffer(44 + samples.length * 2), dv = new DataView(b);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, HZ, true); dv.setUint32(28, HZ * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, samples.length * 2, true);
  let o = 44; for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([b], { type: 'audio/wav' });
}
async function micStart() {
  if (recording) return;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { setStatus('麦克风被拒绝：' + e.message); return; }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  source = audioCtx.createMediaStreamSource(stream);
  proc = audioCtx.createScriptProcessor(4096, 1, 1); chunks = [];
  proc.onaudioprocess = (e) => { if (recording) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  source.connect(proc); proc.connect(audioCtx.destination);
  recording = true; $('mic').classList.add('rec'); setStatus('● 录音中…松开发送');
}
async function micStop() {
  if (!recording) return; recording = false; $('mic').classList.remove('rec');
  try { proc.disconnect(); source.disconnect(); stream.getTracks().forEach((t) => t.stop()); } catch {}
  const inRate = audioCtx.sampleRate; await audioCtx.close();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total < inRate * 0.3) { setStatus(''); return; }
  const merged = new Float32Array(total); let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
  const wav = encodeWav(downsample(merged, inRate));
  setStatus('听懂中…');
  try {
    const lang = $('sttLang').value, model = $('accurate').checked ? 'accurate' : 'fast';
    const d = await (await fetch(api(`stt?lang=${lang}&model=${model}`), { method: 'POST', headers: authHdr({ 'Content-Type': 'audio/wav' }), body: wav })).json();
    if (d.ok && d.text) send(d.text); else setStatus('没听清，再说一次');
  } catch (e) { setStatus('识别失败：' + e.message); }
}

// ---- conversation ----
const convo = [];
function setStatus(t) { $('status').textContent = t || ''; }
function bubble(cls, text) {
  const el = document.createElement('div'); el.className = 'b ' + cls; el.textContent = text;
  $('thread').appendChild(el); $('thread').scrollTop = $('thread').scrollHeight; return el;
}
async function send(text) {
  text = (text || '').trim(); if (!text) return;
  bubble('me', text); convo.push({ role: 'user', text });
  const think = bubble('ai typing', '…'); setStatus('思考中…');
  try {
    const res = await fetch(api('chat'), { method: 'POST', headers: authHdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ history: convo.slice(0, -1), text }) });
    const r = await res.json();
    if (!r.ok) { think.textContent = '出错：' + (r.error || '未知'); setStatus(''); return; }
    think.className = 'b ai'; think.textContent = r.reply; convo.push({ role: 'assistant', text: r.reply });
    for (const a of (r.actions || [])) {
      if (a.name === 'file_mesh_task' && a.result?.url) {
        const link = document.createElement('a'); link.className = 'issue'; link.href = a.result.url; link.target = '_blank'; link.rel = 'noopener';
        link.textContent = `✅ 已开任务 #${a.result.number || ''}`;
        $('thread').appendChild(link);
      } else if (a.name === 'get_mesh_status') {
        bubble('sys', `📊 读取 mesh：${a.result?.openIssues ?? '?'} issues · ${a.result?.openPRs ?? '?'} PRs`);
      }
    }
    $('thread').scrollTop = $('thread').scrollHeight;
    setStatus('');
    if ($('autospeak').checked) speak(r.reply);
  } catch (e) { think.textContent = '请求失败：' + e.message; setStatus(''); }
}

// ---- wiring ----
const input = $('input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.3) + 'px'; });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); unlockAudio(); const t = input.value; input.value = ''; input.style.height = 'auto'; send(t); } });
$('send').onclick = () => { unlockAudio(); const t = input.value; input.value = ''; input.style.height = 'auto'; send(t); };
const mic = $('mic');
const micDown = () => { unlockAudio(); micStart(); };
mic.addEventListener('mousedown', micDown); mic.addEventListener('mouseup', micStop); mic.addEventListener('mouseleave', () => recording && micStop());
mic.addEventListener('touchstart', (e) => { e.preventDefault(); micDown(); }, { passive: false });
mic.addEventListener('touchend', (e) => { e.preventDefault(); micStop(); }, { passive: false });
$('gear').onclick = () => $('sheet').classList.add('on');
$('sheetDone').onclick = () => $('sheet').classList.remove('on');
$('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').classList.remove('on'); });

loadVoices().then(() => bubble('ai', '你好，我是你的 mesh 助手。按住麦克风说话，或直接打字。我们可以探讨想法，我会帮你安排成任务、查看 mesh 状态。'));
