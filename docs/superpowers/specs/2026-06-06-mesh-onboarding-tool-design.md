# Mesh Onboarding & Maintenance Tool — Design

- **Date:** 2026-06-06
- **Status:** Approved — design + 5-round independent Codex co-review (§13),
  accepted post-cap. Build in 3 increments, substrate first.
- **Branch:** v1.0-development

## 1. Goal (the reframe)

The product is **the tool that builds a mesh and onboards existing agent folders
into it** — and keeps them conformant as they evolve. The A2A contract + runtime
(`serve-a2a`, `delegate`, the five boundaries) are not the deliverable per se;
they are the **target the onboarding tool writes toward and validates against.**

Concretely: a user points the tool at a folder they already work in and, in one
ask, it becomes a mesh-recognized agent — without losing the ability to run
standalone, and without drifting out of conformance later.

This adds **Layer 0 — Onboarding** *above* the existing PROJECT.md layers
(Contract → Reference Impl → Eval Harness). The lower layers are not rewritten.

## 2. Chosen model (decisions that got us here)

- **Scope:** one design, two coupled builders (`init-mesh` substrate + `add`
  converter), plus a maintenance layer (`validate`/`doctor`). Built in 3
  sequenced increments, substrate first.
- **Delivery:** a deterministic, testable **CLI engine** (`agent-mesh
  init-mesh|add|validate|doctor`) wrapped by a **Claude Code skill** that is the
  "just ask" conversational surface (does identity inference + gap questions,
  calls the CLI).
- **Topology:** `mesh.json` is the **authoring source of truth**; per-agent
  `registry.json` is **generated** from it. The runtime still reads only
  per-agent `registry.json` — the manifest is never a runtime broker, so the
  "no broker" invariant holds.
- **Agent location:** **in-tree** — `add` **copies** the folder under the mesh
  root (copy-only in v1; no `--move`), so the mesh is one portable directory and
  the global `mesh/` layer resolves by walk-up (bounded by the ceiling).
- **Identity:** **infer-first, ask-on-gaps** — the skill reads the folder's
  `AGENT.md`/`README`/`CLAUDE.md`/code to draft `prompts/system.md` + `agent.json`;
  asks only for what it can't infer (name, one-line role, modes).
- **Maintenance:** a `serve-a2a` startup **self-check** (warn by default,
  `--strict` to refuse) + explicit `validate`/`doctor` commands; standard
  version stamped via `meshVersion`.
- **Capabilities vs. policy (mode ownership, sharpened).** Two distinct owners:
  - **`agent.json` declares supported *capabilities*** — what the agent *can* do
    (e.g. `x-agentmesh.modes: ["ask","do"]`, its skills/tools, the standard
    version it was built against). Set by the agent author / inference.
  - **`mesh.json` declares enabled *policy*** — what is actually *turned on* for
    this agent in *this* mesh (which supported modes are enabled in cowork, which
    peers, served or not). Owned by the mesh.
  - **Rule:** the mesh can only *enable a subset* of what the agent *supports* —
    it can't grant a mode the agent doesn't declare, and may disable a supported
    one. "Mode is mesh-controlled" means **the mesh chooses the enabled policy
    from the agent's declared-supported set.** The agent folder stays
    mode-agnostic at the behavior level and always standalone-runnable; switching
    cowork ↔ standalone is a mesh operation (`join`/`leave`), never a folder edit.

## 3. Control plane / data plane split

- **Agent folder = capability unit** — identity, tools, memory, prompts,
  workflows, skills. Mode-agnostic. The user evolves it freely; it runs alone.
- **Mesh (`mesh.json`) = control plane** — membership, topology (who may call
  whom), spawn config, mode. Generates the runtime wiring (`registry.json`).
- **Runtime = data plane** — `serve-a2a` + `delegate` execute delegations,
  reading only per-agent `registry.json`. Unchanged by this work.

## 4. The substrate — `init-mesh <mesh-root>`

Creates (nothing that runs continuously — consistent with "no broker"):

```
<mesh-root>/
  mesh.json          # the manifest (authoring source of truth)
  mesh/
    skills/          # global shared skills — INHERITED as TRUSTED prompt config, ceiling-bounded (see 4.1)
    mcp.json         # global tool declarations — DECLARED ONLY, NOT inherited in v1 (see 4.1)
  README.md          # how this mesh works
```

The mesh root is the parent of `mesh/` and the `AGENT_MESH_MESH_CEILING`, so
member agents placed under it resolve the shared `mesh/skills` layer via walk-up,
bounded by the ceiling. This is exactly the structure `resolveMeshRoot` already
expects.

