# Multi-turn Peer Sessions (caller-named, persistent B→C) — Design

## 1. Goal

Let a **worker** hold a **multi-turn conversation** with a peer over onward
delegation. Today every `delegate_to_peer` is a stateless one-shot: the peer
bridge ([src/a2a/peer-bridge.js](../../../src/a2a/peer-bridge.js)) opens an A2A
client, sends one `SendMessage`, and **closes the client in a `finally`**
([peer-bridge.js:89-118](../../../src/a2a/peer-bridge.js#L89)) — so the peer's
`serve-a2a` process is torn down after every call. The peer's delegate runs a
**fresh** `claude -p` with no `--session-id`/`--resume`
([src/delegate-invocation.js](../../../src/delegate-invocation.js)). When worker
**B** asks peer **C** a series of related questions, C forgets each time.

This spec makes the **B→C path conversational and persistent**: repeated
`delegate_to_peer` calls from B to C continue **one** `claude` session on C —
named by the **calling agent** ("`from:B`") — that **survives C's per-call
teardown** because the session identity is **deterministic** and resume is driven
by the **on-disk transcript**, not by any in-memory state. The peer still runs
each turn to completion; there is no mid-task pause.

## 2. Scope & non-goals

**In scope (v1):**
- Caller-driven follow-ups: B sends several messages; C resumes the same thread.
- **Auto-continue per caller** — all B→C calls land on C's `from:B` thread; D's
  on `from:D`. One thread per *(caller agent, peer)*, **persistent on disk**.
- A `new_conversation` escape hatch to start a fresh thread.
- **Ask-only.** The bridge is ask-only in v1 (refuses non-`ask` with
  `mode_disabled` before any spawn); multi-turn inherits that. `do`-mode
  multi-turn is **out of scope**.

**Non-goals (explicit):**
- **No `input-required` loop** (peer pausing to ask the caller for input) —
  headless `claude -p` runs to completion. Future spec.
- **No custom compaction engine** — rely on Claude Code auto-compaction (§4).
- **No per-session concurrency lock in v1** — concurrent delegations from *two
  simultaneous runs of the same agent to the same peer on the same key* may race
  on the shared transcript; documented as a limitation (§8), not solved here.
- **No change to the dashboard console path** beyond it benefiting if it later
  stamps `agentmesh/caller`.

## 3. The session-identity model

### 3.1 What each agent holds

A served agent **C** accumulates a small, human-meaningful, **persistent** set of
`claude` sessions in its own project folder (`~/.claude/projects/<C-encoded>/`):

```
C's sessions:
  self        ← the human session started via ⌘ Open in Claude CLI (UNCHANGED — session-runner path)
  from:B      ← B's persistent conversation with C
  from:D      ← D's persistent conversation with C
```

`self` is untouched (C's existing dashboard/native-CLI session,
[src/dashboard/session-runner.js](../../../src/dashboard/session-runner.js)). The
`from:<caller>` sessions are additional session UUIDs in the same folder; because
they're keyed deterministically (§3.2), C resumes the right one even after the
per-call teardown — and across separate worker runs ("C remembers B").

### 3.2 Deterministic session id (the key insight)

C does **not** keep an in-memory map. Each turn, C computes the session id
deterministically from the **conversation key** carried on the message:

```
sessionId = uuidv5(conversationKey, namespace = uuidv5(encodeProjectDir(realpath(C.root)), URL))
```

- `uuidv5` is a deterministic (name, namespace) → UUID hash; Node has no built-in
  v5, so a tiny helper (`sha1` of namespace-bytes + name, with the v5 version/
  variant bits set) lives in a new `src/a2a/session-id.js`. It always yields a
  valid `claude` session UUID.
- **The namespace input is `encodeProjectDir(realpath(C.root))`, NOT the raw
  `realpath` (R-review fix).** The transcript lookup (`resolveTranscript`) already
  reduces C.root through `encodeProjectDir`, whose Windows fallback is
  **case-insensitive**. Deriving the id from the *same* reduced, case-normalized
  form guarantees the id and the transcript path agree on identity — otherwise
  drive-letter/casing drift across the per-call spawns (`C:\…` vs `c:\…`) would
  hash to two different UUIDs and silently fork the `from:B` thread.
- Namespacing on the encoded root means the same caller name maps to **different**
  ids in different peers — no cross-peer collision.

### 3.3 Resume is driven by the transcript (stateless on C)

Per turn, C decides `--session-id` vs `--resume` via a small wrapper around the
existing helper (which **returns the path and throws `not_found`** — it is *not* a
boolean, R-review fix):

```
async transcriptExists(root, id):
  try { await resolveTranscript(root, id); return true } catch (e) { if e.code==='not_found' return false; throw }

resume = await transcriptExists(C.root, sessionId)
  resume  → claude -p <task> … --resume <sessionId>
  else    → claude -p <task> … --session-id <sessionId>
```

**Resume-failure self-heal (R-review fix):** the deterministic key is permanent
but its transcript is not — the dashboard can `deleteSession()` it, compaction can
error, or a concurrent process can unlink it. If a `--resume` turn comes back as a
resume/`not_found` failure (claude exits non-zero with a session-not-found/resume
error), the delegate **retries once as a fresh `--session-id <sessionId>`** for the
same key, so a deleted/broken thread re-seeds itself instead of erroring on every
future call. (A genuine task error is still returned as data; only resume-load
failures trigger the re-seed.)

`resolveTranscript` / `encodeProjectDir` already exist in
[src/dashboard/session-index.js](../../../src/dashboard/session-index.js) (and are
now Windows-safe). They are moved/re-exported into a shared module (§5.2) so the
A2A delegate path can use them without importing dashboard code (boundary hygiene).
**No in-memory state, survives C restarts and per-call teardown.**

### 3.4 Conversation key, the epoch, & the reset escape hatch

The key is `caller:epoch`, where **`epoch` is a small per-caller counter that C
persists on disk** (default `0`) — *not* bridge-process memory.

- **Auto-continue:** for a given caller the epoch is stable, so
  `conversationKey = caller:epoch` is stable → the same persistent `from:B`
  thread for every B→C call, **this run and future runs**.
- **`new_conversation: true`** (optional `delegate_to_peer` arg) → C **increments
  and persists** `epoch[caller]` *before* deriving the id, so the key advances to
  `caller:epoch+1` → a new deterministic id → a fresh transcript. Because the
  epoch is on disk, **the reset is durable across worker runs** (a later run reads
  the bumped epoch and does NOT fall back to the old thread). The previous
  transcript stays on disk but is no longer the active key. This is also the
  **manual compaction reset** (§4).

**Why on C, not the bridge (Codex R3 fix):** an in-memory nonce in the bridge
only survives one worker run, so a reset done to escape a stale/over-compacted
thread would silently revert next run (the default key would resume the abandoned
transcript). Persisting the epoch on C — the agent that owns the session — makes
reset durable while keeping C otherwise stateless (the id is still purely derived
from `caller:epoch`). The epoch store is a tiny framework-owned file
(`peer-epochs.json` under the agent's session-provenance dir, written by the
`serve-a2a` process — **not** by the ask worker, so the read-only-tools / path-guard
model is untouched).

### 3.5 Caller identity is authentic (anti-spoof)

The bridge runs **inside B's folder** (`root` = B's canonical path) and derives
B's name once. **The name is the mesh-unique manifest name, not a non-existent
`agent.json` field (R-review fix):** the bridge already has `AGENT_MESH_MESH_ROOT`
/ `AGENT_MESH_MESH_CEILING` in its env, so it reads the mesh's `mesh.json`, finds
the agent entry whose `realpath(root)` equals the bridge's own root, and uses that
entry's `name` — the value `manifest.js` already enforces **unique**. **If the
mesh manifest cannot be resolved** (env missing/unreadable, or no entry's
`realpath(root)` matches the bridge's), the onward delegation is **REFUSED**
(`delegate_to_peer` returns a `status:refused` Task, `reason:
caller_identity_unresolved`) rather than fall back to a possibly-colliding
`basename` key — **Decision 2/B: a silent caller-thread collision is worse than a
loud refusal in the rare misconfigured-mesh case.** It stamps `agentmesh/caller` on
every message. **The model never supplies the caller name** — it is not a
`delegate_to_peer` argument — so B's `claude` cannot forge a caller to read/poison
another agent's `from:X` thread. (Consistent with the "model-facing surface is
exactly `{mode, task}`" invariant; `new_conversation` is the only added
model-facing arg and it cannot name another caller. The *cross-process* trust
boundary — a different mesh process asserting a caller — is addressed in §9.)

## 4. Session compaction management

Each `from:<caller>` thread grows toward the context window.

- **Primary: Claude Code built-in auto-compaction.** Verified against the docs:
  it **applies in headless `-p` mode including under `--resume`** — "clears older
  tool outputs first, then summarizes." The mesh implements **no** compaction.
- **Constraints:** `/compact` is interactive-only (no headless trigger); no
  CLI/env knob to tune/disable in `-p`; no context-fill signal (`claude -p`
  reports only this-invocation cost); compaction is lossy ("detailed instructions
  from early … may be lost"), and a pathological huge tool output makes claude
  "stop auto-compacting … and show an error."
- **Posture:** rely on auto-compaction; **observability** = stamp an *approximate*
  thread-size hint into `agentmesh/metrics.turn` — the `user_text` event count
  (reuse `session-index.derivePreview`'s counting; **not** raw line count). **It is
  explicitly an estimate, not an exact turn counter (R-review fix):**
  `derivePreview` byte-caps its scan at 2 MB (reports `turnsApprox`), and
  auto-compaction can *shrink* the `user_text` count, so the number is
  non-monotonic and under-reports on exactly the long threads it watches. We
  surface it (plus `turnsApprox`) as a rough "this thread is large" signal, and do
  **not** key any control logic on it. **Manual reset only** via
  `new_conversation` — **no automatic max-turns rotation** (per the chosen
  rely-on-auto-compact decision). Threads are **best-effort context**, not
  guaranteed recall; a caller needing a constraint preserved should restate it. A
  pathological compaction error surfaces as a `status:error` Task (§8).

## 5. Components & changes

### 5.1 New: `src/a2a/session-id.js`
- `deriveSessionId(conversationKey, agentRoot) → uuid` (uuidv5, §3.2). Pure,
  unit-testable, zero deps.
- `readEpoch(agentRoot, caller) → int` / `persistEpoch(agentRoot, caller, n)` —
  the per-caller epoch store (§3.4). **Per-caller, atomically written (R-review
  fix):** one small file **per caller** (`peer-epochs/<sha-of-caller>`), written
  **temp-file + atomic rename**, not a single shared JSON. Rationale: a torn write
  of a *shared* file would parse-fail and reset **every** caller's epoch to 0 —
  silently reverting all durable resets (the R3 bug, reintroduced). Per-caller
  atomic files bound any corruption to a single caller and make a partial write
  impossible to observe. **There is NO process-level lock serializing this** — the
  earlier "per-folder lock" claim was wrong: `ask` turns are unqueued
  ([stdio-server.js:305](../../../src/a2a/stdio-server.js#L305)) and each turn is a
  separate short-lived C process, so nothing serializes concurrent resets across
  processes (the residual same-agent-concurrent-run race, §8). Read failure → `0`
  for **that caller only**; a persist failure is **logged** (it is load-bearing for
  durable reset — not silently swallowed like the dashboard label).

### 5.2 Shared transcript helpers
- Move `encodeProjectDir` + `resolveTranscript` (+ `countLines`) out of
  `session-index.js` into a shared `src/session-transcripts.js`; re-export from
  `session-index.js` for back-compat. The A2A path and the dashboard then share
  one Windows-safe implementation.

### 5.3 Peer bridge — B side ([src/a2a/peer-bridge.js](../../../src/a2a/peer-bridge.js))
- Resolve `callerName` once (§3.5). **No epoch/nonce state on B** — C owns it.
- `delegate_to_peer` gains optional `new_conversation: boolean`; stamp
  `agentmesh/caller`, and `agentmesh/reset_conversation: true` when set.
  `{peer, mode, task}` unchanged; `caller` is not a model arg.

### 5.4 A2A server — C side ([src/a2a/stdio-server.js](../../../src/a2a/stdio-server.js))
- Read `agentmesh/caller` (fallback `"_anon"`) and `agentmesh/reset_conversation`.
- `epoch = readEpoch(root, caller)` (default `0`); if `reset_conversation` →
  `epoch++` and `persistEpoch(root, caller, epoch)` (durable reset, §3.4).
- `conversationKey = `${caller}:${epoch}``;
  `sessionId = deriveSessionId(conversationKey, root)`;
  `resume = await transcriptExists(root, sessionId)`.
- Pass `session: { id: sessionId, resume }` into `delegateTask`.
- Stamp `agentmesh/metrics.turn` (the §4 estimate) and echo `agentmesh/caller`.
- **Best-effort, never fails the turn:** the `from:<caller>` dashboard label +
  `create` provenance (`source: peer:<caller>`) via the shared session-index.
- **Load-bearing, logged on failure (NOT silently swallowed — R-review fix):** the
  `persistEpoch` after a reset. If it failed, the durable reset would be lost
  (§5.1/§3.4), so the failure is surfaced in the run log even though the turn still
  completes. On epoch-*read* failure, default to `0` for that caller only.

### 5.5 Delegate invocation — C side ([src/delegate.js](../../../src/delegate.js), [src/delegate-invocation.js](../../../src/delegate-invocation.js))
- `delegateTask(...)` accepts optional `session:{id, resume}`.
- **The session args go where the full `claude` argv is assembled, NOT inside
  `buildAskInvocation` (R-review fix).** `buildAskInvocation` returns the args that
  *follow* `claude` and takes no session param. Like `session-runner.js` (which
  builds `['-p', text, ('--resume'|'--session-id'), id, …rest]`), the ask delegate
  path **prepends** `-p <task>` and the `--session-id`/`--resume <id>` pair before
  the `buildAskInvocation` args — so the change point is the delegate's claude-argv
  assembly, not the helper. **Ask path only** (bridge is ask-only). This is also
  where the resume-failure self-heal (§3.3) lives: a resume-load failure re-spawns
  once with `--session-id`.

### 5.6 Protocol ([src/a2a/protocol.js](../../../src/a2a/protocol.js))
- **No change needed beyond confirming pass-through (R-review correction):** the
  C-side handler (§5.4) reads `agentmesh/caller` / `agentmesh/reset_conversation`
  **directly from `message.metadata`**, which `validateMessageSendParams` already
  returns intact; it does not need to surface them specially, and it already
  ignores unknown `agentmesh/*` fields. The returned `Task`'s `contextId`
  (`message.contextId || messageId`) is **unrelated** to the caller key and is not
  used for resume — do not wire resume to `contextId`.

## 6. Wire contract (additions, all under reserved `agentmesh/*`)

| field | direction | set by | meaning |
|---|---|---|---|
| `agentmesh/caller` | request | bridge (authentic) | calling agent's name; thread label, anti-spoof identity, and epoch key |
| `agentmesh/reset_conversation` | request | bridge, when `new_conversation:true` | C bumps + persists the caller's epoch → fresh durable thread |
| `agentmesh/metrics.turn` | response | C | approximate thread-size hint (`user_text` events; non-monotonic, §4) |
| `agentmesh/caller` (echo) | response | C | traceability |

The conversation key `caller:epoch` is **computed on C** from the authentic
`caller` + C's persisted epoch — it is never sent on the wire, so the model cannot
influence it.

## 7. Data / control flow (B→C)

```
B.worker → delegate_to_peer({peer:C, mode:'ask', task, new_conversation?})   [bridge process, B's run]
  bridge: caller='B'; msg.metadata['agentmesh/caller']='B'
          if new_conversation → msg.metadata['agentmesh/reset_conversation']=true
  open client → SendMessage to C  → (client closed in finally, C process ends)   [per-call, UNCHANGED]
    C.serve-a2a:
      epoch = readEpoch(C.root,'B')            // persisted, default 0
      if reset_conversation: epoch++; persistEpoch(C.root,'B',epoch)   // durable reset
      key = 'B:'+epoch
      sid = deriveSessionId(key, C.root)
      resume = transcriptExists(C.root, sid)
      delegateTask(..., session:{id:sid, resume})
        delegate assembles argv: claude -p <task> (resume?--resume:--session-id) sid …buildAskInvocation()
          if resume-LOAD fails → re-spawn once with --session-id sid   (self-heal §3.3)
      stamp metrics.turn (approx); best-effort label 'from:B'; persistEpoch logged-on-fail
  ◀── Task (contextId, agentmesh/caller='B', metrics.turn=N)
next B→C call (any later run): same caller+persisted epoch → same sid → --resume   (durable across runs)
```

## 8. Error handling & concurrency

- **Non-`done` turn** (timeout/error/refused) is **data** (existing contract);
  the deterministic id is unchanged, so the next call still resumes the thread.
- **Pathological compaction error** → `status:error` Task; caller may pass
  `new_conversation:true`.
- **Missing `agentmesh/caller`** → `"_anon"`; never crash. With the bridge this
  can't happen — it **refuses** when it can't resolve a unique caller name
  (Decision 2/B, §3.5). `_anon` only covers a *non-bridge* caller (e.g. an external
  A2A client) that omits the field; such callers share one `_anon` thread,
  acceptable under the single-user/local boundary (§9).
- **Resume-load failure self-heals (R-review fix):** a deleted/compacted-away or
  otherwise unloadable transcript on a `--resume` turn re-spawns once with
  `--session-id <same id>` (§3.3), so the durable key recovers instead of erroring
  on every subsequent call. A genuine *task* error is still returned as data.
- **Concurrency (corrected — Codex R1 + R-review):** the A2A server serializes
  **only `do`** via `doQueue`; **`ask` turns run unqueued**
  ([stdio-server.js:305-308](../../../src/a2a/stdio-server.js#L305)) — and there is
  **no** cross-process lock (each turn is a *separate short-lived C process*, so
  the in-process `doQueue` couldn't serialize them anyway). Because multi-turn is
  ask-only with **per-caller deterministic ids**, different callers never share a
  session, and a single worker's calls are inherently sequential (its `claude`
  issues one tool call at a time). **Residual race — documented, not solved in
  v1:** two *simultaneous runs of the same agent* to the same peer can (a) have two
  `claude --resume` touch one transcript, OR (b) both read epoch `N` and a reset
  loses an increment. The **atomic per-caller epoch write (§5.1)** bounds (b) to a
  single caller (never a global revert), and the limitation is stated plainly:
  *run one instance of an agent at a time, or use `new_conversation`*. A
  cross-process advisory lock keyed on the session id is the future hardening.

## 9. Security / invariants preserved

- **Anti-spoof — scope stated honestly (R-review fix):** `agentmesh/caller` is set
  by the framework bridge from B's real `root`, never by model args (the
  model-facing surface stays `{peer, mode, task, new_conversation}`). This stops
  **B's own `claude`** from forging a caller. It does **not** cryptographically
  authenticate the caller to C — `agentmesh/caller` is a self-asserted metadata
  string, so *any local process that can speak stdio JSON-RPC to C's `serve-a2a`*
  could claim `caller='B'` and read/continue B's thread. That is acceptable **only
  because the mesh is single-user and local**: every such process is already inside
  the same trust boundary as the path-guard and recursion model (PROJECT.md §11
  explicitly scopes out a federated/untrusted-peer profile). Cross-mesh / untrusted
  callers would need real peer authentication — out of scope for v1, and now said
  so plainly rather than implied "authentic."
- **Ask-only, single writable root, recursion bound, path-guard,
  `--strict-mcp-config`, mesh MCP grant rules** — all unchanged. Multi-turn only
  changes which `claude` session a turn resumes.
- **Transcript containment:** `resolveTranscript` already realpath-checks the
  resolved file stays under the agent's project dir (the Windows-separator fix
  from this session); reused as-is.

## 10. Testing (hermetic, stubbed `claude`)

1. **`deriveSessionId`** is deterministic + namespaced: same (key, root) → same
   UUID; different root → different UUID; output is a valid v5 UUID.
2. **C resume decision:** transcript absent → argv has `--session-id <sid>`;
   present → `--resume <sid>` (same sid). (Stub `transcriptExists`.)
3. **Bridge** stamps authentic `agentmesh/caller`; `new_conversation:true` sets
   `agentmesh/reset_conversation`; `caller`/reset are framework-set (the model
   cannot set `caller`).
4. **Epoch / durable reset (Codex R3):** default epoch `0` → key `caller:0`; a
   turn with `reset_conversation` bumps + **persists** the epoch to `1` → a new
   sid; a **fresh C process** then reads the persisted epoch `1` and derives the
   SAME new sid — the reset survives per-call teardown and future runs.
   **Auto-continue:** two calls at the same epoch derive the same sid → the second
   resumes. **Isolation:** B vs D derive different sids.
5. **Turn count** in `agentmesh/metrics`; `from:<caller>` label written
   best-effort (label failure does not fail the turn).
6. **Invariant:** a `do`-mode onward call is still refused (unchanged).
7. **Casing-safe id (R-review):** `deriveSessionId` over `C:\…` and `c:\…` (same
   realpath, different drive-letter case) yields the **same** UUID — because the
   namespace input is `encodeProjectDir(realpath)`, not the raw string.
8. **Epoch-write failure must NOT revert (R-review):** with `persistEpoch` stubbed
   to fail after a reset, the failure is **logged** and the turn completes, but a
   *corrupt/failed* write of caller B's epoch file leaves **D's** epoch intact (no
   global revert — proves the per-caller atomic store).
9. **Resume self-heal (R-review):** `transcriptExists`→true but the `--resume`
   spawn returns a session-not-found/resume error → the delegate re-spawns once
   with `--session-id <same id>` and succeeds (vs. a genuine task error, which is
   returned as data with no re-spawn).
10. **Caller-name source (Decision 2/B):** with a resolvable mesh manifest the
    bridge stamps the **manifest** name; with the manifest **unresolvable**,
    `delegate_to_peer` returns `status:refused` (`caller_identity_unresolved`) —
    **no** basename fallback. Separately, a *non-bridge* caller that omits
    `agentmesh/caller` resolves to the `_anon` thread on C.
11. **Shared module Windows-safety (R-review):** after moving `resolveTranscript`/
    `encodeProjectDir` to `src/session-transcripts.js`, the Windows separator/
    containment tests still pin its behavior (so a later refactor can't silently
    re-break the fix from this session).

## 11. Decisions (resolved)

- **D1 — Concurrency (§8): SHIP THE CAVEAT.** v1 adds no cross-process lock; the
  "run one instance of an agent at a time" limitation is documented. A
  session-id-keyed advisory file lock is the future hardening.
- **D2 — Caller identity (§3.5): REFUSE, no basename fallback.** The bridge stamps
  the unique mesh-manifest name; if it cannot resolve one, `delegate_to_peer`
  returns `status:refused` (`caller_identity_unresolved`) rather than risk a
  colliding key.
- **D3 — Shared module (§5.2): YES.** Move `resolveTranscript` / `encodeProjectDir`
  (+ `countLines`) into `src/session-transcripts.js`, re-exported from
  `session-index.js` for back-compat.

## 12. Review log

- **R1 (Codex, gpt-5.5):** two findings, both verified true against the code:
  - *[BLOCKER]* the peer bridge closes the client/peer per call
    ([peer-bridge.js:89-118](../../../src/a2a/peer-bridge.js#L89)) → an in-memory
    `Map<caller→session>` on C cannot persist. **Resolved:** pivoted from the
    in-memory map (old Approach A) to **deterministic id + on-disk transcript
    resume** (§3.2-3.3), which survives teardown and adds cross-run persistence.
  - *[MAJOR]* `ask` turns are **not** serialized by `doQueue`
    ([stdio-server.js:305](../../../src/a2a/stdio-server.js#L305)). **Resolved:**
    corrected §8; documented the residual same-agent-concurrent-run race as a v1
    limitation.
  - (R1 codex run was degraded by Windows ConstrainedLanguage shell errors and did
    not emit a clean `VERDICT:` block; findings taken from its final reasoning and
    independently verified against the code.)
- **R2 (Codex):** could NOT complete — three attempts each loaded the spec + A2A
  files and reached "checking remaining high-severity design risks," then dropped
  with an intermittent `403 invalid_workspace_selected` / websocket reconnect
  failure (short auth probes succeed; long review runs do not). No new findings
  obtained. **Not** substituted with self-review-as-Codex.
- **Claude self-review (R2 stand-in, clearly NOT an independent model):** verified
  the two design risks Codex was about to check — (b) the `new_conversation` nonce
  lives in the long-lived **serve-peer-bridge** process (persists across
  `delegate_to_peer` calls), distinct from the per-call client (correct); (a)
  deterministic-id + transcript-existence resume matches `session-runner.js`'s
  `--session-id`/`--resume` choice (correct). Found one imprecision: turn count
  must be `user_text`-event count, **not** raw line count — **fixed** (§4, §5.4,
  §6). Open items remain for the user (§11).
- **R3 (Codex, gpt-5.5, `CHANGES_REQUESTED`):** one MAJOR finding —
  *[MAJOR] §3.4/§4: the `new_conversation` nonce lived in bridge-process memory, so
  a reset only held for the current worker run; a later run fell back to the
  default caller key and resumed the old transcript, undermining durable
  reset/compaction recovery.* **Accepted + fixed:** moved the reset state to a
  **persisted per-caller epoch on C** (`caller:epoch`), so reset durably advances
  the key across runs while C stays deterministic/stateless otherwise (§3.4, §5.1,
  §5.3-5.4, §6, §7, §10). The bridge no longer holds nonce state.
- **R4 (Codex): could NOT run — workspace out of credits.** All five attempts
  errored immediately with "Your workspace is out of credits. Add credits to
  continue" (the earlier intermittent `invalid_workspace_selected` 403s were the
  same billing state surfacing). So the **epoch fix has no independent Codex
  verdict**; a **Claude self-review** judged it sound — durable across runs,
  deterministic (`caller:epoch` derived on C), no model influence, per-folder-lock
  serialized — but that is **not** an independent second model. **Status:
  Codex-reviewed through R3 (all findings fixed); R4 sign-off blocked on credits.**
  - (Loop reliability note: the codex helper must run with stdin redirected from
    `/dev/null` — the bundled `codex-review.sh` does; a hand-rolled retry loop that
    omitted it hung on "Reading additional input from stdin." `medium` reasoning
    effort + a per-attempt timeout + auto-retry on the transient
    `invalid_workspace_selected` 403 produced a clean verdict on the first
    completed attempt.)
- **R5 (independent pass — built-in `/code-review`, Claude, high effort):** run in
  place of the credit-blocked Codex R4. Multi-angle finders surfaced **10 confirmed
  findings**, all verified against the code and **folded in**:
  1. *Caller-name source was fictional* (`agent.json "x-agentmesh".name` doesn't
     exist) → use the unique **manifest** name via the bridge's mesh env (§3.5).
  2. *The "per-folder lock" serializing the epoch was FALSE* (`ask` is unqueued;
     per-call separate processes) → removed the claim; documented the real race
     (§5.1, §8). *(This also refutes the R4 self-review's "per-folder-lock
     serialized" line above.)*
  3. *Non-atomic shared-file epoch write could revert ALL callers* → **per-caller
     atomic** (temp+rename) files; persist failure **logged**, not swallowed (§5.1,
     §5.4).
  4. *Id casing vs lookup mismatch on Windows* → derive the namespace from
     `encodeProjectDir(realpath)`, not raw realpath (§3.2).
  5. *§3.3 used `resolveTranscript` as a boolean* → added a `transcriptExists`
     wrapper (it returns a path / throws `not_found`).
  6. *§5.5 named the wrong function* (`buildAskInvocation` takes no session arg) →
     session args are prepended where the delegate assembles the claude argv (§5.5,
     §7).
  7. *No `--resume` failure fallback* → resume-load failure re-spawns once with
     `--session-id` (§3.3, §8).
  8. *Anti-spoof overstated* → stated the threat model honestly: caller is
     self-asserted, safe only because the mesh is single-user/local (§9).
  9. *`metrics.turn` misleading* (2 MB cap + compaction shrink) → relabeled an
     approximate, non-monotonic hint (§4, §6).
  10. *§5.6 stale + test gaps* → corrected protocol note (§5.6); added tests
      7–11 (§10).
  **Status: independently reviewed (Codex R1+R3 + /code-review R5); all surfaced
  findings fixed.** A fresh Codex `APPROVED` is still pending on workspace credits
  but is no longer the only independent pass.
