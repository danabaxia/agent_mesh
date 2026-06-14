# Flow-Change Protocol — Design

> **Status:** codex-reviewed R1→R5, **converged on substance** (findings 8→3→2→1→1,
> all accepted, no disagreements; stopped at the 5-round cap — see
> [review log](2026-06-07-flow-change-protocol-design.review.md)). One residual:
> the R5 §3.3.1 tombstone-branch fix is applied but not independently re-reviewed.

## 1. Goal

Make a **post-spec design change deterministic** instead of chaotic.

The pain: once a spec is finalized (codex-converged, plan written, maybe
implementation started), the user changes or rolls back the design. Today the
downstream artifacts (plan, tests, code) silently become inconsistent with the
changed spec, nobody is sure which phase is now authoritative, and the work
degrades into ad-hoc prompt back-and-forth patching half-stale artifacts —
"步骤混乱".

This protocol gives a mid-flow change a fixed handling: **classify how deep it
cuts → mark exactly the affected downstream stale → regenerate in order →
re-converge** — with a single git-tracked source of truth that always says which
phase is authoritative and what is fresh vs stale.

It builds on [DEVELOPMENT_FLOW.md](../../DEVELOPMENT_FLOW.md) (phases P0–P7,
gates, the P3→P1 rollback and P6→P5 feedback edges). It does **not** replace that
flow or drive its happy path — it is the focused change/rollback mechanism only.

## 2. Chosen model + the decisions behind it

Five decisions, each chosen over the alternatives noted:

1. **Scope = focused change protocol** (not a full dev-flow driver, not a bare
   convention). The emphasized pain is the rollback; a focused protocol is YAGNI
   and can later be hosted by a driver skill.
2. **Re-entry by cut-depth, computed from artifact dependency** (not human
   severity tiers, not "always back to spec"). Mechanical and explicable: a change
   maps to the earliest phase whose artifact it invalidates.
3. **Surgical cascade via a dependency manifest** (not full downstream regen, not
   lazy stale-marking). Only the transitively-dependent downstream is invalidated
   and regenerated — minimum rework — with a **fail-closed** fallback when an edge
   is untrusted (stale-until-resolved, §3.3.1), never a guess.
4. **Incremental, scoped re-convergence** (not full codex re-run, not skipping
   it). When the cut reaches the spec, only the changed sections + their blast
   radius go back to `codex-spec-review`, appending a round to the existing log.
5. **Single git-tracked state file** (not distributed front-matter, not
   session-ephemeral). One auditable source of truth, surviving across sessions —
   directly curing "nobody is sure which phase is authoritative".

Realization: **a skill plus a pure JS engine.** The deterministic graph math
(cut-depth, blast radius, staleness, topological work order) lives in a bundled
Node script so it cannot drift; the skill is the impure shell that runs the human
gates and invokes sub-skills around it. This mirrors the project's pure-core /
impure-shell split.

## 3. Components

```
~/.claude/skills/flow-change-protocol/
├── SKILL.md                     trigger + 4-step flow + the confirm-blast-radius gate
├── scripts/flow-change.mjs      pure engine (5 ops + CLI) — no agent/codex calls
├── scripts/flow-change.test.js  engine unit tests (node --test, fixture-driven)
└── references/
    ├── flow-state-schema.md      flow-state.json fields + the two-graph model
    └── bootstrap.md              building the manifest for an existing project
```

The skill installs at the personal `~/.claude/skills/` (cross-project), but
`flow-state.json` lives **inside each project repo** (git-tracked, auditable).

### 3.1 Data model — `flow-state.json` (single source of truth)

Holds **two graphs** plus an authoritative-phase pointer:

```jsonc
{
  "schema_version": 1,
  "base_sha": "ad38d4c",                        // git HEAD this snapshot was taken at
  "authoritative_phase": "P5",                  // who is in charge right now
  "phases": ["P0","P1","P2","P3","P4","P5","P6","P7"],  // phase order (incl. P2 gate) → cut-depth
  "sections": {                                  // stable section anchors for the spec
    "sec-auth":    { "display": "§2.1", "status": "live" },
    "sec-storage": { "display": "§2.2", "status": "live" },
    "sec-old-foo": { "display": "(removed)", "status": "tombstone", "alias": "sec-storage" }
  },
  "artifacts": [
    { "id": "spec", "phase": "P1", "path": "docs/.../X-design.md",
      "status": "fresh", "sources": [], "hash": "sha256:…",
      "stamp": "codex R1→R4 APPROVED" },
    { "id": "task-3", "phase": "P4", "path": "plan.md#task-3", "status": "fresh",
      "sources": [ { "ref": "spec#sec-storage", "provenance": "authored" } ],  // STABLE id, not §2.2
      "hash": "sha256:…" },
    { "id": "test-3", "phase": "P5", "path": "test/foo.test.js", "status": "fresh",
      "sources": [ { "ref": "task-3", "provenance": "authored" } ], "hash": "sha256:…" },
    { "id": "code-foo", "phase": "P5", "path": "src/foo.js", "status": "fresh",
      "sources": [ { "ref": "test-3", "provenance": "inferred",
                     "rationale": "bootstrap: file name matches test target" } ],
      "hash": "sha256:…" },
    { "id": "task-7", "status": "tombstone", "alias": null,  // DELETEd artifact, kept for edge detection
      "path": "plan.md#task-7", "hash": "sha256:…" }
  ]
}
```

- **Phase order** (incl. **P2**, the design-approval gate) → cut-depth.
- **Artifact dependency graph** (`sources`) → blast radius. Each source is an
  **edge object** `{ ref, provenance, rationale?, confirmed_at? }`, so trust is
  **per-edge** — one artifact may mix `authored` and unconfirmed `inferred` edges,
  and the fail-closed check (§3.3.1) is evaluated edge by edge, not per artifact.
- **Stable anchors.** `ref` keys point at stable section anchors (`sec-…` ids in
  `sections`) or artifact ids, never display numbers (`§2`); renaming/renumbering
  only touches `sections[id].display`, so edges never silently break.
- **Tombstones (sections AND artifacts).** A removed section or a DELETEd artifact
  becomes `status: "tombstone"`. Any edge still pointing at it is *detected* and
  **fails closed** — it forces an explicit RE-EDGE before that downstream is
  trusted again. The optional `alias` is only a **suggested** replacement shown to
  the user; it is **never auto-followed** (auto-following would keep a stale ref
  semantically live), so a tombstone can never silently substitute for the original.
- **Drift fields:** `schema_version`, top-level `base_sha`, and a per-artifact
  content `hash` — let the engine detect that disk or git HEAD no longer match the
  snapshot (see §5).
- **Edge `provenance`:** `authored` (trustworthy) vs `inferred` (from bootstrap,
  §6) vs `unknown`. Only `authored`/confirmed edges are trusted for *surgical*
  invalidation; the rest are fail-closed (§3.3.1).
- **Invariant property:** at every moment `authoritative_phase` names who is in
  charge and each `status` names fresh/stale. No silent inconsistency, no
  ambiguity — it is one git file.

**Two graphs are deliberately separate.** The **artifact dependency graph**
(`sources`) is a **DAG** — code←test←task←spec, validated acyclic per generation.
The **workflow back-edges** of DEVELOPMENT_FLOW.md (P3→P1 rollback, P6→P5
feedback) are *control-flow*, not artifact dependencies, and are **not** stored as
`sources` — conflating them would create cycles that deadlock `nextWork`. The
protocol consumes the back-edges as re-entry targets (§4), never as graph edges.

### 3.2 Change is a typed operation

A change isn't only "edit an existing node". The engine models four operations,
so adds/deletes/edge-changes can't slip through unclassified:

