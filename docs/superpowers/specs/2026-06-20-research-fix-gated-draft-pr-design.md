# Research-Fix Gated Draft-PR Design (Sub-project ③b)

**Date:** 2026-06-20
**Status:** Draft — pending Codex review
**Topic:** A daemon job that takes ③a's researched diagnosis on a `needs-human`
escalation, runs the **Coder in do-mode** to implement the recommended fix, and opens
a **DRAFT** pull request that is **never auto-merged** — the human reviews, un-drafts,
and merges. The act-on-research counterpart to ③a's diagnose-only layer.

## Problem

③a (`research-escalation`) posts a researched **diagnosis + recommended strategy** as a
`<!-- research-escalation -->` comment on each open `needs-human` issue — the hard cases
the naive auto-fixers (`dev-mesh-autofix`/`dev-mesh-mergefix`) exhausted their commit
budgets on. Today that research just sits there until a human acts on it. Nothing turns
the diagnosis into a concrete, reviewable fix attempt. ③b closes that gap: it drives the
Coder (do-mode) with the diagnosis as context and produces a **draft** PR the human can
take over — research → *attempted fix*, while keeping the human firmly in the merge loop.

## Goal

A daemon builtin **`research-fix`** (do-mode, scheduled ~hourly) that, for an open
`needs-human` issue carrying a ③a diagnosis and **not** yet attempted by ③b:
1. runs the **Coder** in do-mode in a fresh worktree with a prompt built from the issue
   + the ③a diagnosis ("implement this researched fix strategy");
2. runs the suite + a Reviewer (`ask`) pass over the diff;
3. on **green**, opens a **DRAFT** PR (links the issue + diagnosis, adds a `do-not-merge`
   hold label) and posts a `<!-- research-fix:PR#N -->` marker comment; on a **clean
   red/no-change** result, posts a marked attempt summary and opens **no** PR.

The draft PR is **never auto-merged**; the human un-drafts + merges. The issue stays
`needs-human` until then.

## Non-Goals (hold the line)

- **No auto-merge, ever.** The PR is opened `--draft`; `isAutoMergeable` already blocks
  drafts (`src/automerge/eligibility.js:28`), and ③b adds a `do-not-merge` hold label as
  defense-in-depth. ③b never merges; the only human gate is review + un-draft + merge.
- **No re-running ③a.** ③b consumes ③a's diagnosis comment; it does not research or
  re-diagnose. A missing diagnosis → the issue is skipped (③a will get to it first).
- **No new detection / no triage change.** ③b reads ③a-diagnosed `needs-human` issues; it
  does not re-scan PRs or change `routeFor` (③a already made `needs-human` research-owned).
- **No second fix attempt without a human.** Each issue is attempted once (marker dedup);
  a human deletes the `<!-- research-fix -->` marker to allow a retry. (Avoids burning the
  expensive do-mode build repeatedly on the same hard case.)
- **Not the autofixers.** `dev-mesh-autofix`/`mergefix` fix *their own* failing PRs within
  a 2-commit budget; ③b creates a **new** research-driven fix for the *escalated issue*
  after those budgets are spent. Different input, different output — no duplication.

## Background (verified against code)

- **③a diagnosis surface:** an open `needs-human` issue carries a bot-authored
  `<!-- research-escalation -->` comment (the diagnosis + strategy). ③b reads it via
  `gh issue view <n> --json comments` and matches `comment.author.login === botLogin`
  (the same bot-author guard ③a uses — `src/dev-society/research-escalation-run.js`).
- **The proven Coder-do build pipeline** (`scripts/dev-society-daemon.mjs` `runOneTask`,
  ≈ lines 455–556): fresh worktree off `origin/<base>` → `acquireBuildLock` →
  `client.send('coder', core.a2aMessage('do', core.coderPrompt(issue)))` →
  `core.taskSucceeded` + `core.taskOutcome(...).filesChanged` → run `run-all-tests.mjs`
  (the Tester step; workers have no Bash in do) → `client.send('reviewer',
  core.a2aMessage('ask', core.reviewerPrompt(issue, diff)))` → `core.shouldOpenPR({
  coderTask, tests })` gate → `git push` + `gh pr create` → `releaseBuildLock`. ③b reuses
  this sequence with two deltas: the prompt carries the diagnosis, and the PR is `--draft`.
