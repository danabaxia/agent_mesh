// Mesh Voice PWA — fetch a room-scoped mic-only token, join the LiveKit room, publish
// the mic, and play the agent's streamed reply. Continuous: server VAD drives turns,
// no per-turn tap. Device secret comes from ?t= (stored), sent as the mint bearer.
'use strict';
const LK = window.LivekitClient;
const $ = (id) => document.getElementById(id);
const orb = $('orb'), statusEl = $('status'), goBtn = $('go'), logEl = $('log'), sink = $('sink');

// device secret for the mint endpoint: ?t=... once, then persisted
const url = new URL(location.href);
const t = url.searchParams.get('t');
if (t) { localStorage.setItem('mesh_voice_token', t); history.replaceState({}, '', location.pathname); }
const DEVICE_SECRET = localStorage.getItem('mesh_voice_token') || '';
const MINT_URL = (localStorage.getItem('mesh_mint_url') || '/token');

let room = null;
let lang = 'en';   // temporary default: English interaction (tap 中 to switch per session)   // manual language lock
function setStatus(s) { statusEl.textContent = s; }

function applyLang(l) {
  lang = l; localStorage.setItem('mesh_voice_lang', l);
  document.getElementById('lang-zh').classList.toggle('on', l === 'zh');
  document.getElementById('lang-en').classList.toggle('on', l === 'en');
  if (room && room.localParticipant) {
    try { room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ lang: l })), { reliable: true }); } catch {}
  }
}
document.getElementById('lang-zh').onclick = () => applyLang('zh');
document.getElementById('lang-en').onclick = () => applyLang('en');

let holding = false;
function talk(on) {
  if (!room || !room.localParticipant || on === holding) return;
  holding = on;
  try { room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify({ talk: on })), { reliable: true }); } catch {}
  orb.classList.toggle('talking', on);
  setStatus(on ? '🎤 listening — release when done' : '⏳ processing…');
}
function setupHold() {
  const down = (e) => { if (room) { e.preventDefault(); talk(true); } };
  const up = (e) => { if (holding) { e.preventDefault(); talk(false); } };
  orb.addEventListener('pointerdown', down);
  orb.addEventListener('pointerup', up);
  orb.addEventListener('pointercancel', up);
  orb.addEventListener('pointerleave', up);
}
function log(who, text) {
  const d = document.createElement('div');
  d.className = who; d.innerHTML = `<span class="${who}">${who === 'you' ? 'you' : 'bot'}:</span> ${text}`;
  logEl.prepend(d);
}

async function mintToken() {
  const r = await fetch(MINT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${DEVICE_SECRET}` },
    body: JSON.stringify({ identity: 'phone-' + Math.random().toString(36).slice(2, 8) }),
  });
  if (!r.ok) throw new Error(`mint ${r.status}`);
  return r.json(); // { token, url, room }
}

async function connect() {
  if (!DEVICE_SECRET) { setStatus('missing token — open the /?t=… link'); return; }
  goBtn.disabled = true; setStatus('connecting…');
  try {
    const { token, url: wsUrl } = await mintToken();
    room = new LK.Room({ adaptiveStream: true, dynacast: true });

    room.on(LK.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'audio') { track.attach(sink); }   // play the agent's reply
    });
    room.on(LK.RoomEvent.DataReceived, (payload) => {
      try {
        const m = JSON.parse(new TextDecoder().decode(payload));
        // half-duplex: mute our mic while the agent speaks so its voice isn't re-captured
        if (m.speaking === true) {
          room.localParticipant.setMicrophoneEnabled(false);
          orb.classList.remove('live'); setStatus('🔊 speaking…');
        } else if (m.speaking === false) {
          setTimeout(() => {
            room.localParticipant.setMicrophoneEnabled(true);
            orb.classList.add('live'); setStatus('listening — just talk');
          }, 450);
        }
        if (m.stt) {
          const s = m.stt.startsWith('gemini') ? 'Gemini ☁️' : 'GPU 🖥️ (whisper)';
          document.getElementById('hwinfo').textContent = `STT: ${s} · TTS: GPU 🖥️ (Kokoro)`;
        }
        if (m.transcript) log('you', m.transcript);
        if (m.reply) log('bot', m.reply + (m.idea ? `  ✓ saved: ${m.idea}` : ''));
      } catch {}
    });
    room.on(LK.RoomEvent.Disconnected, () => { orb.classList.remove('live'); setStatus('disconnected'); resetBtn(); });

    await room.connect(wsUrl, token);
    await room.localParticipant.setMicrophoneEnabled(true);  // continuous publish
    applyLang(lang);                                         // tell the agent the chosen language
    orb.classList.add('live'); setStatus('按住圆圈说话 · hold the circle to talk');
    goBtn.textContent = 'Disconnect'; goBtn.className = 'stop'; goBtn.disabled = false;
    goBtn.onclick = disconnect;
  } catch (e) {
    setStatus('error: ' + e.message); resetBtn();
  }
}

async function disconnect() {
  if (room) { await room.disconnect(); room = null; }
  orb.classList.remove('live'); setStatus('tap to connect'); resetBtn();
}
function resetBtn() {
  goBtn.disabled = false; goBtn.textContent = 'Connect & talk'; goBtn.className = ''; goBtn.onclick = connect;
}

goBtn.onclick = connect;
applyLang(lang);   // initialize the toggle to the stored language
setupHold();       // push-to-talk: hold the orb to capture a clean utterance
if (!DEVICE_SECRET) setStatus('open the /?t=… link from your dashboard');
