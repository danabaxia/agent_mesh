# Session Generations — headroom-driven rotation + out-of-band digest — Design

**Date:** 2026-06-12
**Status:** reviewed (R1, findings folded); probe-gated for the occupancy formula (§3.4)
**Decisions:** rotate-don't-compact · digest before rotate, no-digest→no-rotate · framework writes memory, agent never does (Boundary 5) · skills/workflows are propose-only deliverables · v1 covers the `self` session only; peer threads get the metric, not auto-rotation · no persisted rotation state · rotation control input is the live usage capture only

## 1. Goal

An agent's canonical `self` session accumulates every dashboard conversation
([src/dashboard/session-store.js](../../../src/dashboard/session-store.js) — one
id per agent, resumed by every entry point). Long-lived sessions repeatedly hit
Claude Code auto-compaction: lossy, unobservable, and paid in latency exactly
when a user is waiting. The multi-turn peer spec
([2026-06-09](2026-06-09-multi-turn-peer-sessions-design.md) §4) documented the
constraints and chose "rely on auto-compaction"; this spec supersedes that
posture for the `self` session with the mechanism the mesh *can* own:

1. **Measure** context occupancy ("headroom") from data Claude already emits.
2. **Distill** a closing session into durable artifacts — memory the agent
   keeps, skill/workflow drafts a human may promote — *out of band*, on the full
   transcript, not in the lossy in-band compaction path.
3. **Rotate** to a fresh session ("next generation") seeded by that memory, so
   the hot path stays short and auto-compaction becomes a rare backstop instead
   of a recurring tax.

Sessions become **generations**: short-lived working contexts over a durable,
file-based memory. The existing memory subsystem is the landing zone — this
spec adds **no new seeding mechanism** (§5.4).

## 2. Scope & non-goals

**In scope (v1):**
- Headroom measurement: live in the dashboard runner from stream-json (the
  control input), and at-rest from transcript tails (display + peer metric,
  best-effort only).
- Digest pipeline: framework-extracted transcript → ask-mode digest worker →
  framework-applied memory writes + propose-only skill/workflow drafts.
- Automatic digest+rotate of the dashboard `self` session on a headroom
  threshold, never mid-turn.
- A real-`claude` probe script verifying the undocumented usage semantics
  (§3.4) before the formula is trusted.

**Non-goals (explicit):**
- **No custom in-band compaction** — auto-compaction stays untouched as the
  backstop. PreCompact-hook blocking is documented-possible but NOT used
  (blocking without rotating risks context exhaustion).
