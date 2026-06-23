# fix(dev-society): assert RECONCILE_STATES ⊆ LIFECYCLE_STATES at module load

**Date:** 2026-06-23
**Status:** Design (pending review)
**Resolves:** #442
**Builds on:** PR #435 (lifecycle strip-all fix), memory lesson `lifecycle-strip-all-on-terminal-close` (PR #441)

## Problem

PR #435 fixed label-state drift by stripping the full `LIFECYCLE_STATES` group when
reconciling an issue to `done`. The memory:promote PR #441 encodes this as lesson
`lifecycle-strip-all-on-terminal-close`.

The lesson's `value` field notes a latent footgun: **`RECONCILE_STATES ⊆ LIFECYCLE_STATES`
is a hand-maintained silent dependency.** If someone adds a new trigger state to
`RECONCILE_STATES` without also adding it to `LIFECYCLE_STATES`, the reconciler will stamp
`done` without removing the trigger label — re-introducing the very drift that #435 fixed.
There is no guard that surfaces this mismatch at load time or in CI.

## Goal

Add a **fail-fast guard** so any future change that breaks the `RECONCILE_STATES ⊆
LIFECYCLE_STATES` invariant is caught immediately — at module load (loud throw) and in CI
(red build) — before it can cause silent label drift in production.

The fix must be **behavior-preserving for the current state set**: which issues reconcile and
which labels are stripped on `done` must be identical to post-#435.

## Options

### Option A — module-load assertion (runtime tripwire)

Add a load-time loop in `src/dev-society/post-merge-reconcile.js`:

```js
// Invariant: every trigger label must be in the strip set.
// If RECONCILE_STATES grows beyond LIFECYCLE_STATES, done stamps without stripping the trigger.
for (const s of RECONCILE_STATES) {
  if (!LIFECYCLE_STATES.includes(s)) {
    throw new Error(
      `post-merge-reconcile: RECONCILE_STATES has '${s}' not in LIFECYCLE_STATES — strip-all invariant violated`
    );
  }
}
```

**Pro:** minimal diff; explicit error message names the offending state and violated invariant;
loud and fast at daemon startup and test import.
**Con:** the two lists remain hand-maintained; the check catches drift after the fact (at
import time) rather than preventing it structurally.

### Option B — derive RECONCILE_STATES from LIFECYCLE_STATES (structural ⊆)

Replace the hand-maintained constant with a derived one:

```js
// Derive trigger set from the lifecycle group so the ⊆ invariant is structural.
const RECONCILE_STATES = LIFECYCLE_STATES.filter(l => IN_FLIGHT.includes(l) || l === APPROVED);
```

**Pro:** `RECONCILE_STATES ⊆ LIFECYCLE_STATES` is guaranteed by construction — no assertion
can be forgotten; adding a new lifecycle state and wanting it to trigger reconcile is a single
edit (`IN_FLIGHT` or the explicit list), not two.
**Con:** requires understanding `IN_FLIGHT` and `APPROVED` to see which states are included;
slightly less transparent than a literal list.

**Recommendation:** prefer Option B as the default — structural ⊆ is stronger than a runtime
assertion. Option A remains a useful secondary guard (the hermetic test below covers both).
If future profiling shows that the derivation's assumptions are wrong and Option A's assertion
is the right tripwire to surface that).

> The two options are not mutually exclusive: deriving (B) makes the invariant structural, and the test below still guards against a future refactor that re-introduces a hand-maintained list.

### Regression test (required either way)

Add a **hermetic test** asserting `RECONCILE_STATES ⊆ LIFECYCLE_STATES`, so any future change that breaks the invariant **fails CI immediately** — independent of whether the runtime guard or the derivation is in place. With Option A the test confirms the assertion's premise; with Option B it confirms the derivation still yields a subset.

## Components

- **`src/dev-society/post-merge-reconcile.js`** — adds either the module-load assertion (Option A) or the derived `RECONCILE_STATES` definition (Option B). The only production change; ~3–6 lines.
- **Constants involved** — `RECONCILE_STATES`, `LIFECYCLE_STATES`, `IN_FLIGHT`, `APPROVED` (all already defined in the module). The change only alters how `RECONCILE_STATES` relates to them; it does **not** change which states currently trigger reconcile or get stripped (behavior-preserving for the present set).
- **Hermetic test (e.g. `test/post-merge-reconcile.test.js`)** — asserts every element of `RECONCILE_STATES` is in `LIFECYCLE_STATES`; fails CI on any future violation.

## Data flow

This is a guard, not a runtime behavior change, so the "flow" is at load/build time:

1. **Module load:** `post-merge-reconcile.js` is imported (daemon startup / test run).
2. **Option A:** the load-time loop checks each `RECONCILE_STATES` entry against `LIFECYCLE_STATES`; a missing entry throws immediately with the named error → the module fails to load (loud, fail-fast).
   **Option B:** `RECONCILE_STATES` is computed by filtering `LIFECYCLE_STATES` → it is a subset by construction; no separate list can drift.
3. **CI:** the hermetic test imports the module and asserts the subset relationship → a breaking change reds the build before merge.
4. **Runtime (unchanged):** for the current state set, reconcile triggers and strip-all behavior are identical to post-#435; no observable behavior change.

## Testing

- **Subset invariant holds (current):** assert `RECONCILE_STATES ⊆ LIFECYCLE_STATES` for the present definitions → passes.
- **Violation is caught:**
  - *Option A:* a test (or fixture) injecting a `RECONCILE_STATES` entry absent from `LIFECYCLE_STATES` → module load throws the named error.
  - *Option B:* a test confirming the derived `RECONCILE_STATES` contains exactly the expected in-flight + approved triggers and nothing outside `LIFECYCLE_STATES`.
- **Behavior preservation:** the set of states that trigger reconcile and the set stripped on `done` are unchanged vs. post-#435 (no regression in which issues reconcile or which labels are removed) — guards against the fix accidentally narrowing/widening the trigger set.
- **Error message clarity (Option A):** the thrown error names the offending state and the violated invariant.
- **CI integration:** the hermetic test runs in the existing suite and fails the build on a synthetic invariant break.

## Out of scope

- **Changing which states trigger reconcile or get stripped** — this hardens the existing invariant; it does not alter reconcile behavior for the current state set (that was #435/#257's domain).
- **The `done`-stamping / strip-all logic itself** — unchanged; this only guarantees the trigger set stays within the strip set.
- **Other lifecycle invariants** (e.g. `spec:in-review`, `blocked` handling) — not addressed here.
- **Runtime recovery from a violation** — the design intentionally *fails loud* (throw / CI red) rather than attempting to auto-correct a mis-specified state set.
- **Refactoring the broader constants/state model** in `core.js` or `post-merge-reconcile.js` beyond the `RECONCILE_STATES` definition.
- **Path-guard / anti-spoof / write-boundary changes** — none; this is a pure invariant guard plus a test.
