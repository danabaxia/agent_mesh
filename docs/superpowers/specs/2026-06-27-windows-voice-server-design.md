# Windows Voice Server — MVP Design (v2)

Status: draft / design — round-2 (post codex + NotebookLM review)
Date: 2026-06-27
Related: `docs/architecture/mesh-agent-notebooklm-source.md` (§5/§6/§12), the sibling
`2026-06-27-mac-capture-endpoint-design.md` (the normative Mac `/capture` contract), the existing
`voice-demo/` prototype (record-then-POST — superseded). Review log at the end of this file.

## 1. Goal

A self-hosted, always-on **streaming voice server** on the owner's Windows RTX 3060 12GB
(WSL2 + CUDA) that lets the owner — **hands-free while driving** — speak an idea, hear a fast
natural reply, and have **every idea durably captured, never silently lost**, then synced to the
Mac mesh. The latency-critical pipeline is **local STT + local TTS co-located on the GPU, plus one
deliberate cloud hop for the brain (Gemini)**. It fixes the two record-then-POST failures: tapping
every turn (→ continuous VAD turn-taking) and slow playback (→ streaming TTS).

## 2. Non-goals (MVP boundaries)

- **Not a mesh peer.** No A2A, no border gateway / federation. One outbound call: Mac `/capture`.
- **No local LLM** in MVP — Gemini is the brain, behind an adapter for a later local swap. (So the
  MVP is **not offline-capable for replies**; capture *is* offline-safe — see §9.)
- **No barge-in** (interrupt mid-reply) — VAD end-of-turn only; mitigated by short replies (§11).
- **No multi-tier security** beyond tailnet + tokens + the Mac path-guard + untrusted-data handling.
- **Single user, single concurrent call** (`maxParticipants=1`).

## 3. Chosen stack + rationale

| Concern | Choice | Why / caveat |
|---|---|---|
| Orchestration + media | **LiveKit Agents** (self-host) | Ships WebRTC SFU + Silero VAD + semantic turn detector; barge-in available later. |
| STT | **faster-whisper** (CUDA) | **Non-streaming model** — wrap in LiveKit's **VAD + StreamAdapter** for interim/final events from buffered segments (Spike-2 proves it). |
| Brain | **Gemini 2.5-flash** (function-calling) | The **one cloud hop**; reliable tool-calling; behind an LLM adapter for a later local swap. |
| TTS | **Kokoro** (CUDA), streaming | Free/unlimited, ~0.6 s warm (Gemini-TTS quota dies in ~3 calls). |
| Transport | **WebRTC** (Opus/UDP) over **Tailscale** | Jitter buffer, AEC, FEC — essential in a car. |
| Persistence | **SQLite (WAL)** outbox → Mac `/capture` | Atomic, single-writer, crash-recoverable; the "never lose an idea" substrate. |

## 4. Architecture — components

```
 PHONE (PWA, WebRTC client)  ──auth: short room-scoped JWT (§7)──┐
   │  Opus/UDP over Tailscale (the one hot-path hop)             │
   ▼                                                             │
 WINDOWS SERVER (WSL2 + CUDA)                                    │
 ┌───────────────────────────────────────────────┐   token-mint │
 │ token-mint (tailnet-only, bearer)  ◄───────────┼─────────────┘
 │ livekit-server (SFU, WebRTC media)             │
 │ voice-agent ── turn orchestrator ──            │
 │   ├ VAD + semantic turn detector               │   LOCAL (localhost)
 │   ├ stt  faster-whisper (+StreamAdapter)        │
 │   ├ brain  Gemini adapter (+capture tools) ─────┼──► CLOUD (one hop)
 │   └ tts  Kokoro (streaming)                     │
 │ outbox  SQLite(WAL) + background syncer         │
 └─────────────────────────┬─────────────────────┘
                           │ cold path: POST /capture (sibling spec)
                           ▼
 MAC ── /capture → board/notes (ask-safe, path-guarded, untrusted-data)
```

Media stages (STT/TTS) are localhost; the **brain is the single cloud dependency**.

## 5. The turn loop — capture-first (deterministic durability)

