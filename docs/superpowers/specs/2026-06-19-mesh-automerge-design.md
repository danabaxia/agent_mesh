# Mesh gated auto-merge — design

**Date:** 2026-06-19
**Status:** design — Phase 1 detailed (build now); Phase 2 sketched
**Topic:** a scheduled sweep that automatically merges PRs which are fully green and approved, with strict rails and an instant kill switch — relaxing the "a human holds the merge gate" stance in a controlled way.

## Problem & goal

Today the dev-society deliberately keeps **a human on the merge gate for all code PRs**. The only sanctioned auto-merge is `dev-mesh-memory-automerge` (memory PRs / `quick.json` only, never code) — it calls itself "the ONE sanctioned auto-merge in the mesh." `autofix` and `backlog` both state "a human holds the merge gate (auto-merge is off)."

The user wants to **eliminate the manual merge click** for PRs that are unambiguously ready — all checks green, review approved — so the society can carry approved work all the way to `main` without a human in the loop, 24/7.

**Goal:** a scheduled, mechanical sweep that merges any PR meeting a strict, objective bar, with safety rails (fork exclusion, hold labels, drafts) and a one-flip kill switch — and that **degrades safely**: not-ready PRs are left untouched for the existing fixer sweeps.

### Invariant change (explicit)
This **relaxes the documented "human holds the merge gate" stance** to a **gated auto-merge**: a human (or the dev-mesh Reviewer) still **approves**, but the *merge action itself* is automated once the PR is provably ready. Per the repo's own rule ("changing an invariant means changing PROJECT.md first"), Phase 1 updates PROJECT.md + the stale `auto-merge is off` comments to document the new policy. The bar still requires an explicit approval, so **nothing merges unreviewed**.

## Decisions (from brainstorming)
- **Scope:** any open same-repo PR (not just bot PRs).
- **Merge bar:** `mergeStateStatus == CLEAN` **AND** `reviewDecision == APPROVED`. CLEAN already means mergeable + all required checks green + required reviews approved + up-to-date; the explicit `APPROVED` ensures we never merge a PR that had no review even if branch protection didn't require one.
- **Rails:** same-repo only (never fork PRs), skip drafts, skip any PR carrying a hold label (`do-not-merge` / `hold` / `wip`).
- **Kill switch:** an Actions **repo variable `AUTOMERGE_ENABLED`**; the sweep no-ops unless it is exactly `'true'`. **Ships default-OFF** — merging this feature does not turn it on; the operator flips the variable when ready.
- **No cooldown:** eligible PRs merge on the next sweep (the ~15-min cadence is itself a small natural delay).
- **Merge method:** merge-commit + delete branch (matches recent human merges); idempotent.
- **Home:** a **cloud GitHub Actions cron workflow** (like `memory-automerge`/`pr-janitor`/`mergefix`) — runs 24/7, has merge perms, no local dependency. The decision is objective, so it is **mechanical** (no `claude`).
- **Owner:** conceptually the **orchestrator** (ops); implemented mechanically.
- **Fixers:** the auto-merge sweep **never fixes** anything — it merges ready PRs and skips the rest; `mergefix` (DIRTY conflicts → Coder), `ci-sweep` (red CI → Coder), `autofix` (incomplete → Coder), `review-respond` (Reviewer) already handle not-ready PRs on their own schedules, coordinating via GitHub state.

---

# Phase 1 — cloud gated auto-merge sweep (detailed)

## Architecture

A new workflow `.github/workflows/dev-mesh-automerge.yml`, cron every 15 minutes (offset from the other sweeps), one concurrency group. Deliberate **pure-core / thin-shell** split so the merge predicate is unit-provable:

```
 GitHub Actions (cron */15)                         repo
 ┌───────────────────────────────────────┐
 │ 0. read repo var AUTOMERGE_ENABLED     │── if != 'true' → exit 0 (no-op)
 │ 1. gh pr list (open, same-repo)        │── per-PR JSON: number, isDraft, isCrossRepository,
 │      + per-PR mergeStateStatus,        │               headRepositoryOwner, labels,
 │        reviewDecision                  │               mergeStateStatus, reviewDecision
 │ 2. isAutoMergeable(pr, opts)  (PURE)   │── boolean predicate (unit-tested)
 │ 3. for each eligible → gh pr merge     │── --merge --delete-branch (idempotent)
 │ 4. log a one-line summary              │── merged: [#…]  skipped: N
 └───────────────────────────────────────┘
```

