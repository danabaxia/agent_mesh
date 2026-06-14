# Agent Mesh Observable MVP — Design

- **Date:** 2026-06-03
- **Status:** Draft for user review
- **Scope:** Minimal observable MVP for global tools/skills, local agent
  runtime context, and A2A interaction.

## 1. Goal

Build a small end-to-end demo that makes the Agent Mesh layers visible:

- global MCP declarations (declared and visible, not invoked in MVP);
- global reusable skills;
- local agent MCP tools;
- local agent skills;
- local memory;
- local workflows;
- unified system prompt entry;
- A2A delegation between agents.

The MVP is not a production policy engine. It is a runnable sample that shows
which context entered the worker, which tools were granted, and how the peer
agent answered.

Note: the user said "global SQL" and "local agent SQL" in the same sentence as
MCP, memory, and prompt. This design treats that as "global skill" and "local
agent skill". If SQL database behavior is intended instead, the same structure
can be adapted by making the global/local MCP tools expose read-only SQL query
tools.

## 2. Chosen Shape

Use the existing App -> Library demo and extend it into an observable mesh.
Agent A remains the caller. Agent B remains the Library agent. A sends B A2A
`message/send` requests. B executes with its own runtime context and its own
MCP tool grants.

The MVP adds one framework module:

```text
src/agent-context.js
```

It owns discovery and runtime prompt construction:

```js
buildAgentRuntimePrompt(root, mode, { meshRoot })
discoverAgentStructure(root, { meshRoot })
```

`src/agent-context.js` is a **peer** to the existing `src/context.js`, not a
replacement: `src/context.js` keeps its current role of reading
`AGENT_MESH_PATH` / `AGENT_MESH_DEPTH` from process env and enforcing the
cycle / depth-budget guard (`readCallContext` / `enterCallContext`).
`src/agent-context.js` is a separate concern — local agent prompt assembly
and directory discovery — and only the new functions above live there.

`src/delegate.js` calls `buildAgentRuntimePrompt()` instead of its current
local-only prompt reader.

## 3. Directory Model

Repository global layer:

```text
mesh/
  mcp.json
  skills/
    citation-format/
      SKILL.md
```

Agent layer:

```text
agent-root/
  agent.json
  AGENT.md
  .mcp.json

  prompts/
    system.md
    ask.md
    do.md

  memory/
    profile.md
    catalog-policy.md
    decisions.md

  workflows/
    default.md
    ask.md
    do.md

  skills/
    shelf-answer/
      SKILL.md

  tools/
    book-search/
      server.mjs
```

`AGENT.md` remains public descriptive data. It is never obeyed as the worker's
system prompt. `prompts/system.md` is the single local system prompt entry.

In this MVP, **"local memory"** refers to **static policy markdown files**
under `agent-root/memory/` (e.g. `profile.md`, `catalog-policy.md`,
`decisions.md`) that are injected into the worker's prompt at composition
time. It is **not** session-level ephemeral state, working memory, or any
form of run-scoped scratchpad — those are out of scope (see §8 Non-goals).

## 4. Runtime Prompt Assembly

`buildAgentRuntimePrompt(root, mode, { meshRoot })` returns one bounded prompt
string assembled in this order:

```text
1. prompts/system.md
2. memory/profile.md
3. other memory/*.md files, sorted by filename
4. workflows/default.md
5. workflows/<mode>.md
6. prompts/<mode>.md
7. global skill summaries from mesh/skills/*/SKILL.md
8. local skill summaries from skills/*/SKILL.md
```

The MVP injects deterministic skill summaries, never full skill bodies. For
each `SKILL.md`, summary extraction is:

1. use `name` and `description` frontmatter when both are present;
2. otherwise use the first non-empty paragraph after optional frontmatter;
3. cap the extracted summary at 500 characters.

This keeps the first version observable and testable without building
automatic skill routing.

The assembled prompt is passed through the existing Claude Code append path:

```text
claude -p <task> --append-system-prompt <assembled prompt>
```

This preserves Claude Code's tool-use scaffolding while adding the agent's
identity and mesh-specific context.

## 5. MCP Model

There are two declaration layers:

- `mesh/mcp.json` declares global MCP servers.
- `agent-root/.mcp.json` declares local agent MCP servers.

The MVP does not automatically grant all declared MCP tools. It keeps the
current safety posture and pins grant scope to local agent MCP only:

- `ask`: grant only local `agent-root/.mcp.json` servers marked read-only with
  `"x-agentmesh": { "readOnly": true }`;
- `do`: grant no non-framework MCP tools by default.
- `mesh/mcp.json`: discover and log global MCP declarations only; no global MCP
  server is granted or invoked in the MVP.

For observability, the runtime log should show:

