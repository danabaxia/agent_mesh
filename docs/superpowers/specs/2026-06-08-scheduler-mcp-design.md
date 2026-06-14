# Scheduler MCP Server — Design

**Date:** 2026-06-08
**Status:** Approved (design); pending implementation plan
**Topic:** `agent-mesh serve-scheduler` — an MCP server that wraps Windows Task Scheduler

---

## 1. Purpose

Add a new MCP server to the `agent-mesh` CLI that lets an MCP client (Claude
Code, primarily) **create, check, and manage recurring local jobs on Windows**
through Windows Task Scheduler — without hand-writing PowerShell each time.

It codifies the `schedule/<task_name>/` convention already documented in the
user's global CLAUDE.md (a self-contained per-task folder with `run.cmd` and a
durable `logs/run.log` trace) into a safe, opinionated, programmatic surface.

A "temporary Claude task" is not a separate concept: it is simply a one-off
(`type:"once"`) task whose `command` is `claude -p "..."`, optionally
`self_delete`-ing after it fires.

### Scope decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Core job | Wrap Windows Task Scheduler |
| Tool surface | **Opinionated / convention-enforcing** (scaffold folder, sane defaults, idempotent register) |
| Packaging | **Inside the `agent-mesh` repo** as a new subcommand, reusing the hand-rolled zero-dep stdio MCP pattern |
| Management scope | **Only its own tasks**, namespaced under a dedicated Task Scheduler folder |
| Action model | **Generic command only** (a Claude task is just `command=claude -p "..."`) |
| Triggers (v1) | **Once, Daily, Weekly, At-logon** (Once may self-delete) |
| Execution mechanism | **`schtasks.exe` + generated XML** for mutations; read-only PowerShell for status |

### Non-goals (v1, YAGNI)

- Monthly / interval ("every N minutes") / idle triggers.
- Managing tasks outside the `\AgentMesh\` namespace; touching system tasks.
- `Bash`-style arbitrary in-process execution; the server only *registers*
  tasks, it does not run user commands itself.
- Cross-platform (Linux `cron` / macOS `launchd`). Windows only.
- Elevation / "run whether logged on or not" (breaks COM automation; see
  CLAUDE.md). Interactive logon only.

---

## 2. Architecture

Same ethos as the rest of the repo: a **pure core** (unit-provable) plus a
**thin impure shell** (only two files spawn processes or touch the filesystem).

New subcommand: `agent-mesh serve-scheduler <folder>` — a newline-delimited
JSON-RPC-over-stdio MCP server fronting **one** project folder, where the
`schedule/<task>/` convention is scaffolded. Mirrors the existing
`serve-a2a <folder>` / `serve <folder>` shape. MCP server identity:
`agent-mesh-scheduler` v0.1.0.

```
src/scheduler/
  mcp-scheduler.js   impure  stdio JSON-RPC server (clone of src/mcp.js): initialize / ping / tools/list / tools/call
  tools.js            pure   tool names, descriptions, JSON schemas, dispatch table
  schedule-spec.js    pure   validate + normalize the schedule object → normalized trigger model
  task-xml.js         pure   normalized task → Task Scheduler XML string   ← injection-proof core
  run-cmd.js          pure   (command, args, workdir, logPath) → run.cmd text (CLAUDE.md template)
  task-name.js        pure   sanitize/validate name; derive \AgentMesh\<slug>\<name> + <root>/schedule/<name>
  marker.js           pure   .agent-mesh-task.json shape: build / parse / validate / ownership sentinel
  schtasks.js        impure  spawn schtasks.exe (/Create /Run /Change /Delete) with argv array, shell:false
  query.js           impure  read-only status via PowerShell `Get-ScheduledTaskInfo | ConvertTo-Json`
  scaffold.js        impure  fs: mkdir schedule/<task>/logs, write run.cmd + marker + task.xml, tail run.log