### `mesh.json` schema — the **manifest** (authoring config; never read at runtime)

The manifest is **declarative and portable**: it does NOT contain spawn paths or
env. Those are *generated* into each `registry.json` (§4.3) — keeping the two
shapes separate is what lets `root` stay mesh-relative.

```json
{
  "x-agentmesh-generated": true,
  "meshVersion": "0.1.0",
  "defaults": { "transport": "stdio" },
  "agents": [
    {
      "name": "library",
      "root": "./agent-b",
      "card": "agent.json",
      "served": true,
      "enabledModes": ["ask"],
      "peers": []
    }
  ]
}
```

- `x-agentmesh-generated: true` — the top-level ownership marker (§5.1); the whole
  manifest is the tool's artifact.
- `root` is **mesh-relative** in the manifest (portable on disk). The generator
  derives spawn paths + env from `root` + the mesh bin + policy — **the manifest
  carries no spawn block.** See §4.3 for the generated shape.
- `peers` is the explicit edge list — which agents this agent may call. Empty by
  default (no full-mesh). Per-agent `registry.json` is generated from `peers`.
- `served` — whether the mesh stands this agent up at all (`false` → not wired,
  not served).
- `enabledModes` — **the enabled policy** (§2): the subset of the agent's *supported*
  modes (`agent.json` → `x-agentmesh.modes`) that this mesh turns on. `manifest.js`
  and the conformance checker reject any `enabledModes` not ⊆ supported.

### 4.1 Global skills vs. global MCP (asymmetric risk)

These two global layers are **not** equivalent and must be treated differently:

- **`mesh/skills/` → inherited as TRUSTED prompt instructions.** Skill summaries
  are composed into the worker's *obeyed* system prompt, so they can influence its
  reads, writes, and tool use — they are **trusted configuration, not "harmless
  text."** Treat the global `mesh/` like the agent's own `prompts/`: its provenance
  must be bounded. The walk-up is capped by `AGENT_MESH_MESH_CEILING` (= the mesh
  root, projected into the spawn — §4.2); the threat model is PROJECT.md §1.5; and
  `conformance` validates the resolved mesh root is the expected one.
- **`mesh/mcp.json` → DECLARED ONLY, NOT inherited in v1.** A shared *tool grant*
  is an escalation surface: an agent would silently gain tools it never declared,
  defeating Boundary 4 ("declarations are not grants" — and not even the agent's
  own declarations). **v1 rule:** `mesh/mcp.json` is a human-readable *registry of
  shared tools for discovery only*; the per-task `mcpSurface` grant is unchanged —
  a worker still receives **only** its own folder's `readOnly`-marked `.mcp.json`
  servers. The conformance checker asserts no agent's grant is widened by
  `mesh/mcp.json`.
- **Future (opt-in inheritance):** if global MCP is ever inheritable, it requires
  an explicit per-agent opt-in *and* a stated threat boundary (which tools, marked
  read-only, sandboxed) — same gate as re-enabling `Bash`/`do`-MCP. Out of scope
  for v1.

### 4.2 Projecting policy into the data plane (how `serve-a2a` enforces it)

`message/send` mode acceptance is a **two-layer gate**, so capability is enforced
even with no mesh:

1. **Capability gate (always on).** `serve-a2a` loads the folder's `agent.json` and
   **always rejects** a request whose `agentmesh/mode` ∉ `x-agentmesh.modes` — even
   standalone (env unset). This is the agent's own declared surface; nothing can
   exceed it. `buildAgentCard` is updated to reflect `agent.json` modes rather than
   a hardcoded `[ask, do]`, so the served card never drifts from authored capability.
2. **Policy gate (when enabled by a mesh).** The runtime must never read `mesh.json`
   (no broker), so the mesh **projects** policy into the generated spawn env:
   - `AGENT_MESH_ENABLED_MODES` — **presence-aware** to avoid the empty-vs-unset
     footgun: the variable being **absent** means "no mesh policy" (standalone keeps
     full declared capability); the variable being **present** narrows to exactly
     its (possibly empty) comma list — present-but-empty therefore means **no modes
     allowed**, not "no gating." `manifest.js` additionally **requires every
     `served:true` agent to have a non-empty `enabledModes`** (a served agent that
     accepts nothing is a config error), so empty only arises from a deliberate
     non-served/disabled state.

Either rejection returns a `rejected` Task (`error_code: mode_disabled`), like the
existing `readonly_parent` gate. Capability ⊇ policy always holds (`manifest.js`
rejects `enabledModes` ⊄ `x-agentmesh.modes`).

