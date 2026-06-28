# Voice logic in a mesh agent — design

**Status:** design (brainstormed 2026-06-28, Approach A approved; Codex round 1 addressed)
**Governs:** CLAUDE.md Principles P1–P3 (voice = data ingress · logic = registered mesh agent · MVP→production spec-first)

## Goal

Make the voice assistant obey the project principles: the **voice service carries no logic**, and **all reasoning lives in the `concierge` agent registered in the mesh**, with its own obeyed prompt and memory. The concierge runs on **Gemini** (sub-2s) so a mesh-native agent is still fast enough for spoken interaction.

This corrects the current MVP, where the brain (`serve_turn.py`) lives *inside* the voice service — a P1/P2 violation. After this change: voice **captures the raw turn durably (data)** → A2A `SendMessage` to the concierge → the concierge reasons (Gemini + its prompt + memory + tools) → reply text + optional structured enrichment → TTS + durable apply. The voice service is a thin, logic-free data ingress.

## Non-goals (YAGNI)

- A general MCP-tool→Gemini bridge. The concierge has a fixed, small tool set wired as schema-bound adapters.
- Making *every* mesh agent model-pluggable. We add a Gemini brain to the **shared A2A runner**; the `concierge` opts in via its own card; other agents stay Claude.
- Streaming partial replies / barge-in / continuous listening (push-to-talk stays).
- Changing the durability core (outbox · /capture · syncer on main) — but capture-first **stays in the ingress** (see §Durability).

## Architecture

Three components, clean boundaries, each independently testable.

```
📱 Phone ─audio─▶ ① Voice ingress (data only)
                    STT → transcript
                    ├─ commit raw turn to outbox  (capture-first, DATA — never depends on the agent)
                    └─ A2A SendMessage(parts=[transcript], contextId, metadata) ─▶ ② shared A2A runner
                                                                                       brain = Gemini (this agent)
                                                                                       runs ③ concierge:
                                                                                         · obeyed prompt = prompts/system.md
                                                                                         · AGENT.md = bounded DESCRIPTION data
                                                                                         · memory/ (bounded, data-framed)
                                                                                         · tools: list_agents · mesh_status
                                                                                                  · ask_peer (peer bridge)
                                                                                                  · propose_idea (no write)
                    TTS ◀─ reply text + enrichment ◀─ A2A Task ─────────────────────┘
                    └─ apply enrichment to the captured turn (DATA); idea filing = separate gated step
```

### ① Voice ingress — data only (refactor of `voice-server/`)

**Responsibility: move data + durably capture; zero reasoning.** Per turn:
1. Capture a push-to-talk utterance (existing PTT + silence-trim).
2. **Capture-first (raw turn before STT):** the instant the utterance ends, save the audio (`audio_ref`) and commit `{captureId, ts, audio_ref, transcript: null, state: captured}` to the outbox — **before STT or any A2A call** — reusing the merged `handle_turn` ordering core (Task 12). The **only** full-drop case is *proven silence* — no audio frames captured / energy-confirmed no-speech, **never a duration threshold**; a too-short-but-real utterance still gets a captured row (the A2A call may later be skipped). STT or agent failure can never lose the raw turn, and it stays re-transcribable by `captureId`.
3. STT (Gemini primary, whisper-large-v3 fallback) → a **candidate** transcript. **Validate the candidate first** (non-empty, not a known garbled/hallucination marker): only a valid candidate is attached via `attach_transcript(captureId, transcript)` and forwarded; an empty/garbled candidate is **not** attached — the row stays `transcript:null` and is re-transcribable by `captureId`, and the ingress simply skips the A2A call. *(STT is a data transform; validation is a data check, not reasoning.)*
4. **A2A `SendMessage`** to the concierge using the project's **A2A v1 message shape**: `message.parts = [{text: transcript}]`, `contextId = <stable per-phone-session id>`, `metadata.agentmesh/mode = "ask"`, `metadata.agentmesh/lang = "zh"|"en"`, `metadata.agentmesh/captureId`. Receive an A2A `Task`.
5. From a `COMPLETED` Task with a reply artifact: **first apply any `enrichment`** (idea title/note + captureId) to the captured outbox row (data) — durably, **before and independent of TTS** — then TTS the reply artifact text → audio to phone. Ordering matters: the idea proposal is the durable signal; a TTS failure must never strand an applied-or-pending enrichment. Enrichment-apply itself retries/degrades per the outbox policy and records a `enrichment_pending` marker on failure so the next sync re-applies it (idempotent by `captureId`). Render transcript/reply/idea/STT-TTS-hardware.

