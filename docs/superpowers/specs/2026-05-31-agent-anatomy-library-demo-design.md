# Agent Anatomy + A2A Library Demo — Design

- **Date:** 2026-05-31
- **Status:** Approved (design); first build increment = Agent B server
- **Branch:** v1.0-development

## 1. Goal

Make `agents_mesh` feel like a real **agent mesh**, not an MCP tool list. Two
distinct agents: **Agent A** (talks to the user) delegates a whole task to
**Agent B** (a self-contained peer). B does the entire job *as itself* — its own
engine, its own identity, its own tools — and returns the final answer. A is not
a dumb pass-through: it analyzes user intent and constructs the best context for
B.

Concrete proof: a **library demo**. The user asks A "do you have 'Dune'?"; A
frames a clear task for B; B (the librarian) uses its own `search_books` MCP tool
to look up its catalog and answers; A relays the answer to the user.

## 2. Chosen model (the decisions that got us here)

- **B is a self-contained agent**, not a "brain bundle" A's engine loads. B runs
  its own worker with its own identity. A messages B and waits for the final
  answer. This is the true A2A peer model and matches the existing
  `serve-a2a` direction.
- **Transport: A2A** (`serve-a2a`). A sends `message/send`, receives a `Task`.
- **B uses MCP as a granted own-tool** (Shape 2): the demo shows an agent
  invoking its own tool MCP, because "agent mesh uses MCP as key tools for
  tasks" is the pattern we want to demonstrate. `.mcp.json` declares available
  own-tools; the framework still narrows what the worker actually receives via
  `mcpSurface`.
- **A is a real caller-discipline agent**: intent analysis + context
  construction live in a dedicated internal prompt (`prompts/delegate.md`), not
  buried in prose and not baked into the framework.

## 3. Agent anatomy (locked) + five hard boundaries

Every agent — A and B alike — has the same shape. Role (caller vs worker) is a
matter of *behavior*, not a different structure.

```
agent/
  agent.json        # machine-readable PUBLIC contract (AgentCard: identity, skills, modes)
  AGENT.md          # public, human-readable description — SHOWN, never obeyed
  prompts/          # internal behavior modules — runner-injected, OBEYED
    system.md       #   base identity / role
    ask.md          #   read-only mode behavior
    do.md           #   write mode behavior
    delegate.md     #   caller discipline: analyze intent -> construct context -> frame task
  skills/           # local skill docs / workflows the agent owns
    kb-lookup.md
    summarize.md
  tools/            # MCP servers this agent owns
    docstore/
      server.mjs
  .mcp.json         # declares own tools/context — NO peers; grants are separate
  registry.json     # A2A peers this agent may delegate to
  state/cache/      # runtime scratch
  logs/             # run logs
```

**Boundary 1 — `agent.json` is the machine-readable public contract.** The
AgentCard (identity, skills, modes). Built by `buildAgentCard`.

**Boundary 2 — `prompts/` and `skills/` are the agent's internal behavior
modules.** `prompts/*.md` are runner-injected and *obeyed* as system prompts.
`AGENT.md` stays public, descriptive, and is **never** injected/obeyed as a
system prompt. This resolves the contradiction in the old design where AGENT.md
was simultaneously "untrusted public data, never executed" and "a behavior
contract."

**Boundary 3 — `.mcp.json` is ONLY the agent's own tools/context; peers go
through `registry.json` (A2A).** An A2A peer may **not** masquerade as an MCP
tool, except as an explicit, clearly-labeled legacy compatibility shim. This
separates "tools I use" from "agents I delegate to."

**Boundary 4 — declarations are not grants.** `agent.json`, `prompts/`,
`skills/`, `tools/`, and `.mcp.json` describe what an agent is and what own
capabilities exist. The framework constructs the per-task `mcpSurface` grant
from those declarations plus mode/task policy. A worker never receives every
declared MCP server just because it appears in `.mcp.json`.

**Boundary 5 — trusted agent configuration is protected from normal delegated
work.** `prompts/`, `agent.json`, `.mcp.json`, `registry.json`, and `tools/`
are the agent's trusted configuration. A normal delegated `do` task may write
only runtime/state or explicitly allowed owned source paths for that task. This
prevents a delegated task from silently rewriting the agent's future identity,
tool grants, or peer wiring. Self-modifying agent configuration is a separate
admin workflow, not part of this demo.

## 4. Framework changes

