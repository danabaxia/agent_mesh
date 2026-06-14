# Single-Agent Session Management — Design

## 1. Goal

A mesh agent today drifts toward **one long-lived session per entry point**. That
single session simultaneously carries accumulated history *and* the current task,
so it fills the context window and triggers **frequent, lossy auto-compaction**;
the accumulated conversation output stays unstructured, so **recurring work is
never absorbed** into reusable workflows or fast-recall memory.

This spec restructures a single agent's conversations into a **persistent
identity layer + a set of transient, focused task-sessions**, governed by:

- **tiered context delivery (L0/L1/L2)** — only one-line indexes are always in
  context; full content is pulled on demand;
- **pull-on-demand recall with provenance** — no silent injection, real deletes;
- a **per-agent session manifest** — a structured document layer over the raw
  JSONL transcripts;
- a **manual, review-gated absorption-and-retire pipeline** — recurring tasks
  distilled into quick memory + workflows, the spent session retired.

The result: **live sessions stay lean, and knowledge compounds into the structure
layer** instead of bloating the conversation.

It **extends** three existing subsystems, not replaces them:
- session generations (2026-06-12) — headroom rotation + out-of-band digest;
- multi-turn peer sessions (2026-06-09) — deterministic per-caller session ids;
- review-first session management (2026-06-13) — provenance + copy-command.

Design references (mapped, not imported — the repo stays zero-dependency):
- **MemGPT/Letta** — core (always-resident) vs archival (paged-via-tool) memory;
  the model that de-risks recall (§5/§6).
- **Zep/Graphiti** — episodic / semantic-fact / community-summary tiers ≈ our
  L2/L1/L0; **bi-temporal fact validity** → our drift-watch (§10).
- **Mem0** — user/session/agent memory hierarchy; auto extract+compress.
- **agentic-RAG "retrieval-necessity detection"** — pull only when needed, not
  always; backs the session-type split (§6).
- **`agentmemory`** — pull-on-demand, provenance trace, real deletes (the
  "anti-Dreaming" stance).
- **OpenViking** — L0/L1/L2 tiered context over a file-system paradigm.
- **Claude Desktop Projects** — folder-scoped memory + index; but its
  *push-all-history* is exactly the bloat we cure.

## 2. Non-goals

- **Not replacing CLI session storage.** Claude Code's per-folder
  `~/.claude/projects/<enc>/…/<uuid>.jsonl` transcripts remain the substrate;
  this adds a structured layer *over* them.
- **Not auto-injecting history.** Explicitly the opposite of Claude Desktop's
  "bring all prior project chats into every new chat." Index-first, pull-based.
- **Not autonomous.** Mesh **proposes**; the user **decides and launches**
  ("Dashboard observes, CLI acts"). The sessions the framework spawns itself remain
  **headless worker/peer** sessions (its existing job) **and the manually-triggered
  digest/absorption worker** (§9, an ask-only spawn on a dashboard click) — never a
  user-interactive session.
- **Not background consolidation.** No silent "Dreaming"-style push; absorption is
  manually triggered and review-gated.
