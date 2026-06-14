# Dashboard-native Claude Session — Design

## 1. Goal

Let the operator **drive a real `claude` session for an agent from the dashboard
chat pane**, with its output rendered richly in the browser — assistant markdown,
tool-call cards, peer-delegation cards, and (post-MVP) approve/deny **permission
cards**. You type in the dashboard; the mesh runs `claude` headlessly under the
agent's folder and streams the result back.

This is a third way to reach an agent, alongside (a) the ask-only "talk" console
(brokers a restricted `claude -p` and shows only the final text) and (b) the
native iTerm entry point (launches `claude` in the operator's own terminal — see
[2026-06-06-native-cli-entrypoint-design.md](2026-06-06-native-cli-entrypoint-design.md)).
The new surface differs from the talk console by being a **persistent,
session-resumed conversation rendered as a live event stream**; from the iTerm
entry point by being **in-dashboard** rather than a terminal.

Two hard requirements shaped the design:

- **One canonical session per agent, shared across every entry point.** The
  dashboard chat and the iTerm launch resume *the same* session id, so context
  continues no matter where you drive it from. (User requirement.) *Delivery is
  phased — see §6 and §10: the MVP establishes the canonical id + cross-process
  lease on the dashboard side; the iTerm launch joins that same session in
  Increment 3.*
- **No PTY / no `xterm.js` / no in-browser shell.** We use `claude`'s headless
  stream-json output, not a terminal emulator. Zero new runtime dependencies.
  (User decision; reaffirms the native-CLI non-goal.)

**Off by default**, behind the existing `--allow-shell` gate.

## 2. Model & key decisions

- **Render model — rich web chat via session-resume (not raw terminal).** The
  dashboard renders the conversation as **structured markdown + tool/delegation
  cards**, parsed from `claude --output-format stream-json` NDJSON. `xterm.js`
  (raw ANSI) and a re-rendered markdown view are mutually exclusive; the user
  chose rich web rendering. (User decision.)
- **MVP is message-level streaming.** The MVP renders one card per completed
  assistant/tool event (turn-granular), not intra-message token deltas. Live
  token/tool-input deltas require `--include-partial-messages` (with `--verbose`)
  and a `stream_event`/`content_block_*` parser; that is **post-MVP polish**, not
  Increment 1. (Addresses R1/MINOR.)
- **MVP enforces ask-only with the *same* controls as `delegate.js`, not just
  MCP scoping.** `--strict-mcp-config` only governs MCP servers; it does **not**
  disable built-in `Bash`/`Edit`/`Write` or user/project settings & hooks. So the
  MVP turn is built through the **shared** ask-mode invocation logic extracted
  from `delegate.js`: `--tools Read,Glob,Grep,LS` (`READ_TOOLS`), `--mcp-config`
  + `--strict-mcp-config`, `--allowedTools mcp__<server>…` for the injected
  servers, `--settings <mesh-built>` **and** `--setting-sources ""` (so user/
  project/local settings & hooks never load). This is genuine read-only
  enforcement, identical to the brokered ask worker. (Addresses R1/BLOCKER-1.)
- **Dashboard drives the session headlessly; iTerm joins the same session.** With
  session-resume the dashboard needs no PTY. (User decision.)
- **One canonical session id per agent, set deterministically.** Stored at the
  dashboard-controlled path `~/.agent-mesh/sessions/<meshHash>/<agentKey>.json` =
  `{ sessionId, updatedAt }`, where `<meshHash>` derives from the canonical mesh
  root and `<agentKey>` from the canonical agent root. This lives in the
  operator's home, **outside every agent/mesh root** — so it is reachable by no
  agent's confined writes even when a manifest declares root `"."` (= the mesh
  root) or another path that would contain a `meshRoot/.agent-mesh` (R2/MAJOR-4;
  see §7). Under the lease: if no record exists, the mesh
  **generates the uuid up front**, writes the record, and spawns with
  `--session-id <uuid>` (creating that exact session); every later turn — and the
  iTerm launch — spawns with `--resume <uuid>`. Deterministic id means even a
  first-ever iTerm launch has a defined way to populate the record (it follows
  the same "no record → generate + `--session-id`" rule). (User requirement;
  addresses R1/MAJOR-4.)
- **Single-active lease — the answer to "open the same agent twice".** Two live
  `claude --resume <same id>` processes will fork/corrupt the one transcript
  (Claude Code has no multi-writer support). So the canonical session is
  **single-active**, guarded by a lease file
  `~/.agent-mesh/sessions/<meshHash>/<agentKey>.lock`, with the canonical schema
  `{ token, owner, state, pid, startedAt, procStartedAt, updatedAt }` (same
  home-rooted, outside-all-roots location). `state` is `'launching'` (provisional,
  written by the dashboard before the wrapper registers) or `'running'` (written
  by the self-registering `session-exec` wrapper — see §6). `pid`/`procStartedAt`
  identify the **wrapper**; once it spawns `claude`, the wrapper also records the
  **resumer** `childPid`/`childProcStartedAt`/`childPgid` — the process that
  actually writes the transcript and the terminal node for liveness (§6). `procStartedAt` is the holder process's OS
  start-time (the PID-reuse discriminator); `startedAt` is when the lease was
  taken; `updatedAt` is the diagnostic heartbeat. Liveness rules are in §6. A second open that finds a
  **live** lease is **refused** (`session_busy`, carrying who holds it + since
  when); the operator can **force-takeover**, which is handled differently for a
  dashboard-owned vs an external (iTerm) holder (§6) so it can never produce two
  live resumers. (User decision: refuse + explicit takeover.)