**Removed from the ingress:** system prompt, conversation memory, the tool loop, idea *classification*, mesh-querying. The ingress holds **no** `SYS`, no `brain_turn`, no tool dispatch, no Gemini reasoning call.

**Depends on:** the concierge's A2A endpoint (url + identity) and the outbox. Nothing else.

### ② Shared A2A runner with a swappable brain (the framework enabler)

Codex round-1: do **not** fork a `delegate.js` sibling. Instead, factor the existing A2A `SendMessage` handling into a **shared runner** used identically by `serve-a2a` (stdio) and `serve-a2a-http`, and make the **brain** a swappable step inside it:

- **Brain selection is agent-owned, not caller-declared.** The served agent's own card (`agent.json` → `x-agentmesh.runner: { kind: "claude" | "gemini" }`, default `{ kind: "claude" }`) chooses the brain. This is **additive to the existing `x-agentmesh.runner` ScriptRunner shape** — discriminated by `kind`, so `{ command }` ScriptRunner cards keep working; the conformance/runner schema gains the `kind` variant. A *caller's* generated `registry.json` can only name peers to spawn — it can never set another agent's runtime (closes the spoof surface). `doctor`/`discover` carry the runner from the served card, never from a peer.
- **Everything except the model call is shared:** mode gates (`ask`/`do`), run-log writing, the `agentmesh/metrics` block, the recursion guard (`AGENT_MESH_PATH`/`DEPTH`), the timeout + tree-kill, identity/single-writable-root, and the stdio↔http parity. The Gemini brain is one function (`runGemini(systemPrompt, history, tools) → {reply, toolCalls}`) the shared runner invokes where it would otherwise `claude -p`.
- **Obeyed prompt vs description.** The runner's system prompt is the agent's **`prompts/system.md`** (+ mode prompt), exactly like the Claude path. **`AGENT.md` is never the obeyed prompt** — it stays bounded `describe_self` *data* (length-capped, framed as data). Invariant preserved for both brains.
- **Tools** = the agent's declared, **schema-bound** tool adapters (fixed registry, allowlisted, per-call timeout). A bounded function-calling loop (≤4 hops). No generic MCP→Gemini bridge.
- **Memory** = the agent's `memory/` via the project's existing session/memory mechanism: relevant entries loaded as **data** (framed, never instructions), new notes appended with **TTL + size cap**, restart-safe (durable file store, not in-process only), single-writer concurrency. Per-`contextId` rolling history is also size-capped and persisted.
- **Output** = a normal A2A `Task` (reply artifact text + optional `metadata.agentmesh/enrichment`), so callers never special-case the Gemini agent.

**Boundary:** the runner knows agents, A2A, modes, memory, tools — **not** audio/LiveKit/voice.

### ③ concierge — the voice-logic agent (`dev-mesh/concierge/`)

The existing registered agent becomes the brain, on Gemini:
- **`prompts/system.md`** — the obeyed persona/behavior: warm hands-free assistant; answer mesh questions from knowledge + tools; capture ideas via `propose_idea`; concise/spoken; honest when unsure. (This is what the model obeys.)
- **`AGENT.md`** — bounded description for `describe_self`/the card (data only, never obeyed).
- **`agent.json`** — `x-agentmesh.runner: { kind: "gemini" }` and `x-agentmesh.modes: ["ask"]`. Modes live in the **manifest**: `mesh.json` carries `enabledModes: ["ask"]` for the concierge; the card mirrors intent only.
- **`memory/`** — durable, bounded, data-framed memory (owner facts, ongoing topics, mesh notes).
- **tools (schema-bound, ask-only):**
  - `list_mesh_agents()` · `mesh_status()` — read adapters (gh / mesh.json), allowlisted + timeout-bounded.
  - `ask_peer(agent, question)` — routed through the **framework peer bridge** (`agentmesh_peerbridge`, the existing ask-only onward-delegation surface), so it inherits the marker-validated registry, recursion/cost propagation, and ask-only enforcement. **Not** a reverse-SSH side-channel. (The Mac-side `mesh_tools_server.py` may remain only as a same-host read adapter for `list/status`, behind a bounded schema; `ask_peer` does not use it.)
  - `propose_idea(title, note)` — **emits a structured proposal only; performs no write.** The proposal returns in the Task `enrichment`; the **ingress/durability layer** records it against the `captureId`, and gh-issue filing is a **separate gated/audited step** (the existing tap-gated concierge-confirm path / a syncer step) — never the agent writing directly. Keeps the agent strictly ask-only.