- `AGENT_MESH_MESH_ROOT` (= `<mesh-root>/mesh`) — **explicitly pins** the trusted
  global layer, projected into the spawn so resolution does **not** rely on the
  walk-up. This closes the shadowing hole: a nested `agent/mesh/` can no longer be
  picked up as the global layer (`resolveMeshRoot` honors the `AGENT_MESH_MESH_ROOT`
  override first). Conformance/server **reject any resolved mesh root other than the
  expected** `<mesh-root>/mesh`.
- `AGENT_MESH_MESH_CEILING` (= the mesh root) — belt-and-suspenders: bounds the
  walk-up as a fallback if the explicit root is ever unset, so resolution can never
  climb above this mesh.

Every runtime fact thus travels out-of-band (agent.json in-folder + spawn env) and
is enforced at the server; `registry.json` stays purely about peers.

### 4.3 The generated `registry.json` (the consumed shape)

`mesh.json` is the *portable manifest*; `registry.json` is the *generated runtime
artifact* the A2A client (`src/a2a/stdio-client.js` / `registry.js`) actually
reads. `manifest.js` derives one per agent from the manifest, using the
**canonical absolute agent root** for `args` and `cwd` (matching the client, which
spawns each peer with `cwd = peer.root`) and projecting policy env (§4.2):

```json
{
  "x-agentmesh-generated": true,
  "peers": {
    "catalog": {
      "root": "/abs/mesh/catalog",
      "command": "node",
      "args": ["/abs/bin/agent-mesh.js", "serve-a2a", "/abs/mesh/catalog"],
      "cwd": "/abs/mesh/catalog",
      "env": {
        "AGENT_MESH_ENABLED_MODES": "ask",
        "AGENT_MESH_MESH_ROOT": "/abs/mesh/mesh",
        "AGENT_MESH_MESH_CEILING": "/abs/mesh"
      }
    }
  }
}
```

So the two schemas are distinct: **manifest = declarative + mesh-relative**;
**registry = generated + canonical-absolute + carries the projected env** in the
exact shape the client consumes. A registry-spawn test (§10) asserts a generated
entry actually spawns and answers `initialize`. (Per-peer `env` must be wired
through to the spawned `serve-a2a`; if the current client doesn't pass per-peer
`env`, Increment 2 extends it to.)

## 5. The converter — `add <mesh-root> <agent-folder> [--name X] [--peers a,b] [--apply]`

Engine steps, in order. By default `add` runs **dry-run first**: it prints the
full plan (files to copy, gaps to scaffold, identity proposal, manifest/registry
changes) and writes nothing until confirmed (`--apply`). Deterministic operations
(copy, manifest, registry generation) proceed on that confirmation. **Inferred
identity is different: it always requires explicit user approval** — the skill
must surface the drafted `prompts/system.md` + `agent.json` and get a clear yes
(or edits) before they are written. The skill may *not* approve inferred content
on the user's behalf (§5.3).

1. **Discover** — `discoverAgentStructure(folder)` reports anatomy present vs.
   missing (reused; already built).
2. **Place in-tree** — **copy** the folder to `<mesh-root>/<name>/` under the
   **migration policy in §5.2** (ignore rules, no `.git`, symlink handling,
   collision behavior). v1 is **copy-only** — the original is left untouched (no
   `--move`: deleting a source after an ignore-filtered copy risks losing omitted
   files; see §5.2). `name` = `--name` or inferred.
3. **Propose identity** (skill drives) — read `AGENT.md`/`README`/`CLAUDE.md`/code
   → *draft* `prompts/system.md` + `agent.json` (description, skills, supported
   modes); ask the user only for gaps. **This output is a reviewed proposal, never
   written silently — see §5.3.**
4. **Scaffold gaps only** (idempotent) — the pure `scaffold.js` returns content
   for *missing* anatomy: `agent.json`, `AGENT.md` (if absent), `prompts/system.md`
   (+`ask.md`/`do.md`), `.mcp.json` declaring any `tools/<x>/server.mjs`. A grant
   is sensitive, so **inferred tool declarations are written UNMARKED by default**
   (declared but not grantable in `ask`); the `readOnly` marker is added **only on
   explicit user confirmation per tool** — never auto-detected. **Never clobber**
   existing files; ownership rules in §5.1. Create `memory/`/`workflows/`/`skills/`
   only if used.
