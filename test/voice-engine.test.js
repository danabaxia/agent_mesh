// test/voice-engine.test.js — zero-dep unit tests for the PWA voice adapter.
// Injects fake Web Speech APIs (no DOM/browser) so the swappable engine seam,
// language mapping, and start/result/end + speak/cancel flows are provable at L0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceEngine, sttLang, ttsLangFor, LANGS } from '../src/dashboard/public/mobile/voice-engine.js';

// ---- pure language helpers ----

test('sttLang maps the UI toggle to BCP-47, defaulting to en-US', () => {
  assert.equal(sttLang('zh'), 'zh-CN');
  assert.equal(sttLang('en'), 'en-US');
  assert.equal(sttLang('whatever'), 'en-US');
  assert.equal(LANGS.zh.label, '中');
});

test('ttsLangFor picks zh-CN for CJK content, en-US otherwise', () => {
  assert.equal(ttsLangFor('你好,世界'), 'zh-CN');
  assert.equal(ttsLangFor('hello world'), 'en-US');
  assert.equal(ttsLangFor('mixed 中文 text'), 'zh-CN');
  assert.equal(ttsLangFor(''), 'en-US');
});

// ---- fake speech APIs ----

function fakeSR() {
  const instances = [];
  class SR {
    constructor() { this.started = false; this.stopped = false; instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; if (this.onend) this.onend(); }
    emitResult(transcript) { this.onresult({ results: [[{ transcript }]] }); }
    emitError(err) { this.onerror({ error: err }); }
  }
  return { SR, instances };
}

function fakeSynth() {
  const spoken = [];
  let cancels = 0;
  const speechSynthesis = { speak: (u) => spoken.push(u), cancel: () => { cancels++; } };
  class SpeechSynthesisUtterance { constructor(text) { this.text = text; this.lang = ''; } }
  return { speechSynthesis, SpeechSynthesisUtterance, spoken, get cancels() { return cancels; } };
}

// ---- support detection ----

test('an env without speech APIs reports unsupported and refuses to start/speak', () => {
  const e = createVoiceEngine({});
  assert.equal(e.sttSupported, false);
  assert.equal(e.ttsSupported, false);
  assert.equal(e.startListening({ onResult() {} }), false);
  assert.equal(e.speak('hi'), false);
});

test('webkitSpeechRecognition (Safari/iOS) is accepted as the STT impl', () => {
  const { SR } = fakeSR();
  const e = createVoiceEngine({ webkitSpeechRecognition: SR });
  assert.equal(e.sttSupported, true);
});

// ---- STT flow ----

test('startListening configures single-utterance recognition and delivers a trimmed transcript', () => {
  const { SR, instances } = fakeSR();
  const e = createVoiceEngine({ SpeechRecognition: SR });
  let got = null;
  const ok = e.startListening({ lang: 'zh-CN', onResult: (t) => { got = t; } });
  assert.equal(ok, true);
  assert.equal(e.isListening(), true);
  const r = instances[0];
  assert.equal(r.lang, 'zh-CN');
  assert.equal(r.continuous, false, 'single utterance, not a continuous call');
  assert.equal(r.started, true);
  r.emitResult('  打开语音  ');
  assert.equal(got, '打开语音', 'transcript is trimmed');
});

test('onend resets listening so the next tap can start a fresh recognition', () => {
  const { SR, instances } = fakeSR();
  const e = createVoiceEngine({ SpeechRecognition: SR });
  let ended = 0;
  e.startListening({ onResult() {}, onEnd: () => { ended++; } });
  assert.equal(e.startListening({ onResult() {} }), false, 'no double-start while listening');
  instances[0].onend();
  assert.equal(ended, 1);
  assert.equal(e.isListening(), false);
  assert.equal(e.startListening({ onResult() {} }), true, 'can start again after end');
});

test('stopListening stops the active recognition', () => {
  const { SR, instances } = fakeSR();
  const e = createVoiceEngine({ SpeechRecognition: SR });
  e.startListening({ onResult() {} });
  e.stopListening();
  assert.equal(instances[0].stopped, true);
});

test('recognition errors surface via onError', () => {
  const { SR, instances } = fakeSR();
  const e = createVoiceEngine({ SpeechRecognition: SR });
  let err = null;
  e.startListening({ onResult() {}, onError: (x) => { err = x; } });
  instances[0].emitError('no-speech');
  assert.equal(err, 'no-speech');
});

// ---- TTS flow ----

test('speak cancels any prior utterance, then speaks with the inferred language', () => {
  const f = fakeSynth();
  const e = createVoiceEngine({ SpeechRecognition: fakeSR().SR, speechSynthesis: f.speechSynthesis, SpeechSynthesisUtterance: f.SpeechSynthesisUtterance });
  assert.equal(e.ttsSupported, true);
  const ok = e.speak('你好');
  assert.equal(ok, true);
  assert.equal(f.cancels, 1, 'never overlaps utterances');
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].lang, 'zh-CN');
  assert.equal(f.spoken[0].text, '你好');
});

test('speak honors an explicit lang and ignores empty text', () => {
  const f = fakeSynth();
  const e = createVoiceEngine({ speechSynthesis: f.speechSynthesis, SpeechSynthesisUtterance: f.SpeechSynthesisUtterance });
  assert.equal(e.speak('   '), false);
  e.speak('hi', { lang: 'en-GB' });
  assert.equal(f.spoken[0].lang, 'en-GB');
});

// ---- iOS readback unlock (the "voice reply missing" fix) ----

test('unlock primes a silent utterance once so post-async readback works on iOS', () => {
  const f = fakeSynth();
  const e = createVoiceEngine({ speechSynthesis: f.speechSynthesis, SpeechSynthesisUtterance: f.SpeechSynthesisUtterance });
  assert.equal(e.isUnlocked(), false);
  assert.equal(e.unlock(), true);
  assert.equal(f.spoken.length, 1, 'spoke a priming utterance');
  assert.equal(f.spoken[0].volume, 0, 'silently (volume 0)');
  assert.equal(e.isUnlocked(), true);
  assert.equal(e.unlock(), false, 'idempotent — primes only once');
  assert.equal(f.spoken.length, 1);
});

test('unlock is a no-op without TTS support', () => {
  const e = createVoiceEngine({});
  assert.equal(e.unlock(), false);
  assert.equal(e.isUnlocked(), false);
});
