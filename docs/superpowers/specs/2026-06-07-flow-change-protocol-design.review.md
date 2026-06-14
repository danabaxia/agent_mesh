# Review Log — `2026-06-07-flow-change-protocol-design.md`

Driven by `~/.claude/skills/codex-spec-review/`. Reviewer: **Codex CLI 0.130.0** (gpt-5.5, read-only sandbox).

## Round 1 — VERDICT: CHANGES_REQUESTED

2 BLOCKER · 5 MAJOR · 1 MINOR. All accepted (no rebuttals).

1. **[BLOCKER] §3.2/§4 — change model too narrow** (only existing-node refs; adds/deletes/edge-changes unclassifiable).
   → **Accepted.** New §3.2 models changes as four typed operations: MODIFY / ADD(phase,sources required) / DELETE(→tombstone) / RE-EDGE(invalidates artifact + downstream). `classify` takes a typed op and can `reject` (e.g. ADD without placement).

2. **[BLOCKER] §4/§5 vs DEVELOPMENT_FLOW §一–§四 — skips P2, flattens P3.**
   → **Accepted.** P2 added to `phases`; §4 step 5 re-crosses the P2 design-approval gate before any downstream regen when the spec is stale; `markStale` drops authoritative_phase no later than P2. P3 supervisor outcomes encoded explicitly: `APPROVED→P4` | `ROLLBACK_TO_BRAINSTORMING→P1/P0`.

3. **[MAJOR] §3.1/§3.2 — `§2` section refs unstable** under renumber/rename/delete.
   → **Accepted.** Edges keyed by stable `sec-…` anchors in a new `sections` map; `display` carries the number; removed sections become `tombstone` + optional `alias` so dangling edges are detected.

4. **[MAJOR] §3.2/§6 — conservative degradation unsound** (over- and under-marks).
   → **Accepted.** Replaced "whole phase downstream" with §3.3.1 fail-closed: an untrusted-source artifact at/after cut-depth is stale-until-resolved (fixes under-mark) while trusted artifacts still follow the precise DAG (no over-mark).

5. **[MAJOR] §6 — bootstrap edges treated as truth.**
   → **Accepted.** Inferred edges stored `provenance: inferred` + rationale, presented for confirmation before first use; unconfirmed inferred edges are untrusted (→ fail-closed), so a wrong inference can only cause extra review, never silent false precision.

6. **[MAJOR] §5/§3.1 — no real drift detection.**
   → **Accepted.** Added `schema_version`, top-level `base_sha`, per-artifact content `hash`; §5 drift check compares hashes + HEAD before any run and `reconcile` rejects a write whose on-disk hash ≠ expected.

7. **[MAJOR] §3.2/§4 vs §七 — downstream-only graph vs flow back-edges → deadlock/loop risk.**
   → **Accepted.** §3.1 now states the two graphs are separate: artifact `sources` is a validated **DAG**; the P3→P1 / P6→P5 back-edges are control-flow, never stored as `sources`. `blastRadius` validates acyclicity (cycle = hard error); a regen that changes `sources` forces re-classify.

8. **[MINOR] §2/§4/§6/§8 — creeping toward a dev-flow driver.**
   → **Accepted.** §8 boundary: the skill drives only **change-triggered** re-traversal, not the greenfield happy-path (the future driver's job); the two share flow-state but have distinct triggers.

## Round 2 — VERDICT: CHANGES_REQUESTED

3 MAJOR. All accepted (no rebuttals). Schema-precision gaps the Round-1 edits exposed.

1. **[MAJOR] §3.1/§6 — `sources` flat array can't carry per-edge trust** (artifact-level provenance can't represent mixed confirmed/unconfirmed sources).
   → **Accepted.** `sources` is now an array of edge objects `{ref, provenance, rationale?, confirmed_at?}`; the §3.3.1 fail-closed check is evaluated per-edge.

2. **[MAJOR] §3.2/§3.3/§4 — spec owner not guaranteed stale** on a section-level change (only downstream got `staleIds`).
   → **Accepted.** `classify` now returns `changedRefs` AND owning `changedArtifacts`; a `spec#sec-*` MODIFY includes the `spec` artifact (marked stale, stamp cleared). cutDepth = earliest owning artifact's phase.

3. **[MAJOR] §3.1/§3.2 — artifact tombstone undefined** (tombstone only existed for sections; DELETEd tasks/tests/code left danglers).
   → **Accepted.** Tombstones now apply uniformly to sections AND artifacts (`status:"tombstone"` + optional `alias`); DELETE forces downstream RE-EDGE so no edge silently points at a removed node.

## Round 3 — VERDICT: CHANGES_REQUESTED

2 MAJOR. Both accepted (no rebuttals). Op-semantics precision.

1. **[MAJOR] §3.3 — op data-flow underspecified** (`classify` returns `changedRefs` but `blastRadius` dropped it; `staleIds` union undefined).
   → **Accepted.** `blastRadius(state, changedArtifacts, changedRefs)` now takes both; explicit formula `staleIds = changedArtifacts ∪ downstream(changedArtifacts ∪ changedRefs) ∪ failClosed`.

2. **[MAJOR] §3.1/§3.3 — tombstone `alias` could auto-follow** and keep an old ref live.
   → **Accepted.** Any ref/edge pointing at a tombstone fails closed and forces an explicit RE-EDGE; `alias` is only a suggested replacement shown to the user, never auto-followed. classify rejects tombstone refs accordingly.

## Round 4 — VERDICT: CHANGES_REQUESTED

1 MAJOR. Accepted (no rebuttal).

1. **[MAJOR] §3.3/§3.3.1 — tombstone deadlock:** rejecting *any* op touching a tombstone would also block the RE-EDGE that escapes it.
   → **Accepted.** classify rejects only ops that CREATE/RETAIN an edge TO a tombstone (ADD/RE-EDGE whose `newSources` name one); an existing tombstone edge is fail-closed, and a RE-EDGE onto LIVE refs is accepted — so escape is always possible.

## Round 5 — VERDICT: CHANGES_REQUESTED (round cap)

1 MAJOR. Accepted (no rebuttal).

1. **[MAJOR] §3.3.1 — fail-closed didn't cover an `authored` edge to a tombstone** (a target deleted *after* the edge was authored stays "trusted").
   → **Accepted.** Added a provenance-independent tombstone-target branch to §3.3.1: any edge whose ref resolves to a tombstone is fail-closed regardless of provenance; owning artifact is RE-EDGE-required until it points at live refs.

---

## Convergence

**Converged on substance at the 5-round cap.** Finding trajectory **8 → 3 → 2 → 1 → 1**
(2 BLOCKER+5 MAJOR+1 MINOR → 3 MAJOR → 2 MAJOR → 1 MAJOR → 1 MAJOR). Every finding
accepted, **no rebuttals, no persistent disagreements**. The clean `APPROVED` was
not reached within 5 rounds only because each round surfaced a new, smaller,
previously-unseen edge-case in the same area (tombstone / fail-closed semantics) —
the same outcome documented in `2026-06-06-settings-inheritance-design.review.md`
and `2026-06-07-mvp-loop-skill-design.review.md`. Per the skill, the round cap is
respected; the lone residual is that the R5 one-line fix (§3.3.1 tombstone branch)
was applied but not independently re-reviewed. Substance is converged; structural
findings ended at Round 1.
