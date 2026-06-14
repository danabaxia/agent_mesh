# Native Claude Code CLI Entry Point — Design

## 1. Goal

A second, explicitly **privileged** entry point into an agent: open the **native
interactive `claude` CLI** scoped to a chosen agent's folder, as a **mesh-aware
agent session**. This is distinct from the existing ask-only "talk" console
(which brokers a restricted `claude -p` worker). The native entry point drops the
operator into the *real* Claude Code experience for that agent — full tools, their
own terminal — so they can drive the agent interactively.

The dashboard **launches the operator's own terminal**; it never hosts a shell,
PTY, or I/O proxy. This keeps the zero-dependency invariant (no `node-pty`/
`xterm.js`) and adds no in-browser exec surface. **Off by default.**

## 2. Model & key decisions

- **Launch in the operator's own terminal** (not an embedded web terminal). The
  dashboard writes a temp launch script and asks the OS to open it in a terminal;
  `claude` runs natively there. Zero new deps. (User decision.)
- **Mesh-aware session.** The launch sets the mesh env (`AGENT_MESH_MESH_ROOT`,
  `AGENT_MESH_MESH_CEILING`, `AGENT_MESH_ENABLED_MODES` from the manifest entry)
  and registers the full **mesh-defined MCP surface** for the agent (see below) so
  the interactive session genuinely *is* that agent — including the ability to use
  other mesh agents via the peer bridge. (User decision.)
- **Unified mesh claude configuration — one source of truth (R4/user).** A single
  shared assembler builds the MCP server set the mesh hands to `claude` for an
  agent, used by **both** the brokered worker (`delegate.js`) and the native launch
  (`shell.js`) — "same claude setting logic." It composes:
  1. the agent's own `.mcp.json` servers,
  2. the **mesh-global `mesh/mcp.json`** servers, and
  3. the framework **peer bridge** (`agentmesh_peerbridge`) when the agent has
     marker-validated peers (so the session can `delegate_to_peer`).
  **Mode gates the grant, not the source:** the `ask` worker still gets only
  `readOnly`-marked servers, `do` the empty set; the **native** session (a real
  interactive claude) gets the **full** set. `mesh/mcp.json` is thereby promoted
  from "discovery-only (v1)" to **grantable** under the same `readOnly`/grant rule
  — declaration≠grant still holds.
- **Native MCP wiring.** The native launch passes the assembled set via
  `claude --mcp-config <generated.json>` **without `--strict`**, so the operator's
  own user/global claude config also merges. Peers remain A2A (the bridge verb),
  never per-peer MCP tools.
- **macOS + Windows openers + copy fallback.** macOS `.command` via `open`,
  Windows `.cmd` via `cmd /c start` (prefer `wt` if present). Linux/headless/
  unknown → no spawn, return the command string for the UI to copy. (User decision.)
- **Opt-in gate.** The endpoint is **disabled** unless the dashboard is started
  with `--allow-shell` (or `AGENT_MESH_DASHBOARD_SHELL=1`); the UI shows a confirm
  dialog (with the exact command) before launching. The default dashboard stays
  read-only. (User decision.)
- **Frontend placement: Variant A** — a compact header action **and** a dedicated
  amber "native session" block in the Desk agent panel; the existing ask-only
  console stays teal. Privileged framing is explicit (amber + a one-line warning).
  (User decision.)
- **Bonus CLI verb** `agent-mesh shell <mesh-root> <agent>` reuses the same launch
  builder for a headless path.
- **Plan/launch split (R1/MAJOR-4; refined R2/MAJOR-1).** The confirm dialog shows
  the *exact* command that will run. `POST …/shell/plan` computes the plan
  **including a concrete temp dir path that it generates but does NOT create**
  (random name under `os.tmpdir()`), caches the full plan by a short-lived
  `planId`, and returns `{ planId, command }` (no filesystem side effects). The
  dialog shows `command`. `POST …/shell/launch { planId }` then **creates that
  exact directory exclusively** (`mkdir`, fail-if-exists), writes the files, and
  opens the terminal — so the confirmed command is byte-for-byte the one launched.
  Abandoned plans simply expire from the cache (nothing was created).
- **Literal encoders, not interpolation (R1/BLOCKER-1).** Script generation never
  string-interpolates paths/env into shell syntax. POSIX values are single-quoted
  with `'\''` escaping; `cmd.exe` values use a documented `set`-safe encoding; any
  value containing CR/LF/NUL is **rejected** (`bad_input`). Adversarial path/env
  tests are first-class.