- **Draft exclusion is real:** `classifyAutomergePr` returns `{state:'blocked',
  reason:'draft'}` for `pr.isDraft !== false` (`src/automerge/eligibility.js:28`), and
  `isAutoMergeable` only returns true for `state === 'would-merge'` (`eligibility.js:44`).
  So a `--draft` PR is structurally outside the dev-society automerge sweep. `do-not-merge`
  ∈ `DEFAULT_HOLD_LABELS` (`eligibility.js:6`) is the belt-and-suspenders second guard.
- **Build-lock discipline:** `runOneTask` holds the build-lock for the whole build
  (`acquireBuildLock` line 462 → `releaseBuildLock` line 556) so deploy-sync defers the
  daemon restart and only one build runs per tick. ③b's do-mode build (via the shared
  `runCoderBuild`) takes the same lock; before starting, ③b reads `readBuildBusy(repoRoot)`
  (`src/dev-society/build-lock.js:42`, stale-aware) and **yields** the tick if a build is
  already in flight.
- **`shouldOpenPR`/`taskSucceeded`/`taskOutcome`** (`src/dev-society/core.js`): the
  existing gates ③b reuses verbatim — `shouldOpenPR({coderTask, tests})` is the
  green-only gate; `taskSucceeded` distinguishes a clean completion from an infra
  failure/timeout (no `errorCode` + completed state).
- **Builtins + gh helpers:** the daemon `builtins` map (return `{status,output|error}`);
  `gh`, `issueComment`, `addLabel`, `cfg.repo`, `cfg.base`, `cfg.workRoot`, `cfg.timeoutMs`,
  `BIN`, `SCHED_MESH_ROOT`, `core`, `createA2AClient`, `acquireBuildLock`/`releaseBuildLock`
  are in scope. A schedule entry needs `kind:"builtin"`+`builtin:"<id>"`.

## Architecture

```
coder schedule (every ~60 min)
  └─ research-fix builtin  (DO-MODE, build-lock serialized, cap 1/tick)
       gh issue list --label needs-human --state open --search sort:created-asc --limit 200
       per issue: gh issue view <n> --json comments
                  → has bot-authored <!-- research-escalation --> (③a diagnosis)?
                  → lacks bot-authored <!-- research-fix --> (not yet attempted)?
       planResearchFix(issues, diagnosed, attempted, cfg) ─ pure ─▶ { toFix:[{number, prNum, diagnosis}] }  (cap 1)
       if build-lock held → yield (return ok, attempted 0)
       for the picked issue (≤1):
         runCoderBuild({ issue, prompt: researchFixPrompt(issue, diagnosis), draft:true, holdLabel:'do-not-merge' })
            fresh worktree off origin/base → Coder(do) → suite → Reviewer(ask) → shouldOpenPR gate
         ├─ green + change → gh pr create --draft (+do-not-merge) → <!-- research-fix:PR#N --> comment (issue stays needs-human)
         ├─ clean red/no-change → <!-- research-fix --> attempt-summary comment, NO PR
         └─ infra fail/timeout → NO marker (retry next tick)
```

`runCoderBuild` is the shared Coder-do sequence extracted from `runOneTask` (see
Components §3) so the normal build path and ③b's draft path don't duplicate ~90 lines.

## Components

### 1. `src/dev-society/research-fix.js` (pure)

