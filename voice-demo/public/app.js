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
// Returns a promise that resolves when playback ENDS (so the hands-free loop can
// chain: listen → think → speak → listen). Resolves on error/timeout too.
function speak(text) {
  return new Promise(async (resolve) => {
    if (!text || !text.trim()) return resolve();
    const [engine, voice, lang] = ($('voice').value || 'gemini|Kore|').split('|');
    let settled = false, url = '';
    const done = () => { if (!settled) { settled = true; if (url) try { URL.revokeObjectURL(url); } catch {} resolve(); } };
    const guard = setTimeout(done, 30000);
    try {
      const res = await fetch(api('tts'), { method: 'POST', headers: authHdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ text, voice, engine, lang }) });
      if (!res.ok) { setStatus('语音合成失败'); clearTimeout(guard); return done(); }
      url = URL.createObjectURL(new Blob([await res.arrayBuffer()], { type: 'audio/wav' }));
      player.src = url;
      player.onended = () => { clearTimeout(guard); done(); };
      player.onerror = () => { clearTimeout(guard); done(); };
      await player.play().catch((e) => { setStatus('点一下🔈播放（' + e.name + '）'); clearTimeout(guard); done(); });
    } catch (e) { setStatus('语音失败：' + e.message); clearTimeout(guard); done(); }
  });
}