5. **Register** — upsert the agent's entry in `mesh.json`.
6. **Wire** — (re)generate each affected agent's `registry.json` from `mesh.json`
   (`manifest.js`). `registry.json` is a **managed/generated artifact** (§5.1);
   edges come from `peers` (explicit; default none). **If an agent already has a
   markerless (Authored) `registry.json`, `add`/`join` does NOT overwrite it
   silently** — it stops and requires explicit user confirmation to replace it
   (backing the file up first), or the agent stays standalone. Cowork requires
   mesh-generated wiring, so a stale authored registry must never silently shadow
   `mesh.json` as the source of truth.
7. **Validate** — spawn `serve-a2a <agent>`, send `initialize`, assert the
   AgentCard builds and the name matches; report PASS + diagnostics.

**Idempotence:** re-running `add` refreshes managed files and fills new gaps but
never overwrites authored content — safe on bare, half-converted, or
already-converted folders. The ownership model (§5.1) is what makes this precise.

### 5.1 File ownership & authority

Every file the tool touches falls in exactly one class, so `add`/`leave`/`doctor`
know what they may rewrite:

- **`mesh.json` — the manifest, wholly tool-owned (per-entry edits).** The entire
  `mesh.json` *is* the tool's authoring artifact (top-level
  `"x-agentmesh-generated": true`); it is never partly hand-authored. The tool
  owns the whole file and edits the `agents[]` array **by entry**: `add` upserts
  one entry, `leave` removes one. (This is the one place per-entry editing is
  intended — and it's safe precisely because the whole file is the tool's, not a
  mix of authored + generated content.)
- **`registry.json` — Managed, WHOLE-FILE, per agent.** Carries
  `"x-agentmesh-generated": true`. Ownership is **whole-file, binary**: marker
  present → the tool may overwrite or delete the *entire* file; marker absent → it
  is **Authored** and the tool **never silently touches it** (see the join rule in
  §7). No managed-section / partial-rewrite model.
- **Seeded (created once if missing, then authored).** `prompts/*`, `agent.json`,
  `AGENT.md`, `.mcp.json`. The tool writes them **only when absent**; once they
  exist they belong to the human. `add` never clobbers them; `doctor` only
  *suggests* changes (or warns), never overwrites. **Existing-but-partial files**
  (e.g. an `agent.json` missing required `x-agentmesh.modes`/`meshVersion`, or a
  `tools/<x>` not yet declared in `.mcp.json`) are the common onboarding case: the
  tool does **not** edit them in place — it emits a **proposed patch** (§5.3) that
  the user explicitly applies. This gives existing seeded files a deterministic,
  confirmed, still-non-clobbering update path.
- **Authored (never touched).** Everything else in the folder — the user's code,
  data, memory content.

**Rule:** the tool rewrites only **Managed** files. A Managed file missing its
marker (e.g. a human hand-wrote `registry.json`) is treated as **Authored** — the
tool refuses to overwrite and warns instead. This is what lets a standalone agent
keep a hand-authored `registry.json` safely (see §7).

### 5.2 Copy / migration policy

Copying a real working folder must not drag in junk, secrets, or escape hatches.
v1 is **copy-only** (no `--move`): an ignore-filtered copy *omits* files, so
deleting the source afterward could destroy omitted-but-wanted files — too unsafe
for v1. The original always stays put; the user can delete it themselves.

- **Dry-run by default** — the plan (above) prints the copy manifest before any write.
- **Two-tier ignore rules:**
  - **Non-overridable safety denylist** (never copied, no flag, no exception):
    `.git/`, `.env*` / secret patterns (keys, `*.pem`, credentials), build/output
    dirs, `node_modules/`, OS junk (`.DS_Store`). `.git` is excluded so the in-tree
    agent carries no source history; **secrets are excluded unconditionally — there
    is no per-path override** (if a user truly needs a secret in the agent, they add
    it by hand after, outside this tool). `add` *reports* what it excluded.
  - **`.gitignore` tier (overridable):** other `.gitignore`d paths are skipped by
    default; `--include-ignored` may re-include *these* — but it can **not** reach
    the safety denylist above.
