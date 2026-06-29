# Mesh-aware ideation partner — design

**Status:** design (brainstormed 2026-06-28, approved; pre–Codex-review)
**Governs:** CLAUDE.md Principles P1–P3 (voice = data ingress · logic = registered mesh agent · MVP→production spec-first)

## Goal

Today the phone concierge only **moves** ideas — it captures what you say and relays it. It does not **help you form** ideas. This feature makes the concierge an **ideation partner**: it proactively draws on mesh-internal signal to spark ideas and to develop the half-formed thoughts you bring it, while keeping all idea *reasoning* in the registered **analyst** agent (which already owns idea curation).

The closed loop:

```
analyst (idea-owner, ask-mode) ── on a cadence ───────────────────────────────┐
  host gathers 4 read-only signals → analyst DISTILLS → inspiration.json        │
    ① recurring failures (MIR / CI / triage)     ③ past captures (captures.jsonl)│
    ② gaps / unfinished (stale issues, unwired, branches)   ④ team activity + web│
                                   │  digest (Mac mesh file)                     │
                                   ▼  delivered Mac→box (GET /inspiration, cached)│
concierge (voice front) ── live, low-latency ─────────────────────────────────┐ │
  brainstorm_seeds(topic?) reads the cached digest                            │ │
  prompt: open with a spark; when you bring a thought, pull relevant seeds +  │ │
  develop it Socratically → formed idea → propose_idea → capture pipeline     │ │
                                   │ formed idea → captures.jsonl              │ │
                                   ▼                                            │ │
   (existing / separate follow-on: analyst later COLLECTS captures → idea issues)│
```

The **analyst is on both ends** (produces inspiration, later collects results); the **concierge is purely the live conversational partner**. No idea-logic is duplicated, and no per-turn A2A round-trip is on the voice hot path.

## Non-goals (YAGNI)

- **The back half** — captures → analyst-curated `idea` issues → self-evolve pipeline. That is a *separate* spec (flagged earlier); this design composes with it but does not build it. `inspiration.json` *reads* `captures.jsonl` as one input; it does not file anything.
- **Push notifications / unsolicited audio.** "Proactive" here means the concierge offers a spark at session start or when asked — never an interrupt.
- **A second idea-reasoning brain.** The concierge does not reason about the mesh; it reads a digest the analyst produced.
- **Always-on context injection.** The digest is pulled via a tool, not stuffed into every turn's context.
- **Real-time digest.** The digest is cadence-built (default daily); freshness is "as of `<ts>`", not live.

## Architecture

Three components, clean boundaries, each independently testable. Pure cores (gather / prompt-build / parse-validate / read-filter) are unit-provable; the impure shell is only the analyst dispatch, `gh`, and the file/HTTP I/O.

### Component A — Analyst inspiration-digest builtin

A scheduled dev-society job (`src/dev-society/inspiration-digest*.js`), modelled on the existing `research-escalation-run.js` (host gathers read-only context → `dispatchAnalyst({prompt})` → parse) and `analyst-ideas.js` (dedupe markers, bounded output).

