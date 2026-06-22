/**
 * src/dashboard/public/mobile/voice-engine.js
 *
 * Swappable voice-I/O adapter for the concierge PWA — speech-to-text (mic input)
 * and text-to-speech (read the reply aloud). The native implementation uses the
 * browser Web Speech API (free, zero-dep, on-device, private). The whole point of
 * this module is the SEAM: a cloud engine (OpenAI / ElevenLabs) can later replace
 * ONLY this file by returning the same interface, without touching the UI.
 * Owner-approved brief: concierge-analyst-001.
 *
 * Returned engine interface (the contract a cloud impl must also satisfy):
 *   { sttSupported, ttsSupported,
 *     startListening({lang,onResult,onError,onEnd}) -> bool,
 *     stopListening(), isListening() -> bool,
 *     speak(text,{lang}) -> bool, cancelSpeak() }
 *
 * Pure (DOM-free, injectable) so it unit-tests at L0 with fake speech APIs.
 */

// UI language toggle → BCP-47 STT codes. Native recognition handles one language
// at a time (poor at mixed zh/en), so the UI toggles it explicitly (brief).
export const LANGS = {
  zh: { stt: 'zh-CN', label: '中' },
  en: { stt: 'en-US', label: 'EN' },
};

export function sttLang(uiLang) {
  return (LANGS[uiLang] || LANGS.en).stt;
}

/** TTS language follows the reply content: any CJK char → zh-CN, else en-US. */
export function ttsLangFor(text) {
  return /[㐀-鿿]/.test(String(text ?? '')) ? 'zh-CN' : 'en-US';
}

/**
 * Build the engine over injected speech globals (defaults to the browser's).
 * @param {object} [env]  { SpeechRecognition|webkitSpeechRecognition, speechSynthesis, SpeechSynthesisUtterance }
 */
export function createVoiceEngine(env = (typeof globalThis !== 'undefined' ? globalThis : {})) {
  const SR = env.SpeechRecognition || env.webkitSpeechRecognition || null;
  const synth = env.speechSynthesis || null;
  const Utter = env.SpeechSynthesisUtterance || null;
  const sttSupported = !!SR;
  const ttsSupported = !!(synth && Utter);

  let rec = null;
  let listening = false;

  function startListening({ lang = 'en-US', onResult, onError, onEnd } = {}) {
    if (!sttSupported || listening) return false;
    rec = new SR();
    rec.lang = lang;
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;            // single utterance — NOT a continuous "call" (YAGNI)
    rec.onresult = (e) => {
      const t = e?.results?.[0]?.[0]?.transcript ?? '';
      if (onResult) onResult(String(t).trim());
    };
    rec.onerror = (e) => { if (onError) onError(e?.error || 'error'); };
    rec.onend = () => { listening = false; rec = null; if (onEnd) onEnd(); };
    listening = true;
    try { rec.start(); } catch (e) { listening = false; rec = null; if (onError) onError('start_failed'); return false; }
    return true;
  }

  function stopListening() {
    if (rec && listening) { try { rec.stop(); } catch { /* already stopped */ } }
  }

  function isListening() { return listening; }

  function speak(text, { lang } = {}) {
    const t = String(text ?? '').trim();
    if (!ttsSupported || !t) return false;
    try { synth.cancel(); } catch { /* nothing speaking */ }   // never overlap utterances
    const u = new Utter(t);
    u.lang = lang || ttsLangFor(t);
    synth.speak(u);
    return true;
  }

  function cancelSpeak() {
    if (ttsSupported) { try { synth.cancel(); } catch { /* idempotent */ } }
  }

  return { sttSupported, ttsSupported, startListening, stopListening, isListening, speak, cancelSpeak };
}