- **Symlinks** — by default **skipped with a warning** (they can escape the tree).
  `--copy-symlinks` opts in but is precisely bounded: a link is **preserved as a
  symlink only if its realpath resolves inside the source folder** (a relative,
  in-tree link); out-of-tree or unresolvable links are still skipped, and links
  are **never followed** (no copying the target's contents). Tested both ways (§10).
- **Collision** — if `<mesh-root>/<name>/` already exists and is non-empty, `add`
  **refuses** unless `--force`; it never silently overwrites destination files.

### 5.3 Inference is a reviewed proposal (deterministic engine ≠ probabilistic skill)

The CLI engine is deterministic; the skill's identity inference is probabilistic.
That boundary is explicit: **inferred identity is never written by inference.** The
skill produces a *proposal* (drafted `prompts/system.md` + `agent.json`); the user
reviews/confirms (or edits) it; only then does the deterministic CLI write it via
`scaffold.js`. Non-interactive use saves the proposal as `*.proposed` files (a
patch to apply), so an unattended run never commits unreviewed inferred content.

## 6. Maintenance — `validate` / `doctor` + serve self-check

### Conformance rule-set (pure `conformance.js`)

`(folder snapshot [, mesh snapshot]) → report` with pass/warn/fail per rule:

| Rule | Check |
|---|---|
| **Anatomy** | required files present (`agent.json`, `prompts/system.md`), structure well-formed |
| **Tools** | every `tools/<x>/server.mjs` is declared in `.mcp.json`; `readOnly` markers sane; no dangling declarations |
| **Card** | `agent.json` valid + `buildAgentCard` succeeds + matches the folder |
| **Wiring** (mesh) | the agent's `registry.json` equals what the manifest would generate; manifest ↔ on-disk folders consistent (no renamed/moved/missing members); **every `peers[]` target is a live edge — it must name an existing agent with `served: true`** (a peer to a missing or `served:false` agent is a `fail`) |
| **Boundaries** | the five boundaries hold structurally (`AGENT.md` not wired as a prompt; protected paths intact) |
| **Global-layer pin** | the resolved global mesh layer equals the expected `<mesh-root>/mesh` (`AGENT_MESH_MESH_ROOT`); a nested `agent/mesh/` shadowing it, or any other resolved root, is a `fail` (§4.2) |
| **Root containment** | every `agents[].root` canonical realpath resolves **inside** `<mesh-root>` (in-tree topology, §2); a root escaping the mesh is a `fail`. `manifest.js`/`join` refuse an external target — it must route through copy-only `add` instead |
| **Standalone-runnable** | Partly checkable, not fully provable. **fail** when EITHER the agent declares a non-empty `requiredPeers` (an explicit `agent.json` → `x-agentmesh.requiredPeers` list of peers it cannot run without — declaring one is itself an admission the agent is mesh-only, which violates the invariant) OR `serve-a2a`/standalone boot errors with no peers wired. **warn** when generated prompt material contains an *unconditional* peer/delegate directive (dangling when standalone). **manual:** deeper behavioral graceful-degrade is advice, not enforced. With no `requiredPeers` and a clean standalone boot, the rule passes. |
| **Version** | the agent's declared standard version (`agent.json` → `x-agentmesh.meshVersion`) vs. the current standard; migration available if behind. (`mesh.json.meshVersion` records the mesh's standard; each agent carries its own stamp so individual agents can be migrated.) |

### Commands & self-check

- **`validate <folder>`** runs standalone on one agent (anatomy/tools/card/
  standalone/version) **or** on a whole mesh (adds wiring). Output: conformance
  report; non-zero exit on `fail`.
- **`doctor <folder|mesh>`** respects §5.1 ownership: it **auto-applies** fixes to
  *Managed* files (regenerate `registry.json` from the manifest, reconcile the
  `mesh.json` entry) and **seeds** genuinely-missing files; for *Authored* files it
  **proposes** edits (declare a newly-added tool in `.mcp.json`, restamp
  `x-agentmesh.meshVersion`) as a confirmable patch rather than overwriting, and
  flags unsafe drift for a human.
- **`serve-a2a` startup self-check**: runs `validate` on its own root; on drift
  logs a clear conformance warning and still serves, unless `--strict` (then it
  refuses to start). Warn-by-default keeps development fluid; `--strict` gives a
  hard guarantee (CI / production).

## 7. Mode switching (mesh-controlled)

- **Standalone** = the folder is used/run directly; not an active member of any
  running mesh. No `serve-a2a`, no peers reached. The anatomy still applies.
- **Cowork** = the mesh has a `mesh.json` entry for it, generated its
  `registry.json`, and serves it via `serve-a2a`.
- **`join`** registers an *already-converted* folder into the mesh. If the folder
  is **already the in-tree agent root** (`<mesh-root>/<name>/`, e.g. a
  rejoin-after-`leave`), `join` **skips the copy** (no collision/`--force` dance) —
  it only re-registers in `mesh.json` and regenerates wiring. (Full `add` is for a
  folder not yet in-tree.)