- **MODIFY(ref)** — content of an existing node/section changes. If `ref` is a
  spec section (`spec#sec-*`), the **owning artifact** (`spec`) is itself marked
  stale and its approval stamp cleared — a changed section means the spec changed.
  cutDepth = the owning artifact's phase; blast radius = its downstream.
- **ADD(node, phase, sources)** — a new artifact/section. The caller MUST supply
  its phase and sources (no placement → rejected). cutDepth = the new node's
  phase; it is born `stale` (must be generated), and any *sibling* artifact the
  user marks as now-depending-on it is also stale.
- **DELETE(ref)** — a node/section is removed. Applies uniformly to **sections and
  artifacts**: the target becomes `status: "tombstone"` (with optional `alias`),
  and everything that sourced from it goes stale (its inputs vanished) and is
  forced to RE-EDGE — so a downstream edge can never silently point at a deleted
  node.
- **RE-EDGE(artifact, newSources)** — a dependency edge changes without the node's
  own content changing. The artifact itself and its downstream go stale, because
  its inputs are now different. cutDepth = that artifact's phase.

### 3.3 The pure engine — `flow-change.mjs`

Pure functions over `flow-state.json`; never calls agents or codex.

```
classify(state, op)  → { cutDepth, changedRefs[], changedArtifacts[], rejected? }
    op = one typed operation (§3.2). Returns BOTH the changed source refs and the
    OWNING artifacts they belong to — so a `spec#sec-*` change yields the `spec`
    artifact in changedArtifacts (marked stale, stamp cleared), not just downstream.
    cutDepth = earliest phase among the owning artifacts.
    Rejected only when the op would CREATE or RETAIN an edge TO a tombstone: ADD or
    RE-EDGE whose `newSources` name a tombstone ref (a tombstone never auto-resolves
    through its `alias` — that is only a suggested replacement shown to the user).
    An EXISTING edge to a tombstone is NOT a classify error: it is detected by
    failClosed (§3.3.1), and the sanctioned recovery is a RE-EDGE of the owning
    artifact onto LIVE refs — which classify accepts. So you can always escape a
    tombstone; you just cannot point a new edge at one.

blastRadius(state, changedArtifacts[], changedRefs[]) → staleIds[]
    staleIds = changedArtifacts  ∪  downstream(changedArtifacts ∪ changedRefs)
                                  ∪  failClosed (§3.3.1).
    downstream = transitive closure DOWN the (acyclic) sources DAG, seeded by both
    the owning artifacts AND the section refs. Section-precise: a MODIFY of
    `spec#sec-storage` matches only edges whose `ref` is that stable id, NOT every
    spec-sourced artifact — this is what makes the cut surgical within one spec. An
    edge whose ref is the whole `spec` matches any spec change. Validates acyclicity
    per call; a cycle is a hard error, not a loop.

markStale(state, staleIds, cutDepth) → newState
    set staleIds stale; authoritative_phase ← cutDepth; if the spec is stale, clear
    its APPROVED stamp AND force authoritative_phase to **at least P2** (a changed
    spec must re-clear the design-approval gate, §4 — the reachable case is spec
    stale ⟹ cutDepth = P1 ⟹ authoritative_phase = P2). Pure: returns new state.

nextWork(state) → { artifact, phase } | null
    next stale artifact to regenerate, in phase topological order over the DAG. If a
    regeneration step changed an artifact's `sources`, the skill MUST re-run
    classify/blastRadius before trusting the next item (edges may have moved).

reconcile(state, artifactId, newHash, newStamp?) → newState
    mark a regenerated artifact fresh, record its new content hash, stamp it; when
    all fresh, close out. Rejects if the on-disk hash ≠ newHash (something else
    touched the file mid-flow).
