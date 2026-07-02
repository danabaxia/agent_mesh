---
slug: production-vs-fixture-precision-fix
status: active
provenance: "PR #748 (2026-07-02), closing Issue #742"
---

# Pattern: Fix a Routing-Precision Regression at the Production Prompt Locus, Not the Eval Fixture — and Watch for Opposing-Instruction Tension

## What it solves

Issue #742 (mesh-scan): the 3x-disjoint perf cell's `precision` metric
regressed -13.3% (1.0 → 0.867). This is the same magnitude/shape of
regression as `[[no-hedge-single-peer-directive]]` (Issue #744, 6x-confusable
cell) but a **different cell and a different fix locus** — the two issues are
not duplicates, they're sibling regressions in different eval cells.

## The fix (PR #748) — production code, not a fixture

`[[no-hedge-single-peer-directive]]` and its correction fixed the *eval
harness's synthetic caller prompt* (`eval/perf/harness.mjs`
`buildRoutingMesh`) — a change that only affects that specific eval fixture's
agent, not any real deployed agent. PR #748 instead edited the **real,
production tool descriptions** in `buildTools()` in `src/a2a/peer-bridge.js`
— the `list_peers` and `delegate_to_peer` MCP tool descriptions that every
real worker agent reads via the peer bridge, in eval runs and in production
alike. Added text:

- `list_peers`: "Match the task to the single peer whose description most
  specifically covers it — do not delegate to (or guess in favor of) a peer
  whose description only loosely resembles the task."
- `delegate_to_peer`: "Even if you believe you already know the answer, a
  task inside a peer's declared domain (see list_peers) must be delegated to
  that exact peer — answering from your own knowledge or delegating to the
  wrong peer are both routing errors."

**When the regression's cause is generic** (any worker reading the real
peer-bridge tool descriptions can hedge or under-delegate), fix the
production locus (`src/a2a/peer-bridge.js`) so the fix applies mesh-wide, not
just to one eval fixture's synthetic caller. Reserve the
`eval/perf/harness.mjs` fixture-prompt fix for when the regression is
specific to how the eval builds its synthetic mesh (as in `[[no-hedge-single-peer-directive]]`).

## The tension this PR shipped with (verify before repeating)

The two added instructions pull in opposite directions on a task that only
*loosely* matches a peer's domain:

- `list_peers` now says: don't guess in favor of a loose match (biases
  toward answering locally / not delegating).
- `delegate_to_peer` now says: delegate even if you think you know the
  answer, with no comparable hedge for loose/ambiguous matches (biases
  toward delegating).

This is a real risk, not a style nit: fixing the false-negative case (model
answers locally instead of delegating, or hedges across peers — tanking
precision) can silently reintroduce false positives (over-delegation to a
loosely-matching peer — tanking recall on a *different* cell), or vice
versa. PR #748's reviewer flagged this explicitly and it was **unresolved at
merge**.

## The verification gap this PR shipped with

The only new test (`test/peer-bridge.test.js`) is
`assert.match(tool.description, /.../)` — it proves the strings landed in
the tool description, not that model routing behavior actually changed. That
is an acceptable regression guard for a wording diff (you can't easily unit
test model behavior) but it gives **zero evidence** the -13.3% precision
regression is fixed. Only a real re-run of the affected eval cell
(`node scripts/eval-perf.mjs`, 3x-disjoint) confirms that — and per the
tension above, must check **precision AND recall together**, not precision
alone.

## Reuse checklist

- [ ] Trace a routing precision/recall regression to its cause before
      choosing where to fix it: a real worker reading production tool
      descriptions (`src/a2a/peer-bridge.js` `buildTools()`) vs. an eval
      fixture's synthetic caller prompt (`eval/perf/harness.mjs`
      `buildRoutingMesh`). Fix at the locus that actually causes the
      behavior — production code if the bias is generic, the fixture prompt
      if it's specific to that eval's synthetic mesh.
- [ ] Before merging a hedge/directive added to one tool's description,
      re-read every *other* tool description in the same `buildTools()` for
      an opposing directive — `list_peers` (survey) and `delegate_to_peer`
      (act) are a paired surface and a one-sided fix can create exactly the
      opposite regression on a different eval cell.
- [ ] A substring-match unit test on a tool description proves the string
      landed, not that routing behavior changed. Schedule (or open a
      follow-up issue for) a real `scripts/eval-perf.mjs` re-run on the
      affected cell before treating the regression issue as closed for real,
      checking precision *and* recall together.

## Related

`[[no-hedge-single-peer-directive]]` — the sibling regression (Issue #744,
6x-confusable cell), fixed at the eval-fixture locus instead of the
production locus; read both before deciding where a future routing-precision
fix belongs. `[[task-first-delegate-prompt]]` — a third, distinct mechanism
(recall via per-task instruction ordering) in the same family of
delegation-routing prompt reliability fixes.

## Provenance

PR #748 (2026-07-02): `[mesh-scan] perf-regression: precision regressed
(-13.3%)`, closing Issue #742. Diff: `src/a2a/peer-bridge.js` (+7/-2),
`test/peer-bridge.test.js` (+12).