- **`leave`** removes the agent's `mesh.json` entry, then, **atomically before any
  registry regeneration**:
  1. **Prunes the departed name from every remaining agent's `peers[]`** in
     `mesh.json` — otherwise the manifest would reference a non-existent agent and
     diverge from the generated registries.
  2. Applies the whole-file rule (§5.1) to the **departing** agent's own
     `registry.json`: marker present → **delete the whole file**; marker absent →
     leave untouched and report.
  3. **Regenerates every *other* affected agent's managed `registry.json` from the
     updated `mesh.json`**, so no remaining agent keeps a stale peer entry for the
     departed one. (A stale-peer-removal test guards this — §10.)

  The departing agent's identity/tools/memory are **never** touched.
- **Invariant — always standalone-runnable:** checked by the conformance rule
  above — deterministically where it can be (no required peer at boot), heuristically
  otherwise (warn on unconditional peer references), with deeper graceful-degrade
  left as manual guidance. The goal: a folder should never *silently* drift into a
  mesh-only state.
- Behavior adapts automatically: `agent-context` injects peer/delegation guidance
  only when peers are wired (cowork). No folder flag is needed.

## 8. New modules / file structure

| Module | Responsibility | Purity |
|---|---|---|
| `src/builder/scaffold.js` | `(structure, identity) → [{path, content}]` to write | **pure** |
| `src/builder/conformance.js` | `(snapshot) → conformance report` (the rule-set) | **pure** |
| `src/builder/manifest.js` | read/validate/write `mesh.json`; generate `registry.json` | thin I/O |
| `src/builder/init-mesh.js` | create the substrate | shell |
| `src/builder/add.js` | discover → place → scaffold → register → wire → validate; also `leave` (remove manifest entry + regen registry) | shell |
| `src/builder/doctor.js` | run conformance → apply safe fixes → report | shell |
| `src/cli.js` (extend) | `init-mesh` · `add` · `join` · `leave` · `validate` · `doctor` (`join` = register an already-in-tree folder without re-copying; `add` = copy-in + register) | shell |
| `src/a2a/stdio-server.js` (extend) | startup self-check (warn / `--strict` refuse); two-layer mode gate — capability from `agent.json` (always) + policy from `AGENT_MESH_ENABLED_MODES` (when set) → `mode_disabled` (§4.2) | shell |
| `src/a2a/protocol.js` (extend) | `buildAgentCard` reflects `agent.json` `x-agentmesh.modes` (no hardcoded `[ask,do]`) so the card matches authored capability (§4.2) | shell |
| `skills/mesh-builder/SKILL.md` | the "simple ask": inference + gap questions, calls the CLI | skill |

**Reuses (built):** `discoverAgentStructure` (`src/agent-context.js`),
`buildAgentCard` (`src/a2a/protocol.js`), `describeFolder`, `src/a2a/registry.js`
normalization, `resolveMeshRoot` + the ceiling, the existing validators.

**Design-for-isolation:** keep `scaffold.js` and `conformance.js` **pure** (take a
snapshot, return content/report); the impure shell (file writes, spawn-validate)
stays thin — matching the project's pure-core ethos.

## 9. Build increments (each gets its own plan → build cycle)

1. **Substrate** — `manifest.js` + `init-mesh.js` + CLI `init-mesh`. Creates
   `mesh.json` + `mesh/skills` + `mesh/mcp.json`; generates `registry.json` from
   the manifest; sets the ceiling convention.
2. **Converter** — `scaffold.js` (pure) + `add.js` (incl. `join`/`leave`) + CLI
   `add`/`join`/`leave` + registry regen + validation; then the **skill** wrapper.
3. **Maintenance** — `conformance.js` (pure) + `validate`/`doctor` CLI +
   `serve-a2a` self-check + `meshVersion` stamping + the standalone-runnable rule.

## 10. Testing

- **Pure units (hermetic):** `manifest.js` (read/write/validate, `registry.json`
  generation), `scaffold.js` (gap-filling, idempotence — never clobbers),
  `conformance.js` (one test per drift rule).
- **Integration (tmp dirs):** `init-mesh` creates the substrate; `add` converts a
  fixture folder in-tree → asserts files + manifest entry + generated
  `registry.json` + `serve-a2a` AgentCard validates.
- **Maintenance:** `doctor` repairs seeded drift; `serve-a2a` self-check warns by
  default and refuses under `--strict`.