```

### 3.3.1 Fail-closed degradation (not "whole phase downstream")

Untrusted edges must **fail closed**, never guess. An artifact whose `sources` are
`unknown`/`inferred`-but-unconfirmed is **not** safe to either skip or to use as a
precise downstream key. So:

- Any artifact with untrusted sources that sits **at or after** the cut-depth phase
  is marked **stale until its edges are resolved** — this avoids *under*-marking an
  unknown artifact that the surgical closure wouldn't have reached.
- **Tombstone-target branch (provenance-independent):** any edge whose `ref`
  resolves to a `status: "tombstone"` node is fail-closed **regardless of its
  provenance** — even an `authored` edge, since its target may have been deleted
  *after* the edge was authored. The owning artifact is stale / RE-EDGE-required
  until it points at live refs.
- It does **not** blanket-stale the whole phase's *trusted* artifacts (which would
  *over*-mark) — those still follow the precise DAG closure.
- The skill then asks the user to repair/confirm the untrusted edges; once
  `provenance` becomes `authored`/confirmed, the engine returns to surgical mode
  for them.

Surgical when edges are trusted; fail-closed (stale-until-resolved) when they
aren't — never pretend precision, never silently skip.

The engine is pure I/O plus a printed work-list, so it is unit-testable with a
fixture `flow-state.json` under `node --test`, consistent with the project's
hermetic suite.

## 4. Control flow — the skill

Trigger: after a spec is finalized, the user signals a design change / rollback
("change the design", "roll back X", "actually Y should be Z", "scrap that
approach").

```
1. Locate flow-state.json. Missing → run bootstrap (§6), then continue.
   Verify no drift first (§5): if disk hashes or HEAD ≠ snapshot, stop and reconcile.

2. Capture the change as a TYPED operation (§3.2): MODIFY / ADD / DELETE / RE-EDGE,
   and which ref(s) it touches. Infer from the description; ask the user one
   question only if unclear (ADD/RE-EDGE always need the user to state placement).

3. ★ Engine classify + blastRadius → show the user the full impact:
     "op = MODIFY spec#sec-storage. cut-depth = P1 (spec). Will invalidate:
      task-3, test-3, src/foo.js. Re-entry = P1; the changed spec must re-pass the
      P2 design-approval gate and an incremental codex re-review. Confirm?"
   This is the anti-chaos gate: before touching anything, the user sees exactly
   what goes stale and where work resumes. Confirm / narrow / cancel.

4. On confirm → engine markStale persists: authoritative_phase ← cut-depth (and no
   later than P2 if the spec is stale), spec APPROVED stamp cleared.

5. Regenerate in nextWork topological order (never jump around). When the cut
   reaches the spec, the FULL upstream sequence is re-traversed — no shortcut past a
   gate:
     · edit the changed spec section
     · ★ P2 design-approval gate — re-present the changed design; the user must
       re-approve (MVP_APPROVED / DESIGN_APPROVED, per DEVELOPMENT_FLOW.md §二)
       before any downstream regen. Not approved → stay in P1.
     · P3 incremental codex-spec-review (only the changed section + blast radius;
       append a round to the review log). Explicit supervisor outcome (§四):
         APPROVED → proceed to P4 regen;
         ROLLBACK_TO_BRAINSTORMING → re-enter P1/P0, re-run from there (the change
           turned out to invalidate a core assumption).
     · regenerate task-3 against the new spec (P4)
     · regenerate test-3 / src/foo.js (P5, TDD)
   Each designed human gate (P2 approval, codex APPROVED, tests green) still stops
   as usual.

6. Engine reconcile: mark each fresh, re-stamp; all fresh → close out.
   flow-state.json always shows the authoritative phase; an interruption at any
   point resumes via nextWork.