Durability must **not** depend on the LLM choosing a tool or on STT succeeding. Order:

1. Phone joins the (authed, §7) LiveKit room; publishes its mic.
2. **VAD + semantic turn detector** segment the turn (continuous — no tap).
3. **On end-of-turn, FIRST: commit the raw turn to the outbox** — `{id: ULID, ts, audio_ref,
   state: captured}`. **This is the durability commit; everything after only enriches it.** No
   spoken confirmation precedes this write.
4. **STT** (faster-whisper via VAD+StreamAdapter) → transcript; attach to the record. **If STT
   fails, the record keeps the raw audio** for later re-transcription (state stays `captured`).
5. **Brain** (Gemini) receives the transcript + enrichment tools and **enriches** the record
   (classify / tag / title / compose reply). It **cannot un-capture**: if it calls no tool, or
   errors / times out, the record remains captured — the idea is preserved either way.
6. Reply text → **streaming TTS** (Kokoro) → phone plays the first chunk immediately.
7. **Outbox syncer** (background, decoupled from the turn) pushes the record to Mac `/capture`.

> Headline fix (codex B1/B2): capture is **unconditional**; the LLM and STT only enrich. This
> closes both "never lost" holes (LLM may not call the tool; STT may fail).

## 6. Media plane (R2′)

WebRTC media (UDP) into a NAT'd WSL2 container is the hardest part.

- **Primary — WSL2 mirrored networking** (`networkingMode=mirrored`, Win 11 22H2+): WSL2 gets the
  host interfaces (no NAT); the SFU runs in WSL2 with everything else; UDP rides the tailnet.
- **Fallback — native-Windows SFU**: media terminates natively; inference stays in WSL2 over the
  localhost bridge. **Known cost:** frames cross the Windows↔WSL2 hypervisor bridge → possible
  latency spikes (a reason to prefer mirrored). Spike-1 measures both.
- **Concrete networking (codex M8):** pin LiveKit's **UDP port range** + advertise ICE candidates on
  the tailnet IP; open those UDP ports in the **Windows/Hyper-V firewall** (and for mirrored mode).
  `tailscaled` on the **host, not WSL2** (MTU 1280). Force **direct UDP** (41641; `tailscale ping`
  = `direct`). **DERP policy:** if only DERP (TCP relay) is available — common off-LAN — **do not
  silently ship media over TCP**: prefer the **Mac as a Tailscale peer relay** (better than DERP),
  and if still relayed, **degrade explicitly** (accept higher latency with a brief earcon) rather
  than pretend it's real-time. Off-LAN latency is inherently higher (cellular) — surfaced, not hidden.

## 7. Phone join / WebRTC auth (codex B5)

LiveKit clients need signed access tokens. A small **token-mint endpoint** (tailnet-only,
bearer-gated) issues **short-lived (~60 s), room-scoped JWTs** with **microphone-only publish**
grants. The room is **single-occupant (`maxParticipants=1`)**; a second join is **rejected**. Short
TTL ⇒ no self-hosted revocation machinery needed. (Tested: unauthorized join, second-join reject.)

## 8. Brain + capture contract (LLM enriches, never gates durability)

- **System prompt:** concise concierge; bias to capturing spontaneous ideas; **truthful**
  confirmation — "noted, syncing" until the Mac ack, never a false "saved."
- **Tools (enrichment only):** `classify_idea`, `tag_idea`, `title_idea` mutate the already-captured
  record. There is **no "should I capture?" decision** — capture happened in §5 step 3.
- **Untrusted data (codex M10 / NB N3):** transcript, tags, and audio are **untrusted user/LLM
  data** — **length-bounded, schema-validated, stored quoted**, never executed; rate-limited;
  audited. The Mac treats `/capture` payloads as data (the AGENT.md-as-data invariant).
- **Secrets:** `GEMINI_API_KEY` from `.voice-env` (chmod 600, gitignored, never committed).

## 9. Outbox (durability, R1′/R3′ + codex B2/B3/M9)