Following the Phase-2 gh-activity pattern (pure + injectable logic in `src/`, a thin CLI shell in `scripts/`): the **pure** predicate and the **injectable** sweep logic live in `src/automerge/`, and `scripts/automerge-sweep.mjs` is a thin CLI that wires the real `gh` + env + `console` and calls them. This keeps the decision and the sweep loop hermetically testable rather than buried in shell/YAML.

## Components

### 1. `src/automerge/eligibility.js` (new, PURE)
```
isAutoMergeable(pr, { holdLabels = ['do-not-merge','hold','wip'] } = {}) → boolean
```
- `pr` is one `gh pr list/view --json` row: `{ number, isDraft, isCrossRepository, mergeStateStatus, reviewDecision, labels:[{name}] }`.
- Returns `true` **iff** all hold: `!isDraft` · `!isCrossRepository` (same-repo only) · `mergeStateStatus === 'CLEAN'` · `reviewDecision === 'APPROVED'` · no label name in `holdLabels`.
- Pure, total, no I/O. Any missing/unknown field → not mergeable (fail-closed).

### 2. `src/automerge/sweep.js` (new, impure logic — injectable)
```
runSweep({ gh, repo, enabled, holdLabels?, dryRun = false, log = () => {} }) → { merged:[number], skipped:number, ineligible:number, disabled?:true }
```
- If `enabled !== true` → returns `{ disabled:true, merged:[], skipped:0, ineligible:0 }` and logs `automerge: disabled`.
- `gh(['pr','list','--repo',repo,'--state','open','--json','number,isDraft,isCrossRepository,mergeStateStatus,reviewDecision,labels','--limit','100'])` → parse JSON.
- Filter with `isAutoMergeable`; for each eligible PR (unless `dryRun`), `gh(['pr','merge',String(n),'--repo',repo,'--merge','--delete-branch'])`, each in its own try/catch so one failure (e.g. a 409 from a PR that just changed) is logged + counted as `skipped`, never aborting the rest — retried next sweep.
- Returns the summary; the caller logs `automerge: merged [#a,#b] · skipped <N> · ineligible <M>`.

### 3. `scripts/automerge-sweep.mjs` (new, thin CLI shell)
- Wires the real `gh` (`execFile`), `repo` (env/git remote), `enabled = process.env.AUTOMERGE_ENABLED === 'true'`, `dryRun = process.argv.includes('--dry-run')`, and `log = console.error`, then calls `runSweep(...)` and prints the one-line summary. Exits 0 always (failure is data).

### 4. `.github/workflows/dev-mesh-automerge.yml` (new)
- `on: schedule: cron '7,22,37,52 * * * *'` (every 15 min, offset from memory-automerge `*/15` / janitor `20,50` / mergefix `45` to avoid clustering) **plus** `workflow_dispatch` (manual run; a `dry_run` input wires `--dry-run` for safe first runs).
- `concurrency: { group: dev-mesh-automerge, cancel-in-progress: false }`.
- Permissions: `contents: write`, `pull-requests: write` (merge perms). No `claude` / no `CLAUDE_CODE_OAUTH_TOKEN`.
- **Auth: use the same token mechanism `dev-mesh-memory-automerge` uses to merge** (the proven merging workflow) — reuse it verbatim so behavior (incl. whether the merge re-triggers downstream workflows) matches the already-working memory path. Don't invent a new token scheme.
- Steps: checkout → setup-node 20 → `node scripts/automerge-sweep.mjs` with `AUTOMERGE_ENABLED: ${{ vars.AUTOMERGE_ENABLED }}` in env.