- **Process model — one short-lived `claude` per turn (per-message resume).**
  Each turn: acquire the lease → spawn `claude` (one-shot `-p` in the MVP) →
  stream events → on exit release the lease and reap the process tree. A dashboard
  headless turn therefore holds the lease **only while that turn runs**, so
  successive dashboard turns hand the one canonical session back and forth
  cleanly. The iTerm/native process is **persistent** and holds the lease for its
  **entire CLI session until exit** (it is not a per-turn holder); while it holds
  the lease the dashboard shows `session_busy_external` and resumes the shared
  session only after the terminal exits. So "shared canonical session" means *one
  holder drives at a time, with context preserved across handoffs* — **not**
  simultaneous turn-level interleave with a live terminal. A persistent dashboard
  child (instead of per-turn) would needlessly hold the lease the whole time the
  view is open; per-turn keeps the dashboard a cooperative holder. (User decision,
  Fork A.)
- **Permission posture — full-native + permission cards is post-MVP and
  spike-gated; the MVP is ask-only.** The eventual target is full tools with each
  tool-permission request shown as an approve/deny card. **This `claude` build has
  no `--permission-prompt-tool`** (only `--permission-mode`), so the *only*
  mechanism for per-tool cards is the **stream-json input control protocol**
  (`--input-format stream-json`, in-band `control_request`/`control_response`, as
  the Agent SDK uses) — which is **not a documented CLI contract**. Therefore
  Increment 2 is **gated behind a blocking spike** that proves this protocol on
  the pinned `claude`; if it cannot be proven, the fallback is a **non-writing**
  `--permission-mode` preset (`plan`, or `default` which blocks writes with no
  approver) **without** per-tool cards — **never** `acceptEdits`/
  `bypassPermissions`, which would be silent dashboard auto-approval (§11 forbids
  it) — and write work is deferred to the iTerm native session. The **MVP
  (ask-only) needs none of
  this** — read tools raise no permission requests — so the MVP carries zero
  dependency on the unproven protocol. (Addresses R1/MAJOR-2 + the CLI reality.)
- **Reuses the unified mesh claude config & env.** MCP surface from the shared
  [`assembleMcpServers`](../../../src/mesh-mcp.js); env via `buildBridgeEnv` after
  `enterCallContext` so onward `delegate_to_peer` is cycle/depth-safe. MVP uses
  `mode: 'ask'`; the full build `mode: 'native'`. One source of truth.
- **Gated + authed like every privileged route.** Disabled unless `--allow-shell`
  / `AGENT_MESH_DASHBOARD_SHELL=1`; same capability cookie + same-origin/host-port
  auth + manifest membership + containment; gate-before-side-effect ordering.
- **Board stays status-only.** All session content renders in the **chat pane**
  only; the activity board keeps showing status/phase with no task/output text.

## 3. The turn (what actually runs)

For agent `library` at `<meshRoot>/library`, one **MVP (ask-only)** turn, built
by the shared invocation logic:

```
# cwd = <meshRoot>/library ; env = threaded mesh env (buildClaudeEnv ask)
claude -p "<operator message>" \
  --session-id <uuid>            # first turn only; --resume <uuid> thereafter \
  --output-format stream-json --verbose \
  --append-system-prompt <agent runtime prompt>  # buildAgentRuntimePrompt(root,'ask',{meshRoot}) \
  --tools Read,Glob,Grep,LS \
  --strict-mcp-config --mcp-config <tmp>/session-mcp.json \
  --allowedTools mcp__agentmesh_peerbridge,…  # injected servers only \
  --settings <tmp>/settings.json --setting-sources ""
```

- **Session id is set under the lease** (§2): no record → generate uuid, persist,
  `--session-id <uuid>`; else `--resume <uuid>`. `session_id` from the stream's
  init event is asserted to equal the record (consistency check), not used as the
  source of truth.
- `<tmp>/session-mcp.json` = `assembleMcpServers({ agentRoot, meshRoot, mode:
  'ask', includeAgentLocal: true })` — agent `.mcp.json` (readOnly-marked only) +
  mesh-global + peer bridge; `agentmesh_*` dropped from author sources first.
- **Tools** are locked exactly as the ask worker: `--tools READ_TOOLS`,
  `--allowedTools mcp__*`. No `Bash`/`Write`/`Edit`. (R1/BLOCKER-1.)
- **Identity parity (R2/MAJOR-1).** The turn includes the same
  `--append-system-prompt` payload the ask worker uses —
  `buildAgentRuntimePrompt(root, 'ask', { meshRoot })` (system → memory →
  workflows → mode prompt → skill summaries) — so the dashboard session genuinely
  *is* that agent, not a bare claude. `buildAskInvocation` emits the **full**
  delegate ask argv; argv parity with `delegate.js` is asserted.
- **Settings: the worker's sanitized merge, stated precisely (R2/MAJOR-2).** The
  turn passes `--setting-sources ""` (native user/project/local loading off) plus
  a mesh-built `--settings` file from `settings-merge.js` — the **same** path the
  brokered ask worker uses. That merge *does* carry forward author settings under
  the existing allowlist/sanitization (e.g. `enabledPlugins`, allowlisted
  `permissions`/`env`, the trusted-plugin rule). So the dashboard ask session's
  settings trust surface is **identical to the brokered ask worker — no broader,
  no narrower** (not "nothing loads"). This is the deliberate one-logic/fidelity
  choice; a stricter dashboard-only builder that drops plugin/settings inheritance
  is noted as future hardening, not MVP.