- **Storage: SQLite in WAL mode** — atomic commits, single-writer, crash recovery via WAL replay on
  restart. Record: `{id ULID, ts, audio_ref, transcript?, enrichment?, state, attempts, last_error}`;
  `state ∈ {captured, enriched, syncing, synced, dead}`. (Chosen over JSONL for atomicity + recovery.)
- **Durability commit** at `captured` (§5.3), before any confirmation.
- **Syncer:** `POST /capture`; **idempotent on `id`** (at-least-once + dedupe — simple one-way sync,
  **not** a SAGA).
  - **Transient failure (offline / network / 5xx)** → stays **pending indefinitely**, retried with
    backoff; **never dead-lettered** (Mac offline a week ⇒ still synced on recovery).
  - **Permanent failure (4xx schema/auth)** → `dead` + a hard notice.
- **STT-failed records** keep their audio for background re-transcription.
- **Alert delivery (NB Q2):** pending/dead notices surface **via the next voice session** —
  Windows-local; the agent reads its own outbox and speaks "N ideas still syncing / N failed." No
  extra Mac path (dashboard surfacing is out of MVP; would need a second Mac endpoint).

## 10. Mac `/capture` seam → sibling spec

The normative contract (schema, **durable-before-2xx**, idempotency on `id`, `401/403` vs `5xx`
retry policy, untrusted-data storage, token rotation) lives in
**`2026-06-27-mac-capture-endpoint-design.md`**. Windows calls only this endpoint — no A2A.

## 11. Driving-mode profile (codex M11)

Eyes-free, voice-only contract: **terse replies** (~1–2 sentences max — also mitigates the absent
barge-in); **no reliance on the screen**; session **start/stop by voice or one large pre-drive tap**;
robust to **Bluetooth (A2DP/HFP) routing and screen-lock** (audio continues); all recovery prompts
are voice-only. Tested on real mobile + Bluetooth + cellular.

## 12. Management / control plane (remote admin)

Orthogonal to the data plane. **Windows OpenSSH Server** on the host, reached **only over Tailscale**
(`ssh user@win.ts.net`, ACL-restricted to the Mac, no public exposure); then `wsl` into the Linux
env. Not Tailscale-SSH-server (limited on Windows); don't run `tailscaled` in WSL2. Auth: SSH keys,
password off. Management-plane, **prerequisite for remotely driving Spikes 1–3 / the build** (§16).

## 13. Config / secrets (`.voice-env`, gitignored)

`GEMINI_API_KEY` · `MAC_CAPTURE_URL` · `MAC_CAPTURE_TOKEN` · LiveKit API keys + `TOKEN_MINT_SECRET` ·
model paths · `OUTBOX_DB` (SQLite path). Tailscale configured on the host.

## 14. Latency budget / targets (codex M6)

Target **≤ ~2 s** you-stop → first-audio. **Local STT/TTS + one cloud LLM hop** (not "all
localhost"). Per-stage (refs): transport ~5% · STT ~350 ms · **Gemini TTFT ~375 ms p50 (cloud — track
p95, 429 rate, and privacy/offline implications)** · TTS TTFB ~100 ms. Streaming so first audio
precedes full reply. **Meter + log per-turn per-stage** latency. Local-LLM swap later removes the
cloud hop.

## 15. Error handling / failure modes

| Failure | Behavior |
|---|---|
| LLM calls no tool / errors / times out | Record already `captured` (§5.3) — **idea kept**; brief graceful reply. |
| STT error | Keep raw audio in outbox for re-transcription; re-prompt ("didn't catch that"). |
| Mac offline / 5xx | Outbox `pending` **indefinitely** + retry; truthful "syncing"; **never lost**. |
| Mac 4xx (schema/auth) | `dead` + hard notice next session. |
| TTS error | Canned earcon / retry; turn doesn't hard-fail. |
| Gemini 429 / cloud slow | Back off; if persistent, capture stands, reply degrades; surfaced in budget logs. |
| WebRTC disconnect / DERP-only | Phone reconnect; per §6 DERP policy (degrade/earcon, not silent TCP media). |
| Crash / restart | SQLite WAL replay reconciles outbox state on startup. |
| Unauthorized / second join | Rejected (§7). |