### 4.1 Identity injection via `prompts/` (replaces "reuse AGENT.md")

- The runner reads `prompts/system.md` + the mode file (`ask.md` / `do.md`) and
  injects them via `claude -p --append-system-prompt`. Append (not replace) so
  the worker keeps Claude Code's default tool-use scaffolding while acting as
  itself.
- `AGENT.md` is **not** injected. It remains the caller-facing description used
  to build the AgentCard / tool description only.
- The prompts are read by the runner. Bound the injected text (new
  `MAX_PROMPT_CHARS`, e.g. 8000). Missing `prompts/` → no injected identity
  (worker still runs; back-compatible).
- Threading: each server already reads `self = describeFolder(root)` once at
  startup. The prompt text is read by the runner at spawn time from `root`
  (cheap, local) OR threaded from the server. Decision: read in the runner from
  `prompts/` under `root`; keep `describeFolder` for the public description.

### 4.2 `.mcp.json` tools-only / `registry.json` peers split

- **Today:** `.mcp.json` holds agent-mesh *peers*, filtered by
  `isAgentMeshServer` (`src/delegate.js:160-172`).
- **New:** `.mcp.json` holds only the agent's **own tool servers**.
  `createStrictMcpConfig` reads those declarations, then emits only the
  framework-granted subset for the current task's `mcpSurface` via
  `--strict-mcp-config --mcp-config`. The `isAgentMeshServer` peer filter is
  removed from the tool path, but default-deny remains: declaration in
  `.mcp.json` is necessary, not sufficient.
- **Peers** move to `registry.json` — the on-disk form of what
  `src/a2a/registry.js` already consumes for the A2A client.
- **Demo grant:** Agent B's `search_books` server is granted only for `ask`
  tasks because it is read-only. In `do`, non-framework MCP tools remain
  disabled by default unless a later design adds an explicit sandboxed grant.

### 4.3 Tool-MCP trust boundary (stated honestly in PROJECT.md)

A tool MCP server runs with the **agent author's** trust and is **outside the
path-guard** (its tool names are not the built-in write tools the PreToolUse hook
matches). The single-writable-root guarantee still covers
`Edit/Write/MultiEdit/NotebookEdit`. The demo's `search_books` tool is
**read-only**, so it cannot write regardless. Since `.mcp.json` is now defined as
own-tool declarations only, the worker receives only the framework-generated
grant for the current task, not the raw file.

### 4.4 Protected configuration boundary

- The framework should treat `prompts/`, `agent.json`, `.mcp.json`,
  `registry.json`, and `tools/` as protected configuration for ordinary
  delegated work.
- The first build increment may enforce this conservatively in the runner by
  denying structured writes into those paths during delegated `do` tasks, while
  allowing writes under `state/`, `logs/`, and task-specific owned work paths.
- The library demo is `ask`-only, so this boundary is mostly documented here,
  but it must be stated before `prompts/` become obeyed identity.

### 4.5 PROJECT.md updates

- Add the agent anatomy and the five boundaries.
- Refine the AGENT.md invariant: **AGENT.md is public descriptive data, never
  obeyed; the obeyed identity lives in `prompts/`.**
- Document the tool-MCP trust boundary (4.3).
- Document `.mcp.json` (tools) vs `registry.json` (peers).
- Document declaration vs grant (`mcpSurface`) and protected configuration.

## 5. The answer path (already works, unchanged)

B's worker stdout → `result.summary` → A2A `Task`: it becomes the `Task` status
message text **and** a `summary` artifact (`src/a2a/protocol.js:76-83`). A
receives B's answer in the Task. No protocol change needed.

## 6. The library demo

### Agent B — `examples/agent-b/` (the library)

