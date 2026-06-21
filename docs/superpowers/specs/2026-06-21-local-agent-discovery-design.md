# Local Agent Discovery + One-Click Deploy — Design

## 1. Goal

Realize the PRD's deployment promise end-to-end: *"on any local deployment,
**one-click generate and recognize local agents**, and join them into the mesh
according to project need."* Two pieces: a read-only `discover` primitive that
**recognizes** local agent folders, and a `deploy` command that **one-click
joins** the new ones (discover → add → doctor). Today wiring an agent into a mesh is
fully manual — the operator must already know each folder path and run
`agent-mesh add <mesh> <folder> --apply` per agent, then `doctor --apply`. There is
**no** code that scans a checkout to find which folders are agents (confirmed: no
`scan`/`find` verb, no tree walk in `src/builder/`). This adds a read-only
`discover` primitive that recognizes candidate agent folders, so an operator (or a
future one-click `deploy` wrapper) can wire them in without hand-enumerating paths.

## 2. Non-goals

- **No mutation.** `discover` only reads the filesystem — it never copies,
  registers, scaffolds, or edits `mesh.json`. Discovery **proposes**; the operator
  runs `add`/`doctor` (which keep their existing dry-run-by-default safety). This
  preserves "mesh.json is the authoring source of truth" — we never silently
  enroll a folder.
- **No peer-graph inference.** `discover`/`deploy` report and wire folders, not
  edges. Who delegates to whom stays an explicit authoring decision (the operator
  edits peers, or a follow-up infers them).
- **`deploy` is dry-run by default and adds no new mutation kind** — see §7.

## 3. What marks a folder as an agent candidate

A directory directly containing any of (strongest → weakest signal):

| marker | confidence | rationale |
|---|---|---|
| `agent.json` | `high` | the conformance-required agent card |
| `prompts/system.md` | `medium` | the runtime system prompt |
| `AGENT.md` | `low` | human-readable description only |

`confidence` is the strongest marker present. All present markers are reported, so
an operator can see how "complete" a candidate is before promoting it.

## 4. Mechanism

`src/builder/discover.js` → `discoverAgentCandidates(scanRoot, { maxDepth=4, meshRoot })`:

- Bounded-depth walk of `scanRoot`. Prunes noise dirs (`node_modules`, `.git`,
  `.claude`, `dist`, `build`, `vendor`, …), any dot-dir, and the mesh substrate
  (`mesh/`, `.agent-mesh`, `.dev-society`) so a real checkout scan stays fast and
  doesn't surface vendored or generated folders.
- **A matched candidate is a leaf** — the walk does not descend into it, so an
  agent's own `prompts/` or subfolders are never mis-reported as separate agents.
- When `meshRoot` is given, each candidate is annotated `alreadyInMesh` by
  comparing its absolute path against the `agents[].root` set resolved from
  `<meshRoot>/mesh.json` (best-effort; a missing/invalid manifest just leaves the
  annotation off).
- Never throws: a missing/empty scan root → `[]`.

CLI: `agent-mesh discover <scan-root> [--mesh <mesh-root>] [--depth N] [--json]`.
Human output lists each candidate (confidence · in-mesh/new · markers · path);
`--json` emits the raw array for scripting; `--mesh` appends the copy-paste
`add`/`doctor` wire-in commands for the new candidates. Read-only, exit 0 on
success (data, not a gate).

## 5. Safety / invariants

- **Read-only**, so it touches none of the write-boundary invariants — it spawns no
  `claude`, opens no MCP server, and writes nothing. It is safe to run from any cwd
  against any tree.
- **`AGENT.md` stays untrusted data** — `discover` only checks for its *existence*;
  it never reads, parses, or obeys its contents (consistent with the AGENT.md-as-data
  invariant).
- **No silent enrollment** — finding a folder does not add it; the operator's
  explicit `add --apply` remains the only path into the manifest.

## 6. One-click deploy

`src/builder/deploy.js` → `deployMesh(scanRoot, { meshRoot, apply=false, modes=['ask'], maxDepth })`,
CLI `agent-mesh deploy <scan-root> --mesh <mesh-root> [--modes ask,do] [--depth N] [--apply]`:

1. **Ensure substrate** — if `<meshRoot>/mesh.json` is absent, `initMesh` it
   (creating the root dir). Dry-run reports `would-init` and creates nothing.
2. **Discover** candidates under `scanRoot`.
3. **Add** each new, out-of-tree candidate via `add(meshRoot, path, { modes, apply })`.
   - **Idempotent by name**: a candidate whose name is already a manifest agent is
     skipped (re-deploy is safe). `add` copies a source folder to a dest *inside*
     the mesh and keys the manifest by name, so dedup is name-keyed, not path-keyed.
   - A candidate **physically under the mesh root** is reported for `join` (copying
     it into itself is nonsense), not added.
   - One agent's `add` throwing is captured in `errors[]` and never aborts the rest.
4. **Doctor** once to sync registries / peer-bridges / SessionStart hooks.

Returns a structured plan/outcome (`initialized`, `added[]`, `alreadyInMesh[]`,
`skippedInTree[]`, `errors[]`, `doctor`). Real smoke: `deploy dev-mesh --mesh <tmp>`
(dry-run) plans to init a fresh mesh and add all 9 dev-mesh agents.

## 7. Safety (deploy)

`deploy` is a **thin orchestrator** — it introduces no new mutation kind. Every
write goes through `add` / `doctor` / `initMesh`, which keep their dry-run-by-
default semantics, managed-wiring markers, and the single-writable-root model
(`add` copies into the mesh root only; `doctor` only regenerates Managed files).
Default is dry-run; `--apply` is required to write. No silent peer wiring, no
auto-merge of authored files.

## 8. Tests (hermetic, temp fixture trees)

`test/discover-agents.test.js`: marker detection (all three kinds); confidence
ranking; noise-dir + mesh-substrate pruning; candidate-is-a-leaf (no descent);
`maxDepth`; `alreadyInMesh` annotation vs a manifest; absolute + name-sorted
results; empty/missing root → `[]`. Plus CLI-level: `--json` array, `--mesh`
suggests `add`/`doctor` for new-only, missing-arg → nonzero exit.

`test/deploy-mesh.test.js`: dry-run plans init+adds and writes nothing; apply
initializes + adds + runs doctor (manifest grows); re-apply is name-idempotent (no
duplicate entry); in-tree candidate reported for `join`; CLI requires `--mesh` and
dry-runs by default.