## 16. Testing / validation (codex M12 + NB)

**Spikes (gate the build):**
- **Spike-1 (media/R2′):** mirrored vs native SFU — WebRTC media over tailnet with acceptable jitter;
  measure the hypervisor-bridge cost of the fallback. **Decides §6.**
- **Spike-2 (STT):** faster-whisper **via VAD+StreamAdapter** — prove interim/final semantics +
  turn latency on real turn lengths (not a clip) on the 3060.
- **Spike-3 (standup):** LiveKit Agents self-hosted on WSL2 + Tailscale — end-to-end authed "hello."

**Unit / deterministic:** capture-before-LLM; capture-on-LLM-no-tool; STT-failure keeps audio;
outbox atomicity + idempotent sync + crash/restart WAL recovery; transient-pending-forever vs
permanent-dead; payload bound/validate/quote; token mint + second-join reject; HTTP 401/409/500
capture behavior.

**Acceptance demo:**
1. Continuous (no tap), reply ~2 s, idea on the Mac.
2. **Mac offline mid-drive → 3 ideas → all pending in outbox → Mac back → all 3 sync → confirmed.
   Nothing lost.** Plus: LLM-no-tool turn still captured; mobile/Bluetooth/cellular real-device run.

## 17. Open prerequisites

- Confirm **Windows 11 22H2+** (gates mirrored-networking primary; else native-SFU fallback).
- The sibling **Mac `/capture`** spec finalized + endpoint built.

## 18. Build sequence (hand-off to writing-plans)

1. **Spikes 1–3.** 2. **Outbox (SQLite) + capture contract** (headless, fully unit-tested).
3. **Mac `/capture`** (sibling). 4. **voice-agent capture-first turn loop** (capture→STT→enrich→TTS).
5. **token-mint + phone PWA** (WebRTC, authed). 6. **Wire media plane** per Spike-1. 7. **Driving
profile + acceptance demo.**

---

## Review log

**Round 1 — codex-spec-review (CHANGES_REQUESTED: 5 BLOCKER, 7 MAJOR) + notebooklm-research-review
(CHANGES_NEEDED).** Both independently flagged: durability gated on LLM/STT (→ §5 capture-first),
the "all localhost" overclaim vs cloud Gemini (→ §1/§14), untrusted captured data (→ §8), and the
media/DERP path (→ §6). codex additionally caught: missing WebRTC/token auth (→ §7), faster-whisper
being non-streaming (→ §3/Spike-2), ambiguous outbox storage (→ §9 SQLite), the dead-letter-vs-offline
conflict (→ §9 transient-pending-forever), the non-normative Mac contract (→ §10 sibling spec), and
the absent driving-mode profile (→ §11). NotebookLM caught the dead-letter-alert vs "only /capture"
contradiction (→ §9 next-session voice). All folded into v2.

**Round 2 — convergence re-review (NotebookLM): 8/11 resolved; 3 partial, all accepted as
build-time / physics tradeoffs (not design contradictions):**
- **Media off-LAN (§6):** a Mac peer-relay still routes through the home ISP uplink — inherent to
  phone-on-cellular + server-at-home; no design fixes physics. Off-LAN latency is surfaced, not
  hidden; a cloud relay/SFU is the only real fix and is out of MVP scope. **Accepted.**
- **faster-whisper chunkiness (§3 / Spike-2):** a non-streaming STT behind VAD+StreamAdapter buffers
  per segment. **Spike-2 measures it**; if it misses the latency bar, swap to a truly streaming STT.
  Spike-decided.
- **Dead-letter promptness (§9):** a *permanent* failure (401/schema) only notifies next voice
  session — but permanent failures are misconfiguration (caught in test), not a normal-runtime path;
  the common case (offline) pends-forever and self-heals, and a driver can't act on a token error
  mid-drive anyway (operator sees `dead` via logs/SSH). **Accepted for MVP.**

**Review loop capped at 2 rounds.** Every design contradiction is resolved; the rest are build-time
tradeoffs (Win11 version, Spike-1/2 outcomes, the 3 above).