- **Env is threaded** — `buildClaudeEnv` + `buildBridgeEnv(entered.env, env)`
  after `enterCallContext(canonicalAgentRoot, env, DEFAULT_DEPTH)`, so onward
  A→B→A rejects as `cycle` and depth is bounded, exactly as the worker path.
- The dashboard launches this **through the `session-exec` wrapper** (the per-turn
  lease owner; §6), not by spawning `claude` directly. Spawned `detached: true`;
  on exit/timeout the process **tree** is killed (`kill(-pid)`) and the wrapper
  releases the lease, mirroring the worker timeout discipline.
- **MVP streaming is message-level** (no `--include-partial-messages`).

Increment 2 swaps `-p "<msg>"` for `--input-format stream-json` (writing the
single turn as a stream-json message) **iff** the control-protocol spike passes,
and switches to `mode: 'native'`.

## 4. Components

| Module | Responsibility | Purity |
|---|---|---|
| `src/dashboard/session-events.js` | **new.** `parseEventLine(line)` → `{ type: 'init'\|'text'\|'tool_use'\|'tool_result'\|'permission_request'\|'turn_done'\|'error'\|'raw', seq, … }` from a stream-json NDJSON line; tolerant — unknown/malformed → `raw`, never throws. `redactSessionEvent(ev)` (**new contract**, §7) scrubs secrets + size-caps. | **pure** |
| `src/dashboard/session-lease.js` | **new.** Pure `evaluateLease(existing, { now, self: { pid, procStartedAt }, force, launchGraceMs })` → `{ action: 'acquire'\|'busy'\|'reclaim'\|'takeover-kill'\|'takeover-refuse' }`. `running` leases: reclaim by pid-dead/`procStartedAt`-reuse only (not age). `launching` leases: busy unless dashboard pid dead **and** `launchGraceMs` elapsed (startup grace, not a liveness TTL). `updatedAt` is UI-only. Thin fs `acquire`/`registerRunning`/`release`/`read` (exclusive `wx`, token-checked). Rules in §6. | mixed |
| `src/dashboard/session-store.js` | **new.** `readSessionId/writeSessionId` over `~/.agent-mesh/sessions/<meshHash>/<agentKey>.json` (home-rooted, outside all agent/mesh roots); `meshHash`/`agentKey` = canonical-root hashes (stable, filesystem-safe). | shell |
| `src/dashboard/session-runner.js` | **new.** `runTurn({ agentName, message, force }, sink, io)` — acquire in-memory lock + write provisional `launching` lease → resolve/create canonical id → build invocation via the shared ask-mode builder → spawn the **`session-exec` wrapper** (injectable) → parse the wrapper's stdout NDJSON via `session-events` → `redactSessionEvent` → push to the per-agent SSE hub with a monotonic `seq` → on end/timeout/crash reap tree (the wrapper releases the lease; runner clears the in-memory lock). `stop()` = kill wrapper tree → wait → terminal event. (Inc 2) permission control. | shell |
| `bin` `session-exec` subcommand (in `src/cli.js`) | **new.** The per-turn lease owner: as its **first action** atomically rewrites the lease to its own `pid`/`procStartedAt` + `state:'running'` (same `token`), then spawns `claude` with the passed argv (stdout passthrough), and on `claude` exit token-checked-releases the lease. Reused by the iTerm launch in Inc 3. | shell |
| `src/delegate-invocation.js` | **new (refactor).** Extract from `delegate.js`: `buildAskInvocation` (full ask argv incl. `--append-system-prompt` via `buildAgentRuntimePrompt`, tools, mcp, allowlist, settings), `buildClaudeEnv`, `createClaudeSettings`, `writeMcpConfig`. `delegate.js` and `session-runner.js` both call it — one ask-mode enforcement (tools + identity + settings), no drift. | shell |
| `src/dashboard/server.js` (extend) | `GET /api/agent/:name/session/stream` (EventSource; per-agent channel; replay via `Last-Event-ID`); `POST /api/agent/:name/session/message { text, force? }` → gates → starts a turn → `202 { turnId }` (events arrive on the open SSE); `POST …/session/stop`. `sessionEnabled` on `/api/mesh`. All gates **before** lease/spawn/fs. | shell |
| `src/dashboard/public/{app.js,app.css,index.html}` (extend) | A **"Native session"** view in the chat pane: opens the SSE on mount, posts messages, renders streamed cards (markdown / tool_use / tool_result / peer-delegation / (Inc 2) permission), a status chip, and a `session_busy`→take-over affordance. | asset |
| `src/cli.js` | reuse existing `dashboard … --allow-shell`. (Optional bonus verb deferred to §10/4.) | shell |

The iTerm launch (`src/dashboard/shell.js`) gains, **in Increment 3**, the same
lease wrapper + canonical-id resolution (`--session-id`/`--resume`) so it joins
the one session. The MVP designs the lease/store as cross-process files at a
dashboard-controlled path precisely so iTerm can adopt them unchanged.

## 5. Data flow (one turn)

