# Reusable Eval Agent Fixtures — Design

## 1. Goal

The eval scenarios (`eval/scenarios/*`) build their agents **inline** in a temp
dir via `h.buildMesh({ agents: { … } })` — perfect for the hermetic scorecard
harness, but invisible and un-runnable by hand. There was no **reusable,
standalone** set of agent folders a developer (or a real `claude`) could
materialize and drive directly to reproduce a behavior, demo the mesh, or sanity
-check a change end to end.

This spec adds two **reusable agent fixtures** — a **pair** and a **trio** —
that together exercise every behavior the eval scorecard probes, plus the
framework's own wiring path (`init-mesh → add → doctor`), plus an opt-in
real-`claude` smoke test over the live **stdio A2A** peer-bridge.

The design constraint that governs everything here: **the agent↔agent protocol
stays stdio** (`serve-a2a` + the `agentmesh_peerbridge` stdio MCP server). These
fixtures consume the protocol; they never change it.

## 2. Non-goals

- **Not a CI gate.** The real-`claude` e2e is opt-in (`AGENT_MESH_E2E=1`) and
  POSIX-only, exactly like `test/demo-e2e.test.js`. `npm test` stays hermetic.
- **Not a replacement for the inline scenarios.** `eval/scenarios/*` remain the
  scorecard's ground truth. These fixtures are a *runnable, reproducible*
  companion, not the scoring harness.
- **Not a new protocol or transport.** No change to `serve-a2a`, the wire, the
  peer-bridge surface, recursion threading, or the path-guard.
- **Not `do`-mode onward delegation.** The peer-bridge is ask-only in v1, so the
  trio's onward-delegation chain is ask-mode. `do`-mode writes are covered by the
  pair (single hop) and by `test/demo-e2e.test.js` (MCP-compat path).

## 3. Fixtures

### 3.1 The pair — `examples/eval-pair/{app,lib}`

Single-hop driver + peer.

- **`app`** (driver) — the agent a human/CLI talks to. Owns nothing domain
  -specific; answers trivial self-questions directly; delegates catalog/string
  work to `lib`.
- **`lib`** (peer) — owns the canonical shelf-code records
  (`data/shelf-codes.md`, **fixed** values so assertions are stable) and a
  writable string-utils library (`lib/strings.js`, seeded with `slugify`).
  ask + do modes.

Topology: `app → lib`.

### 3.2 The trio — `examples/eval-trio/{app,lib,docs}`

Adds the third agent needed for the two scenarios a pair cannot express.

- **`app`** (driver) — peers `[lib, docs]`; routes catalog questions to `lib`,
  release-note/documentation requests to `docs`.
- **`lib`** (leaf peer) — same catalog + strings owner as the pair's `lib`.
- **`docs`** (middle hop) — owns release-note prose/templates but **no** shelf
  data; peers `[lib]`; must onward-delegate to `lib` for any shelf code.

Topology:

```
        app   (routes to the right peer)
       /   \
     lib   docs
      ^      |
      └──────┘   docs onward-delegates to lib
```

## 4. Coverage matrix

Every behavior the scorecard probes maps to a runnable command. "Fixture" is the
minimum fixture that expresses it.

| # | Scenario | Fixture | How |
|---|----------|---------|-----|
| 01 | should-delegate | pair | ask `app` for a shelf code only `lib` knows |
| 02 | should-not-delegate | pair | ask `app` a trivial self-question |
| 03 | peer-selection | **trio** | catalog Q → `lib`; release-note Q → `docs` |
| 05 | multi-turn-memory | pair | two-turn session; turn 2 resolves from memory |
| 06 | reset-semantics | pair | fresh session cannot answer turn 2 |
| 07 | two-hop-chain | **trio** | `app → docs → lib` for a note incl. shelf code |
| 08 | refusal-is-data | pair | ask `lib` an out-of-scope task → structured refusal |
| 09 | do-write-lands | pair | `app` → `lib` adds a helper in its own folder |
| 10 | do-edit-existing | pair | `app` → `lib` edits existing `slugify` |
| 11 | do-out-of-root-denied | pair | drive `lib` to write outside its root → denied |
| 12 | ask-cannot-write | pair | ask-mode `lib` cannot modify a file |

Scenario 04 (roster-A/B) is an eval-only env seam, not a hand-runnable behavior.

## 5. Materialization