- **Reserved-name preflight (R1/MAJOR-3; broadened R2/MAJOR-2).** Because the
  interactive launch uses `--mcp-config` *without* `--strict`, a same-named server
  from another loaded source could shadow the bridge. The endpoint refuses
  (`reserved_name`) if **any MCP source it can read** declares an `agentmesh_*`
  server: the agent's `.mcp.json`, the **mesh-global `mesh/mcp.json`** (now
  grantable — R4), any project `.mcp.json` from the agent root up to the mesh root,
  and the user config (`~/.claude.json`) when present. Equivalently,
  `assembleMcpServers` drops `agentmesh_*` from every source before adding the
  framework bridge, so neither agent-local nor mesh-global config can squat the
  namespace (R4-followup).
  **Safe-degrade residual:** for any source the dashboard cannot read, the worst
  case is the framework bridge is *shadowed* → onward `delegate_to_peer` is simply
  unavailable in that session (the operator's own config wins). That is a
  capability loss, **not** a privilege escalation — documented, and the bridge tool
  is self-identifying. We do **not** assume merge precedence either way.
- **Threaded call-context env (R1/BLOCKER-2).** The native bridge env is built from
  the **same** `buildBridgeEnv` helper after `enterCallContext(canonicalAgentRoot,
  env, DEFAULT_DEPTH)`, so `AGENT_MESH_MODE=ask` + `AGENT_MESH_PATH`/`DEPTH` are
  present and onward delegation stays cycle/depth-safe (A→B→A → `cycle`).
- **Hardened temp files (R1/MAJOR-5).** Each launch uses a private `mkdtemp`
  directory; script + bridge config are written with **exclusive create** (`wx`),
  POSIX perms `0700` (dir) / `0600` (files); Windows relies on the per-user temp
  ACL (documented).
- **Gate-before-side-effect (R1/MAJOR-6).** Every gate (allowShell, cookie,
  same-origin/host-port, manifest membership, containment, reserved-name) runs
  **before** any file write or spawn; a rejected request writes nothing and spawns
  nothing (tested with injected `writeFile`/`spawn`).

## 3. The launch (what actually runs)

Conceptually, for agent `library` at `<meshRoot>/library`:

```
cd "<meshRoot>/library"
export AGENT_MESH_MESH_ROOT="<meshRoot>/mesh"
export AGENT_MESH_MESH_CEILING="<meshRoot>"
export AGENT_MESH_ENABLED_MODES="ask,do"
exec claude --mcp-config "<tmp>/peer-bridge.json"
```

- `<generated>.json` is the **assembled mesh MCP set** from the shared
  `assembleMcpServers({ agentRoot, meshRoot, mode: 'native' })`: the agent's own
  `.mcp.json` servers + the mesh-global `mesh/mcp.json` servers + the reserved
  `agentmesh_peerbridge` (`node <bin> serve-peer-bridge <agentRoot>`, reusing
  `generateBridgeServerEntry`). The same assembler (with `mode: 'ask'|'do'`) feeds
  the worker — one source of truth. The bridge reads the agent's marker-validated
  `registry.json` for peers, ask-only.
- **Env is threaded, not hand-written.** The exported env is produced by
  `buildBridgeEnv(entered.env, env)` where `entered = enterCallContext(
  canonicalAgentRoot, env, DEFAULT_DEPTH)` — i.e. the same helper the worker uses
  — so `AGENT_MESH_MODE=ask`, `AGENT_MESH_PATH` (seeded with the agent root),
  `AGENT_MESH_DEPTH`, `MESH_ROOT`, `MESH_CEILING` are all present. A native
  A→B→A delegation then rejects as `cycle`, and depth is bounded, exactly as in
  the worker path (R1/BLOCKER-2).
- We do **not** pass `--strict-mcp-config`: this is the operator's interactive
  session, so their normal claude config + the folder's `.mcp.json` apply, with
  the peer bridge **added**. To stop a shadow/spoof, the endpoint **preflights all
  readable MCP sources** (agent `.mcp.json` + **mesh-global `mesh/mcp.json`** +
  project `.mcp.json` up to the mesh root + `~/.claude.json`) and refuses
  `reserved_name` on any `agentmesh_*` declaration; unreadable sources safe-degrade
  to an unavailable bridge, never escalation (R1/MAJOR-3, R2/MAJOR-2, R4).
- `parent_run_id` is not set (an interactive session is the top of a chain).
- **No string interpolation into shell syntax.** Paths/env are emitted via literal
  encoders (POSIX single-quote; `cmd.exe` `set`-safe); CR/LF/NUL → rejected. The
  command string shown in the dialog/copy is the encoded one — what actually runs
  (R1/BLOCKER-1).

## 4. Components

| Module | Responsibility | Purity |
|---|---|---|
| `src/dashboard/shell.js` | **new.** `encodePosix(v)` / `encodeCmd(v)` literal encoders + `assertNoControlChars(v)` (**pure**); `detectOpener(platform, { which })` → `{ kind, hasWt }` (**impure pre-plan probe**, run once before planning); `buildLaunchPlan({ agentRoot, env, bridgeConfigPath, tempDir, platform, opener })` → `{ command, scriptName, scriptBody, openerArgv | null }` (**pure** — `opener`/`tempDir` are inputs, no probing); `writePlanFiles(plan, { mkdir, writeFile })` (exclusive dir + files, 0700/0600) + `openTerminal(plan, { spawn })` (detached, no detection). I/O injectable for tests. | mixed |
| `src/dashboard/server.js` (extend) | `POST /api/agent/:name/shell/plan` → gates + builds plan (NO fs side effects) + caches by short-lived `planId` → `{ planId, command }`. `POST /api/agent/:name/shell/launch { planId }` → re-validates gates, writes temp files, opens terminal → `{ ok, command, opened }`. Both gated by `allowShell` + auth + membership + containment + reserved-name preflight, **all before any side effect**. `shellEnabled` capability surfaced (e.g. in `/api/mesh`). | shell |
| `src/dashboard/public/{app.js,app.css,index.html}` (extend) | Desk: header "⌘ Open in Claude Code" action + amber "native session" block (only when `shellEnabled`); confirm dialog shows the `command` from `/plan`; "Open Terminal" calls `/launch`; copy fallback; toast. | asset |
| `src/cli.js` (extend) | `dashboard … --allow-shell` flag; bonus `shell <mesh-root> <agent>` verb (reuses `buildLaunchPlan` + `writePlanFiles` + `openTerminal`; detects `wt` itself). | shell |
| `src/mesh-mcp.js` | **new (R4).** `assembleMcpServers({ agentRoot, meshRoot, mode })` — the single source of truth: agent `.mcp.json` + `mesh/mcp.json` + peer bridge, gated by `mode` (`ask`→readOnly, `do`→∅, `native`→full). Pure over loaded JSON (thin reads). | mixed |
| `src/delegate.js` (refactor) | extract `generateBridgeServerEntry()` (+ keep `buildBridgeEnv` exported); **route worker MCP assembly through `assembleMcpServers`** so worker + native share one logic (worker now also sees `mesh/mcp.json` servers under the same grant rule). | shell |

## 5. Cross-platform opener

`buildLaunchPlan` switches on `platform` (default `process.platform`):

- **darwin** → script `agent-mesh-shell-XXXX.command`:
  ```sh
  #!/bin/sh
  cd "<agentRoot>"
  export AGENT_MESH_MESH_ROOT="…" …
  exec claude --mcp-config "<bridge.json>"
  ```
  opener `{ cmd: 'open', args: [scriptPath] }` (chmod 0700).
- **win32** → script `launch.cmd`:
  ```bat
  @echo off
  cd /d <encodeCmd agentRoot>
  set <encodeCmd "KEY=value">
  …
  claude --mcp-config <encodeCmd bridge.json>
  ```
  openerArgv `['cmd', '/c', 'start', '', scriptPath]`, or `['wt', '-d', dir, …]`
  when `opener.hasWt`. **`detectOpener` runs once before planning** (impure probe)
  and its result is passed into the pure `buildLaunchPlan` as `opener` — so the
  planned argv is fixed at plan time and `openTerminal` only spawns it
  (R1/MINOR, R2/MINOR).
- **other** → `openerArgv: null` → `/launch` returns `{ ok: false,
  reason: 'unsupported_platform', command }`; the UI shows the copy block.

**Encoders (R1/BLOCKER-1).** `encodePosix(v)` → `'…'` with each `'` rewritten as
`'\''`; `encodeCmd(v)` → a `set`/`cd`-safe quoting that neutralizes `% ! " & | < >
^`. `assertNoControlChars` rejects CR/LF/NUL up front (`bad_input`) since no shell
quoting reliably tames a newline. The generated `command` string uses the same
encoders, so what the dialog shows is what runs.

**Temp files (R1/MAJOR-5; R2/MAJOR-1).** `/plan` generates a concrete dir path
`<os.tmpdir>/agent-mesh-shell-<rand>` (NOT created). `/launch` creates it
**exclusively** (`mkdir`, no `recursive`, EEXIST → `plan_expired`/retry), dir
`0700`; writes `peer-bridge.json` and the script with flag `wx`, perms `0600`; the
script is `chmod 0700` on POSIX so the opener can execute it. On Windows,
isolation relies on the per-user temp ACL (documented assumption). Files are
short-lived; no secrets beyond non-secret mesh env.

## 6. Security

- **Disabled by default.** `POST /api/agent/:name/shell` → `403 shell_disabled`
  unless `allowShell` is set. The default dashboard is unchanged (read-only +
  ask-only console only). Enabling is an explicit operator choice.
- **This is the one sanctioned escape hatch** from the ask-only model: it launches
  a *full-tool* native `claude` (Bash/Write/Edit) with **no path-guard** — by
  design, in the operator's own terminal, under their account. Documented as
  privileged; gated + confirmed in the UI.
- **No new exec/network surface in the dashboard:** no PTY, no in-browser shell,
  no stdin/stdout proxy. The server only writes a temp script and asks the OS to
  open it. The same auth (capability cookie + same-origin/host-port) and
  containment (`isPathInsideRoot`, marker-validated manifest membership) gate the
  endpoint as every other route.
- **No secrets written.** The launch script carries only non-secret mesh env +
  the bridge config path. Script perms `0700`; temp dir per launch.
- **Peer bridge stays ask-only** (the same reserved, marker-validated surface as
  the worker bridge); it does not widen the interactive session's own tools.
- **Mesh-global MCP under the same grant rule (R4).** Promoting `mesh/mcp.json`
  to grantable does **not** loosen the model: declaration≠grant still holds — an
  `ask` worker gets only `readOnly`-marked mesh-global servers (same as for the
  agent's own), `do` gets none. The **native** session gets the full set *because
  it is already a full-tool native claude* (this endpoint's whole, gated premise),
  not because the grant rule changed. Unifying the assembler means the grant rule
  is enforced in exactly one place for both agent-local and mesh-global servers.
- **Gate-before-side-effect (R1/MAJOR-6).** Both endpoints run every gate
  (allowShell → cookie → same-origin/host-port → manifest membership →
  containment → reserved-name preflight → control-char validation) **before** any
  `mkdtemp`/`writeFile`/`spawn`. A rejected request leaves no temp dir and spawns
  nothing — asserted with injected `writeFile`/`spawn` spies.
- **No script injection (R1/BLOCKER-1).** Paths/env reach the script only through
  the literal encoders; CR/LF/NUL are rejected. Adversarial agent roots / env
  values (`"`, `$()`, backticks, `%`, `!`, `&`, `|`, newlines) cannot break out of
  the `cd`/`export`/`set` lines.
- **Reserved-name collision refused (R1/MAJOR-3; R2/MAJOR-2).** Refused
  (`reserved_name`) if any *readable* MCP source (agent `.mcp.json` + mesh-global
  `mesh/mcp.json` + project `.mcp.json` up to mesh root + `~/.claude.json`)
  declares `agentmesh_*`. Unreadable sources safe-degrade to a *shadowed*
  (unavailable) bridge — capability loss, not escalation. No merge-precedence
  assumption.

## 7. Error handling (failure-as-data)

- `allowShell` off → `403 { error: { code: 'shell_disabled' } }`.
- Unknown agent / root escapes mesh → `404` / `403` (reused checks).
- Any readable MCP source (agent `.mcp.json`, `mesh/mcp.json`, project, user)
  declares `agentmesh_*` → `409 { error: { code: 'reserved_name' } }` (refused
  before any side effect).
- Path/env contains CR/LF/NUL → `400 { error: { code: 'bad_input' } }`.
- `/launch` with an unknown/expired `planId` → `410 { error: { code:
  'plan_expired' } }` (re-request `/plan`).
- Unsupported platform → `200 { ok: false, reason: 'unsupported_platform',
  command }` (UI shows copy block; never a blank).
- Opener spawn fails → `200 { ok: false, reason: 'open_failed', message,
  command }` (UI falls back to copy).
- The dashboard never waits on the terminal/claude; it returns immediately after
  spawning the opener (detached). It cannot report what happens inside the session.

## 8. Testing (hermetic)

- **encoders (pure, adversarial):** `encodePosix`/`encodeCmd` neutralize `"`,
  `$()`, backticks, `%`, `!`, `&`, `|`, `<`, `>`, `^`; an agent root / env value
  carrying these cannot escape the `cd`/`export`/`set` lines; CR/LF/NUL →
  `assertNoControlChars` throws → `bad_input`.
- **buildLaunchPlan (pure):** darwin → `.command` body has cd + each env export +
  `claude --mcp-config` (all encoded); win32 → `.cmd` body has `cd /d` + `set` +
  claude; `opener.hasWt` → `wt` argv else `cmd start`; other → `openerArgv: null`
  + a correct copyable command. Threaded env includes `AGENT_MESH_MODE/PATH/DEPTH`.
- **recursion parity:** native bridge env (via `buildBridgeEnv` after
  `enterCallContext`) makes a native A→B→A delegation reject as `cycle`; depth
  bounded.
- **writePlanFiles/openTerminal:** injected `mkdir`/`writeFile`/`spawn` → the
  precomputed dir is created **exclusively** (EEXIST surfaces), files `0600`
  exclusive-create, script `0700`; opener argv correct per platform/`hasWt`; **no
  real terminal opens**.
- **plan↔launch identity:** the `command` from `/plan` is byte-identical to what
  `/launch` writes/opens (same tempDir/opener threaded via the cached plan).
- **reserved-name across sources:** an `agentmesh_*` server in the agent
  `.mcp.json`, the mesh-global `mesh/mcp.json`, a parent project `.mcp.json`, or
  `~/.claude.json` each → `409 reserved_name`; an unreadable source → launch
  proceeds (documented safe-degrade).
- **gate-before-side-effect:** disabled / missing cookie / cross-origin / unknown
  agent / containment-fail / reserved-name / control-char → injected `mkdir`,
  `writeFile` & `spawn` are **never called**.
- **endpoint:** `/plan` enabled → `{ planId, command }` (no fs side effects);
  `/launch` valid planId + darwin (mocked) → `ok:true` + opener once; expired
  planId → 410; reserved-name → 409; unknown platform → `ok:false` + command.
- **bridge entry parity:** `generateBridgeServerEntry` output used by the launch
  equals what `delegate.js` injects (one source of truth).
- **assembler parity + gating (R4):** `assembleMcpServers` includes agent
  `.mcp.json` + `mesh/mcp.json` + peer bridge; `mode:'ask'` → only `readOnly`
  servers (agent AND mesh-global), `mode:'do'` → none (bridge still added when
  peers), `mode:'native'` → full; worker and native call the same function;
  reserved-name preflight still refuses author `agentmesh_*`.
- **frontend (light):** button hidden when `shellEnabled` false; confirm dialog
  shows the `/plan` command; copy fallback present on unsupported/disabled.
- **CLI:** `shell <mesh-root> <agent>` builds the same plan (opener mocked).

## 9. Build increments

1. **Unified config + launch builder** — `src/mesh-mcp.js` `assembleMcpServers`
   (agent + mesh-global + bridge, mode-gated); route `delegate.js` worker MCP
   assembly through it (+ extract `generateBridgeServerEntry`, export
   `buildBridgeEnv`); `shell.js` encoders + `buildLaunchPlan` (pure) +
   `writePlanFiles`/`openTerminal` (injected I/O); unit + adversarial encoder +
   recursion-parity + assembler-parity/gating tests. No HTTP/UI.
2. **Endpoints + gates + CLI verb** — `/shell/plan` + `/shell/launch` (gated,
   gate-before-side-effect, reserved-name preflight, planId cache), `shellEnabled`
   capability, `dashboard --allow-shell`, `agent-mesh shell`; endpoint +
   no-side-effect-on-reject tests.
3. **Frontend (Variant A)** — header action + amber native-session block + confirm
   (shows the `/plan` command) → `/launch` + copy fallback + toast; shown only when
   `shellEnabled`.

## 10. Non-goals (v1)

- No embedded web terminal / PTY / `xterm.js` (deliberately out — keeps zero-dep
  and avoids an in-browser shell).
- No Linux terminal opener in v1 (copy fallback); add later behind the same builder.
- No session capture/streaming back to the dashboard (it's the operator's own
  terminal; the dashboard can't observe it).
- No `do`-policy change: the native session's power comes from native `claude`
  itself, not from relaxing any mesh gate. Promoting `mesh/mcp.json` to grantable
  keeps the `readOnly`/grant rule intact (R4).

## Review log

- **R0 (draft):** initial design.
- **R1 (codex; 2 BLOCKER / 4 MAJOR / 1 MINOR — all accepted):**
  - BLOCKER-1 (script injection) → literal `encodePosix`/`encodeCmd` + CR/LF/NUL
    rejection; adversarial tests (§2/§3/§5/§6/§8).
  - BLOCKER-2 (missing call-context env) → native bridge env via `buildBridgeEnv`
    after `enterCallContext`; A→B→A cycle test (§2/§3/§8).
  - MAJOR-3 (reserved-name shadow, non-strict MCP) → preflight refuse
    `agentmesh_*` in the agent's `.mcp.json` (`reserved_name`) (§2/§3/§6/§7).
  - MAJOR-4 (UI can't show exact command) → split `/shell/plan` (no side effects,
    returns command) + `/shell/launch { planId }` (§2/§4).
  - MAJOR-5 (temp-file hardening) → `mkdtemp` private dir, exclusive create,
    0700/0600, documented Windows ACL (§2/§5).
  - MAJOR-6 (gate-before-side-effect) → all gates before any write/spawn; injected
    spy tests (§2/§6/§8).
  - MINOR (purity vs `wt` probe) → `wt` detection moved to `openTerminal`; pure
    `buildLaunchPlan` takes `opener` as input (§4/§5).
- **R2 (codex; 2 MAJOR / 1 MINOR — all accepted):**
  - MAJOR-1 (`/plan` no-side-effects vs concrete temp paths) → `/plan` generates a
    concrete *uncreated* temp dir path + command; `/launch` creates that exact dir
    **exclusively**; plan↔launch byte-identity test (§2/§5/§8).
  - MAJOR-2 (preflight only checked agent `.mcp.json`) → broadened to all readable
    MCP sources (agent + project + `~/.claude.json`); unreadable → safe-degrade to
    a *shadowed* (unavailable) bridge, not escalation; cross-source test (§2/§3/§6/§8).
  - MINOR (`wt` detect order) → `detectOpener` runs once **before** planning; the
    pure builder takes `opener`/`tempDir` as inputs; `openTerminal` only spawns
    (§4/§5).
- **R3 (codex):** `VERDICT: APPROVED` — no actionable findings (7 → 3 → 0).
- **R4 (user requirement, post-approval):** the native session must be able to
  **use other mesh agents** and carry the **mesh-global MCP**, with the mesh using
  **one unified claude-config logic**. Added `assembleMcpServers` (single source of
  truth: agent `.mcp.json` + `mesh/mcp.json` + peer bridge, mode-gated) used by
  both worker and native launch; `mesh/mcp.json` promoted from discovery-only to
  grantable under the unchanged `readOnly`/grant rule (§2/§3/§4/§6/§8/§9/§10).
  Re-review pending (this touches the grant model).
- **R4 (codex; 2 findings — accepted):**
  - reserved-name preflight must also cover the now-grantable `mesh/mcp.json` →
    `assembleMcpServers` drops `agentmesh_*` from **every** source (agent + mesh
    + project + user) before adding the bridge (§3/§6).
  - PROJECT.md still said MCP is folder-local / no global inheritance → **amended**
    §1.5/§1.6/§2.4 to make `mesh/mcp.json` grantable under the same `readOnly` rule
    (do=∅, peer-bridge carve-out intact) and point the invariant at the unified
    `assembleMcpServers`; stale init-mesh label updated.
- **R5 (codex; 1 finding — accepted):** §3/§6/§7/§8 still listed the preflight
  sources as agent/project/user-only — made consistent with §2: every live section
  now names **`mesh/mcp.json`** among the reserved-name sources.
- **R6 (codex):** `VERDICT: APPROVED` — consistent across the spec. **Consensus
  reached** (7 → 3 → 0; reopened by the R4 grant-model requirement → 2 → 1 → 0).