```
browser  (view mounts) → GET /session/stream            // EventSource opens FIRST
browser  POST /session/message {text}
  → gates (allowShell, auth, membership, containment)    // before any side effect
  → in-memory lock + write `launching` lease             // 409 session_busy if live-held (no force)
  → resolve canonical id (create+persist if absent)
  → buildAskInvocation (+ env, settings, mcp)            // shared with delegate.js
  → spawn session-exec wrapper                            // wrapper self-registers `running` lease,
       → claude -p [--session-id|--resume] --output-format stream-json   //   then spawns claude
  → 202 { turnId }                                        // POST returns immediately
  → for each wrapper stdout line: parseEventLine → redactSessionEvent
       → hub.push(agentKey, { seq, turnId, ...ev })       // delivered on the OPEN SSE
  → on end/timeout/crash: wrapper releases lease, runner reaps tree, hub.push turn_done|error
browser  renders each SSE event as a card, keyed by seq (ordered, replayable)
```

**Single transport, no ambiguity (R1/MAJOR-5):** the browser subscribes to the
SSE channel *before* posting; `POST` never streams the body — it only starts the
turn and returns `{ turnId }`. Events carry a per-agent monotonic `seq`; the hub
keeps a bounded ring buffer per agent so a late/reconnecting subscriber replays
from `Last-Event-ID`. A turn whose subscriber drops mid-stream still completes
server-side (lease released); the buffer lets the client catch up on reconnect.

## 6. Concurrency & the canonical session

- **Canonical id:** the home-rooted `sessions/<meshHash>/<agentKey>.json` record
  holds the one id per agent; created deterministically on first turn
  (`--session-id`), resumed forever after, shared by dashboard + iTerm.
- **Lease liveness — pid + proven-identity, never heartbeat-guesswork
  (R1/BLOCKER-2 + R2/MAJOR-5 + R3/MAJOR-1):** the reclaim decision turns on whether
  the recorded process *still exists as the same process*, proven by **the
  holder's OS start-time vs the lease `procStartedAt`**, not by heartbeat
  staleness (a stalled
  heartbeat must **not** license reclaiming a still-running process — that could
  create two live resumers). A "process matches" iff its **OS start-time equals
  the recorded `*ProcStartedAt`** (proves it is not a reused PID); start-time
  newer → reused PID; start-time indeterminate → conservatively treated as a
  match (busy). The decision considers **both** the wrapper (`pid`/`procStartedAt`)
  **and** the resumer (`childPid`/`childProcStartedAt`) — because the `claude`
  child is the actual transcript writer and can outlive a crashed wrapper
  (R8/MAJOR):
  - Either the wrapper **or** the resumer child is **alive-and-matching** →
    **busy**. (Dead wrapper + live child is still busy — no reclaim.)
  - **Both dead or proven-reused** → **reclaim**.
  - **Takeover** of a busy *dashboard-owned* lease (`force`, `token` tracked
    here): **kill the resumer's process group (`childPgid`) and wait**, then
    reclaim. An *external/iTerm* holder is **refused** until closed — never
    auto-reclaimed while alive.
  `updatedAt` heartbeat is UI/diagnostic only; `release` succeeds only with the
  matching `token`.
- **The lease owner is a self-registering per-turn wrapper, so the liveness pid
  always equals a process that wraps the live resumer (R4/MAJOR-3 + R6/MAJOR +
  R7/MAJOR).** The danger across rounds was a *gap* in which the on-disk lease
  pointed at a process (the dashboard) that could die while the real `claude`
  resumer lived. We close it by making the process that owns the resumer also own
  the lease, and register itself **before** running `claude`:
  - The dashboard **never** spawns `claude` directly. It spawns a thin per-turn
    **`session-exec` wrapper** (a `bin/agent-mesh.js` subcommand) whose lifetime
    *is* the turn. The wrapper's **first action** (before it spawns `claude`) is to
    atomically write the lease with its **own** `pid`/`procStartedAt`, `token`, and
    `state:'running'`; it then spawns `claude` **in its own process group** and
    atomically records the resumer `childPid`/`childProcStartedAt`/`childPgid`;
    it streams stdout to the dashboard and, on `claude` exit,
    token-checked-releases the lease. **If the wrapper crashes while `claude`
    survives**, §6 liveness keeps the lease **busy on the live child** (not
    reclaimed), and an owned takeover kills the `childPgid` — so no second
    `--resume` can start. A dashboard crash cannot orphan the lease either way.
  - **Pre-registration window.** Between the dashboard's in-memory acquire and the
    wrapper's first write, the dashboard writes a provisional lease
    `state:'launching'` with its **own** pid. A `'launching'` lease is **busy**;
    it is reclaimable only if its (dashboard) pid is dead **and** a bounded
    `LAUNCH_GRACE_MS` has elapsed (the wrapper failed to start → no resumer
    exists). This is a startup grace, not a liveness TTL — once `'running'`,
    reclaim is pid+`procStartedAt` only (§6 liveness), never age.
  - **Authoritative-in-MVP note.** In the MVP the dashboard is the *only* launcher,
    so its in-memory lock already prevents a double-launch; the wrapper +
    `'launching'` grace make the on-disk lease crash-safe for the second writer
    (the iTerm session) that arrives in Inc 3, where the same wrapper/`--resume`
    path is reused.
  `owner` (`'dashboard'`|`'iterm'`) drives takeover classification (owned vs
  external); a spawn failure releases the lease.
