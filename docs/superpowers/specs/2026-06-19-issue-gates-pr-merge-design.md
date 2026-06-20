# Issue-state gates PR merge (label-based)

Status: design (approved 2026-06-19)
Adds an upstream→merge coupling the mesh lacked: a PR whose linked issue is
`blocked`/`rejected`/`wontfix`/`duplicate` must not auto-merge.
Related: the auto-merge gate (`src/automerge/eligibility.js`), the merge automation map.

## Problem

The merge gate (`isAutoMergeable`) reads only PR fields (draft/fork/mergeState/review/
labels). The linked issue's state is invisible to it — so if a human `blocked` or
`rejected` an issue, its already-open PR can still satisfy CLEAN+APPROVED and auto-merge.
Issue labels gate whether work *starts*, never whether a PR *merges*.

## Decision (Option A — label-based, confirmed 2026-06-19)

A scheduled sweep stamps a dedicated hold label on a PR when its linked issue is in a
blocking state, and removes it when it isn't. The existing hold-label rule in
`isAutoMergeable` then blocks the merge — no decision-logic change to the gate.

- **Gate condition:** hold iff ANY linked issue carries any of
  `blocked`, `rejected`, `wontfix`, `duplicate`.
- **No linked issue:** do not gate (chore/docs/infra PRs merge normally).
- **Dedicated label:** `blocked-by-issue` — owned exclusively by this sweep, so it never
  fights a human-set `do-not-merge`/`hold`/`wip`. Added to `DEFAULT_HOLD_LABELS` (1 line)
  so the auto-merge gate honors it.
- **Idempotent:** add only when missing, remove only when present — no label churn.

## Components

### `src/automerge/issue-gate.js` (pure, new)
- `ISSUE_HOLD_LABEL = 'blocked-by-issue'`
- `DEFAULT_BLOCK_LABELS = ['blocked','rejected','wontfix','duplicate']`
- `shouldHoldForIssues(labelSets, {blockLabels}) → boolean` — `labelSets` is an array of
  label-name arrays (one per linked issue); true iff any set contains any block label;
  `[]`/non-array → false (fail-open to "allow", matching the no-issue policy).
- `gateDecision(prLabelNames, shouldHold, {holdLabel}) → 'add' | 'remove' | 'none'` —
  idempotent action for the gate's OWN label only.

### `src/automerge/eligibility.js` (1-line change)
- `DEFAULT_HOLD_LABELS = ['do-not-merge','hold','wip','blocked-by-issue']`.

### `src/automerge/issue-gate-sweep.js` (impure, fully injected — mirrors `sweep.js`)
`runIssueGate({ gh, repo, enabled, dryRun, log })`:
1. `enabled !== true` → `{disabled:true, held:[], cleared:[]}`.
2. `gh pr list --json number,labels` (open, limit 100).
3. Per PR: resolve `closingIssuesReferences` (`gh pr view <n> --json closingIssuesReferences`)
   → issue numbers; for each, `gh issue view <n> --json labels` → label names.
4. `hold = shouldHoldForIssues(labelSets)`; `action = gateDecision(prLabels, hold)`.
5. `add`/`remove` the `blocked-by-issue` label via `gh pr edit` (skip on dryRun).
   Per-PR errors are data — logged, never abort the sweep.

### `scripts/issue-gate-sweep.mjs` (thin CLI wrapper, mirrors automerge-sweep.mjs)

### `.github/workflows/dev-mesh-issue-gate.yml`
- `cron: '2,17,32,47 * * * *'` — 5 min before `dev-mesh-automerge` so the hold label is
  fresh when automerge evaluates. `workflow_dispatch` with `dry_run`.
- Gated by `AUTOMERGE_ENABLED == 'true'` (same family).
- `permissions: { contents: read, pull-requests: write, issues: read }`.
- Ensures the label exists first: `gh label create blocked-by-issue ... || true`.

## Caveats (documented, not solved here)

- **Manual `gh pr merge` bypasses labels** — this gates AUTO-merge only. Hard enforcement
  (blocking manual merges too) would need a branch-protection required status check; out
  of scope.
- PRs with no linked issue are intentionally ungated.

## Testing

- `test/issue-gate.test.js` (pure): `shouldHoldForIssues` (block present/absent, empty,
  multi-issue, non-array); `gateDecision` (add/remove/none idempotency).
- `test/automerge-eligibility.test.js`: assert `blocked-by-issue` now blocks.
- `test/issue-gate-sweep.test.js` (injected gh): linked issue blocked → adds label;
  issue clean + PR already labelled → removes; no linked issue → none; disabled → no-op;
  dryRun → decides but no `gh pr edit`.
- Workflow lint (extend a workflow test or add one): cron offset, AUTOMERGE_ENABLED gate,
  label-ensure step, invokes `issue-gate-sweep.mjs`.

## Out of scope / follow-ups
- Positive "require approved/in-progress" gating (rejected — doesn't fit the lifecycle).
- Branch-protection hard gate for manual merges.
