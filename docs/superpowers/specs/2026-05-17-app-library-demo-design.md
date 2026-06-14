# App→Library Real MVP Demo + One Real-`claude` Test — Design

**Date:** 2026-05-17
**Status:** Approved (brainstorm, revised after spec review), pending implementation

## Goal

Prove `agent-mesh` actually works with a *real* `claude` doing *real coding*:
a minimal App agent (A) delegates a real code change to a Library agent (B)
over the mesh, confined to B's folder. Demonstrated live (transcript + the
file B actually wrote captured as evidence), plus one automated real-`claude`
integration test for regression. Minimal new code.

## Decisions (locked during brainstorm + spec-review pushback)

- **Real proof, not stubs for the demo.** The demo is a live `claude` run,
  executed here, with the real transcript and B's real file diff captured.
- **Keep the 6 deterministic suites unchanged.** They are test doubles at the
  *one* impure boundary (the `claude` spawn) and are what makes the security
  invariants (path-guard denial, recursion cycle/depth, timeout-kill-tree,
  spawn_failed, change-detect) *unit-provable* — per PROJECT.md's pinned
  "safety logic is unit-provable" decision and CLAUDE.md's Invariants. A
  non-deterministic real-claude run cannot prove a security boundary (a pass
  may mean the model never attempted the adversarial path). Replacing them
  was rejected on technical grounds during spec review.
- **Add exactly one** real-`claude` integration test for the *happy path*,
  **auto-skipped** when `claude` is unavailable or the opt-in env flag is
  unset, so `npm test` stays hermetic/deterministic by default.
- **Scenario:** App (A) → Library (B); B owns a tiny `slugify` lib; A asks B
  (`do`) to add a small helper.
- **Minimal coding.** Smallest viable fixtures + a ~small materialize script;
  concise Test Design docs.

## Non-goals

- No change to `agent-mesh` runtime (`src/`, `bin/`, `hooks/`).
- No removal/weakening of existing suites.
- No always-on real-claude test in the default `npm test` path.
- No manual multi-step runbook (superseded — the demo is run here, once).

## Components (new files only)

### 1. `examples/agent-b/` — Library agent (folder B)

- `AGENT.md` — untrusted descriptive data: owns the string-utilities library
  in `lib/`; `ask` = explain the API, `do` = add/fix functions in `lib/`.
- `lib/strings.js` — one tiny zero-dep ESM module exporting `slugify(str)`
  (lowercase, trim, non-alphanumeric runs → single `-`, strip edge `-`).

### 2. `examples/agent-a/` — App agent (folder A, the caller)

- `AGENT.md` — A is a URL-builder app; it delegates string-utility work to
  the library peer (steers the model to delegate rather than self-do).
- `.mcp.json.template` — peer wiring with `__AGENT_MESH_BIN__` /
  `__AGENT_B_ROOT__` placeholders (committed file has no machine paths).

### 3. `scripts/demo-setup.mjs` — materialize script (zero-dep, small)

`node scripts/demo-setup.mjs [target-dir]`: copy both `examples/agent-*` into
a fresh workspace (default under `os.tmpdir()`), `realpath` both, `git init` +
one initial commit in `agent-b` (clean tree → `preexisting_dirty:false`),
render `agent-a/.mcp.json` from the template with this machine's absolute
realpaths (repo `bin/agent-mesh.js` + workspace `agent-b`). Prints the
workspace path and the exact `claude` command. Never spawns `claude`.

### 4. `test/demo-e2e.test.js` — one real-`claude` integration test

`node:test`. **Skips** (not fails) unless `AGENT_MESH_E2E=1` AND `claude` is
on `PATH` (`claude --version` succeeds). When enabled: run `demo-setup.mjs`
into a tmp workspace, spawn the real `claude -p` in `agent-a` wired to the
peer, instruct it to have the peer add `truncateSlug` to `lib/strings.js`,
then assert: `agent-b/lib/strings.js` now contains `truncateSlug`; the change
is in **agent-b only**; an agent-mesh run log exists under
`agent-b/.agent-mesh/logs/`. Generous timeout; on skip it prints why.

### 5. PROJECT.md `## Test Design` (concise) + `## Changelog`

Short ```mermaid``` map: *pure core* (ContextGuard, Contract, Description,
PathGuard) + *thin shell* (Delegate, McpServer) — the deterministic
safety/invariant layer — and a separate `RealE2E (opt-in)` node fed by
`examples/` + `demo-setup.mjs`. One-paragraph card per group (not per-assert
exhaustive — minimal). State explicitly: deterministic suites prove the
security invariants; the opt-in real test proves the live happy path; the two
layers are complementary, not substitutes. Add a Changelog line.

## The live proof (executed here, once)

1. `node scripts/demo-setup.mjs` → workspace `<ws>`.
2. From `<ws>/agent-a`, run the real `claude -p` wired to the peer with a
   prompt to have the library peer add `truncateSlug(str, max)` to its
   strings lib.
3. Capture as evidence in the final report: (a) A's result/summary, (b) the
   real diff of `<ws>/agent-b/lib/strings.js`, (c) confirmation
   `<ws>/agent-a` was not written, (d) the agent-mesh log path/contents.
4. If the live run cannot complete (auth/tool-permission/model-choice), report
   the failure honestly with the captured output — do not claim success.

## Error handling / edge cases

- `demo-setup.mjs`: refuse non-empty target without `--force`; if `git`
  missing, note `files_changed` would be `null` and continue.
- Integration test: skip cleanly (exit 0, printed reason) when disabled or
  `claude` absent — never a false CI failure.
- `.mcp.json` always written with realpath-absolute paths (agent-mesh
  identity is realpath-canonical).
- Headless `claude -p` for A must be allowed to call the MCP delegate tool;
  the exact flags are resolved during the live run and recorded in the test.

## Testing strategy

- Unchanged: the 6 deterministic suites remain the security-invariant proof.
- Added (opt-in): `test/demo-e2e.test.js` proves the real happy path on
  demand; skipped by default to keep `npm test` hermetic.
- Live: the one-time real run here is the "show it works" evidence.

## File manifest (new)

- `examples/agent-a/AGENT.md`
- `examples/agent-a/.mcp.json.template`
- `examples/agent-b/AGENT.md`
- `examples/agent-b/lib/strings.js`
- `scripts/demo-setup.mjs`
- `test/demo-e2e.test.js`
- PROJECT.md — concise `## Test Design` + `## Changelog` (edit)