- **Open twice → refuse + explicit takeover (R1/MAJOR-3):**
  - *Dashboard-owned holder* (`owner:'dashboard'`, token tracked here): `force`
    **kills the resumer process group (`childPgid`) and waits for exit**, then
    reclaims — only one resumer ever lives, even if the wrapper already died.
  - *External / iTerm holder* (a process we do not own): `force` **refuses**
    (`session_busy_external`) with "close it in the terminal first", and rechecks
    on retry. We never silently let two `claude --resume <same id>` run, and we
    never reclaim a live external holder.
  - *Dead, or proven PID-reuse, holder*: auto-reclaimed (per §6 liveness).
    *Start-time-indeterminate* holders remain **busy** regardless of heartbeat age
    (R4/MAJOR-2).
- **Turn serialization:** one in-flight turn per agent (the lease is the
  mechanism); a second concurrent message returns `session_busy`.

## 7. Security

- **Disabled by default** — every `/session/*` route → `403 shell_disabled`
  unless `allowShell`. Default dashboard stays read-only + ask-only console.
- **MVP carries no new write authority.** Ask-only is enforced by `--tools
  READ_TOOLS` + `--allowedTools mcp__*` + mesh `--settings` + `--setting-sources
  ""` (no Bash/Write/Edit, no author hooks) — identical to the brokered worker
  (R1/BLOCKER-1). The full-native build (Inc 2) is the sanctioned escape hatch,
  with per-tool consent cards (spike permitting) and the same `--allow-shell`
  gate as the iTerm entry point.
- **No new exec/network surface beyond spawning `claude`.** No PTY, no in-browser
  shell, no arbitrary command — only `claude` with the assembled argv, in
  `cwd=agentRoot`. Same auth + containment (`isPathInsideRoot`, marker-validated
  manifest membership) as every route.
- **Rendered content is scrubbed — a recursive, allowlisted contract
  (R1/MAJOR-6 + R2/MAJOR-3).** This repo has no `redactText`; the dashboard's
  existing redaction is *structural* (it omits fields). So we add
  `redactSessionEvent(ev)` with an explicit contract: it first **allowlists which
  fields of each event type are rendered at all** (e.g. for `tool_use`: name +
  redacted input; for `init`: model/cwd, never raw env), then **recurses over
  every rendered string field** — `text`, `tool_use.input` (and nested values),
  `tool_result`, `permission_request` payloads, `error.message`, and `raw` — and
  on each: (1) size-caps (`… N more lines`); (2) scrubs secret-shaped substrings
  (key/token patterns, `.env`-style `KEY=value`). No event type bypasses the
  scrubber; unknown/`raw` events are capped + scrubbed by default. Read-tool
  output (file contents) **is** rendered — the point of an ask session — but
  always through the scrubber. **Trust model:** the session is the operator's own,
  on a cookie-authed localhost origin, so this is **defense-in-depth, not a hard
  boundary**; documented as such. Tested with adversarial secrets planted in
  `tool_use.input`, `permission_request`, `error`, and `init` events.
- **Coordination state lives outside *every* agent/mesh root (R1/MAJOR-8 +
  R2/MAJOR-4).** `session.json`/`session.lock` are under
  `~/.agent-mesh/sessions/<meshHash>/`, in the operator's home — **not** under any
  `agentRoot` or `meshRoot`. This holds even when a manifest declares an agent
  root of `"."` (the mesh root) or any path that would otherwise contain a
  `meshRoot/.agent-mesh` dir, which the earlier "under meshRoot" placement did not
  survive. The ask worker (writes confined to `agentRoot`) therefore cannot touch
  coordination state. For dashboard turns the **authoritative lease is the
  dashboard's in-memory lock**; the on-disk lease only coordinates with the
  separate iTerm process. **Residual boundary (documented):** a full-native Inc-2
  session has `Bash` and *could* still tamper with files in the operator's home —
  but the operator already granted that session full tools, so this is within the
  existing native-session trust model, not a new escalation. Future hardening: an
  OS-level lock / dashboard lock service. The lease `token` makes `release` safe
  against a stale-reclaimed-then-returning holder.
- **Args, not interpolation.** `claude` is spawned with an argv array; the
  operator message and paths are never concatenated into shell syntax.
- **Gate-before-side-effect.** Every gate runs before lease acquisition, any fs
  write, or any spawn (asserted with injected `spawn`/fs spies).
- **No bridge-shadow risk (strict config).** `--strict-mcp-config` loads only the
  generated `session-mcp.json`, so no external `agentmesh_*` can shadow the
  bridge; `assembleMcpServers` already drops `agentmesh_*` from author sources.

## 8. Error handling (failure-as-data)

- `allowShell` off → `403 { error: { code: 'shell_disabled' } }`.
- Unknown agent / containment fail → `404` / `403` (reused checks).
- Live lease, no `force` → `409 { error: { code: 'session_busy', owner,
  startedAt } }`; external holder + `force` → `409 { code:
  'session_busy_external' }`.
- `claude` spawn fails → SSE `error` `{ code: 'spawn_failed', message }`; lease
  released.
- Turn exceeds `AGENT_MESH_TIMEOUT_MS` → SSE `error` `{ code: 'timeout' }` +
  partial transcript; process tree killed; lease released.
- Malformed/unknown stream-json line → `raw` event, never fatal.
- init `session_id` ≠ stored id → SSE `error` `{ code: 'session_mismatch' }` +
  abort (guards against a forked transcript).
- (Inc 2) control-protocol spike failed → permission features disabled with a
  documented banner; never a silent auto-approve.