```

`bin/agent-mesh.js` → `src/cli.js`: add the `serve-scheduler` case
(`realpath`-canonicalize the folder, then `createSchedulerMcpServer({root, env})`).

### Why writes via `schtasks`+XML but reads via PowerShell

Mutations go through `schtasks.exe /Create /XML` (and `/Run`, `/Change`,
`/Delete`): the user-supplied `command`/`args` never appear on a command line we
assemble — they live only inside the generated XML/`run.cmd` files — so this path
is injection-proof and the XML generator is exhaustively unit-testable.

For **checking** status, parsing `schtasks /Query` CSV/LIST output is
locale-fragile, so reads go through a read-only
`Get-ScheduledTaskInfo | ConvertTo-Json` call. The task name is sanitized and
namespace-scoped and is passed as a bound `-TaskName` argument, so this read path
carries no injection risk.

---

## 3. Tool surface

The model-facing args are minimal — **no filesystem paths, no raw XML, and no
`schtasks` flags ever reach the model**.

| Tool | Args | Behavior |
|---|---|---|
| `create_task` | `name, command, args?, schedule, workdir?, description?, overwrite?` | Scaffold `schedule/<name>/`, write `run.cmd` + marker + `task.xml`, register via `schtasks /Create /XML`. Idempotent: refuses with `error: name_exists` if the task already exists, unless `overwrite:true`. |
| `list_tasks` | — | This folder's managed tasks (from marker files) joined with live Task Scheduler state. |
| `get_task` | `name` | Full status: enabled/disabled, last run time, **last result** (`0`=success, `267011`=never run yet), next run time, plus a tail of `run.log`. |
| `run_task` | `name` | `schtasks /Run` — fire it now (a real run). |
| `enable_task` / `disable_task` | `name` | `schtasks /Change /ENABLE` / `/DISABLE`. |
| `delete_task` | `name, keep_logs?` | `schtasks /Delete /F` then remove `schedule/<name>/` (kept if `keep_logs:true`). |
| `get_task_logs` | `name, lines?` | Tail `schedule/<name>/logs/run.log` (default last 50 lines). |

### Schedule object (the only branching schema)

- `{ type:"once",   date:"YYYY-MM-DD", time:"HH:mm", self_delete?:true }`
- `{ type:"daily",  time:"HH:mm" }`
- `{ type:"weekly", days:["Mon","Wed",...], time:"HH:mm" }`
- `{ type:"logon" }`

Times are local, 24-hour `HH:mm`. `weekly.days` accept the three-letter English
day abbreviations. `self_delete` is only valid for `type:"once"`.

---

## 4. Generated artifacts

Per task, under `<root>/schedule/<name>/`:

- **`run.cmd`** — the launcher, from the CLAUDE.md template:
  ```bat
  @echo off
  cd /d "%~dp0"
  if not exist logs mkdir logs
  >>logs\run.log echo START %DATE% %TIME%
  <command> <args>
  >>logs\run.log echo END (exit %ERRORLEVEL%) %DATE% %TIME%
  ```
  (Redirection is written *before* `echo` deliberately: `%TIME%` ends in a
  digit, and a digit immediately preceding `>>` would be parsed by `cmd` as a
  stream-handle redirect. The redirection-first form avoids that pitfall.)
- **`logs/run.log`** — durable, Claude-independent `START`/`END (exit …)` trace
  appended each run.
- **`task.xml`** — the generated Task Scheduler definition, kept on disk for
  transparency/debugging.
- **`.agent-mesh-task.json`** — the ownership marker:
  ```json
  {
    "marker": "agent-mesh-scheduler",
    "name": "<name>",
    "root": "<canonical folder path>",
    "taskPath": "\\AgentMesh\\<slug>\\<name>",
    "command": "<command>",
    "args": ["..."],
    "schedule": { "type": "daily", "time": "14:00" },
    "createdAt": "<ISO-8601>"
  }
  ```

---

## 5. Namespace & ownership

- **Task Scheduler path:** `\AgentMesh\<slug>\<name>`, where
  `slug = <folder-basename>-<6 hex chars of the canonical folder path>`. This
  prevents cross-project name collisions and lets `list_tasks` scope by querying
  `\AgentMesh\<slug>\`.
- **Ownership proof:** the generated XML carries
  `<RegistrationInfo><Source>agent-mesh-scheduler</Source><URI>\AgentMesh\<slug>\<name></URI></RegistrationInfo>`.
  A task is considered managed only if it is under `\AgentMesh\`, its `Source`
  matches the sentinel, **and** a matching marker file exists in the served
  folder. Both are verified before any mutate/delete.
- **`list_tasks` source of truth:** the marker files in `<root>/schedule/*/`,
  cross-checked against live Task Scheduler state. A task present in markers but
  gone from Task Scheduler (e.g. an expired self-deleting one-off) is reported
  with a derived status (e.g. `expired`).
- **`self_delete` lifecycle:** for `type:"once"`, the XML sets an `EndBoundary`
  shortly after the start and `DeleteExpiredTaskAfter=PT0S`, so Task Scheduler
  auto-removes the task after it fires. The marker + logs remain on disk, so
  `get_task` still reports the outcome. This is the "temporary task" lifecycle.

---

## 6. Safety invariants

These are security properties, not style preferences — in the spirit of the
repo's existing invariants.

- **No shell interpolation of user values.** `schtasks.exe` is spawned with an
  argv array (`shell:false`). User-supplied `command`/`args` live only inside the
  generated `task.xml` / `run.cmd` files — never on a command line we assemble.
  XML generation is the safety boundary.
- **Name sanitization.** `name` ∈ `[A-Za-z0-9._-]`, length-bounded, no path
  separators, no `..`, no Windows reserved device names (`CON`, `PRN`, `AUX`,
  `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`). Rejected names never reach the
  filesystem or `schtasks`.
- **Single writable subtree.** All filesystem writes are confined under
  `<root>/schedule/` via a realpath check (same idea as the path-guard hook).
- **Namespace confinement.** Every mutation is scoped to `\AgentMesh\<slug>\`;
  the server refuses to create/modify/delete/run anything outside its namespace,
  and verifies the `Source` sentinel + marker before destructive ops
  (`error: not_managed` otherwise).
- **Failure is data, not an exception.** Every tool returns a structured result
  with a status; `schtasks`/PowerShell stderr is captured, never thrown to the
  client. `LastTaskResult` is surfaced as data.
- **Conservative defaults** (from CLAUDE.md): Interactive logon (COM-safe) and
  `StartWhenAvailable`. The server never elevates.

---

## 7. Testing

Hermetic by default, mirroring the existing `createFakeClaude` approach.

- **Pure unit tests:** `schedule-spec` normalization and rejection; `task-xml`
  generation (snapshot per trigger type, incl. `self_delete`); `run-cmd` text;
  `task-name` sanitization including traversal and reserved-name rejection;
  `marker` build/parse/ownership.
- **Shell tests:** a `createFakeSchtasks` `.mjs` (pointed at by
  `AGENT_MESH_SCHTASKS`) records argv and returns canned output; asserts the
  correct flags, namespace scoping, and the refusal paths (`name_exists`,
  `not_managed`).
- **Opt-in real e2e** (`AGENT_MESH_SCHEDULER_E2E=1`): registers a harmless
  one-off under `\AgentMesh\test\`, runs it, asserts `run.log` received
  `START`/`END`, then deletes it. Gated because it touches the real machine.

---

## 8. Config (env, all optional)

- `AGENT_MESH_SCHTASKS` — schtasks binary (default `schtasks.exe`).
- `AGENT_MESH_POWERSHELL` — PowerShell binary for read-only status queries
  (default `powershell.exe`).
- `AGENT_MESH_SCHEDULER_NS` — Task Scheduler namespace root (default
  `\AgentMesh`).
- `AGENT_MESH_SCHEDULER_E2E` — set to `1` to enable the real-machine e2e test.

---

## 9. Integration

Registered as an MCP server in the client config:

```json
"agent-mesh-scheduler": {
  "command": "node",
  "args": ["c:/AI/agents_mesh/bin/agent-mesh.js", "serve-scheduler", "c:/path/to/project"]
}
```

The served folder is the base for `schedule/` scaffolding and the marker store;
tasks register in the global `\AgentMesh\<slug>\` namespace tagged back to that
folder.