- `agent.json` — AgentCard: name "library", description, skills, modes.
- `AGENT.md` — public description ("A library agent that answers questions about
  its book catalog").
- `prompts/system.md` — "You are the library agent. Use the `search_books` tool
  to answer questions about the catalog. Answer with title + shelf, or say the
  title is not in the catalog."
- `prompts/ask.md` — read-only behavior.
- `tools/book-search/server.mjs` — a tiny **read-only** MCP stdio server
  exposing `search_books(query)`; reads `books.json`, returns matches
  (`[{title, author, shelf}]`).
- `.mcp.json` — declares the book-search tool server. The framework grants this
  server into B's `mcpSurface` for `ask` tasks in the demo.
- `books.json` — the catalog (the data the tool reads), e.g. Dune, etc.

### Agent A — `examples/agent-a/` (the caller)

- `agent.json`, `AGENT.md` — public.
- `prompts/system.md` + `prompts/delegate.md` — the caller discipline: analyze
  the user's intent, construct a self-contained context, frame a clear task for
  the peer, then interpret the returned Task for the user.
- `registry.json` — one peer: B, reachable via
  `node ./bin/agent-mesh.js serve-a2a <agent-b>`.

### Runner — `scripts/library-demo.mjs`

Materializes/points at the two agent folders, starts B's A2A server, then runs
Agent A's caller path rather than bypassing it. A receives the user wording
("do you have 'Dune'?"), applies `prompts/delegate.md` to analyze intent and
construct a self-contained A2A task for B, sends `message/send`, receives B's
Task, and interprets it for the user. Found → title + shelf; not found → "not in
catalog." Mirrors `scripts/demo-setup.mjs` conventions (never spawns real
`claude` silently in the hermetic path; real-model execution remains opt-in).

## 7. Error handling

- Book not found → B answers "not in catalog" (worker decides from tool output).
- Tool MCP error → outcome depends on the worker process. If the worker exits
  non-zero or times out, the existing failure-as-data path captures it
  (`status: error`/`timeout`, `log_path`). If the model catches the tool error
  and exits 0 with an explanatory answer, the Task may be `completed` with that
  explanation. The mesh never auto-retries.
- MCP server declared but not granted → the worker cannot call it; the expected
  result is a structured failed/rejected Task depending on the runner's exact
  detection point.
- Missing `prompts/` → no injected identity, worker still runs (back-compat).
- All non-`done` outcomes remain structured `Task` data, per existing invariant.

## 8. Testing

- **Unit (hermetic, `createFakeClaude` stub):**
  - `prompts/` injection adds `--append-system-prompt` containing
    `system.md` + mode file; absent `prompts/` → no flag.
  - `.mcp.json` declaration + `mcpSurface` grant: own tool servers can be
    declared; only granted read-only tools are emitted to the worker config; the
    old peer filter no longer applies on the tool path.
  - Default-deny: a declared but ungranted MCP tool is not present in the
    generated worker config.
  - Protected config: delegated `do` tasks cannot write `prompts/`, `agent.json`,
    `.mcp.json`, `registry.json`, or `tools/` unless a future admin workflow
    explicitly authorizes it.
  - `registry.json` parsing for peers (extend `src/a2a/registry.js` tests).
  - `book-search` server: `search_books` returns correct matches from a fixture
    `books.json` (exact + partial title; empty on miss).
- **E2E (opt-in, real `claude`, gated by `AGENT_MESH_E2E=1`):** A messages B → B
  calls `search_books` → correct answer in the Task. Mirrors
  `test/demo-e2e.test.js`.

## 9. Scope

**In scope:** agent anatomy + five boundaries; `prompts/` identity injection;
`.mcp.json`/`registry.json` split; `mcpSurface` grant filtering for own MCP
tools; protected configuration boundary; read-only book-search tool MCP; the
library demo (A + B); PROJECT.md updates; unit + opt-in e2e tests.

**Out of scope (left room for, not built):**
- Onward worker→peer delegation and the "peer-as-MCP-tool" compatibility shim
  (the demo is a single A→B hop; B does not delegate onward).
- HTTP(S) A2A transport (stdio only, as today).
- `do`-mode for the demo (library lookup is read-only `ask`).
- Full admin/self-modification workflow for changing trusted agent
  configuration.
- `skills/`, `state/`, `do.md`, `delegate` execution wiring beyond what the demo
  exercises (defined in the anatomy, populated minimally).

## 10. First implementation increment

**Agent B server** — the first vertical slice the user asked to build:

1. `prompts/` identity injection in the runner (`system.md` + `ask.md`).
2. `.mcp.json` tools-only declarations + `mcpSurface` grant filtering (remove
   peer filter from the tool path, keep default-deny).
3. `examples/agent-b/` populated: `agent.json`, `AGENT.md`, `prompts/`,
   `tools/book-search/server.mjs`, `.mcp.json`, `books.json`.
4. B stands up under `serve-a2a` and answers a book lookup (verified by unit
   tests + the opt-in e2e).

Agent A (caller discipline) and the end-to-end runner follow as the next
increment.
