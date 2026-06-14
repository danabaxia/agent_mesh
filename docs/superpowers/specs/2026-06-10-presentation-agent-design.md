# Presentation Agent — Design

- **Date:** 2026-06-10
- **Status:** approved (pending written-spec review)
- **Mesh:** `my-mesh/`
- **Type:** new mesh agent + capability wiring

## Goal

Give the mesh a single owner of **company-standard deliverables**:

- **Workflow documentation → PPTX deck** (company template, via the `ppt-master` MCP).
- **Idea proposals → polished HTML** (via the global `frontend-design` skill + Claude `Write`).

The agent pulls source *content* from peer agents (`knowledge`, `data-analyst`, `fracas`,
`coder`) and produces the deliverable into its own folder. The human drives it directly —
there is no automatic agent-to-agent presentation handoff in scope.

## Key constraint that shaped the design — the mode tension

The two deliverable types need **opposite** execution modes, because of how the mesh gates
capabilities (`src/mesh-mcp.js` `readEligibleServers`, `src/delegate-invocation.js`):

| Deliverable | Written by | Needs | Works in | Fails in |
|---|---|---|---|---|
| PPTX deck | `ppt-master` MCP, **in its own process** | the MCP server granted | `ask` / `native` | `do` — **MCP servers are dropped in `do` mode** |
| HTML proposal | Claude `Write` tool | a write tool available | `do` / `native` | `ask` — no write tools |

A single `ask` or `do` delegation cannot produce both. The only mode that has the MCP **and**
a write tool **and** skills at once is **`native`** — a full interactive session in the
agent's folder (the dashboard "open terminal" path).

**Decision: the presentation agent is driven as a `native` session.** This is also the
natural shape of "I trigger it directly." Headless `ask`/`do` delegation to it remains
possible but is single-purpose (ask → PPT only; do → HTML only).

### Confinement note

`native` is the gated, opt-in full session (`PROJECT.md` §1.6). It carries the agent's MCP
servers, skills, and default write tools. The `ppt-master` MCP writes to a path it controls
(`PPT_OUTPUT_DIR`), which is **outside** the mesh path-guard (the hook only governs Claude's
own `Edit`/`Write`/`MultiEdit`/`NotebookEdit`). We point `PPT_OUTPUT_DIR` at the agent's own
`deliverables/` folder so PPTX output co-locates with HTML output and stays inside the
agent's tree by configuration (not by enforcement).

## Architecture (Approach C — dedicated agent + global frontend skill)

```
my-mesh/
├── mesh/
│   ├── mcp.json          # ppt-master REMOVED from here (was global)
│   └── skills/
│       └── frontend-design/   # STAYS global — coder uses it too
├── presentation/         # NEW agent
│   ├── agent.json        # name=presentation, modes [ask, do]
│   ├── AGENT.md          # public identity (data, not instructions)
│   ├── .mcp.json         # ppt-master, marked x-agentmesh.readOnly:true,
│   │                     #   env.PPT_OUTPUT_DIR -> ./deliverables
│   ├── registry.json     # peers: knowledge, data-analyst, fracas, coder
│   └── deliverables/     # decks + HTML land here
└── mesh.json             # + presentation agent entry (peers: all four)
```

### Components

1. **`presentation/agent.json`** — A2A card mirroring siblings:
   `{ name: "presentation", protocolVersion: "1.0", version: "0.1.0", skills: [],
   x-agentmesh: { modes: ["ask","do"], meshVersion: "0.1.0" } }`.

2. **`presentation/AGENT.md`** — public description, read as **data**. States: produces
   company-standard deliverables; workflow docs → PPTX (company template), idea proposals →
   polished HTML; pulls content from peers; writes only under `deliverables/`.

3. **`presentation/.mcp.json`** — `ppt-master` moved out of the global file to here
   (Approach C scopes it to this agent). Entry: `type: stdio`, `command: python`,
   `args: ["C:/AI/MCP/PPT-master/server.py"]`,
   `env: { PPT_OUTPUT_DIR: "C:/AI/agents_mesh/my-mesh/presentation/deliverables" }`,
   `x-agentmesh: { readOnly: true }` (keeps `ask`-delegated PPT generation possible; the
   marker is irrelevant to `native`, which grants all servers regardless).

4. **`presentation/registry.json`** — marker-validated peer list (`x-agentmesh-generated`),
   same `command/args/cwd/env` shape as `coder/registry.json`, peers: `knowledge`,
   `data-analyst`, `fracas`, `coder`. Enables `ask`-mode "what do you know about X" pulls.

5. **`mesh.json`** — add the `presentation` agent entry (`served: true`,
   `enabledModes: ["ask","do"]`, `peers: [knowledge, data-analyst, fracas, coder]`).
   Optionally add `presentation` to the four peers' peer lists if reverse handoff is ever
   wanted — **out of scope now** (human-driven).

6. **Global `mesh/mcp.json`** — remove the `ppt-master` entry added earlier (now agent-local).

7. **`frontend-design`** — unchanged, stays in `mesh/skills/` (global), per Approach C.

## Data flow (typical run)

1. Human opens a `native` session on `presentation` (dashboard terminal / `claude` in folder).
2. Session reads `AGENT.md` identity; has `frontend-design` skill, `ppt-master` MCP, and
   `Write`/`Edit`.
3. For content it lacks, it `ask`s a peer (`delegate_to_peer` `mode: ask`) — e.g. asks
   `data-analyst` for yield numbers or `knowledge` for product facts.
4. **HTML proposal:** invokes `frontend-design`, writes `.html` into `deliverables/`.
5. **PPTX deck:** calls a `ppt-master` deck-generation tool, which renders into
   `deliverables/` (= `PPT_OUTPUT_DIR`).

## Known gap (explicitly out of scope here)

`PPT-master` is currently a **skeleton**: the only tool is `get_status`; there is **no
deck-generation tool yet** and **no `company_template.pptx`** in `templates/`. This design
wires the *capability structure* — HTML generation works immediately; **actual PPTX
generation is blocked until PPT-master gains generation tools + a company template.** That
build-out is PPT-master's own project, tracked separately, not part of this spec.

## Out of scope / YAGNI

- Building PPT-master's deck-generation tools and template (separate project).
- Automatic agent→agent presentation handoff (the peer bridge is `ask`-only; an agent cannot
  make `presentation` *write* a file). Revisit only if a real workflow needs it.
- Giving other agents PPT capability (Approach C deliberately scopes `ppt-master` to
  `presentation`).

## Exit criteria

- `presentation` agent appears in `mesh.json` and is served.
- `node` check: `assembleMcpServers` for `presentation` in `native`/`ask` includes
  `ppt-master`; for the other four agents it does **not** (scoped out of global).
- `resolveSkillPolicy` for `presentation` includes `frontend-design`.
- A `native` session in `presentation/` can `ask` a peer and write an `.html` into
  `deliverables/`.
- PPTX path verified once PPT-master has a generation tool (deferred).