- POST returns `{ turnId }` immediately; turn lifecycle (`init` → … →
  `turn_done`/`error`) streams over SSE — the request never blocks on the turn.
- `stop` is **kill process tree → wait for exit → token-checked release →** emit a
  terminal `turn_done`/`error` event (R3/MAJOR-2). It never releases the lease
  while the child may still be alive, so a new turn cannot start against a
  not-yet-dead resumer.

## 9. Testing (hermetic)

- **`session-events` (pure):** each event type from canned NDJSON → normalized
  shape with `seq`; malformed JSON / unknown `type` → `raw` (never throws);
  partial lines buffered. **`redactSessionEvent` (R2/MAJOR-3):** secrets planted
  in `text`, `tool_use.input` (incl. nested), `tool_result`, `permission_request`,
  `error.message`, `init`, and `raw` are **all** scrubbed + size-capped; only
  allowlisted fields render; no event type bypasses the scrubber.
- **`session-lease` (pure core + injected pid/start-time probe):** `evaluateLease`
  — free→acquire; dead pid→reclaim; **live pid + start-time newer than lease
  (reused PID)→reclaim** (R3/MAJOR-1); **live pid + matching start-time→busy**
  (and stale heartbeat alone does **not** reclaim it); start-time
  indeterminate→busy; force+owned(token match, matching start-time)→
  `takeover-kill`; force+external→`takeover-refuse`; release only with matching
  token. No real files.
- **shared ask-mode invocation (R1/BLOCKER-1 + R2/MAJOR-1/2):** `buildAskInvocation`
  emits the **full** delegate ask argv — `--tools READ_TOOLS`, `--allowedTools
  mcp__*`, `--append-system-prompt <buildAgentRuntimePrompt>`, `--settings`,
  `--setting-sources ""`, `--strict-mcp-config`; **no** `WRITE_TOOLS`, **no**
  `Bash`; an adversarial agent `.mcp.json`/settings/hook cannot widen the tool
  set. **Argv + settings parity with `delegate.js` ask path asserted** (same
  builder → same identity prompt + same sanitized settings merge).
- **`session-runner` (injected spawn/io):** fake `claude` emitting canned
  stream-json → ordered events; first turn generates+persists id and passes
  `--session-id`, later turns `--resume <id>`; `session_id` mismatch → abort;
  crash → `error` + lease released; timeout → tree kill + `error` + lease
  released; live lease → `session_busy` **without spawning**. **Self-registering
  wrapper (R4/MAJOR-3 + R6/MAJOR + R7/MAJOR):** runner writes a `launching` lease
  then spawns the `session-exec` wrapper, which **self-registers** `state:'running'`
  + its own pid/procStartedAt before spawning `claude`, releasing on exit. Tests:
  a `launching` lease is busy and reclaimable only when the dashboard pid is dead
  **and** `LAUNCH_GRACE_MS` elapsed; a `running` lease whose **wrapper pid stays
  alive across a simulated dashboard crash is not reclaimed**; **a dead wrapper +
  live resumer `childPid` is also not reclaimed** (R8/MAJOR), reclaiming only once
  **both** wrapper and child are dead/reused; an owned takeover **kills the
  `childPgid` and waits**; spawn failure releases.
- **transport (R1/MAJOR-5):** subscriber attached before POST receives every
  event in `seq` order; a reconnect with `Last-Event-ID` replays the gap; POST
  returns `{ turnId }` without streaming its body.
- **Endpoints:** disabled→403; missing cookie / cross-origin / unknown agent /
  containment → rejected with **no spawn / no fs write**; `session_busy`→409 with
  owner; external-force→409; **`stop` kills the tree, waits, then releases (a new
  turn is rejected until exit is confirmed)** (R3/MAJOR-2); `sessionEnabled` in
  `/api/mesh`.
- **canonical-session sharing:** two sequential turns resume the same id; (Inc 3)
  the iTerm launch plan carries the same `--resume <id>` + lease wrapper.
- **coordination location (R2/MAJOR-4):** `session.json`/`session.lock` resolve
  under `~/.agent-mesh/sessions/<meshHash>/`, never inside `agentRoot`/`meshRoot`,
  including the adversarial case of a manifest agent root `"."` (= mesh root); the
  store/lease paths are asserted outside every declared agent root.
- **Frontend (light):** view hidden when `sessionEnabled` false; events render as
  the right cards; `session_busy` shows the take-over affordance.
- **Opt-in e2e (`AGENT_MESH_E2E=1`):** a real ask-only `claude` turn through
  `runTurn` renders init→text→turn_done; a second turn continues the same
  session; a read of a secret-shaped fixture is scrubbed in the rendered event.

## 10. Build increments

1. **MVP — ask-only single-turn + canonical session + lease (dashboard side).**
   - Refactor: extract `src/delegate-invocation.js` (ask-mode builder, env,
     settings, mcp) from `delegate.js`; keep `delegate.js` behavior identical
     (re-run its tests).
   - `session-events.js` (parser + `redactSessionEvent`), `session-lease.js`
     (pid + start-time liveness rules), `session-store.js` (canonical id under
     `~/.agent-mesh/sessions/<meshHash>/`, outside all agent/mesh roots).
   - `session-exec` wrapper subcommand (self-registers the `running` lease, then
     spawns `claude`, releases on exit) + `session-runner.runTurn` (ask mode via
     the shared builder; `--session-id`/`--resume`; `launching`→`running` lease;
     spawn injectable; per-agent SSE hub with `seq`+replay; reap).
   - `GET /session/stream` + `POST /session/message` (202+turnId) + `POST
     /session/stop` + `sessionEnabled`; gated, gate-before-side-effect.
   - Chat-pane "Native session" view: SSE-on-mount, input, streamed markdown/
     tool/delegation cards, status chip, `session_busy`/take-over affordance.
   - Full hermetic tests (§9). **Approval gate: demo the MVP before Inc 2+.**