### 5. Documentation (the invariant change)
- **PROJECT.md:** add a short "Merge policy" note: humans/Reviewer approve; merging is automated for CLEAN+APPROVED PRs via `dev-mesh-automerge` when `AUTOMERGE_ENABLED=true`; memory-automerge remains the separate memory path.
- **`dev-mesh-backlog.yml` / `dev-mesh-autofix.yml` comments:** the *agents* still never merge their own PRs (separation of duties preserved) — reword "a human holds the merge gate (auto-merge is off)" to "agents never self-merge; merging is gated + automated by `dev-mesh-automerge` (when enabled)".
- **`dev-mesh-memory-automerge.yml`:** note it's now one of two sanctioned auto-merges (memory path), alongside the gated code path.

## Data flow & error handling
cron → check `AUTOMERGE_ENABLED` → list open PRs → `isAutoMergeable` filter → merge each (idempotent; per-PR try/catch) → log. Failure is data: a merge that races a state change (409/“not mergeable”) is logged and retried next sweep — never aborts the run, never force-anything. A `gh` API hiccup fails that PR only. Disabled or zero-eligible → clean no-op.

## Safety properties (Phase 1 invariants)
- **Nothing merges without an explicit `APPROVED` review** (fail-closed predicate).
- **Never merges fork PRs** (`isCrossRepository` guard) — untrusted code never auto-lands.
- **Hold labels and drafts are honored** — a human can veto any PR by labeling it.
- **Instant global pause** via `AUTOMERGE_ENABLED=false` (default off until explicitly enabled).
- **Never fixes / force-pushes / closes** — only merges ready PRs (merge-commit) and deletes the merged branch.
- The predicate is **pure + unit-tested**; the sweep’s only writes are `gh pr merge` on PRs that pass it.

## Testing (hermetic, `node --test`)
- **`test/automerge-eligibility.test.js`** — table-driven `isAutoMergeable`: CLEAN+APPROVED → true; each disqualifier independently → false (draft, fork, not-CLEAN states `BEHIND`/`BLOCKED`/`DIRTY`/`UNKNOWN`, reviewDecision `REVIEW_REQUIRED`/`CHANGES_REQUESTED`/null, each hold label); unknown/missing fields → false (fail-closed).
- **`test/automerge-sweep.test.js`** — `runSweep({ gh, repo, enabled, dryRun, log })` (from `src/automerge/sweep.js`) with an injected `gh`: `enabled:false` → no merges (`disabled:true`); mixed PR list → merges only eligible PRs, in order, with the exact `gh pr merge … --merge --delete-branch` args; a throwing `gh pr merge` on one PR doesn’t abort the others (counted `skipped`); `dryRun:true` merges nothing but reports the eligible set.
- **`test/automerge-workflow.test.js`** — lint the workflow YAML shape (cron, concurrency, permissions, reads `vars.AUTOMERGE_ENABLED`, runs the sweep script), mirroring `test/integration-workflow.test.js`.

---

# Phase 2 — A2A fix-then-merge orchestration (sketch)

*Not built in Phase 1.* A **local** orchestrator (in the dev-society daemon, where the real A2A wire lives) that closes the loop on approved-but-not-ready PRs:
- On finding an `APPROVED` PR that is `DIRTY` (conflicts) or red, the orchestrator delegates over **A2A** to the **Coder** (`do`) to resolve/▸re-green, waits for the result, then merges — one driven pipeline instead of independent sweeps.
- **Why it's separate / later:** A2A is the local stdio plane, so this runs only when the machine + daemon are up (**not 24/7**), and it **overlaps** the existing cloud `mergefix`/`ci-sweep` (which already drive the Coder via GitHub state). Worth designing only if the cloud-coordinated flow (Phase 1 + existing fixers) leaves a real gap in practice.
- Open questions for the Phase-2 spec: dedupe against the cloud fixers (avoid two agents fixing the same PR), local-vs-cloud ownership handoff, bounded fix attempts, and whether to drive fixes via A2A vs `workflow_dispatch` of the existing fixers (orchestration without duplication).

## Deferred
- Per-PR `automerge` opt-in label (Phase 1 merges *all* eligible; a label-gated mode is a small future option if "any approved PR" proves too broad).
- A merge cooldown / approval-age window (chosen: none for Phase 1).
- Auto-disable on repeated post-merge breakage (revisit if it ever lands a bad-but-green change).
