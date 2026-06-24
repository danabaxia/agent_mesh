# Separate Voice and Text Module Testing for Agents — Design

**Date:** 2026-06-24
**Status:** Draft
**Topic:** Restructure agent test suites so voice (STT/TTS) logic and text (reasoning) logic run in separate tiers, eliminating unnecessary token consumption when only agent reasoning is under test.

---

## 1. Motivation

Agents such as the voice-demo assistant bundle two distinct concerns: a reasoning/logic layer (text-in → text-out) and an audio layer (STT + TTS). Today's test suites exercise the full pipeline together — every logic test invokes the voice module, consuming STT/TTS tokens even when only the agent's reasoning is being validated. This is wasteful and makes the default CI run unnecessarily expensive.

**Issue #512:** "When testing agents, the voice module and text module should be tested separately to avoid unnecessary token consumption by always using the voice module when only logic is being tested."

## 2. Goal

Split each agent's test suite into two independent tiers — a **text (logic) tier** and a **voice tier** — so that each module is paid for only when it is the thing under test.

## Components

- **Voice/logic seam (interface)** — the boundary exposing the agent's text-in→text-out logic independently of the audio wrapper. The enabling abstraction; everything else depends on it.
- **Text (logic) test tier** — test files/suite that drive the logic layer with text inputs and assert on text outputs; do not import or instantiate the voice module.
- **Voice test tier** — test files/suite that exercise STT/TTS transforms and audio round-trip wiring, with the logic layer (and ideally the model-backed speech engines) stubbed/fixture-driven.
- **Test-tier selector** — the mechanism (tag, file pattern, flag, or separate script) that runs `text` by default and `voice` only on request. Wired into the test runner / CI config.
- **Voice stubs & fixtures** — fakes for the logic layer and recorded audio/transcript fixtures so voice tests are deterministic and token-free where possible.
- **CI configuration** — runs the text tier on every change; runs the voice tier on a narrower trigger (voice-surface changes / scheduled / manual).

## Data flow

**Text (logic) test:**
1. Test supplies **text** input directly to the logic layer.
2. Logic produces **text** output.
3. Test asserts on the text output. Voice module is never constructed → zero STT/TTS tokens.

**Voice test:**
1. Test supplies an **audio fixture** (or invokes STT) → transcript.
2. The logic layer is **stubbed** to return a canned reply (no real reasoning tokens).
3. The reply text is passed to TTS → audio.
4. Test asserts on the transforms/wiring (transcript correctness, audio produced, fallback behavior). Live model use is limited to an explicitly-gated e2e case.

**Runner selection:**
1. Default invocation → **text tier only**.
2. Opt-in flag/tag → **voice tier** (and/or both).

## Testing

(Validating the split itself behaves as intended:)

- **Logic tests invoke no voice module:** a text-tier run instantiates no STT/TTS and records zero voice/speech token usage (the core token-saving assertion).
- **Default excludes voice:** the default test command runs only the text tier; the voice tier requires an explicit opt-in.
- **Voice tier runs independently:** the voice tier can run on its own and exercises STT/TTS wiring with the logic layer stubbed (no full-reasoning tokens).
- **Seam isolation:** the logic layer is fully testable text-in→text-out with the voice module absent (import/instantiation guard).
- **Coverage parity:** logic/reasoning/tool/routing assertions that previously ran inside combined tests are preserved in the text tier (no loss of coverage from the split).
- **Determinism:** text-tier tests are deterministic and faster than the equivalent combined tests; voice-tier fixture tests are deterministic (no flaky live dependency) except the explicitly-gated e2e case.
- **CI wiring:** text tier triggers on every change; voice tier triggers only on its narrower condition.
- **Fallback coverage:** voice-path fallback/error behavior is asserted in the voice tier, not the text tier.

## Out of scope

- **Changing agent logic, the voice pipeline, or its UX** — this restructures *how agents are tested*, not what they do.
- **Optimizing voice latency or swapping STT/TTS engines** — separate efforts (voice-speed ideas); this only isolates the test surfaces.
- **Removing voice testing** — the voice module is still tested, just in its own opt-in tier rather than on every logic run.
- **A live, full end-to-end voice run on every CI build** — reserved as a small, explicitly-gated check; routine CI uses fixtures/stubs.
- **Cross-agent or integration-tier restructuring** beyond the voice/text split (e.g. board/pipeline scenarios) — out of scope.
- **New token-accounting/metering infrastructure** — this *reduces* token use by not invoking voice; building usage dashboards is separate.
- **Mandating a specific test framework or runner** — uses the existing test tooling; only adds the tier selection and seam.