```js
// FIX_MARKER = '<!-- research-fix -->'  (dedup marker ③b writes)
// DIAG_MARKER = '<!-- research-escalation -->'  (③a's diagnosis marker it reads)
// planResearchFix(issues, cfg) → { toFix: [{ number, prNum, diagnosis }] }
//   issues: [{ number, body, diagnosis|null, attempted:boolean }]
//     diagnosis = the bot-authored ③a comment text (null if none)
//     attempted = already carries a bot-authored FIX_MARKER
//   Picks issues WITH a diagnosis and NOT attempted, parses prNum from the
//   needs-human marker (reuses ③a's parseStuckPr), sorts ascending by issue
//   number (oldest-first), caps at cfg.capPerRun (default 1). Pure.
// researchFixPrompt(issue, diagnosis) → string
//   Builds the Coder do-mode prompt: the task + the ③a diagnosis fenced as a
//   RECOMMENDED STRATEGY TO EVALUATE (the diagnosis was derived from untrusted
//   issue/PR content, so the Coder must judge it, not blindly execute), + the
//   standing rule: implement a real fix, keep it minimal, the suite must pass.
```

The PR-number parse imports `parseStuckPr` from `./research-escalation.js` (DRY).

### 2. `src/dev-society/research-fix-run.js` (impure runner)

```js
// runResearchFix({ gh, runBuild, buildLockHeld, repo, botLogin?, now, cfg, log })
//   gh: injected (argv→stdout). runBuild: injected Coder-do executor (fake-able):
//     runBuild({ issue, prompt, draft, holdLabel }) → { opened:boolean, prNumber, status, summary }
//   buildLockHeld: () => boolean  (yield if a normal build is running)
//   1. resolve botLogin (gh api user --jq .login); fail closed if unresolved.
//   2. gh issue list --label needs-human --state open --search sort:created-asc --limit 200 --json number,body
//   3. per issue: gh issue view <n> --json comments → diagnosis (bot DIAG_MARKER comment text) + attempted (bot FIX_MARKER?)
//   4. planResearchFix(...) → toFix (cap 1)
//   5. if buildLockHeld() → return { status:'ok', output:'yield (build in progress)' }
//   6. for the pick: res = await runBuild({ issue, prompt: researchFixPrompt(...), draft:true, holdLabel:'do-not-merge' })
//        opened (green) → gh issue comment <n> `${FIX_MARKER}\n\n🛠 Draft fix PR: <url> …`  (issue stays needs-human)
//        clean not-opened → gh issue comment <n> `${FIX_MARKER}\n\n🛠 Attempted, suite red / no change — needs a human:\n<summary>`
//        runBuild throws / infra status → NO comment, NO marker (retry next tick)
//   read-only gh + the single mutation gh issue comment; runBuild owns the worktree/git/pr writes.
```

Fail-closed on botLogin (same rationale as ③a — an unknown identity can't judge which
markers are the bot's own). Marker write distinguishes a **clean** attempt (suite ran,
red or no-change → mark, dedup) from an **infra** failure (`runBuild` threw / non-`done`
→ no mark, retry).

### 3. `scripts/dev-society-daemon.mjs` — extract `runCoderBuild` + wire the builtin

Refactor `runOneTask`'s Coder-do→test→reviewer→PR core into a reusable:
```js
// runCoderBuild({ issue, prompt, draft = false, holdLabel = null })
//   → { opened, prNumber, status, summary }
// Identical behavior to today's runOneTask body for the NON-draft default (the normal
// path keeps calling it with draft:false and the same coderPrompt) — covered by the
// real-`claude` demo-e2e. When draft:true: `gh pr create --draft …` and addLabel(holdLabel).
```
`runOneTask` becomes a thin caller of `runCoderBuild({ issue, prompt: core.coderPrompt(issue) })`
plus its existing label transitions (`IN_PROGRESS`/`PR_IN_REVIEW`/`BLOCKED`). The
`research-fix` builtin wires `runResearchFix` with `runBuild = (a) => runCoderBuild(a)`,
`buildLockHeld = () => readBuildBusy(repoRoot)`, `gh`, `repo: cfg.repo`, `cfg:{capPerRun:1}`.

`readBuildBusy(root)` already exists (`src/dev-society/build-lock.js:42`, built on the pure
`isBuildBusy(lockContent)` at line 32) and returns true iff a non-stale build lock is held —
no new predicate needed; ③b reuses it.

### 4. Schedule entry — `dev-mesh/coder/.agent/schedule.json`

