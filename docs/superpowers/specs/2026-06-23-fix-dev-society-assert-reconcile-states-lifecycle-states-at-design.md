assumptions are wrong and Option A's assertion is the right tripwire to surface that).

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