2. **Permission-protocol spike → full-native + permission cards.** *First*, a
   blocking spike proving the stream-json input control protocol
   (`--input-format stream-json`, in-band `control_request`/`control_response`)
   on the pinned `claude`. **If it passes:** `mode: 'native'`, switch the turn to
   stream-json input, render `permission_request` as allow/deny/allow-for-session
   cards, `POST /session/permission`. **If it fails:** ship behind a **non-writing**
   `--permission-mode` (`plan`/`default`, never `acceptEdits`/`bypassPermissions`) and document that write-with-
   consent lives in the iTerm session; revisit when the CLI gains a permission
   hook. No silent auto-approve either way.
3. **iTerm joins the canonical session.** `shell.js` launch gains the lease
   wrapper + `--session-id`/`--resume`; "open twice" (terminal ↔ dashboard)
   honors one single-active lease end to end. Delivers the cross-entry-point half
   of the canonical-session requirement.
4. **Polish.** `--include-partial-messages` token/tool-input deltas (live
   typing), idle/abandoned-turn reap, take-over UX, session history/reset,
   optional `agent-mesh session` CLI verb, e2e extension.

## 11. Non-goals (v1 / MVP)

- No embedded web terminal / PTY / `xterm.js` (rich web rendering instead).
- No multi-session tabs — exactly one canonical session per agent.
- No attach-by-discovery; the *single canonical* id is shared by construction
  (deterministic `--session-id` + shared record), not by scanning
  `~/.claude/projects`.
- No auto-approve / `--dangerously-skip-permissions`; writes are human-consented
  (cards, spike permitting) or absent (MVP ask-only).
- No intra-message token streaming in the MVP (message-level only; deltas in
  Inc 4).
- No change to the brokered-delegation invariants (no-Bash-in-`do`, path-guard,
  single writable root). Those govern *delegated* execution; this is the
  operator's own gated session, like the iTerm entry point.
- Board remains status-only; no session content on the board.

## Review log

- **R0 (draft):** initial design.
- **R1 (codex; 2 BLOCKER / 6 MAJOR / 1 MINOR — all accepted):**
  - BLOCKER-1 (ask-only enforced only via MCP scoping) → reuse `delegate.js`
    ask-mode controls (`--tools READ_TOOLS`, `--allowedTools mcp__*`,
    `--settings` + `--setting-sources ""`) via a shared extracted
    `delegate-invocation.js`; adversarial tests (§2/§3/§7/§9/§10).
  - BLOCKER-2 (TTL reclaim ignored live pid) → reclaim is decided by pid liveness
    + `procStartedAt` (dead or proven PID-reuse → reclaim; live-matching → busy;
    indeterminate → busy), **not** by age; `updatedAt` heartbeat is diagnostic
    only. *(Refined through R3/R4/R5; this is the final rule.)* (§6/§9).
  - MAJOR-3 (force takeover allowed two live resumers) → owned holder
    kill-tree+wait; external holder refuse-until-closed (§6).
  - MAJOR-4 (iTerm sharing deferred vs requirement; first-launch id undefined) →
    deterministic mesh-generated `--session-id` + shared record so any entry
    point can populate it; MVP scope narrowed to dashboard side, iTerm join in
    Inc 3, stated honestly (§1/§2/§6/§10).
  - MAJOR-5 (dual/ambiguous transport) → single transport: SSE subscribe-first,
    POST returns `{ turnId }`, monotonic `seq` + ring-buffer replay via
    `Last-Event-ID` (§4/§5/§8/§9).
  - MAJOR-6 (`redactText` assumed; free-text leakage) → defined
    `redactSessionEvent` contract (cap + secret-scrub + raw), localhost
    defense-in-depth trust model, adversarial tests (§4/§7/§9).
  - MAJOR-7 (in-band permission speculative) → **CLI reality:** this `claude` has
    no `--permission-prompt-tool`; per-tool cards require the stream-json input
    control protocol; Inc 2 gated behind a proving spike with a `--permission-
    mode` fallback (§2/§10).
  - MAJOR-8 (coordination files editable by full-native claude) → moved outside
    the agent folder; in-memory authoritative lease; documented residual trust
    boundary (§2/§4/§6/§7). *(Location further hardened in R2/MAJOR-4 to
    `~/.agent-mesh/sessions/<meshHash>/`, outside every agent/mesh root — that is
    the authoritative path; this entry's interim `meshRoot` location is
    superseded.)*
  - MINOR (missing `--include-partial-messages`) → MVP is message-level
    streaming; token deltas deferred to Inc 4 (§2/§3/§10).
