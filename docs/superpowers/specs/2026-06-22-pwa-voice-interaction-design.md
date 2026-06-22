# PWA Voice Interaction — Design

Resolves the owner board ticket `concierge-analyst-001` ("手机端 concierge PWA 语音交互,双向语音,原生引擎先行").

## 1. Goal

Add **bidirectional voice** to the mobile concierge PWA (`/m`): tap mic → speak →
speech-to-text → auto-send to the concierge → the concierge's reply is **read aloud**
(text-to-speech) while still shown on screen. One-tap, native-first, privacy-friendly.

## 2. Key constraint — swappable engine

STT + TTS use the browser-native **Web Speech API** (free, zero-dep, on-device). The
voice engine is isolated behind a clean adapter (`src/dashboard/public/mobile/voice-engine.js`,
`createVoiceEngine`) returning a fixed interface — so a cloud engine (OpenAI / ElevenLabs)
can later replace **only that module** without touching the UI. This is the explicit
extensibility requirement.

Engine interface:
`{ sttSupported, ttsSupported, startListening({lang,onResult,onError,onEnd})→bool,
   stopListening(), isListening()→bool, speak(text,{lang})→bool, cancelSpeak() }`

## 3. Language

- A **中 / EN toggle** chip in the composer controls the STT recognition language
  (native engines are weak at mixed zh/en, so it is manual — `sttLang('zh')→'zh-CN'`,
  `'en'→'en-US'`).
- TTS readback language follows the reply content: any CJK char → `zh-CN`, else `en-US`
  (`ttsLangFor`).
- Cloud auto language-id is a future enhancement, out of scope.

## 4. UI wiring (browser-only, in `app.js` `mount()`)

- Composer gains a `🎤` mic button + the lang chip; both stay **hidden unless
  `voice.sttSupported`** (graceful no-op on unsupported browsers).
- Mic tap: if listening → stop; else cancel any readback, add a pulsing `listening`
  state, and start a **single-utterance** recognition. On result → fill the input,
  mark the turn voice-initiated, and submit through the existing send path.
- Auto-read: after the assistant reply, `voice.speak(reply)` fires **only for a
  voice-initiated turn** (`lastWasVoice`), so typed turns stay silent. Screen always
  shows the text.

## 5. Out of scope (YAGNI red lines, per brief)

Continuous "phone-call" dialogue · cloud voice (interface only) · wake word
("Hey concierge").

## 6. Safety

Pure front-end, same-origin, **no change** to the concierge's ask-only + tap-gated
behavior: voice only fills the existing text input and uses the existing
`/api/concierge/message` path; `assign_task`/`file_issue` remain Confirm-gated. No new
permissions beyond the browser's own mic prompt; nothing is sent anywhere the typed
path didn't already send.

## 7. Tests

`test/voice-engine.test.js` (zero-dep, L0) injects fake `SpeechRecognition` /
`speechSynthesis`: support detection (incl. `webkitSpeechRecognition`), single-utterance
config, trimmed-transcript delivery, `onend` reset / no double-start, stop, error
surfacing, TTS cancel-then-speak with inferred language, explicit-lang + empty-text
guards, and the `sttLang` / `ttsLangFor` language maps. The DOM wiring follows the
existing browser-only `mount()` pattern (guarded by `typeof document`).