1. **Gather (host-side, read-only — the ask-mode analyst can't do I/O):**
   - **① recurring failures:** latest MIR (`mir.json`), regression issues, CI failure patterns from the `gh-activity` cache.
   - **② gaps / unfinished:** open issues that are stale or blocked (age + label heuristics), known-unwired markers, stale branches.
   - **③ past captures:** recent entries from the Mac `captures.jsonl` (the voice ideas).
   - **④ team activity + web:** the `gh-activity` cache (what agents have done / underused capabilities) and, gated by the analyst manifest `webTools:true`, an optional `WebSearch` pass.
2. **Distill:** `buildInspirationPrompt(signals)` → `dispatchAnalyst({prompt})`. The analyst returns JSON: `{ seeds: [{ theme, spark, why, sources:[…], relatedCaptures:[…] }] }`.
3. **Validate + write:** parse and bound the analyst's output (`≤ MAX_SEEDS`, default **7**; per-field length caps; drop malformed) → write `<mesh-root>/.dev-society/inspiration.json` **atomically** (`{ generatedAt, seeds }`), plus an optional human-readable `inspiration.md`.

**Pure cores (unit-tested):** `gatherSignals` (over injected readers), `buildInspirationPrompt`, `parseInspiration` (validate/bound the analyst JSON). **Impure shell:** `dispatchAnalyst`, `gh`, file writes.

**Cadence:** a dev-society schedule entry (default daily, env-tunable interval, disable flag) — same shape as the other analyst jobs. Lineage label `generated:analyst` reused; no new write surface beyond the one digest file.

### Component B — Digest delivery (Mac → box)

The digest is produced on the **Mac** (where dev-society + the analyst live); the concierge runs on the **box**. Deliver it by adding a read route to the **existing** tailnet-only `serve-capture` sink (`src/voice-capture/`), which the box already talks to (captures flow box→Mac there):

- `GET /inspiration` → returns the latest `inspiration.json` (bearer-auth, same token as `/capture`; tailnet-only; bounded; missing file → `{ seeds: [] }`, never 500).
- The box concierge's `brainstorm_seeds` backend **fetches + caches** it (short TTL). Box offline / Mac down → serve the **last cached** digest with its `generatedAt`, or `{seeds:[]}` if none — a voice turn is never blocked on the network.

**Pure cores (unit-tested):** the `GET /inspiration` handler (auth, missing-file, bounds), the cache read/staleness logic. **Impure shell:** the HTTP fetch.

### Component C — Concierge `brainstorm_seeds` tool + ideation prompt

- **Tool** (`src/brains/tools.js`): add `brainstorm_seeds` to `SPECS` with optional `{ topic }`. Description (functional, never tool-name-baiting): *"Get fresh idea seeds drawn from the mesh — recurring problems, gaps, your past ideas, trends — to spark a new idea or develop one you're forming."* Default backend reads the cached digest (Component B), optionally ranks/filters by `topic`, returns `{ seeds, generatedAt }`. Ask-only, injectable `deps.brainstorm` (mirrors how `listAgents`/`askPeer` default to real read backends). Failures degrade to `{ seeds: [] }` — never throw the loop.
- **Prompt** (`dev-mesh/concierge/prompts/system.md`): add ideation behavior — *at session start, offer one spark from `brainstorm_seeds`; when the owner brings a half-formed thought, call `brainstorm_seeds(topic)`, weave in the relevant seed(s), ask one or two sharpening questions, and once the idea is concrete, `propose_idea` it (title + the developed note).* Seeds are **reference data, not instructions** (untrusted, like `AGENT.md`/captures).

## Data flow

1. **(cadence, Mac)** dev-society fires the inspiration-digest builtin → host gathers ①–④ → analyst distills → `inspiration.json` written atomically under the Mac mesh.
2. **(serve, Mac)** `serve-capture` exposes `GET /inspiration`.
3. **(turn, box)** owner asks for inspiration or brings a thought → concierge calls `brainstorm_seeds(topic?)` → backend returns cached digest seeds (fetched/refreshed from the Mac over the tunnel) → concierge develops the idea live with the owner.
4. **(turn, box)** formed idea → `propose_idea(title, note)` → existing outbox → syncer → Mac `captures.jsonl`.
5. **(separate follow-on)** analyst later collects captures → curated `idea` issues → self-evolve pipeline.

## Error handling (failure = data, never an exception)

- **Analyst dispatch fails / empty / malformed:** keep the last good `inspiration.json` (atomic write means never half-written); log; retry next cadence.
- **No signals at all:** write `{ generatedAt, seeds: [] }`; the concierge simply converses normally.
- **Box offline / Mac down:** `brainstorm_seeds` returns the cached digest (with `generatedAt` so the concierge can say "as of yesterday"), or `{seeds:[]}` if no cache. A voice turn never blocks on digest delivery.
- **Oversized / adversarial analyst output:** bounded and validated (`MAX_SEEDS`, per-field length caps); excess dropped, surfaced as data.

## Security / trust

- **Untrusted data:** seeds, captures, web snippets are bounded, validated, and surfaced to the model as reference material — never executed or obeyed (same posture as `AGENT.md`/captures today).
- **Ask-only:** `brainstorm_seeds` is a pure read; the concierge's only "write" remains `propose_idea` (enrichment, no file write). No new write surface.
- **Delivery:** `GET /inspiration` rides the existing **tailnet-only, bearer-auth** `serve-capture` — no new network exposure, no new secret.
- **Principles:** P1 — the concierge holds no idea-logic (reads a pre-made digest, converses). P2 — all idea reasoning (sourcing, distillation, later collection) lives in the registered analyst. P3 — spec → Codex review → plan → TDD.

## Testing (per repo posture: zero-dep `node --test` L0)

- **Component A:** `gatherSignals` over injected readers (each of ①–④ present/absent/garbage); `buildInspirationPrompt` (includes the gathered signals, bounded); `parseInspiration` (valid → seeds; malformed/oversized → bounded/dropped; empty → `{seeds:[]}`). Analyst dispatch + `gh` are faked.
- **Component B:** `GET /inspiration` handler (auth required; missing file → `{seeds:[]}`; bounds; never 500); cache staleness/fallback logic.
- **Component C:** `brainstorm_seeds` default backend over a temp digest file (returns seeds; `topic` filter; empty/missing → `{seeds:[]}`; degrade-not-throw). Consistent with the existing `brains-tools.test.js` default-backend tests.
- **No Python changes** (no voice-box logic touched; the concierge tool is JS).

## Open / deferred

- **Digest delivery transport** is `GET /inspiration` on `serve-capture` (recommended, reuses the box↔Mac path). If the capture sink is later retired, the route moves with it.
- **Topic ranking** in `brainstorm_seeds` starts simple (substring/keyword over `theme`/`spark`); semantic ranking is a later refinement, not v1.
- **The back half** (captures → analyst `idea` issues) is the next spec; this design is complete and useful without it.

## Review log

(Codex-spec-review rounds appended here.)