- **R2 (codex; 5 MAJOR — all accepted):**
  - MAJOR-1 (shared invocation omitted agent identity prompt) →
    `buildAskInvocation` emits the full delegate ask argv incl.
    `--append-system-prompt` via `buildAgentRuntimePrompt`; argv parity tested
    (§3/§4/§9).
  - MAJOR-2 (overstated "settings never load") → corrected: the turn reuses the
    worker's sanitized allowlist settings merge (`--settings` + `--setting-sources
    ""`); trust surface stated as **identical to the brokered ask worker**, not
    "nothing loads"; stricter dashboard-only builder noted as future hardening
    (§2/§7).
  - MAJOR-3 (redaction left tool_use/permission/error/init leak paths) →
    `redactSessionEvent` is recursive over **every** rendered string field with
    per-type field allowlisting; adversarial tests across all event types
    (§7/§9).
  - MAJOR-4 (`meshRoot/.agent-mesh` not guaranteed outside agent folder; manifest
    root `"."`) → coordination moved to `~/.agent-mesh/sessions/<meshHash>/`
    outside every agent/mesh root; path-location test incl. root `"."` (§2/§4/§6/
    §7/§9).
  - MAJOR-5 ("live pid busy forever" ignores PID reuse) → liveness proven by
    process **start-time vs lease** (reused pid → reclaim; matching → busy),
    refined further in R3; identity `{token,owner,pid,startedAt,procStartedAt,
    updatedAt}` (§6/§9).
- **R3 (codex; 2 MAJOR / 2 MINOR — all accepted):**
  - MAJOR-1 (stale-heartbeat reclaim of a live pid could still double-resume) →
    reclaim a live pid **only** when process start-time proves PID reuse;
    otherwise busy (owned→kill+wait on force; external→refuse); heartbeat is
    diagnostic only (§6/§9).
  - MAJOR-2 (`stop` under-specified) → `stop` = kill tree → wait for exit →
    token-checked release → terminal event; a new turn is blocked until exit is
    confirmed (§4/§8/§9).
  - MINOR (stale "under meshRoot" in §10) → §10 + review log now say
    `~/.agent-mesh/sessions/<meshHash>/` (§10).
  - MINOR (`acceptEdits` in the failed-spike fallback reads as auto-approval) →
    fallback constrained to non-writing presets (`plan`/`default`), never
    `acceptEdits`/`bypassPermissions`; write work → iTerm (§2/§10/§11).
- **R4 (codex; 3 MAJOR / 1 MINOR — all accepted, all consistency cleanups from
  the R1–R3 edits):**
  - MAJOR-1 (iTerm "turn-granular interleave" claim contradicted external-refuse)
    → narrowed: dashboard turns hold the lease per turn; the persistent iTerm
    process holds it for its whole session (dashboard shows
    `session_busy_external`); "shared session" = one holder at a time with context
    preserved across handoffs, not live interleave (§2/§6/§10).
  - MAJOR-2 (stale "Dead/indeterminate-stale → reclaimed" bullet) → corrected to
    "dead or proven-PID-reuse → reclaim; indeterminate → busy regardless of
    heartbeat" (§6).
  - MAJOR-3 (no holder identity before the child pid exists) → the lease records
    the **coordinating** process identity (`owner:'dashboard'` + dashboard
    pid/start-time) at acquire — no pre-spawn pending window; spawn failure
    releases; test added (§6/§9).
  - MINOR (R1 log still showed `meshRoot` path) → marked superseded by
    R2/MAJOR-4's `~/.agent-mesh/...` location (review log).
- **R5 (codex; 1 MAJOR / 1 MINOR — accepted, final consistency pass):**
  - MAJOR (lease contract inconsistent across §2/§4/§6/§9) → canonical schema
    `{ token, owner, pid, startedAt, procStartedAt, updatedAt }`; OS start-time
    compared only to `procStartedAt`; `ttlMs` removed from `evaluateLease`
    (reclaim is pid+procStartedAt, never age; `updatedAt` UI-only) (§2/§4/§6/§9).
  - MINOR (R1/BLOCKER-2 log line still mentioned TTL reclaim) → rewritten to the
    final pid+`procStartedAt` rule (review log).
- **R6 (codex; 1 MAJOR — accepted):**
  - MAJOR (lease tracked the dashboard coordinator pid, but the detached `claude`
    child can outlive a dashboard crash → false reclaim → double-resume) → the
    lease liveness identity is written as the dashboard at acquire (no empty
    window) then **atomically transitioned to the child `claude`
    pid/procStartedAt** right after spawn, so a surviving child keeps the lease
    busy until it actually exits; no second resumer is ever started (§6/§9).
- **R7 (codex; 1 MAJOR — accepted):**
  - MAJOR (TOCTOU gap between detached spawn and the parent's lease rewrite) →
    replaced "parent rewrites the lease" with a **self-registering `session-exec`
    wrapper**: the wrapper owns the lease for the turn and writes its own
    pid/`procStartedAt` (`state:'running'`) *before* spawning `claude`; the
    pre-registration window is a provisional `state:'launching'` lease bounded by
    `LAUNCH_GRACE_MS`. The lease's liveness pid therefore always wraps the live
    resumer, closing the crash window (§2/§4/§6/§9).
- **R8 (codex; 1 MAJOR — accepted):**
  - MAJOR (wrapper dies but its `claude` child survives → wrapper-pid-dead reclaim
    → double-resume) → the lease also records the resumer
    `childPid`/`childProcStartedAt`/`childPgid`; liveness is **busy if the wrapper
    *or* the child is alive-and-matching**, reclaim only when **both** are
    dead/reused; owned takeover **kills the `childPgid` and waits**. The `claude`
    resumer is the terminal transcript-writer, so this closes the class (no
    further child layer writes the session) (§2/§6/§9).