- **No auto-rotation of `from:<caller>` peer threads** — they keep manual
  `new_conversation` (the 2026-06-09 posture). Digesting a caller's thread into
  the peer's shared `memory/` would leak caller A's task content into caller
  B's turns; the privacy model needs its own design. v1 stamps the headroom
  metric on peer turns and stops there. (A future peer-rotation design should
  start from this spec's digest core — §4.3.)
- **No scheduled digest job type** — v1's only trigger is the rotation
  threshold. A cadence-based digest is a v2 entry point into the same
  `runDigest` core; it earns its scheduler integration when an agent wants it.
- **No SessionStart/PreCompact hook dependency** — seeding rides the existing
  runtime-prompt assembly. Hook-based external-session reporting is future work.
- **No conversation/topic-scoped dashboard threads** — generations keep one
  active `self` pointer; a thread picker is a separate UI design.
- **No Headroom-the-OSS-project integration** (github.com/chopratejas/headroom)
  — name collision only. A spike on its MCP mode for tool-output compression is
  possible future work, never a core dependency (zero-dep posture).

## 3. The headroom signal

### 3.1 Occupancy formula

For a resumed `claude` session the prompt *is* the conversation, so the last
assistant turn's API usage approximates current context occupancy:

```
occupancy ≈ input_tokens + cache_read_input_tokens + cache_creation_input_tokens
headroom% = max(0, 1 − occupancy / contextWindow)
```

`contextWindow` defaults to 200_000 (`AGENT_MESH_CONTEXT_WINDOW` override —
needed for 1M-context models). Verified against docs: stream-json carries
`usage` with all three input fields; there is **no** direct "context remaining"
field anywhere in stream-json, so computing it is the only option.

### 3.2 Two read points; only the live one is a control input

- **Live (dashboard turns) — drives rotation.** The runner already parses
  every stream-json line
  ([src/dashboard/session-runner.js:181](../../../src/dashboard/session-runner.js#L181)).
  The event parser **currently drops `usage`**
  ([src/dashboard/session-events.js](../../../src/dashboard/session-events.js)
  extracts content/type only — R1 finding), so `parseEventLine`'s `result`
  handling is extended to surface `usage`; the runner captures it from the
  final `result` event. Zero extra IO, freshest possible value. If a turn ends
  with no captured usage, **no rotation decision is made that turn** — there is
  deliberately no disk-read fallback on the control path (the next turn
  re-measures; R1 finding: the fallback re-read was redundant IO).
- **At rest (any session) — display + peer metric, best-effort.** New
  `readSessionHeadroom(agentRoot, sessionId)` in
  [src/session-transcripts.js](../../../src/session-transcripts.js): resolve via
  the existing `resolveTranscript` (containment gate reused), read a bounded
  tail (last 256 KB), scan **raw JSONL lines** backwards for the last assistant
  event carrying `message.usage` — `JSON.parse` per line, NOT via
  `parseTranscriptLine`, which does not surface usage (R1 finding). Returns
  `{occupancy, headroomPct, atMtime}` or `null` (absent usage / unparseable
  tail degrades to `null`, exactly like `turnsApprox`). Works uniformly for
  self sessions, peer threads, and external CLI sessions — no spawn changes.

### 3.3 Surfacing

- `listSessions` rows ([src/dashboard/session-index.js:155](../../../src/dashboard/session-index.js#L155))
  gain `headroomPct`. To avoid new per-poll IO, the value is computed **from
  the same bounded buffer `derivePreview` already reads** (shared tail-reader
  in `src/session-transcripts.js`; `derivePreview` and `readSessionHeadroom`
  become two consumers of one read — R1 finding) and cached in the existing
  mtime/size `_cache` entry. The session list/log UI renders it as a small
  water-level indicator; UI work is intentionally minimal.
- Peer turns stamp `agentmesh/metrics.headroom` next to the existing
  `agentmesh/metrics.turn`
  ([src/a2a/stdio-server.js:330](../../../src/a2a/stdio-server.js#L330)) via
  `readSessionHeadroom` — same best-effort, never-fails-the-turn pattern as
  `countTurns` there. This is an **additive** field under the reserved
  `agentmesh/*` namespace: a minor-version extension per PROJECT.md §1.10
  (receivers already ignore unknown `agentmesh/*` fields), present only when
  measurable.

### 3.4 Probe gate (build this FIRST)

`scripts/probe-headroom.mjs`, a sibling of
[scripts/live-a2a-check.mjs](../../../scripts/live-a2a-check.mjs) (real `claude`,
Windows-aware spawn via `resolveSpawnTarget`), verifies two undocumented
assumptions:

1. **Resume reflects full occupancy** (BLOCKING for rotation): run a turn,
   `--resume` it with a tiny prompt, assert the second turn's input+cache
   tokens ≈ first turn's cumulative context (not a per-request reset). If this
   fails, the occupancy formula is wrong and auto-rotation falls back to a
   threshold on `lineCount` (coarse but monotonic).
2. **Transcript carries usage** (NON-blocking): assert the on-disk `.jsonl`
   assistant events embed `message.usage` with the three input fields. Failure
   only degrades the at-rest surface (§3.2) — rows show `null`, peer turns omit
   the metric; rotation is unaffected since its control input is the live
   capture.

The probe prints a PASS/FAIL table; its outcome is recorded in §12 before
implementation proceeds past the measurement layer.

## 4. Generation rotation (`self` session)

### 4.1 Mechanism

The session store is already the pointer (`writeSessionId`); rotation is a
pointer rewrite, not new identity machinery (deterministic ids buy nothing here
— the store persists the pointer; random UUIDs stay):

```
post-turn (runner, after `done` resolves, live usage captured):
  if headroomPct < threshold → arm an IN-MEMORY pending-rotation flag
on pending flag, after a short idle delay (no new turn for ROTATE_IDLE_MS):
  1. acquire the runner's single-active lease (new exported wrapper, §4.1.1)
  2. digest the current transcript (§5) — bounded by its own timeout
  3. on digest success: writeSessionId(meshRoot, agentRoot, randomUUID())
     + recordEvent {kind:'rotate', source:'headroom', prior id in payload}
  4. on digest failure/timeout: do NOT rotate; clear the flag; surface on
     the dashboard; the next threshold crossing re-arms (failure is data)
```

There is **no persisted rotation state** (R1 finding — the earlier
`rotate-due.json` was an extra state machine): a crash or restart simply loses
the pending flag, and the next completed turn re-measures and re-arms. Nothing
is lost either way — the old thread keeps working under the auto-compaction
backstop. Rules: never mid-turn; the idle delay keeps a user who is actively
typing from queueing behind a digest; a turn submitted during digest queues
behind the lease exactly like a busy turn, and the dashboard surfaces a
"digesting" state for that window rather than blocking silently. `do`-mode is
never used (the worker needs no write tools — §5).

#### 4.1.1 Lease integration (named, not assumed)

`session-runner.js` exports only `runTurn`/`setActiveSession`/`stop` today; the
lease (`acquireLaunching`/`releaseLease` + the `inFlight` map) is internal (R1
finding). The runner gains one export, `runMaintenance(agentName, fn)`: acquire
the same lease + `inFlight` slot a turn takes, run `fn` (here: `runDigest`),
always release. The digest's inner `claude` spawn happens via `delegateTask`
*while the framework holds that lease* — the subprocess itself neither knows
nor needs the lease. The scheduler's own `runningAgents` lock is untouched (no
scheduler involvement in v1, §2).

### 4.2 Frontend and mirror — no changes required

`session-view` polls the canonical id every 4 s
([src/dashboard/public/session-view.js:596](../../../src/dashboard/public/session-view.js#L596))
and switches streams when it moves
([session-view.js:145](../../../src/dashboard/public/session-view.js#L145));
the new generation has no transcript until its first turn, which is the
already-handled first-launch path (canonical-id exception at
[src/dashboard/server.js:1991](../../../src/dashboard/server.js#L1991) +
store-write-before-spawn at
[src/dashboard/session-runner.js:164](../../../src/dashboard/session-runner.js#L164)).
The mirror is per-id and LRU-bounded; prior generations remain listed and
streamable as history. The only additions are provenance (`rotate`) and a
`deriveProvenance` case for it, so the list can label past generations.

### 4.3 Peer threads (v1: metric only)

`agentmesh/metrics.headroom` gives callers the signal to decide
`new_conversation` themselves. Auto-rotation needs per-caller digestion with a
privacy story (§2) — deferred, with the epoch machinery
([src/a2a/session-id.js](../../../src/a2a/session-id.js)) already in place and
`runDigest` designed as the shared core a peer-rotation design would call.

## 5. The digest pipeline (distillation)

### 5.1 Extract (framework, pure IO)

A digest worker must not re-read the very transcript that overflowed a context
window. The framework pre-reduces it: new `src/digest-extract.js` reads a
**bounded tail of the file** (last `4 × DIGEST_EXTRACT_MAX_CHARS` bytes — the
read is bounded, not just the output; R1 finding: transcripts can be tens of
MB), walks it with `parseTranscriptLine` + `redactSessionEvent`, keeps
user/assistant text (tool dumps dropped — the same priority order
auto-compaction uses), bounds the result (newest-first within
`DIGEST_EXTRACT_MAX_CHARS`, default 120_000), and writes it to
`<agentRoot>/.agent-mesh/digest/<sessionId>-extract.md`. Runtime state dir, not
a protected dir; overwritten per digest; redaction already applied.

**Boundary hygiene (R1 finding):** `digest-extract.js` lives in core `src/` and
must not import dashboard code — the exact problem `session-transcripts.js` was
extracted to solve. `parseTranscriptLine` + `redactSessionEvent` move from
`src/dashboard/session-events.js` into the shared module (re-exported from
`session-events.js` for back-compat), the same §5.2 pattern the 2026-06-09 spec
used for `resolveTranscript`/`encodeProjectDir`.

### 5.2 Digest worker (ask-mode, no write tools)

One ask delegation through the normal pipeline (recursion guard, run-log, all
inherited; timeout overridden to `AGENT_MESH_DIGEST_TIMEOUT_MS`, default
180_000 — the delegate default of 10 minutes is too long to hold the runner
lease; R1 finding): *"Read .agent-mesh/digest/<id>-extract.md and emit a
digest"* with a pinned output contract — fenced JSON:

```json
{ "learned":   ["durable facts/preferences/constraints, ≤200 chars each"],
  "decisions": ["YYYY-MM-DD — <one-line, self-contained decision>"],
  "proposals": [{ "type": "skill" | "workflow", "name": "...",
                  "summary": "...", "draft": "..." }] }
```

(`skill`/`workflow` proposals share one array — they are handled identically;
R1 simplification.) The prompt is framework-owned text (a constant, not
agent-editable config). Parsing reuses the orchestrator's existing
first-JSON extractor
([src/orchestrator.js:174](../../../src/orchestrator.js#L174) `extractFirstJson`,
exported or lifted to a small shared util — R1 finding) plus a shape
validator. Unparseable worker output → digest failure (data, §4.1) — the
framework never "best-guesses" memory out of free text.

### 5.3 Apply (framework writes; the agent cannot — by design)

[src/path-guard.js:20](../../../src/path-guard.js#L20) lists `memory/`,
`skills/`, `workflows/`, `prompts/` as PROTECTED_CONFIG_DIRS — Boundary 5:
delegated tasks may never rewrite the agent's own future instructions. The
digest pipeline **honors** this rather than tunneling around it: the worker
only *emits text*; the framework process applies it. Stated plainly (R1
finding): this is a **new, deliberate class of automated memory mutation** —
Boundary 5's "separate admin workflow" performed by framework code instead of a
human — and it is acceptable only under all three of: content is validated
against the fixed contract, every write is hard-capped, and nothing that is
*obeyed as instructions* (skills/workflows/prompts) is ever auto-applied.

- `learned[]` → **overwrite** `memory/learned.md` (dated header + bullets),
  hard-capped to `MAX_MEMORY_FILE_CHARS` (2 000,
  [src/config.js:14](../../../src/config.js#L14)) — eagerly loaded next
  generation, can never starve the prompt budget.
- `decisions[]` → **append** to `memory/decisions.md`. Entries must be
  **one-line and self-contained**, because in the framework itself the
  decisions surface is the prompt *index* only: `buildDecisionsIndex`
  ([src/agent-context.js:198](../../../src/agent-context.js#L198)) renders
  80-char summaries and recommends a `recall_decision` tool that is **not
  framework-shipped** — it exists only in the agent-b example
  (`examples/agent-b/tools/memory/server.mjs`; R1 finding). v1 therefore
  treats full-entry recall as optional per-agent tooling; a framework
  memory-recall MCP server is future work. Targeted hardening in the same
  change: cap the index at the most recent `MAX_DECISIONS_INDEX_LINES` (30)
  bullets — it is currently unbounded **in line count** (per-bullet 80-char
  caps exist), and a digest that appends forever must not regrow the prompt it
  exists to shrink.
- `proposals[]` → files under `deliverables/digests/YYYY-MM-DD/<session-prefix>/`.
  Deliberate layout choice (R1 finding): the scheduler's `saveJobArtifact`
  writes `.agent/artifacts/<id>/` ([src/dashboard/scheduler.js:25](../../../src/dashboard/scheduler.js#L25)),
  a separate tree from the browsable `deliverables/` routes
  ([src/dashboard/server.js:729](../../../src/dashboard/server.js#L729));
  digest proposals are agent deliverables for a human to review, so they go in
  the `deliverables/` tree, borrowing `saveJobArtifact`'s slug/collision
  conventions. **Never** written into `skills/` or `workflows/` automatically:
  those are obeyed instructions; auto-applying self-authored instructions is a
  self-amplification loop (one bad digest compounds), the exact posture the
  mesh-manager spec set ("observes and proposes"). Proposal `name`s are
  `isSafeSkillName`-validated before any path is built.

All apply writes go through a shared `atomicWriteFile` (temp + rename),
extracted from the `persistEpoch` pattern
([src/a2a/session-id.js:52](../../../src/a2a/session-id.js#L52)) into a small
util both call (R1 finding). Every apply records a provenance line in the run
log: source session, files written, byte counts.

### 5.4 Seeding — zero new mechanism

`buildAgentRuntimePrompt` already loads `memory/*.md` (capped per-file) into
**every** turn — dashboard, scheduled, and peer paths alike
([src/agent-context.js:73](../../../src/agent-context.js#L73), order: system →
memory → decisions index → workflows → mode prompt → skills → roster). The next
generation's first turn sees `learned.md` and the decisions index with no new
code. Memory is rendered as bounded *data* in the prompt — same trust class as
AGENT.md, never framed as instructions.

### 5.5 Trigger

One trigger in v1: the rotation flow (§4.1) calls `runDigest(agentRoot,
sessionId)` while holding the runner lease via `runMaintenance`. The function
is trigger-agnostic by construction so a future scheduled job or peer-rotation
design reuses it without change.

## 6. Components & changes

| Component | Change |
|---|---|
| `src/session-transcripts.js` | + shared bounded tail-reader; + `readSessionHeadroom` (raw-JSONL usage scan, §3.2); receives `parseTranscriptLine`/`redactSessionEvent` moved from session-events (§5.1) |
| `src/dashboard/session-events.js` | surface `usage` on `result` events; re-export the moved parsers (back-compat) |
| `src/dashboard/session-runner.js` | capture live usage; post-turn threshold check + in-memory pending flag + idle delay; new export `runMaintenance(agentName, fn)` (§4.1.1) |
| `src/dashboard/session-index.js` | `headroomPct` in rows (from the shared tail read, cached); `rotate` provenance kind + `deriveProvenance` case |
| `src/a2a/stdio-server.js` | stamp `agentmesh/metrics.headroom` (best-effort, alongside `metrics.turn` at :330) |
| `src/digest-extract.js` (new) | bounded-tail transcript → extract (§5.1) |
| `src/digest.js` (new) | `runDigest`: extract → ask delegation (digest timeout) → contract parse (shared first-JSON extractor) → atomic apply (§5.2–5.3) |
| `src/atomic-write.js` (new, tiny) | `atomicWriteFile` extracted from `persistEpoch`; both call it |
| `src/agent-context.js` | cap decisions index lines (§5.3) |
| `src/config.js` | `MAX_DECISIONS_INDEX_LINES`; defaults for the env knobs (§7) |
| `scripts/probe-headroom.mjs` (new) | the §3.4 gate |
| dashboard UI | headroom indicator on session rows; "digesting" status during §4.1; rotation label — minimal |

## 7. Config (env, all optional)

`AGENT_MESH_CONTEXT_WINDOW` (200000) ·
`AGENT_MESH_ROTATE_HEADROOM_PCT` (25 — rotate when headroom < 25%; `0` disables
auto-rotation entirely) · `AGENT_MESH_ROTATE_IDLE_MS` (120000 — quiet period
before a pending rotation runs) · `AGENT_MESH_DIGEST_TIMEOUT_MS` (180000) ·
`AGENT_MESH_DIGEST_EXTRACT_MAX_CHARS` (120000).
Claude's own backstop knobs (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`,
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`) are documented as operator-tunable but the
framework does not set them in v1.

## 8. Error handling & concurrency

- Digest worker timeout/refused/error → structured failure, **no rotation**,
  no memory writes, flag cleared, surfaced on the dashboard; the prior thread
  keeps working (auto-compaction backstop). Failure is data — never
  auto-retried in a loop; the next threshold crossing re-arms naturally.
- Apply is atomic per file (`atomicWriteFile`); a failed apply of one section
  does not corrupt another.
- Rotation/digest runs under the runner lease (`runMaintenance`), so it can
  never overlap a dashboard turn; a turn submitted mid-digest queues behind the
  lease with a visible "digesting" state. No persisted rotation state exists to
  go stale: restart loses only the pending flag, which the next turn re-arms.
- `readSessionHeadroom` returning `null` only degrades display/metrics; a turn
  with no captured live usage simply makes no rotation decision that turn.

## 9. Security / invariants preserved

- **Boundary 5 upheld, not weakened:** the digest *worker* runs ask-mode with
  read-only tools; only the framework process writes `memory/` — and
  `deliverables/` is the ceiling for anything that would otherwise become
  obeyed instructions (`skills/`, `workflows/`, `prompts/` are never
  auto-written). The framework-as-admin-workflow stance is stated explicitly in
  §5.3 with its three conditions.
- **Memory is untrusted data:** length-bounded, loaded as content in the
  assembled prompt (existing path), never executed or framed as instructions —
  identical posture to AGENT.md.
- **Anti-spoof unchanged:** no model-facing surface gains a path or id
  argument; the digest target session id comes from the framework, the extract
  path is framework-computed, proposal names are validated, and
  `metrics.headroom` is response metadata (additive minor per §1.10).
- **Transcript containment:** all transcript access goes through
  `resolveTranscript` (realpath containment), including the tail reads.
- **Single writable root / no Bash in do:** untouched (nothing here uses `do`).
- **Failure is data:** every non-done digest/rotation outcome is a structured,
  logged result; the mesh never auto-fails-over.

## 10. Testing (hermetic; stubbed `claude`)

1. `readSessionHeadroom`: synthesized transcripts (usage present / absent /
   truncated tail / >256 KB tail) → correct occupancy or `null`; containment
   violation propagates; shares one read with `derivePreview` (no second open).
2. Live capture: synthesized stream-json `result` with usage → runner computes
   headroom; missing usage → no rotation decision armed.
3. Runner rotation decision: below-threshold arms the pending flag; a new turn
   during the idle window defers it; digest-failure → pointer unchanged + flag
   cleared; success → new id written + `rotate` provenance; restart loses the
   flag and the next below-threshold turn re-arms it.
4. `runMaintenance`: holds the same lease as a turn (a concurrent `runTurn`
   gets `session_busy`); always releases on throw.
5. Extract: fixture transcript → bounded tail READ honored (file larger than
   the bound), tool dumps dropped, newest-first output bound honored,
   redaction applied.
6. Digest contract: valid JSON → exact file writes (learned.md capped,
   decisions appended one-line, proposals under `deliverables/digests/`);
   invalid JSON → failure, zero writes; oversized `learned` → truncated to cap;
   malicious proposal `name` (`../prompts/x`) rejected by `isSafeSkillName`.
7. Decisions index cap: >30 bullets → newest 30 in the prompt index.
8. listSessions rows carry `headroomPct`; cache invalidates on mtime/size
   change.
9. Peer turn stamps `metrics.headroom` (stubbed transcript), absent → omitted,
   never fails the turn.
10. Boundary move: `parseTranscriptLine`/`redactSessionEvent` re-exports keep
    existing dashboard tests green; the shared module carries the
    Windows-safety tests (same discipline as the 2026-06-09 move).
11. Probe script asserted runnable in CI-skip mode (real run is manual, §3.4).

## 11. Decisions (resolved)

- **D1 — rotate vs compact:** rotation + out-of-band digest; auto-compaction is
  a backstop only. In-band custom compaction is not buildable (no headless
  trigger, no instruction-injection mechanism — verified against hook docs).
- **D2 — who writes memory:** the framework, post-validation, within hard caps.
  Forced by Boundary 5; stated as a deliberate new mutation class (§5.3).
- **D3 — skills/workflows:** propose-only deliverables; a human promotes.
- **D4 — failure policy:** no digest → no rotate.
- **D5 — peer threads:** metric only in v1 (privacy of cross-caller digestion).
- **D6 — self session identity:** keep random UUIDs + store pointer; no
  deterministic ids for `self`.
- **D7 — probe-gated:** assumption (1) blocks rotation; assumption (2) only
  gates the at-rest surface (§3.4).
- **D8 — no persisted rotation state:** in-memory pending flag + idle delay;
  restart re-arms on the next threshold crossing (R1).
- **D9 — decisions are one-line and self-contained:** `recall_decision` is
  example-only, not framework infrastructure; a framework recall server is
  future work (R1).
- **D10 — v1 trigger is rotation only:** scheduled digest deferred to v2 (R1).

## 12. Review log

- **R1 (built-in `/code-review`, high effort — independent pass per the
  2026-06-09 spec's R5 precedent; `codex` CLI unavailable in this
  environment):** 7 finder angles (3 correctness, reuse/simplification/
  efficiency, altitude) over the spec vs. the codebase; ~40 candidates, deduped
  and verified against the code (two finder claims were themselves refuted by
  direct reads: `metrics.turn` stamping DOES exist at stdio-server.js:330, and
  transcript mtime/size cache discipline is adequate for append-only
  transcripts). **10 findings folded:**
  1. `recall_decision` treated as framework infra — it is example-only →
     one-line self-contained decisions, D9 (§5.3).
  2. `digest-extract.js` (core) importing dashboard `session-events.js`
     re-created the boundary `session-transcripts.js` was extracted to fix →
     move + re-export the two parsers (§5.1).
  3. "Holds the runner lease" had no API — the lease is runner-internal and
     `delegateTask` subprocesses know nothing of it → named `runMaintenance`
     export (§4.1.1).
  4. Neither `parseTranscriptLine` nor the live event parser surfaces `usage`
     → raw-JSONL tail scan + explicit `result`-usage extension (§3.2).
  5. Extract bounded only its OUTPUT; the transcript read was unbounded →
     bounded tail read (§5.1).
  6. Digest could hold the lease for the full 10-min delegate timeout with no
     UI signal → 3-min digest timeout + idle-delay arming + visible
     "digesting" state (§4.1, §7).
  7. Persisted `rotate-due.json` was a redundant state machine → in-memory
     flag, D8 (§4.1).
  8. Scheduled digest job type was YAGNI in v1 → cut, D10 (§2, §5.5).
  9. Deliverables layout divergence (scheduler artifacts vs `deliverables/`
     routes) was implicit → explicit tree choice + shared conventions (§5.3).
  10. Reuse misses → shared `atomicWriteFile`, orchestrator `extractFirstJson`,
      one shared tail read for preview+headroom (§3.3, §5.2, §5.3, §6); plus
      accuracy nits (metrics-additivity note per §1.10, decisions-index
      "unbounded in line count", session-view poll citation :596).
- **Probe (§3.4, 2026-06-12, claude 2.1.175 linux sandbox):** ran two real turns (--session-id then --resume) in a tmp cwd; transcript landed at `~/.claude/projects/-tmp-probe-headroom-*/` as expected.
  ```
  PASS  turn1 result usage present  ({"input_tokens":3,"cache_creation_input_tokens":20709,"cache_read_input_tokens":0,"output_tokens":5,...})
  PASS  turn2 (--resume) usage present  ({"input_tokens":3,"cache_creation_input_tokens":19,"cache_read_input_tokens":20709,"output_tokens":5,...})
  PASS  assumption 1: resume occupancy cumulative (t2 >= t1)  (t1=20712 t2=20731)
  PASS  assumption 2: transcript carries usage  (occupancy=20731)
  ALL PASS
  ```
  ALL PASS — formula and at-rest surface confirmed: the --resume turn's input+cache usage is cumulative (t2 occupancy 20731 > t1 occupancy 20712, as the first turn's context is served from cache in turn 2), and the on-disk transcript's assistant records carry `message.usage` with the three input fields; both the rotation formula (§3.1) and the at-rest tail reader (§3.2) are safe to implement in Tasks 13-15.
- **(pending)** A fresh independent-model pass (`codex-spec-review`) when the
  `codex` CLI is available.
- **Implementation (2026-06-12):** landed on branch claude/dreamy-goodall-vcvash per docs/superpowers/plans/2026-06-12-session-generations.md — 16 tasks, TDD, two-stage reviewed per task; probe verdict ALL PASS (above); full suite green at the environment's pre-existing 6-failure baseline (4 change-detect git-signing sandbox artifacts, 2 delegate retry-timing flakes — verified present on the pre-implementation parent commit).