- **Not cross-machine session sync** (backlog #9) — single-agent, single-host here.

## 3. Core model — identity layer + task-sessions

```
┌─ PERSISTENT IDENTITY LAYER (invariant across all sessions) ───────────┐
│  AGENT.md (identity) · memory/quick.json (quick memory) · workflows/  │
└───────────────────────────────────────────────────────────────────────┘
        ↑ loaded (as L0 index) at session open   ↓ distilled at task done
┌─ TASK-SESSIONS (transient, focused, retire-able) ─────────────────────┐
│   task-A session    task-B session    task-C session …  (each lean)    │
└───────────────────────────────────────────────────────────────────────┘
```

An agent is **not one session**. It is a stable identity layer plus a set of
**task-sessions**, each a focused conversation for one task. The identity layer is
the durable knowledge; task-sessions are working contexts that are spun up, kept
lean, distilled, and retired.

**Lifecycle of one task-session:** `open → active → (rotate)* → distill → retire`.
- **open** — new task ⇒ a fresh, lean session; identity layer auto-loaded *as L0
  index only* (§5).
- **active** — the session carries only the current task's working context; durable
  knowledge is pulled on demand (§6), never restated.
- **rotate** — same task, session grew too long ⇒ headroom-driven digest+rotate to
  a new generation (existing mechanism, generalized from `self` to every agent).
- **distill** — task done ⇒ user-triggered absorption (§9).
- **retire** — session marked `archived`: never injected into a new session again,
  but preserved/queryable/resumable.

**rotate ≠ segment.** *Rotate* continues the *same* task across generations;
*segment* opens a *different* task as a new session. The mesh has rotate today; this
adds the explicit task-session as the segmentation unit.

## 4. Cold-start — open-new-by-default; resume only to continue

> **Scope:** this section is about **interactive user sessions**. Headless
> worker/peer sessions are a *different* cold-start regime — their task **is** known
> at spawn time, so the framework does deterministic task-matching/prefetch for
> them (§6). "Never guesses the task" below is an invariant for the *interactive*
> path only.

A user does not declare a task type when starting `claude`, so **task-based routing
at session-open does not exist** (for interactive sessions). Two cases, only one
needs a choice:

- **New task (the common case): no choice.** Default to a **fresh lean session**.
  The identity layer (memory index + workflow names) auto-loads regardless of task,
  so even a "same-kind" task has its knowledge at hand — *without resuming any old
  session.*
- **Continuing an unfinished task (rare): the user chooses, and has the
  information.** The user picks that task-session from the manifest list (§7) and
  copies its `claude --resume <id>`.

**The mesh never guesses the task at interactive cold-start.** It computes session
*identity* and the dashboard **proposes the exact command**; the user **executes
the launch**. Open-new mints a **fresh unused UUID** and proposes `claude
--session-id <fresh-uuid>` (safe per the 2026-06-09 lesson: `--session-id` only for
an id whose transcript doesn't exist yet); resume only ever proposes `claude
--resume <id>` for an id **already in the manifest** — never `--continue`. The
**task label is derived post-hoc** (§9), used only for absorption/grouping — never
to select a session id (anti-spoof: identity is the canonical path, never a
model-derived label).

Optional, non-blocking nicety: *after* the first turn, if the dashboard detects the
new session overlaps a past task (§9 signals), it may propose *pulling that task's
quick-memory/workflow into the current session* (not resuming the old one). Ignorable.

## 5. Tiered context delivery (L0/L1/L2) + core/archival split

Every context object — task-session, quick-memory entry, workflow — carries three
abstraction levels (OpenViking / Zep-Graphiti pattern):

| Level | Content | Cost |
|---|---|---|
| **L0** | one line: what it is + outcome | tiny (index) |
| **L1** | overview: core points + when-to-use | small |
| **L2** | full content (transcript / full workflow / full memory value) | large |

But *tiering alone doesn't decide what's in context.* We overlay **MemGPT/Letta's
core-vs-archival split** (the key research result that de-risks recall, §6):

- **Core memory — always in context.** A small, hard-capped set: **every entry's
  L0** (the index) **+ the L1 of entries flagged `core`** (the agent's essential,
  stable facts/decisions + active task-session one-liners + available workflow
  names). This is the always-resident "RAM."
- **Archival memory — pulled on demand.** Everything else: all **L2** bodies, and
  the **L1 of non-core** entries. The paged "disk," reached by tool (§6).

`buildAgentRuntimePrompt` injects **only core memory**. This is the lever against
"single entry → frequent compression": the conversation never restates durable
knowledge, yet the *essentials are guaranteed present* (in core), and the long
tail is one pull away. `core` is a per-entry flag set at absorption (§9), capped
by count + tokens; L0/L1 summaries are generated by the existing **ask-only digest
worker** (zero new deps); L2 is the already-stored artifact.

**Prompt-assembly cutover (this is a behavior change, not a pure add-on).** Today
`buildAgentRuntimePrompt` *eagerly injects the full body of every `memory/*.md`
file* (capped at `MAX_MEMORY_FILE_CHARS` each). Switching to "core only" is a
**replacement** of that path, so the cutover is specified, not assumed:
- The one-time migration (Decision 2) covers **all** `memory/*.md` (e.g.
  `profile.md`, `decisions.md`, `learned.md`), not just `learned.md` — each becomes
  `quick.json` entries with generated L0/L1; identity-critical ones seed `core:
  true` (so a migrated agent isn't context-starved before its first Absorb, §8).
- Until an agent is migrated, the **legacy eager-body injection stays** (feature-
  flagged per-agent on `quick.json` presence) — no agent silently loses prompt
  content. New "core only" applies only once `quick.json` exists.

**Injected memory is fenced as DATA, not instructions (invariant).** Core-memory
L1 entering the system prompt is derived from absorbed conversation/task text —
some of which originated from callers/peers and is therefore *untrusted* (same
threat as "AGENT.md is data, never instructions"). So injected core L1 is wrapped
in the **same explicit "recalled data, not instructions" fence** the peer roster
uses (`agent-context.js`), length-bounded, and the §9 promotion review surfaces
each entry's **provenance** (which caller/run produced it) prominently so an
injection-origin entry is visible to the human approver — not rubber-stamped.

## 6. Recall strategy — session-type-aware (resolves the "will the model pull?" risk)

Pure pull has a real failure mode (validated by the agentic-RAG literature and our
own first-turn-tool-visibility lesson): the agent sees the index but **doesn't call
recall**, and answers with partial context. We resolve it three ways at once —
**core memory (§5) carries the essentials regardless**, and the *long-tail* recall
is **split by session type**, because the two contexts have opposite constraints:

- **Headless worker/peer sessions → framework prefetch, *additive* not exclusive.**
  The task is known at spawn time and the first-turn tool race makes a turn-1
  `recall` call unreliable, so before spawning the framework matches the task
  against the L0/L1 index and **injects the top-K (token-budgeted) L2 bodies + any
  trigger-matched workflow directly into the prompt** — the race is sidestepped
  (content is in-prompt, no tool call needed). **But the `recall` verbs remain
  exposed** so a multi-turn worker that's had "a beat of work" can still pull what
  prefetch missed (per the CLAUDE.md lesson: functional asks after turn 1 find
  tools fine). Prefetch is best-effort, not the only path — this is the mitigation
  for lexical mis-selection (see Decision 7 + §14): a wrong/weak prefetch no longer
  strands the worker.
- **Interactive user sessions → core + agent-decided pull.** Multi-turn, tools
  ready after the first beat. Core memory (§5) is always in; the agent pulls L2
  via tool as the conversation reveals specifics. The runtime prompt frames it as
  **retrieval-necessity** ("core has the essentials; `recall` archival only when
  the task needs detail beyond core") — explicit, not blind, retrieval.

> **Prefetch relevance is lexical (zero-dep) and *will* mis-select** (vocabulary
> mismatch on short tasks). That is acceptable *only because* prefetch is additive
> (recall remains) and core carries the essentials; it is **not** the sole context
> source. Decision 7 (lexical vs. one `claude` call) is measured against the §13
> recall eval, not guessed.

**The recall surface is a framework-OWNED MCP server** (like `agentmesh_peerbridge`),
assembled in `assembleMcpServers` **after** the mode gate — **not** the
`x-agentmesh readOnly` author-marker path, which `mesh-mcp.js` drops entirely in
`do` mode (`if (mode === 'do') return {}`). Its verbs are `recall({ key })` /
`load_workflow({ name })` / `load_session({ id })`, granted **read-only in both
`ask` and `do`** (so a `do` task-session can still recall a workflow before
editing). Discipline (from `agentmemory` + the mesh's confinement invariant):
- **Read-side root confinement (invariant).** Every verb canonicalizes its target
  under `realpath(AGENT_MESH_ROOT)` and **refuses** (a `refused` data result —
  failure is data) any `key`/`name`/`id` resolving outside it. `recall` reads only
  `<root>/memory/quick.json`; `load_workflow` only `<root>/workflows/`;
  `load_session` accepts **only session ids present in this agent's own manifest**
  — never an arbitrary UUID over the shared `~/.claude/projects` tree. This is the
  read-side analog of `path-guard.js`; it gets a hermetic test like the path-guard.
- **Explicit pull, never silent injection** — archival content enters only on an
  ask; the index advertises *what exists* (each entry's L0 line **is keyed by its
  `key`**, so the agent always has the exact string to pass to `recall`), not the
  content.
- **Provenance on every recall** — returns the value **plus a trace** (source ids,
  when produced, which session/run); surfaced in the dashboard.
- **Real deletes** — retiring a memory entry removes it; no ghost re-injection.
- **Bounded** — one entry per call, token-capped, so over-pulling can't re-bloat.

**Reliability is measured, not gated** (§13): an L2 eval scenario plants a fact in
archival memory and a task that needs it, and checks the answer used it. This is a
**record-only scorecard, not a merge gate** (the eval tier never blocks PRs) — it
*reports* a tunable recall-rate (raise prefetch-K, promote an entry to `core`, or
strengthen the prompt if it dips); it does not *guarantee* the property.

## 7. Per-agent session manifest

The structured **document layer** over raw JSONL — what "session document
management" means here. One manifest per agent (e.g. `.agent-mesh/sessions/index.json`,
under the framework state dir so it is change-detection-excluded), each entry:

```jsonc
{
  "id": "<session-uuid>",
  "task_label": "string|null",     // derived post-hoc (§9); null until distilled
  "l0": "one-line summary",         // generated at rotate/distill
  "status": "active" | "archived",
  "origin": "cli" | "worker:<route>" | "peer:<caller>" | "dashboard",
  "headroom_pct": 0-100,
  "produced_memory_keys": ["..."],  // quick-memory entries this session yielded
  "produced_workflows": ["..."],     // workflow drafts (≥0; one Absorb can yield several)
  "run_ids": ["..."],
  "updated_at": "iso8601"
}
```

The dashboard reads the manifest for the task-session **list / navigation /
resume-proposals**; absorption updates it. Raw JSONL is L2; the manifest is L0/L1.
Built from artifacts already present (provenance events, run records, transcript
tails) — no new telemetry. **On first read for an existing agent the manifest is
backfilled** from the present transcripts/run records (a `task_label: null`,
`status: archived` entry per past session, L0 generated lazily/at next Absorb), so
migration doesn't lose history; thereafter it is forward-maintained. L0 generation
for backfilled entries is **bounded by the §9 per-Absorb spawn cap** (lazy, in
windows) so a long-lived agent's first read isn't an unbounded digest run.

## 8. Structured quick memory

Replaces the prose `learned.md` blob with `memory/quick.json` — structured,
indexed, hard-capped:

```jsonc
{
  "<key>": { "l0": "one-line", "l1": "overview", "value": "full (L2)",
             "core": true|false,           // §5: in always-resident core memory?
             "valid_from": "iso8601", "valid_to": "iso8601|null",  // §10 bi-temporal
             "provenance": { "session_id": "...", "run_id": "...", "at": "..." },
             "status": "active" | "pending" | "retired" }
}
```

Hard caps: entry count + per-field length, **plus a separate tighter cap on
`core: true` entries** (core is always in context — §5). Runtime injects the
`{key → l0}` index for all active entries + the L1 of `core` entries; non-core
`value` (L2) is pulled via `recall` (§6). `decisions.md`-style index stays a
complementary view; `learned.md` migrates into this (decision 2). Bi-temporal
`valid_from`/`valid_to` (Zep pattern) let a superseded fact be marked expired
without deletion, feeding drift-watch (§10).

## 9. Absorption & retirement (manual, review-gated)

**Trigger:** manual — the user clicks **Absorb** on an agent in the dashboard (no
auto/scheduled run in v1). The framework runs the digest engine over that agent's
accumulated **task-sessions + run records**.

**Repetition detection (workflow candidacy)** — two signals must agree:
- **task-text similarity** — cluster the `task` fields across the agent's run
  records. Zero-dep: a cheap token-overlap / normalized pre-filter, then the
  ask-only worker confirms a cluster (semantic judgment via `claude`, no new dep).
- **artifact-diff pattern** — recurring `files_changed` shapes/paths across runs.
- Both hit ⇒ high-confidence **recurring-task cluster** ⇒ a **workflow draft**
  (steps = the common tool sequence; parameters = intra-cluster differences). A
  single signal ⇒ memory candidate only, not workflow-worthy.

**Distill split** (ask-only worker → fail-closed JSON → framework writes):
- stable facts/decisions ⇒ proposed `quick.json` entries (`status: pending`);
- recurring clusters ⇒ proposed workflow drafts under `deliverables/digests/`.
- **Fail-closed contract:** the worker's output is parsed like `parseResultEnvelope`
  — any malformed/unparseable/over-cap field ⇒ **zero proposals, zero writes**, a
  plain error surfaced in the dashboard (failure is data). Never partial.
- **Cost bound:** a hard cap on `claude` spawns per Absorb click (the input is
  "accumulated sessions + run records," which can be large); over-cap ⇒ process a
  bounded window and report what was skipped.

**Promotion (review-first), framework-direct writes that self-enforce the root.**
The dashboard shows a **diff view** of proposed entries + workflow drafts; on the
user's approval the **framework** (not a `do` spawn — so it must self-enforce the
boundary the path-guard would) writes them. **The model never supplies a path.**
The framework computes every target from a fixed prefix —
`<root>/memory/quick.json`, `<root>/workflows/<slug>.md` — where `<slug>` is the
model's *label* run through a sanitizer that **rejects any separator / `..` /
absolute path** (a model-chosen `produced_workflow` of `../../other-agent/evil`
must be refused, not written). Writes are hard-capped (count + length) and atomic.
Rejected ⇒ discarded. Nothing read-as-data is ever auto-executed.

**Concurrency & write safety.** Absorption can run while a live session holds the
same folder. So: (a) promotion writes to `quick.json`/`workflows/` take a
**per-agent write lock** (reuse the `SerialQueue` discipline — at most one
mutator per folder); (b) `quick.json` is **read-once** at session-open / prefetch
time (like AGENT.md is read once at server start), so a mid-session write never
shifts the running session's memory — it applies from the next session/generation;
(c) an Absorb requested while a `do` worker holds the folder **queues** behind it.

**Headless agents must still compound (the volume case).** Most mesh sessions are
headless worker/peer — there is no human to click Absorb on them directly. They are
**not** stranded: every headless session is recorded in that agent's manifest (§7),
and when a human **Absorbs that agent** in the dashboard, absorption runs over its
**accumulated worker/peer + cli sessions together**. So a frequently-delegated
worker agent compounds whenever someone reviews it. (Fully unattended agents that
no human ever Absorbs do not compound in v1 — that is the explicit trigger for
moving **auto/scheduled absorption** from §14 "future" to a fast-follow once the
review flow is trusted.)

**Retire:** the distilled session is marked `archived` in the manifest — no longer
injected, still preserved/resumable. *Retire ≠ delete.* The compounding loop: a
retired session's knowledge now lives at L0/L2 in the structure layer, so the next
same-kind task opens a **fresh** lean session that reuses it — instead of resuming
a long stale session and re-bloating.

## 10. Drift watch (bi-temporal)

Combine `agentmemory`'s `MemoryDriftWatcher` with Zep's bi-temporal validity:
- track entries' usage/recency over a sliding window — **counting both verb
  `recall`s and framework prefetch injections** (§6) as usage events; otherwise a
  prefetched-into-prompt entry (the headless path, never `recall`ed via the verb)
  would look perpetually "unused" and get proposed for retirement — exactly
  backwards for the high-volume entries;
- when a new absorbed fact **supersedes** an older one (same key/topic, conflicting
  value), set the old entry's `valid_to` (mark expired) rather than deleting it —
  history is preserved, but only `valid_to: null` entries are injected/recalled;
- when an entry goes stale (long unused) or self-contradictory, **propose**
  (review-first) "re-absorb or retire."

> **`expired` ≠ `retired`.** A superseded fact is *expired* (`valid_to` set) — kept
> for history, never injected/recalled. A *retired* entry (§6) is a **hard real
> delete**. Supersession preserves; retirement removes.

A health signal that keeps the structure layer from rotting and prevents stale
facts from being silently recalled — never an automatic edit (promotion/retirement
is user-approved, §9).

## 11. Natural CLI integration

No change to how a user starts `claude`. The existing wiring carries the new layer:
- `buildAgentRuntimePrompt` injects the **L0 index** (memory keys + workflow names +
  active task-session one-liners) instead of full memory bodies;
- the framework MCP config adds the **read-only `recall`/`load_*` verbs** (§6);
- the dashboard reads the **manifest** (§7) to render the task-session list and
  **propose** the exact `--resume <id>` / `--session-id <new>` command to copy.

So plain `claude` in an agent folder is mesh-aware with **zero session juggling**:
lean by default, knowledge one pull away, history one click away — and the user
never hand-manages UUIDs.

## 12. Observable artifacts (mostly already present)

| Artifact | Source | New? |
|---|---|---|
| raw transcripts (L2) | `~/.claude/projects/<enc>/…/<uuid>.jsonl` | exists |
| provenance events / run records | session-provenance store, `runs-*.jsonl` | exists |
| headroom | `usageFromTail` / `occupancyFromUsage` | exists |
| `memory/quick.json` (structured quick memory) | this spec | **new** |
| `.agent-mesh/sessions/index.json` (manifest) | this spec | **new** |
| `recall` / `load_*` read-only MCP verbs | this spec (framework MCP) | **new** |

## 13. Testing the harness itself (hermetic, `npm test`)

Pure, stubbed-`claude`:
- manifest builder: from synthetic provenance/run records → expected entries
  (task_label null until distilled; status transitions; produced_* links);
- **core/archival split**: `buildAgentRuntimePrompt` injects **only core memory**
  (L0 index for all active + L1 of `core` entries); assert non-core L2 bodies are
  **absent**, and that `valid_to != null` (expired) entries are excluded;
- **headless prefetch logic** (pure): given a task + a synthetic index, the
  top-K-by-lexical-similarity selection is deterministic and token-budget-bounded;
  weak match falls back to core + top-K L1;
- `recall`/`load_*`: returns value + provenance trace; one entry per call,
  token-capped; a retired entry is a real delete (not recallable);
- absorption math: repetition detection fires only when **both** signals agree
  (task-text cluster + artifact-diff); single-signal ⇒ memory-only; the
  ask-only-worker confirmation is faked deterministically;
- review gate: proposals are `pending`/draft until an explicit approve; reject
  discards with zero writes;
- drift watch: a superseding fact sets the old entry's `valid_to` (bi-temporal),
  never deletes; a stale/contradictory entry proposes (never auto-edits).

- **read-side confinement** (mirrors path-guard): `recall`/`load_workflow`/
  `load_session` refuse (as data) any `key`/`name`/`id` resolving outside
  `realpath(AGENT_MESH_ROOT)`, and `load_session` refuses ids absent from the
  agent's own manifest — its own dedicated test, like the path-guard tests.

**Recall reliability is its own L2 eval scenario** (real `claude`, the eval tier):
plant a fact in archival memory + a task that needs it → probe the answer used it
→ a tunable recall-rate (record-only; the eval tier never gates merges). The
model's judgment (clustering, L0/L1 generation, whether-to-pull) lives in the eval
tier; the *plumbing* (prefetch selection, injection shape, caps, confinement,
provenance) is hermetic here. **No fixture/scenario may depend on first-turn
`recall`/`load_*` tool visibility** (CLAUDE.md MCP-init-race lesson): phrase
recall-eval tasks functionally and only after a beat of work; the headless
reliability path is prefetch-into-prompt, not a turn-1 tool call.

## 14. Limitations & future work

- **Zero-dep similarity is lexical**, not semantic, in the pre-filter; semantic
  judgment costs one `claude` call per absorption (accepted). A future optional
  embedding backend could improve clustering.
- **Single-host.** Cross-machine manifest/session sync is backlog #9 (the Agent
  SDK `SessionStore` adapter is the natural seam).
- **Directory-recursive retrieval** (OpenViking) over many memory entries is a v2
  refinement once `quick.json` grows large.
- **Auto/scheduled absorption** is deliberately out of v1 (manual only); could be a
  later opt-in once the review flow is trusted.

## 15. Decisions (resolved after research + adversarial review)

> **Review log.** Round 1 adversarial review (independent agent, Codex CLI being
> unavailable in this env) found 3 blockers — F1 recall verbs can't use the
> ask-only readOnly marker (`do` drops it) → §6 framework-owned server; F2 missing
> read-side root confinement → §6/§13 invariant + test; F8 "inject only core"
> silently regresses the current eager `memory/*.md` injection → §5 cutover — plus
> majors F3/F4/F6/F9/F11/F12/F14/F15, all folded in above.
> **Round 2 (independent re-review): `VERDICT: CONVERGED`** — all 3 blockers + 8
> majors verified RESOLVED against the actual code (`mesh-mcp.js` mode-gate + bridge
> assembly, `delegate-invocation.js` both-mode allowlist, `agent-context.js`
> eager-injection baseline + roster data-fence, `hooks/path-guard.js` read-side
> mirror); no new blocker/major. 4 minors (M1 expired≠retired, M2 recall key in
> index, M3 backfill cost bound, M4 `produced_workflows` array) folded in too.

1. **Manifest location** — `.agent-mesh/sessions/index.json` (state-dir,
   change-detection-excluded). *Resolved.*
2. **`quick.json` is the source of truth**; `learned.md` migrates into it (one-time
   migration; `learned.md` kept read-only for back-compat). *Resolved.*
3. **Separate, explicit recall verbs** (`recall`/`load_workflow`/`load_session`) —
   clearer allowlisting + provenance per kind. *Resolved.*
4. **Defer** the post-first-turn "pull related task's knowledge" nicety (§4) to v2;
   v1 ships open-new-by-default + manual resume + the §6 prefetch/pull. *Resolved.*
5. **Drift-watch v1 = usage/staleness + bi-temporal supersession** (§10); a
   recall-*score* signal waits until a retrieval score exists. *Resolved.*

Still open (need a real-data pass before fixing):
6. **Core-memory caps** — how many `core` entries / token budget before quality
   degrades. Tune from the recall-reliability eval (§13), not guessed up front.
7. **Headless prefetch match** — lexical default (zero-cost). *De-risked by the F6
   fix:* prefetch is now **additive** (recall stays exposed) and core carries
   essentials, so lexical mis-selection no longer strands a worker. An optional one
   `claude` call for semantic match stays a measured add-on (turn it on only if the
   §13 recall eval shows lexical miss-rate is poor) — not a per-delegation default
   tax. Effectively resolved; the eval sets the threshold.