`record_idea` (auto-file) is **removed** from both the ingress and the agent; idea capture = ingress durable-capture + agent enrichment + gated filing.

## Data / control flow (one turn)

1. Phone PTT → utterance; ingress saves `audio_ref` and commits `{captureId, ts, audio_ref, transcript:null, state:captured}` — **before STT** (capture-first; only proven silence is dropped).
2. Ingress STT → validate candidate → `attach_transcript(captureId, transcript)` only if valid (empty/garbled → stay `transcript:null`, skip the A2A call).
3. Ingress `SendMessage(parts=[transcript], contextId, metadata{mode:ask, lang, captureId})` → concierge.
4. Shared runner (gemini brain): load `prompts/system.md` + framed memory + capped history; ≤4-hop tool loop (`mesh_status`/`ask_peer`/`propose_idea`); produce `reply` (+ `enrichment` if an idea).
5. Runner returns a `Task` (reply artifact + `agentmesh/enrichment`); appends capped history + any new memory.
6. Ingress: if `enrichment`, apply it to the captured outbox row **first** (durable, idempotent by `captureId`; on failure leave an `enrichment_pending` marker for the next sync); then TTS(`reply`) → phone. Idea→issue filing happens on the existing gated path, not in this turn's hot loop.

## Error handling

- **STT fails** → whisper fallback (ingress, data layer); even if both STT paths fail, the raw turn is already captured (`audio_ref`, `transcript:null`) and re-transcribable later by `captureId`.
- **Outbox commit fails** → ingress retries/degrades per the existing outbox policy; the turn is never silently lost.
- **Concierge A2A — a usable reply requires `TASK_STATE_COMPLETED` + a reply artifact.** Unreachable / timeout / a `rejected`/`failed` Task / a completed Task with no reply artifact all → ingress speaks the fixed local fallback ("抱歉，连不上助手，稍后再试") — a *message*, not logic — logs the Task metadata, and **leaves the captured row unchanged**. (Bad inputs come back as rejected `Task` data, not RPC errors, so the ingress checks Task state, never assumes an artifact.) The captured turn is already durable.
- **A tool call fails** (peer bridge / read adapter down) → the runner answers from knowledge / says it can't fetch live data; never fabricates. Tool calls are timeout-bounded.
- **Enrichment-apply fails** (outbox write error) → the row is marked `enrichment_pending` (carrying the proposal + `captureId`); the next sync re-applies it idempotently. The idea is never lost just because the apply raced or the disk hiccupped. This happens **before** TTS, so it is independent of playback.
- **TTS fails / playback errors** → the turn's reply simply isn't heard, but the enrichment is **already applied** (step 5 ordering) and the captured row is durable; the ingress logs and moves on, never retrying the A2A call (no duplicate idea).
- **Empty/garbled transcript** (real audio was present) → the raw turn **stays captured** (`audio_ref`, `transcript:null`, re-transcribable by `captureId`); the ingress skips **only** the A2A call and keeps listening. The sole full-drop case is **proven silence** — no captured audio frames / energy-confirmed no-speech, detected *before* capture, **never a duration threshold**. Duration may make the ingress skip the A2A call, but it never skips capture.

## Security & invariants (carried, with new coverage)