// ---- chunked TTS: play sentence 1 while sentence 2 is still synthesizing, so the
// first audio starts ~1s sooner (within the no-streaming Gemini stack) ----
function splitSentences(text) {
  const parts = String(text).split(/(?<=[。！？.!?])\s*/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) { if (out.length && out[out.length - 1].length < 8) out[out.length - 1] += p; else out.push(p); }
  return out.slice(0, 4);
}
async function ttsBlob(text) {
  const [engine, voice, lang] = ($('voice').value || 'gemini|Kore|').split('|');
  const res = await fetch(api('tts'), { method: 'POST', headers: authHdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ text, voice, engine, lang }) });
  if (!res.ok) throw new Error('tts ' + res.status);
  return new Blob([await res.arrayBuffer()], { type: 'audio/wav' });
}
function playBlob(blob) {
  return new Promise((resolve) => {
    let done = false; const url = URL.createObjectURL(blob);
    const fin = () => { if (!done) { done = true; try { URL.revokeObjectURL(url); } catch {} resolve(); } };
    const g = setTimeout(fin, 30000);
    player.src = url;
    player.onended = () => { clearTimeout(g); fin(); };
    player.onerror = () => { clearTimeout(g); fin(); };
    player.play().catch(() => { clearTimeout(g); fin(); });
  });
}
async function speakChunked(text, gen) {
  if (!text || !text.trim()) return;
  const chunks = splitSentences(text);
  let next = ttsBlob(chunks[0]).catch(() => null);
  for (let i = 0; i < chunks.length; i++) {
    const cur = await next;
    if (gen !== undefined && gen !== cvGen) return;    // session stopped/changed → abort remaining playback
    next = (i + 1 < chunks.length) ? ttsBlob(chunks[i + 1]).catch(() => null) : null;  // prefetch while playing
    if (cur) await playBlob(cur);
  }
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
    const confirmBeforeFile = $('confirmFile') ? $('confirmFile').checked : true;
    const res = await fetch(api('chat'), { method: 'POST', headers: authHdr({ 'Content-Type': 'application/json' }), body: JSON.stringify({ history: convo.slice(0, -1), text, confirmBeforeFile }) });
    const r = await res.json();
    if (!r.ok) { think.textContent = '出错：' + (r.error || '未知'); setStatus(''); return; }
    think.className = 'b ai'; think.textContent = r.reply; convo.push({ role: 'assistant', text: r.reply });
    for (const a of (r.actions || [])) {
      if (a.name === 'file_mesh_task' && a.result?.url) {
        cue('saved');               // earcon: idea actually filed (tied to real write success)
        const link = document.createElement('a'); link.className = 'issue'; link.href = a.result.url; link.target = '_blank'; link.rel = 'noopener';
        link.textContent = `✅ 已记下 #${a.result.number || ''}`;
        $('thread').appendChild(link);
      } else if (a.name === 'get_mesh_status') {
        bubble('sys', `📊 读取 mesh：${a.result?.openIssues ?? '?'} issues · ${a.result?.openPRs ?? '?'} PRs`);
      }
    }
    $('thread').scrollTop = $('thread').scrollHeight;
    setStatus('');
    if ($('autospeak').checked) await speakChunked(r.reply, cvGen);   // chunked + awaited; cvGen lets '停' abort mid-reply
    return r;
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

// ============================================================================
// Hands-free continuous conversation (drive-safe): tap ONCE to start, then it
// auto-detects when you speak (VAD), auto-sends, auto-speaks the reply, and
// auto-resumes listening — no tapping per turn.
// ============================================================================
let cvOn = false, cvStarting = false, cvStream, cvCtx, cvSource, cvProc, cvInRate = 48000;
let cvState = 'idle';          // 'idle' | 'listen' | 'capturing' | 'busy'
let cvBuf = [], cvSpeech = 0, cvSilence = 0;
let cvGen = 0;                 // bumped on stop — aborts any in-flight reply playback
let cvLastFrame = 0, cvWatchdog = 0;
const CV_MAX_CAPTURE_S = 40;   // cap a monologue so cvBuf can't OOM the tab
const VAD = {
  thresh: () => Number(($('sens') && $('sens').value) || 0.02),     // RMS gate (settings slider)
  minSpeechMs: 250,            // ignore blips shorter than this
  silenceMs: () => Number(($('endpause') && $('endpause').value) || 1.1) * 1000,  // trailing silence that ends a turn — tolerates think-pauses
};
// Audible earcons (eyes-free: the driver can't watch the UI). Short tones via the
// mic AudioContext (already unlocked by the start tap).
let earCtx;
function cue(kind) {
  try {
    if (!earCtx) earCtx = new (window.AudioContext || window.webkitAudioContext)();   // one shared, reused (don't leak per call)
    const ctx = cvCtx && cvCtx.state !== 'closed' ? cvCtx : earCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const seq = { listen: [660], heard: [880], saved: [660, 990], stopped: [520, 380], error: [300, 300], resumed: [520, 700] }[kind] || [660];
    seq.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      const t = ctx.currentTime + i * 0.12;
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.12);
    });
  } catch {}
}
function cvSetUI(on) {
  const b = $('convo');
  if (b) { b.classList.toggle('on', on); b.textContent = on ? '🚗 连续中·点停' : '🚗 连续对话'; }
}
// Build (or rebuild) the mic→processor graph on the existing stream+context.
function cvBuildGraph() {
  try { if (cvProc) cvProc.disconnect(); if (cvSource) cvSource.disconnect(); } catch {}
  cvSource = cvCtx.createMediaStreamSource(cvStream);
  cvProc = cvCtx.createScriptProcessor(4096, 1, 1);
  cvProc.onaudioprocess = onCvFrame;
  cvSource.connect(cvProc); cvProc.connect(cvCtx.destination);
  cvLastFrame = Date.now();
}
async function startContinuous() {
  if (cvOn || cvStarting) return;          // sync guard: no double-start leak
  cvStarting = true;
  try {
    try { cvStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { setStatus('麦克风被拒绝：' + e.message); return; }
    unlockAudio();
    cvCtx = new (window.AudioContext || window.webkitAudioContext)();
    cvInRate = cvCtx.sampleRate;
    cvBuf = []; cvSpeech = 0; cvSilence = 0; cvState = 'listen';
    cvBuildGraph();
    // If the mic track dies (another app grabs it, route change), tell the user audibly.
    cvStream.getTracks().forEach((t) => { t.onended = () => { if (cvOn) { setStatus('麦克风断开，已停'); cue('error'); stopContinuous(); speak('麦克风断开了，点连续对话可以重新开始。'); } }; });
    cvOn = true; cvSetUI(true); setStatus('🎧 在听…说吧');
    if ($('mic')) $('mic').disabled = true; if ($('send')) $('send').disabled = true;   // avoid a 2nd mic/echo while continuous
    // Watchdog: if the processor silently dies (iOS resume) it never deadlocks.
    clearInterval(cvWatchdog);
    cvWatchdog = setInterval(() => {
      if (!cvOn || cvState !== 'listen') return;
      if (Date.now() - cvLastFrame > 2500) {
        try { if (cvCtx.state === 'suspended') cvCtx.resume(); cvBuildGraph(); } catch {}
        if (Date.now() - cvLastFrame > 5000) { setStatus('音频停了，已停'); stopContinuous(); speak('对话停住了，点连续对话可以继续。'); }
      }
    }, 1500);
    if (!convoStarted) { convoStarted = true; bubble('sys', '连续对话已开启——直接说话即可，无需点按。说「停」或点按钮结束。'); }
  } finally { cvStarting = false; }
}
function stopContinuous() {
  cvOn = false; cvState = 'idle'; cvGen++;          // bump gen → abort any in-flight reply playback
  clearInterval(cvWatchdog);
  try { player.pause(); } catch {}                  // cut a reply that's already speaking
  cue('stopped');
  try { cvProc.disconnect(); cvSource.disconnect(); cvStream.getTracks().forEach((t) => t.stop()); setTimeout(() => { try { cvCtx.close(); } catch {} }, 400); } catch {}
  if ($('mic')) $('mic').disabled = false; if ($('send')) $('send').disabled = false;
  cvSetUI(false); setStatus('已停。点🚗可重新开始。');
}
let convoStarted = false;
function onCvFrame(e) {
  cvLastFrame = Date.now();                          // liveness for the watchdog
  if (!cvOn || cvState === 'busy') return;          // ignore mic while thinking/speaking (no self-capture)
  const data = e.inputBuffer.getChannelData(0), n = data.length;
  let sum = 0; for (let i = 0; i < n; i++) sum += data[i] * data[i];
  const rms = Math.sqrt(sum / n);
  const speaking = rms > VAD.thresh();
  const ms = (frames) => frames * n / cvInRate * 1000;
  if (cvState === 'listen') {
    if (speaking) { cvBuf.push(new Float32Array(data)); cvSpeech++; cvSilence = 0; if (ms(cvSpeech) >= VAD.minSpeechMs) { cvState = 'capturing'; setStatus('🎤 听到了…'); } }
    else { cvBuf = []; cvSpeech = 0; }
  } else if (cvState === 'capturing') {
    cvBuf.push(new Float32Array(data));
    const capped = cvBuf.length * n >= CV_MAX_CAPTURE_S * cvInRate;   // monologue cap → force-end
    if (speaking && !capped) cvSilence = 0;
    else if (capped || (++cvSilence, ms(cvSilence) >= VAD.silenceMs())) {
      const merged = (() => { const t = cvBuf.reduce((a, c) => a + c.length, 0), o = new Float32Array(t); let k = 0; for (const c of cvBuf) { o.set(c, k); k += c.length; } return o; })();
      cvBuf = []; cvSpeech = 0; cvSilence = 0; cvState = 'busy';
      handleCvUtterance(merged);
    }
  }
}
async function handleCvUtterance(samples) {
  if (samples.length < cvInRate * 0.3) { if (cvOn) { cvState = 'listen'; setStatus('🎧 在听…'); } return; }
  cue('heard');                       // earcon: "got it, processing" (eyes-free)
  const wav = encodeWav(downsample(samples, cvInRate));
  setStatus('💭 在想…');
  try {
    const lang = $('sttLang').value, model = $('accurate').checked ? 'accurate' : 'fast';
    const d = await (await fetch(api(`stt?lang=${lang}&model=${model}`), { method: 'POST', headers: authHdr({ 'Content-Type': 'audio/wav' }), body: wav })).json();
    if (d.ok && d.text) {
      // Loosened stop intent: strip all punctuation/space, match common spoken forms.
      const bare = d.text.replace(/[\s，。、！？!?.「」"']/g, '');
      if (/^(停|停一下|停下|停下来|停止|结束(对话)?|退出|不聊了|stop|exit|quit)$/i.test(bare)) { bubble('me', d.text); stopContinuous(); return; }
      await send(d.text);             // chat + speak (awaits playback end)
    } else setStatus('没听清…');
  } catch (e) { setStatus('识别失败：' + e.message); cue('error'); }
  if (cvOn) { cvState = 'listen'; cvBuf = []; cvSpeech = 0; cvSilence = 0; cue('listen'); setStatus('🎧 在听…说吧'); }
}
if ($('convo')) $('convo').onclick = () => { unlockAudio(); cvOn ? stopContinuous() : startContinuous(); };

// iOS Safari suspends the tab on screen-lock / incoming call / app-switch, which
// silently freezes the audio loop. On return, resume the context; if the mic is
// dead, tell the user audibly so a driving session never silently stalls.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !cvOn) return;
  try {
    if (cvCtx && cvCtx.state === 'suspended') await cvCtx.resume();
    const live = cvStream && cvStream.getTracks().some((t) => t.readyState === 'live');
    if (!live) { stopContinuous(); speak('对话刚才中断了，点连续对话可以继续。'); }
    else if (cvState !== 'busy') {           // never override an in-flight think/speak (would self-capture)
      cvBuildGraph();                         // iOS often kills the processor on resume — rebuild it
      cvState = 'listen'; cue('resumed'); setStatus('🎧 回来了，在听…');
    }
  } catch { /* best-effort */ }
});

loadVoices().then(() => bubble('ai', '你好，我是你的 mesh 助手。点「🚗 连续对话」免提聊（开车也能用），或按麦克风/打字。把好想法随口说给我，我帮你记下来、安排成任务。'));
