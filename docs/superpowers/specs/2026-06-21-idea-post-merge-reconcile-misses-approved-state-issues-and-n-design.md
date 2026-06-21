# Post-Merge Reconcile: Approved-State Orphans and `done` Label — Design

## Problem

`src/dev-society/post-merge-reconcile.js` backstops GitHub's intermittent auto-close failure for issues carrying `pr:in-review` or `in-progress` labels. Two gaps have been observed:

**Gap 1 — `approved`-state orphans.** When a PR with `Closes #N` merges for an issue still at `approved` (human-approved but never claimed as `in-progress`), `planPostMergeReconcile` skips it — `IN_FLIGHT = ['pr:in-review', 'in-progress']` does not include `approved`. Evidence: issue #248 (`approved`) remained open after PR #251 merged with `Closes #248`; the reconcile produced an empty plan.

**Gap 2 — `done` label never applied.** The reconcile path removes in-flight labels and closes the issue but never adds `done`. Closed issues that carry `done` (e.g., #141, #97, #184) received it manually. An auto-reconciled issue lands without the terminal label, making it invisible to label-scoped queries for completed work.

## Approach

1. **Add `approved` to the reconcile-eligible states.** The current `IN_FLIGHT` guard excludes issues at `approved` whose closing PR has merged. Extending the predicate — either by widening `IN_FLIGHT` or adding a parallel `approved` check — makes such orphans eligible for close.
2. **Apply `done` on every reconcile item.** Each plan item gains `addLabel: 'done'`, so the daemon runs `gh issue edit --add-label done` **before** `gh issue close`. This applies uniformly to the existing in-flight items and the new `approved` items.
3. **Update the daemon builtin** `postMergeReconcile` to execute the `addLabel` step (label-before-close ordering) for each plan item.

The change is roughly ten lines in `post-merge-reconcile.js` plus the daemon builtin, exercised by the existing pure-plan test pattern.

### Ordering and idempotency

- **Order:** add `done`, then close. Closing first would still work functionally but labeling the open issue first keeps the terminal state coherent if the close step fails midway.
- **Idempotency:** an issue already closed with `done` produces no plan item (it is no longer in `approved`/in-flight and is already closed). Re-adding `done` to an issue that already has it is a harmless `gh` no-op, so a partial-failure re-run is safe.

## Components

- **`planPostMergeReconcile` (`src/dev-society/post-merge-reconcile.js`)** — the pure plan builder. Gains `approved` as an eligible state (or a dedicated `approved-orphan` branch) and sets `addLabel: 'done'` on each emitted item. Remains pure and table-testable.
- **State set / branch logic** — `IN_FLIGHT` extended, or a parallel `approved` predicate added. Existing guard that prevents closing issues with genuinely ongoing work is preserved.
- **Daemon builtin `postMergeReconcile`** — the imperative shell. For each plan item: `gh issue edit --add-label done`, then `gh issue close`. Removal of in-flight labels (existing behavior) is retained.
- **`TERMINAL_LABELS` (`core.js`)** — unchanged; `done` already lives here, so no new invariant surface is introduced.

## Data flow

1. Reconcile runs (daemon cadence) after merges.
2. For each recently merged PR with `Closes #N`, resolve issue #N and its current labels.
3. `planPostMergeReconcile` evaluates the issue:
   - State ∈ {`pr:in-review`, `in-progress`, **`approved`**} and not otherwise guarded as ongoing work → emit a plan item.
   - Plan item: `{ issue: N, removeLabels: [in-flight labels present], addLabel: 'done', close: true }`.
4. Daemon builtin applies each item: remove in-flight labels (as today) → `gh issue edit --add-label done` → `gh issue close`.
5. Issue #248-class cases now close, and every reconciled issue carries `done`, restoring visibility to label-scoped "completed work" queries.

## Testing

Pure-plan unit tests in the existing pattern, plus builtin ordering:

- **`approved` orphan:** issue at `approved`, PR merged with `Closes #N` → plan item with `addLabel: 'done'` and `close: true` (this is the #248/#251 regression test).
- **`done` applied to in-flight items:** existing `pr:in-review` and `in-progress` cases now also carry `addLabel: 'done'`.
- **Ordering:** builtin test asserts `--add-label done` is issued **before** `gh issue close` per item.
- **Guard preserved:** an issue at `approved` whose closing PR has NOT merged (no entry in the `closedBy` map) → still no plan item. This is covered by the existing `'does NOT close an issue whose closing PR is not in the merged set'` test, which is unchanged.
- **Existing test to replace:** `test/post-merge-reconcile.test.js` line 22–25 (`'does NOT touch an open issue with no in-flight label (e.g. human reopened)'`) currently asserts an empty plan for `iss(5, ['bug', 'approved'])` with a merged PR — **this test must be replaced** by the new `approved`-orphan case above. After this change the behavior flips: an `approved` issue with a merged `Closes #N` PR is a plan item, not a skip.
- **Non-`approved`/non-in-flight states:** untouched.
- **`spec:in-review` exclusion:** a `spec:in-review` issue is not acted on (covered by a separate escalation idea).
- **Idempotency:** already-closed-with-`done` issue → empty plan; re-adding `done` is a no-op.
- **No PR / no `Closes` link:** issue skipped, no throw.

## Out of scope

- **Changing the human-approval gate or `approved` label semantics** — `approved` still means human-approved; this only handles the post-merge close for already-approved issues.
- **Auto-closing issues with ongoing work** — the existing guard stays.
- **`spec:in-review` issues** — a separate escalation idea covers those.
- **New invariant surface** — `done` is already terminal in `TERMINAL_LABELS`; nothing new is introduced.
- **Push notifications or re-routing** — reconcile only closes and labels; it does not re-route.