- **Opt-in real-`claude` e2e** (gated by `AGENT_MESH_E2E=1`): the skill converts a
  real folder and `serve-a2a` answers, mirroring `test/agent-b-e2e.test.js`.

**Required cases for the sharp decisions (must each have an explicit test):**
- **No global MCP inheritance** — a worker with `mesh/mcp.json` present still gets
  a grant containing only its own `readOnly`-marked servers (§4.1).
- **Mode subset validation** — `manifest.js`/conformance rejects `enabledModes`
  not ⊆ the agent's supported modes; and `serve-a2a` returns `mode_disabled` for a
  `message/send` whose mode isn't in `AGENT_MESH_ENABLED_MODES` (§4.2).
- **Generated-marker refusal** — given a marker-less (Authored) `registry.json`,
  `add`/`doctor`/`leave` refuse to overwrite/delete and warn (§5.1).
- **`leave` preserves Authored registries** — marked file deleted whole; unmarked
  file untouched (§7).
- **Dry-run / no-write** — default `add` writes nothing; only `--apply` writes.
- **Inferred MCP unmarked** — scaffolded `.mcp.json` declares a discovered tool
  **without** a `readOnly` marker unless explicitly confirmed (§5 step 4).
- **Symlink handling** — default: an in-source symlink is skipped-with-warning.
  With `--copy-symlinks`: a relative in-tree link (realpath ⊂ source) is preserved
  as a symlink; an out-of-tree/unresolvable link is still skipped; links are never
  followed (§5.2).
- **Copy collision** — `add` into a non-empty destination refuses without `--force`
  (§5.2).
- **Ignore rules (two-tier)** — the safety denylist (`.git/`, `.env*`/secrets,
  `node_modules/`, build dirs) is **never** copied, even with `--include-ignored`
  (no per-path exception for secrets); `--include-ignored` only re-includes
  ordinary `.gitignore`d paths (§5.2).
- **Join with an Authored registry** — `add`/`join` against a folder that has a
  markerless `registry.json` does not overwrite it: it stops and requires explicit
  confirmation (backing it up) or leaves the agent standalone (§5 step 6 / §7).
- **Rejoin-after-leave (in-place join)** — `leave` then `join` on the same in-tree
  agent succeeds without re-copying and without a collision/`--force` error (§7).
- **`leave` removes stale peers everywhere** — after agent X leaves, every other
  agent that listed X as a peer has X removed from its regenerated `registry.json`
  (§7).
- **Manifest ownership marker** — a generated `mesh.json` carries top-level
  `x-agentmesh-generated: true` (§4 / §5.1).
- **Capability gate (standalone + cowork)** — an ask-only agent (`x-agentmesh.modes:
  ["ask"]`) rejects a `do` `message/send` with `mode_disabled` *even standalone*
  (env unset); its AgentCard advertises only `["ask"]` (§4.2 / §8).
- **`leave` prunes manifest peers** — after agent X leaves, no remaining agent's
  `mesh.json` `peers[]` still lists X (§7).
- **Live-edge peers** — conformance fails a `peers[]` entry naming a missing agent
  or one with `served: false` (§6 Wiring).
- **Global-layer pin (no shadowing)** — with `AGENT_MESH_MESH_ROOT` projected, an
  agent that contains a nested `mesh/` resolves the *mesh's* `<mesh-root>/mesh`, not
  its own; conformance fails a resolved root ≠ expected (§4.2 / §6).
- **enabledModes presence-aware** — env **absent** → full declared capability
  (standalone); env **present-but-empty** → all modes rejected (not "no gating");
  `manifest.js` rejects a `served:true` agent with empty `enabledModes` (§4.2).
- **Partial seeded → proposed patch** — `add` against an existing `agent.json`
  missing `x-agentmesh.modes` does not edit it in place; it emits a `*.proposed`
  patch the user applies (§5.1 / §5.3).
- **Root containment** — a manifest `agents[].root` that realpath-escapes the mesh
  root fails conformance; `join` of an out-of-tree folder refuses (routes through
  `add`) (§6 / §7).
- **Generated spawn paths** — a manifest entry produces a `registry.json` + spawn
  whose `args`/`cwd` use the canonical absolute agent root, and that generated
  entry actually spawns and answers `initialize` (§4.3).
- **Mesh-ceiling projection** — generated spawns carry `AGENT_MESH_MESH_CEILING`
  (= mesh root); an in-tree agent resolves this mesh's `mesh/skills` and nothing
  above the ceiling (§4.2).
- **Standalone-runnable rule** — an agent declaring a non-empty
  `x-agentmesh.requiredPeers` (or that errors on standalone boot) **fails**;
  a clean standalone agent with no `requiredPeers` **passes** (§6).