```

**Two hard rules:**
- **The step-3 gate is never skipped** — the blast radius is reviewed by the user
  before any invalidation/regeneration. Incidental jumping (the model editing
  freely) is blocked; the essential stop (the user confirming scope) is made
  explicit.
- **nextWork order is never violated** — always regenerate spec→plan→test→code,
  so no one patches a half-stale artifact.

## 5. Error handling (failure is data, not an exception)

- Change touches multiple phases → cut-depth is the **earliest**.
- **Drift detection (hash + SHA based, not path/stamp guessing):** before any run,
  recompute each artifact's content `hash` and compare `base_sha` to current
  `git HEAD`. Any mismatch (a file was hand-edited/moved/deleted, or HEAD advanced)
  → engine reports `drift` with the exact diverged artifacts; the user reconciles
  (re-hash the legitimately-changed files, or restore) before the protocol
  proceeds. `reconcile` itself also rejects a write whose on-disk hash ≠ expected.
- `schema_version` mismatch → engine refuses and asks for a migration rather than
  misreading an old state file.
- Regeneration interrupted mid-way → state is on disk, so `nextWork` resumes the
  unfinished items next time.
- A regeneration step that changes an artifact's `sources` → re-run
  classify/blastRadius (§3.3) before continuing; edges may have moved.
- Spec re-review doesn't reach APPROVED within the cap → per DEVELOPMENT_FLOW.md
  §四, escalate to the user; never auto-stamp.
- Cycle detected in the artifact DAG → hard error (a back-edge leaked into
  `sources`); surface it, don't loop.

## 6. Bootstrap (one-time, for existing projects)

For a project that already has spec/plan/code but no `flow-state.json` (e.g.
agents_mesh). **Inferred edges are hypotheses, not truth** — they must never drive
surgical invalidation until confirmed:

- Scan existing artifacts to build the initial manifest. Dependency edges come
  mainly from existing signal: writing-plans plans already carry a "Self-Review /
  Spec coverage" section mapping `Task N → spec §X` — parse it into candidate
  `sources`. test/code edges are inferred from each Task's description.
- Every inferred edge is stored with `provenance: "inferred"` (and a short
  rationale). The skill presents the inferred graph to the user for **confirmation
  before first use**; on confirm an edge becomes `provenance: "authored"`.
- An **unconfirmed `inferred` edge is treated as untrusted** → it follows the
  §3.3.1 fail-closed rule (its artifact is stale-until-resolved if at/after the
  cut-depth), so a *wrong* inferred edge can only cause extra review, never silent
  false precision.
- Bootstrap is one-time; artifacts produced by the normal flow afterward are
  `authored`.

## 7. Testing

- **Pure engine** (`flow-change.mjs`) → fixture-driven `node --test`, zero deps,
  hermetic. Cases: cut-depth picks earliest across a typed op; each op type
  (MODIFY/ADD/DELETE/RE-EDGE) classifies correctly and ADD-without-placement is
  rejected; blastRadius transitive closure is section-precise via stable ids;
  acyclicity check rejects a seeded cycle; fail-closed staleness for untrusted
  edges (no over-/under-mark); nextWork topological order; reconcile close-out and
  hash-mismatch rejection; drift detection on a hand-edited fixture file.
- **Skill flow** → documented interactive contract; not force-automated (the gates
  inherently need a human).

## 8. Scope / non-goals

**In scope:** the post-spec **change/rollback** protocol — typed change ops,
surgical cascade, incremental re-convergence, single-source-of-truth state, and
**driving the regeneration sequence that a change triggers** (with its gates).

**Boundary (what "driver" means here):** this skill drives the **change-triggered**
re-traversal — re-entry → gated regeneration of stale artifacts. It does **not**
drive the greenfield happy-path P0→P7 from scratch (no spec yet, nothing to be
stale). That greenfield orchestration is the future "dev-flow driver" skill; this
protocol is designed to be *hosted by* it. The two share the flow-state file but
have distinct triggers (a change vs a cold start).

**Out of scope (v1):**
- Greenfield happy-path driving (above).
- Hook-based enforcement (rejected: brittle, hard to debug, false-blocks).
- Auto-resolving a non-converging re-review (always escalates to the user).
- Cross-project / multi-spec dependency graphs (one project, one flow-state).