- **AGENT.md / memory / persisted history are untrusted data, never instructions** — framed as data for both brains; tested with a malicious-`AGENT.md` and malicious-memory that must not steer tool dispatch.
- **concierge is ask-only** — read + `ask_peer`; `propose_idea` is non-writing; no `do`, no direct gh/file writes; tested that a write attempt is refused before any side effect.
- **runtime is agent-owned** — a caller registry that sets `x-agentmesh.runner` on a peer is ignored; tested.
- **anti-spoof / single-writable-root / recursion guard / timeout** — unchanged, inherited from the shared runner (not re-implemented).

## Testing (P3 — hermetic, fake brain, no live model in the gate)

`node --test` for the JS A2A/runner units; Python `unittest` for the voice-box units.

- **② shared runner + gemini brain (core target):**
  - A2A contract: `SendMessage` (correct v1 parts/contextId/metadata) → well-formed `Task` with reply artifact; over **both stdio and http** (parity test).
  - Tool loop: stubbed Gemini emits `propose_idea`/`mesh_status`/`ask_peer` calls → runner dispatches via the schema-bound adapters / peer bridge, feeds canned results back, returns final reply + enrichment.
  - Brain selection: `x-agentmesh.runner:{kind:"gemini"}` on the served card uses the gemini brain; an existing `{command}` ScriptRunner card still resolves (no schema collision); a *caller registry* override is ignored.
  - Obeyed-prompt vs data: `prompts/system.md` is obeyed; a malicious `AGENT.md`/`memory/` entry cannot change tool dispatch or exfiltrate.
  - ask-only: a `do`/write attempt is refused before any side effect; `propose_idea` performs no write.
  - Memory/session: a fact persists and a follow-up (same `contextId`) sees it; restart-safe (reload from store); size/TTL caps enforced; malicious persisted text stays inert.
- **① voice ingress:** (a) commits the **raw turn** (`audio_ref`, `transcript:null`) to the outbox **before STT**, then attaches the transcript — a forced STT failure, and a too-short-but-real utterance, both still leave a `captured` row (only no-audio/energy-confirmed silence drops); (b) issues exactly one A2A `SendMessage` with the correct v1 shape; (c) only enriches/TTSes when the `Task` is `COMPLETED` **with** a reply artifact — a rejected/failed/no-artifact Task → fixed fallback spoken, capture row unchanged, no throw; (d) applies enrichment to the capture row **before** TTS — an enrichment-apply failure leaves an `enrichment_pending` marker (re-applied on next sync, idempotent by `captureId`), and a TTS failure still leaves the enrichment applied and the row durable; (e) the negative test asserts the ingress holds **no** system prompt, **no** tool loop, and makes **no direct mesh-query/list/status/peer call** beyond the single concierge A2A `SendMessage`.
- **③ concierge definition:** `prompts/system.md` present + obeyed; `AGENT.md` present + length-bounded + data-only; declared tool set matches the runner's dispatch table; `x-agentmesh.runner == gemini`, `enabledModes == [ask]`.
- **end-to-end (record-only, not a gate):** the synthetic LiveKit publisher drives a full turn against the live stack and asserts a reply returns + the captured idea reaches the outbox.

## Build sequence (MVP → production, decomposed)

1. **② Shared A2A runner + agent-owned brain selection + Gemini brain** — the enabler: factor the shared runner, add `x-agentmesh.runner`, the `runGemini` brain, schema-bound tool dispatch, bounded/durable memory, A2A `Task` output. Full unit suite (incl. the negative/invariant tests). Unblocks the rest.
2. **③ concierge agent** — author `prompts/system.md`, `AGENT.md` (data), `agent.json` (`runner: gemini`), seed `memory/`, declare tools (`ask_peer` via peer bridge; `propose_idea`). Verify via direct A2A `SendMessage` (no voice).
3. **① voice ingress refactor** — strip the brain; add capture-first + A2A client + enrichment-apply; keep STT/TTS/PTT/lang/hardware UI. Verify with the synthetic publisher.
4. **Production hardening** (separately scoped): persistent services (launchd/Task Scheduler), stable secrets, monitoring — the MVP→production jump for the whole stack.

MVP = steps 1–3 (logic correctly in the mesh agent, voice thin, durable, ask-only, end-to-end). Production = step 4.