- which global MCP servers were discovered;
- which local MCP servers were discovered;
- which servers were actually granted for the task.

The Library agent's existing `book-search` MCP server remains the local tool.
The global MCP sample can be a read-only helper declaration, such as
`citation-policy`. The runtime log confirms that global MCP declarations were
discovered without confusing them with A2A peers; live global MCP invocation is
out of scope.

## 6. Skills Model

Global skills live under:

```text
mesh/skills/*/SKILL.md
```

Local skills live under:

```text
agent-root/skills/*/SKILL.md
```

The MVP treats skills as context modules. It does not implement a full skill
selection engine. Instead, the runtime prompt receives an observable section:

```text
Available global skills:
- citation-format: ...

Available local skills:
- shelf-answer: ...
```

This lets the demo show that the model sees shared behavior and local behavior
at the same time.

## 7. Demo Scenarios

The demo should run deterministic worker stubs by default, with real Claude
execution remaining opt-in as the current project pattern already uses.

### Scenario 1: Local MCP + Memory

A asks B:

```text
Do you have Dune?
```

Expected observations:

- B's prompt includes `prompts/system.md`;
- B's prompt includes `memory/catalog-policy.md`;
- B is granted local read-only MCP `book-search`;
- B answers from the catalog, not from model memory.

### Scenario 2: Global Skill + Local Skill

A asks B:

```text
Do you have Dune? Use the shared citation style.
```

Expected observations:

- B sees global `citation-format`;
- B sees local `shelf-answer`;
- B answers using the shared format while still applying local shelf rules.

### Scenario 3: Do Mode Boundary

A asks B to make a local code or catalog-related change inside B's folder.

Expected observations:

- B's prompt includes `workflows/do.md` and `prompts/do.md`;
- non-framework MCP tools are not granted in `do`;
- writes remain confined to B's root;
- `files_changed` reports only B-owned files.

### Scenario 4: Anti-Guessing

A asks B to ignore the catalog and answer from memory.

Expected observations:

- B follows local system prompt, memory, and workflow;
- B refuses to guess or states that the catalog is the source of truth;
- B uses `book-search` in ask mode.

## 8. Implementation Boundaries

MVP code changes:

- add `src/agent-context.js` as a peer to the existing `src/context.js`
  (the latter keeps its call-path / depth-guard role unchanged — no rename,
  no merge);
- update `src/delegate.js` to call `buildAgentRuntimePrompt`;
- add global `mesh/` fixtures;
- add missing `memory/`, `workflows/`, and `skills/` fixtures in
  `examples/agent-b/`;
- keep Agent A as the existing scripted/demo caller for this MVP; only Agent B
  receives the full runtime anatomy fixtures;
- add tests for context assembly and backward compatibility;
- update demo output to include context/tool observability.

MVP non-goals:

- no central broker;
- no automatic agent discovery;
- no automatic skill routing;
- no write-capable MCP grants in `do`;
- no production SQL database unless the user explicitly confirms SQL is meant
  literally;
- no replacement of A2A with MCP;
- no live invocation of a global MCP server (only declarations and visibility
  are demoed — see §1 and §10);
- no session / ephemeral working memory (only the static policy markdown
  under `agent-root/memory/` is in scope — see §3).

## 9. Testing

Unit tests:

- `buildAgentRuntimePrompt` includes system, memory, workflows, mode prompt,
  global skills, and local skills in the documented order.
- Missing directories are ignored without failure.
- Existing `examples/agent-b/prompts/system.md` behavior remains compatible.
- Prompt length is bounded by the existing prompt budget.

MCP tests:

- global and local MCP declarations can be discovered;
- unmarked MCP servers are discovered but not granted;
- local read-only marked servers are granted in `ask`;
- global MCP declarations are not granted in `ask`;
- no non-framework MCP tools are granted in `do`.

Demo tests:

- the demo entry point is `node scripts/complex-demo.mjs` (no npm script alias
  in MVP scope);
- the observable demo prints or returns:
  - runtime context sections present;
  - discovered MCP declarations;
  - granted MCP servers;
  - A2A Task status and artifacts;
  - `files_changed` for `do`.

Regression tests:

- existing A2A, MCP compatibility, path guard, context, and demo tests continue
  passing.

## 10. Success Criteria

The MVP is successful when a developer can run `node scripts/complex-demo.mjs`
and inspect output showing:

- Agent A can enter through A2A and call Agent B;
- B's identity comes from `prompts/system.md`;
- B's memory and workflow files are included;
- global and local skills are visible;
- global and local MCP declarations are visible (global MCP invocation is
  explicitly out of scope per §8 — declarations and visibility only);
- only allowed MCP tools are granted;
- ask/do mode differences are observable;
- all outcomes still return structured A2A Task data.