Each fixture ships a setup script (`scripts/eval-pair-setup.mjs`,
`scripts/eval-trio-setup.mjs`) that materializes a **disposable, doctor-wired**
workspace using the framework's own commands — not hand-rolled JSON:

```
init-mesh <ws>
add <ws> <src>/app  --modes ask,do --apply
add <ws> <src>/lib  --modes ask,do --apply
[trio] add <ws> <src>/docs --modes ask,do --apply
patch mesh.json: app.peers=[…]; [trio] docs.peers=['lib']
doctor <ws> --apply        # generates registry.json + syncs agentmesh_peerbridge .mcp.json
git init + seed commit per agent   # canonical files_changed / clean baseline
```

The single manual edit is **peering** (`add` leaves `peers: []`); everything
else — marker'd `registry.json` whose peer entries are `serve-a2a` (stdio)
spawns, the `agentmesh_peerbridge` stdio MCP entry in each delegating agent's
`.mcp.json`, anatomy scaffolding — is produced by `doctor`. Scripts print the
agent roots and the exact `claude -p "…"` commands; they never spawn `claude`.

Each is idempotent under `--force` and refuses a non-empty target otherwise,
mirroring `scripts/demo-setup.mjs`.

## 6. Real-`claude` e2e

`test/eval-mesh-e2e.test.js` — opt-in (`AGENT_MESH_E2E=1`), POSIX-only (same
spawn/skip discipline and rationale as `test/demo-e2e.test.js`; on Windows it
skips and `scripts/live-a2a-check.mjs` is the equivalent). It materializes a
fresh trio per test and drives `app` headlessly through its doctor-wired bridge:

- **peer-selection** — ask for a shelf code; assert the answer carries `DUNE-7F`,
  `lib` recorded a delegate run, and `docs` did **not** (the selection property).
- **two-hop chain** — ask `docs` (via `app`) to draft a release note including
  the shelf code; assert the relayed note carries `DUNE-7F`, **both** `docs`
  (hop 1) and `lib` (onward hop 2) recorded runs, and no path-guard denial was
  logged anywhere (confined ask-only happy path).

"An agent ran" is read from `<root>/.agent-mesh/logs/delegate-*.jsonl` — the same
run-log evidence the scorecard uses, not answer-text heuristics. Worker tasks are
phrased **functionally** ("ask the docs agent…"), never by internal tool name, to
avoid the headless first-turn MCP enumeration race (CLAUDE.md lesson).

## 7. Invariants

- **stdio protocol untouched.** Peer transport is `serve-a2a` over stdio; onward
  delegation is the `agentmesh_peerbridge` stdio MCP server. No wire/protocol
  change.
- **Framework-owned wiring.** Registries/`.mcp.json` are generated by `doctor`,
  carry the `x-agentmesh-generated` marker, and are regenerable; the fixtures
  never hand-author managed files.
- **Deterministic ground truth.** Shelf codes are fixed; `docs` owns no shelf
  data, forcing the onward hop; assertions key on stable tokens + run-log edges.
- **Hermetic by default.** The e2e skips without `AGENT_MESH_E2E=1`; the
  fixture/setup correctness tests are pure (no `claude`).

## 8. Testing

- `test/eval-pair.test.js` — source folders well-formed; setup produces a
  marked, stdio-A2A, doctor-idempotent mesh (`app` peers `[lib]`).
- `test/eval-trio.test.js` — source folders well-formed; setup produces the
  peer-selection + two-hop topology (`app`→`[lib,docs]`, `docs`→`[lib]`, `lib`
  leaf), all stdio `serve-a2a`, doctor-idempotent.
- `test/eval-mesh-e2e.test.js` — opt-in real-`claude` peer-selection + two-hop.

## 9. File inventory

```
examples/eval-pair/app/{AGENT.md,agent.json}
examples/eval-pair/lib/{AGENT.md,agent.json,data/shelf-codes.md,lib/strings.js,memory/*}
examples/eval-pair/README.md
examples/eval-trio/app/{AGENT.md,agent.json}
examples/eval-trio/lib/{AGENT.md,agent.json,data/shelf-codes.md,lib/strings.js,memory/profile.md}
examples/eval-trio/docs/{AGENT.md,agent.json,templates/release-note.md}
examples/eval-trio/README.md
scripts/eval-pair-setup.mjs
scripts/eval-trio-setup.mjs
test/eval-pair.test.js
test/eval-trio.test.js
test/eval-mesh-e2e.test.js
```