```json
{ "id":"research-fix", "name":"Draft-fix stuck escalations (do)", "kind":"builtin",
  "builtin":"research-fix", "cadence":{ "kind":"every", "minutes":60 }, "enabled":true,
  "description":"Do-mode: Coder implements ③a's diagnosis on a needs-human issue and opens a DRAFT PR (never auto-merged). Build-lock serialized, cap 1/tick." }
```
`capPerRun = 1` — one heavy do-mode build per tick; the build-lock + yield keep ③b from
colliding with the normal coder queue.

## Data Flow

`③a diagnosis comment → research-fix (hourly) lists diagnosed-unattempted needs-human
issues → planResearchFix (cap 1) → runCoderBuild(draft) → green ? DRAFT PR + marker :
attempt comment + marker`. The only ③b mutations are `gh issue comment`, the `--draft`
PR, and the `do-not-merge` label. The issue stays `needs-human`; the human merges.

## Error Handling

- **Build-lock held** → yield the tick (`{status:'ok'}`, attempted 0); no build started.
- **`runBuild` infra failure / non-`done` Coder** → no marker, no PR; retried next eligible
  tick (failure is data; mirrors ③a's status gate). The worktree is always cleaned in a
  `finally` (as `runOneTask` does today).
- **Clean suite-red / no-change** → marked attempt-summary comment, no PR (deduped; human
  deletes the marker to retry).
- **botLogin unresolved** → `{status:'fail'}`, nothing posted (fail closed).
- **`gh issue list` failure** → `{status:'fail'}`, no builds.
- Dedup is bot-authored-marker-based, so a re-run never double-attempts.

## Testing (hermetic, `node --test`, zero deps)

- **`planResearchFix` (pure):** picks diagnosed + un-attempted; skips no-diagnosis and
  already-attempted; parses prNum; ascending oldest-first; caps at `capPerRun`.
- **`researchFixPrompt` (pure):** includes the issue + the diagnosis fenced as a
  recommended-strategy-to-evaluate (not an instruction to obey) + the minimal-fix/suite-green rule.
- **`runResearchFix`** (fake `gh` + fake `runBuild` + fake `buildLockHeld`):
  - read-only allowlist: `issue list`, `issue view`, `api user`, `issue comment` only —
    no `issue create/edit/close`, no `pr` verbs, no `git` (runBuild owns those).
  - green build → exactly one `<!-- research-fix:PR#N -->`-marked comment, issue NOT closed
    and `needs-human` retained; a `do-not-merge`/draft is requested via runBuild args.
  - clean red/no-change → one `<!-- research-fix -->` attempt comment, **no** PR opened.
  - `runBuild` throw / infra status → **no** comment, **no** marker (retry).
  - build-lock held → no build, yields.
  - botLogin unresolved → fail closed, nothing posted.
  - cap honored (≤ capPerRun builds per run).
- **`runCoderBuild` refactor:** a unit test that `draft:true` adds `--draft` to the
  `gh pr create` argv and applies `holdLabel`; the non-draft default omits both. The
  real-`claude` `demo-e2e` (do-mode write + PR) stays green (behavior-preserving refactor).
  (`readBuildBusy`/`isBuildBusy` are already covered by the existing build-lock tests — ③b
  reuses them, no new test.)
- **Schedule lint:** the coder job has `builtin:"research-fix"`.

## Verification (manual, on the host — after merge)

1. The coder schedule shows `research-fix` (60 min).
2. For an open `needs-human` issue with a ③a diagnosis, within a tick either a **draft**
   PR appears (linked from a `<!-- research-fix:PR#N -->` comment, carrying `do-not-merge`,
   and NOT picked up by the automerge sweep) or a marked attempt-summary comment appears;
   a second tick does neither again (dedup). The issue stays `needs-human`.
3. The Coder run-log shows do-mode confined to the worktree; the draft PR is never
   auto-merged by the dev-society sweep.

## Deferred (not ③b)

- **Auto-undraft on green review** — letting a human's `approve` review flip the draft to
  ready is a separate policy; ③b always leaves it draft.
- **Multi-attempt escalation** — trying a second strategy if the first draft is rejected
  is out of scope (a human re-triggers by deleting the marker).