- **Inferred-identity approval gate** — inferred `agent.json`/`prompts/system.md`
  are never written without explicit approval; a non-interactive run writes only
  `*.proposed` files, never the live files (§5.3).
- **No `--move`** — the converter is copy-only; the source folder is left intact (§5.2).

## 11. PROJECT.md updates

- Add **Layer 0 — Onboarding** (the product surface: `init-mesh`/`add`/`validate`/
  `doctor`, control-plane/data-plane split, mesh-controlled mode) above the
  existing layers.
- Add a **Conformance & Maintenance** subsection: the rule-set, the serve
  self-check posture, `meshVersion`/migration.
- Note `mesh.json` is authoring config (not a runtime broker) and `registry.json`
  is mesh-generated — both consistent with the existing "no broker" invariant.
- Document the **capabilities (`agent.json`) vs. policy (`mesh.json`)** split, the
  **file-ownership model** (Managed / Seeded / Authored), and the **global-MCP
  boundary** (`mesh/mcp.json` declared-only, not inherited in v1).
- Extend the closed `error_code` set with **`mode_disabled`** and document all
  three spawn-env projections (§4.2): `AGENT_MESH_ENABLED_MODES` (mode policy,
  presence-aware), `AGENT_MESH_MESH_ROOT` (the **primary** global-layer pin =
  `<mesh-root>/mesh`), and `AGENT_MESH_MESH_CEILING` (walk-up fallback bound).
- Document the optional `agent.json` → `x-agentmesh.requiredPeers` field and the
  **always-standalone-runnable** invariant it guards (a non-empty value fails
  conformance — §6); and that the global `mesh/skills` layer is **trusted prompt
  configuration** with ceiling-bounded provenance (§4.1, threat model §1.5).

## 12. Scope / non-goals (this design)

**In scope:** `init-mesh`, `add` (in-tree, infer-first, idempotent),
`validate`/`doctor`, serve self-check, mesh-controlled mode (`join`/`leave`),
the skill wrapper, PROJECT.md Layer 0.

**Out of scope (left room for):** HTTP(S) transport (the only place real standing
infra appears); **global MCP inheritance** (v1 is declared-only per §4.1; opt-in
inheritance + threat boundary is future work); auto-inference quality beyond
reading docs/structure (no code synthesis of behavior); a running mesh
dashboard/registry service (rejected by design); cross-machine meshes.

## 13. Review log — codex-spec-review (independent Codex cross-review)

Run via the `codex-spec-review` skill (`codex exec -s read-only`, gpt-5.5). All
findings each round were judged valid and fixed (no rebuttals needed). Convergence
trajectory of actionable findings: **11 → 7 → 2 → 3 → 3**. The 5-round cap was
reached without a clean `APPROVED`, so the final 3 (round-5) fixes were applied
post-cap and are **not yet Codex-reverified** — flagged for the author to either
accept or authorize one confirming round.

- **R1 (CHANGES_REQUESTED, 11):** mesh.json/registry ownership contradiction;
  markerless-registry join; spawn path semantics; ceiling not projected; global
  skills mislabeled low-risk; unsafe `--move`; `--include-ignored` overriding
  secrets; undefined `--copy-symlinks`; backwards standalone rule; missing
  approval-gate tests; §4 numbering. → all fixed.
- **R2 (CHANGES_REQUESTED, 7):** split manifest vs generated-registry schema;
  missing manifest ownership marker; leftover `--move` in §2; secret-denylist
  contradiction; rejoin-after-leave collision; `leave` leaving stale peers in
  other registries; stale "low risk" tree comment. → all fixed.
- **R3 (CHANGES_REQUESTED, 2):** capability gate not enforced standalone + card
  drift; `peers` not pruned on leave / `served:false` peers allowed. → fixed
  (two-layer mode gate; live-edge peers + leave pruning).
- **R4 (CHANGES_REQUESTED, 3):** global-layer shadowing despite ceiling; no update
  path for partial seeded files; `enabledModes` empty-vs-unset footgun. → fixed
  (project `AGENT_MESH_MESH_ROOT` pin; proposed-patch update path; presence-aware
  modes + non-empty-when-served).
- **R5 (CHANGES_REQUESTED, 3 — cap reached):** `join` not first-class in
  CLI/§8/§9; no root-inside-mesh containment rule; §11 omitted `AGENT_MESH_MESH_ROOT`.
  → applied post-cap (this revision); pending Codex reconfirmation.
