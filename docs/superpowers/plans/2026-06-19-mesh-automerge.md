# Mesh Gated Auto-Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A scheduled GitHub Actions sweep that auto-merges PRs which are CLEAN + APPROVED (same-repo, non-fork, non-draft, no hold label), gated behind a default-OFF repo variable.

**Architecture:** A pure predicate (`isAutoMergeable`) + an injectable sweep (`runSweep`) in `src/automerge/`, both hermetically tested; a thin CLI shell `scripts/automerge-sweep.mjs` wires the real `gh`/env; a cron workflow `dev-mesh-automerge.yml` runs it 24/7 (mechanical — no `claude`). Mirrors the Phase-2 gh-activity pure/impure/CLI split and the `memory-automerge` workflow's auth.

**Tech Stack:** Node ≥20, ESM, zero deps, `node --test`. `gh` CLI. GitHub Actions.

Spec: `docs/superpowers/specs/2026-06-19-mesh-automerge-design.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/automerge/eligibility.js` (new) | pure `isAutoMergeable(pr, opts)` predicate |
| `src/automerge/sweep.js` (new) | injectable `runSweep({gh,repo,enabled,…})` loop |
| `scripts/automerge-sweep.mjs` (new) | thin CLI: real `gh` + env → `runSweep` |
| `.github/workflows/dev-mesh-automerge.yml` (new) | cron sweep (default-OFF, mechanical) |
| `PROJECT.md` + `dev-mesh-backlog.yml`/`dev-mesh-autofix.yml`/`dev-mesh-memory-automerge.yml` (modify) | document the gated-auto-merge policy |
| `test/automerge-eligibility.test.js`, `test/automerge-sweep.test.js`, `test/automerge-workflow.test.js` (new) | coverage |

---

## Task 1: Pure `isAutoMergeable` predicate

**Files:**
- Create: `src/automerge/eligibility.js`
- Test: `test/automerge-eligibility.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/automerge-eligibility.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAutoMergeable } from '../src/automerge/eligibility.js';

const ok = { number: 1, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [{ name: 'approved' }] };

test('CLEAN + APPROVED + same-repo + non-draft + no hold → mergeable', () => {
  assert.equal(isAutoMergeable(ok), true);
});
test('draft → not mergeable', () => assert.equal(isAutoMergeable({ ...ok, isDraft: true }), false));
test('fork (isCrossRepository) → not mergeable', () => assert.equal(isAutoMergeable({ ...ok, isCrossRepository: true }), false));
test('non-CLEAN merge states → not mergeable', () => {
  for (const s of ['BEHIND', 'BLOCKED', 'DIRTY', 'UNKNOWN', 'UNSTABLE', 'HAS_HOOKS', '']) {
    assert.equal(isAutoMergeable({ ...ok, mergeStateStatus: s }), false, s);
  }
});
test('non-APPROVED reviews → not mergeable', () => {
  for (const r of ['REVIEW_REQUIRED', 'CHANGES_REQUESTED', null, '']) {
    assert.equal(isAutoMergeable({ ...ok, reviewDecision: r }), false, String(r));
  }
});
test('any hold label → not mergeable', () => {
  for (const l of ['do-not-merge', 'hold', 'wip']) {
    assert.equal(isAutoMergeable({ ...ok, labels: [{ name: 'approved' }, { name: l }] }), false, l);
  }
});
test('custom holdLabels respected', () => {
  assert.equal(isAutoMergeable({ ...ok, labels: [{ name: 'freeze' }] }, { holdLabels: ['freeze'] }), false);
});
test('fail-closed on garbage / missing fields', () => {
  assert.equal(isAutoMergeable(null), false);
  assert.equal(isAutoMergeable(undefined), false);
  assert.equal(isAutoMergeable({}), false);
  assert.equal(isAutoMergeable({ ...ok, labels: undefined }), true); // no labels = no hold
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/automerge-eligibility.test.js`
Expected: FAIL — `Cannot find module '../src/automerge/eligibility.js'`.

- [ ] **Step 3: Write `src/automerge/eligibility.js`**

```js
// Pure: decide whether one open PR is safe to auto-merge. Fail-closed — any
// missing/unknown field or disqualifier → false. No I/O.
export const DEFAULT_HOLD_LABELS = ['do-not-merge', 'hold', 'wip'];

/**
 * @param {object} pr  one `gh pr list/view --json` row:
 *   { isDraft, isCrossRepository, mergeStateStatus, reviewDecision, labels:[{name}] }
 * @param {{holdLabels?:string[]}} [opts]
 * @returns {boolean} true iff safe to auto-merge
 */
export function isAutoMergeable(pr, { holdLabels = DEFAULT_HOLD_LABELS } = {}) {
  if (!pr || typeof pr !== 'object') return false;
  if (pr.isDraft) return false;
  if (pr.isCrossRepository) return false;              // never fork PRs
  if (pr.mergeStateStatus !== 'CLEAN') return false;   // mergeable + checks green + up-to-date
  if (pr.reviewDecision !== 'APPROVED') return false;  // explicit approval required
  const names = Array.isArray(pr.labels) ? pr.labels.map((l) => (l && l.name) || '') : [];
  if (names.some((n) => holdLabels.includes(n))) return false;
  return true;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/automerge-eligibility.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/automerge/eligibility.js test/automerge-eligibility.test.js
git commit -m "feat(automerge): pure isAutoMergeable predicate (CLEAN+APPROVED, fail-closed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Injectable `runSweep`

**Files:**
- Create: `src/automerge/sweep.js`
- Test: `test/automerge-sweep.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/automerge-sweep.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSweep } from '../src/automerge/sweep.js';

const ok = (n, over = {}) => ({ number: n, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [], ...over });

function ghStub(prs, { failMerge = [] } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
    if (args[0] === 'pr' && args[1] === 'merge') {
      if (failMerge.includes(Number(args[2]))) throw new Error('not mergeable');
      return '';
    }
    return '';
  };
  return { gh, calls };
}

test('disabled → no list, no merge', async () => {
  const { gh, calls } = ghStub([ok(1)]);
  const r = await runSweep({ gh, repo: 'o/r', enabled: false });
  assert.equal(r.disabled, true);
  assert.equal(calls.length, 0);
});

test('merges only eligible PRs, with exact args', async () => {
  const prs = [ok(1), ok(2, { mergeStateStatus: 'DIRTY' }), ok(3, { reviewDecision: 'REVIEW_REQUIRED' }), ok(4)];
  const { gh, calls } = ghStub(prs);
  const r = await runSweep({ gh, repo: 'o/r', enabled: true });
  assert.deepEqual(r.merged, [1, 4]);
  assert.equal(r.ineligible, 2);
  const mergeCalls = calls.filter((a) => a[1] === 'merge');
  assert.deepEqual(mergeCalls[0], ['pr', 'merge', '1', '--repo', 'o/r', '--merge', '--delete-branch']);
  assert.equal(mergeCalls.length, 2);
});

test('one merge failure does not abort the rest (counted skipped)', async () => {
  const { gh } = ghStub([ok(1), ok(2)], { failMerge: [1] });
  const r = await runSweep({ gh, repo: 'o/r', enabled: true });
  assert.deepEqual(r.merged, [2]);
  assert.equal(r.skipped, 1);
});

test('dry-run merges nothing but reports the eligible set', async () => {
  const { gh, calls } = ghStub([ok(1), ok(2)]);
  const r = await runSweep({ gh, repo: 'o/r', enabled: true, dryRun: true });
  assert.deepEqual(r.merged, [1, 2]);
  assert.equal(calls.filter((a) => a[1] === 'merge').length, 0);
});

test('pr list failure → returns error, no throw', async () => {
  const gh = async () => { throw new Error('gh down'); };
  const r = await runSweep({ gh, repo: 'o/r', enabled: true });
  assert.equal(r.merged.length, 0);
  assert.ok(r.error);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/automerge-sweep.test.js`
Expected: FAIL — `Cannot find module '../src/automerge/sweep.js'`.

- [ ] **Step 3: Write `src/automerge/sweep.js`**

```js
// Impure but fully injected: list open PRs via gh, merge the auto-mergeable ones.
// Failure is data — a per-PR merge error is logged + counted, never aborts the sweep.
import { isAutoMergeable, DEFAULT_HOLD_LABELS } from './eligibility.js';

const PR_FIELDS = 'number,isDraft,isCrossRepository,mergeStateStatus,reviewDecision,labels';

/**
 * @param {object} deps
 *   gh(args)        → stdout string (injected)
 *   repo            'owner/name'
 *   enabled         boolean (must be exactly true to act)
 *   holdLabels?     string[]
 *   dryRun?         boolean
 *   log?            (msg) => void
 * @returns {{disabled?:boolean, merged:number[], skipped:number, ineligible:number, error?:string}}
 */
export async function runSweep({ gh, repo, enabled, holdLabels = DEFAULT_HOLD_LABELS, dryRun = false, log = () => {} }) {
  if (enabled !== true) {
    log('automerge: disabled (AUTOMERGE_ENABLED != true)');
    return { disabled: true, merged: [], skipped: 0, ineligible: 0 };
  }
  let prs;
  try {
    prs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', PR_FIELDS, '--limit', '100']));
  } catch (e) {
    log('automerge: pr list failed: ' + (e?.message || e));
    return { merged: [], skipped: 0, ineligible: 0, error: e?.message || String(e) };
  }
  const list = Array.isArray(prs) ? prs : [];
  const eligible = list.filter((pr) => isAutoMergeable(pr, { holdLabels }));
  const ineligible = list.length - eligible.length;
  const merged = [], skipped = [];
  for (const pr of eligible) {
    if (dryRun) { merged.push(pr.number); continue; }
    try {
      await gh(['pr', 'merge', String(pr.number), '--repo', repo, '--merge', '--delete-branch']);
      merged.push(pr.number);
    } catch (e) {
      skipped.push(pr.number);
      log(`automerge: #${pr.number} merge failed (retry next sweep): ${e?.message || e}`);
    }
  }
  log(`automerge: merged [${merged.join(',')}]${dryRun ? ' (dry-run)' : ''} · skipped ${skipped.length} · ineligible ${ineligible}`);
  return { merged, skipped: skipped.length, ineligible };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/automerge-sweep.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/automerge/sweep.js test/automerge-sweep.test.js
git commit -m "feat(automerge): runSweep — list open PRs and merge the eligible ones

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Thin CLI shell

**Files:**
- Create: `scripts/automerge-sweep.mjs`

- [ ] **Step 1: Write `scripts/automerge-sweep.mjs`**

```js
#!/usr/bin/env node
// Thin CLI: wire the real gh + env, run the gated auto-merge sweep. Failure is
// data → always exit 0 (a cron sweep must not fail the workflow on a transient
// gh hiccup). enabled is OFF unless AUTOMERGE_ENABLED === 'true'.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runSweep } from '../src/automerge/sweep.js';

const sh = promisify(execFile);
const gh = async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout;
const repo = process.env.GITHUB_REPOSITORY || process.env.DEV_SOCIETY_REPO || '';

const r = await runSweep({
  gh,
  repo,
  enabled: process.env.AUTOMERGE_ENABLED === 'true',
  dryRun: process.argv.includes('--dry-run'),
  log: (m) => console.error(m),
});
console.error('automerge result: ' + JSON.stringify(r));
```

- [ ] **Step 2: Syntax check + disabled-path smoke (no network, no merges)**

Run: `node --check scripts/automerge-sweep.mjs` → no output (valid).
Run: `node scripts/automerge-sweep.mjs` (AUTOMERGE_ENABLED unset)
Expected: prints `automerge: disabled (AUTOMERGE_ENABLED != true)` and `automerge result: {"disabled":true,...}`, exit 0. (No `gh` call, so no network needed.)

- [ ] **Step 3: Commit**

```bash
git add scripts/automerge-sweep.mjs
git commit -m "feat(automerge): CLI shell wiring real gh + AUTOMERGE_ENABLED gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: The cron workflow

**Files:**
- Create: `.github/workflows/dev-mesh-automerge.yml`
- Test: `test/automerge-workflow.test.js`

- [ ] **Step 1: Write the failing lint test**

```js
// test/automerge-workflow.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wf = readFileSync(fileURLToPath(new URL('../.github/workflows/dev-mesh-automerge.yml', import.meta.url)), 'utf8');

test('automerge workflow: scheduled + manual, ubuntu, safe concurrency', () => {
  assert.match(wf, /^on:/m);
  assert.match(wf, /schedule:/);
  assert.match(wf, /cron:\s*'[^']+'/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /runs-on:\s*ubuntu-latest/);
  assert.match(wf, /cancel-in-progress:\s*false/);
});

test('automerge workflow: gated by the AUTOMERGE_ENABLED repo variable + runs the sweep', () => {
  assert.match(wf, /AUTOMERGE_ENABLED:\s*\$\{\{\s*vars\.AUTOMERGE_ENABLED\s*\}\}/);
  assert.match(wf, /automerge-sweep\.mjs/);
});

test('automerge workflow: mechanical — has merge perms, no claude', () => {
  assert.match(wf, /pull-requests:\s*write/);
  assert.match(wf, /contents:\s*write/);
  assert.doesNotMatch(wf, /CLAUDE_CODE_OAUTH_TOKEN|anthropic/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/automerge-workflow.test.js`
Expected: FAIL — workflow file does not exist.

- [ ] **Step 3: Write `.github/workflows/dev-mesh-automerge.yml`**

```yaml
# Dev-mesh · gated auto-merge — merges CLEAN + APPROVED same-repo PRs on a schedule.
# Default-OFF: no-ops unless repo variable AUTOMERGE_ENABLED == 'true'. Mechanical
# (no claude). NEVER merges forks, drafts, or PRs with a hold label (do-not-merge/
# hold/wip). The merge decision is the pure isAutoMergeable() predicate.
# Spec: docs/superpowers/specs/2026-06-19-mesh-automerge-design.md
name: dev-mesh-automerge

on:
  schedule:
    - cron: '7,22,37,52 * * * *' # every 15 min, offset from the other sweeps
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'List eligible PRs without merging'
        type: boolean
        default: false

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: dev-mesh-automerge
  cancel-in-progress: false

jobs:
  automerge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: sweep
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AUTOMERGE_ENABLED: ${{ vars.AUTOMERGE_ENABLED }}
        run: node scripts/automerge-sweep.mjs ${{ (github.event_name == 'workflow_dispatch' && inputs.dry_run) && '--dry-run' || '' }}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/automerge-workflow.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/dev-mesh-automerge.yml test/automerge-workflow.test.js
git commit -m "feat(automerge): default-OFF cron workflow (gated by AUTOMERGE_ENABLED)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Document the gated-auto-merge policy

**Files:**
- Modify: `PROJECT.md`
- Modify: `.github/workflows/dev-mesh-backlog.yml`, `.github/workflows/dev-mesh-autofix.yml`, `.github/workflows/dev-mesh-memory-automerge.yml`

No new test — this is documentation of the invariant change (per the repo rule "change the invariant in PROJECT.md first").

- [ ] **Step 1: Add a "Merge policy" note to `PROJECT.md`**

Find a sensible section (near the security/invariants discussion, or append a short subsection). Add verbatim:
```markdown
### Merge policy (gated auto-merge)

A human or the dev-mesh Reviewer still **approves** every code PR. The **merge action** is automated: `dev-mesh-automerge` (a mechanical scheduled sweep) merges any PR that is `mergeStateStatus=CLEAN` AND `reviewDecision=APPROVED`, same-repo (never forks), non-draft, and carries no hold label (`do-not-merge`/`hold`/`wip`). It is **default-OFF** — it no-ops unless the repo variable `AUTOMERGE_ENABLED='true'`. Agents still NEVER self-merge their own PRs (separation of duties); they leave merging to this sweep. `dev-mesh-memory-automerge` remains the separate memory-only path.
```

- [ ] **Step 2: Reword the stale `auto-merge is off` comments**

In `.github/workflows/dev-mesh-backlog.yml`, the comments currently say a human holds the merge gate. Replace both occurrences:
- `# never merges — a human holds the merge gate (auto-merge off).`
  → `# never self-merges — agents leave merging to dev-mesh-automerge (gated, default-OFF).`
- In the agent prompt body: `Do NOT merge — a human holds the merge gate (auto-merge is off). CI (\`ci.yml\`)`
  → `Do NOT merge — agents never self-merge; dev-mesh-automerge handles merging when enabled. CI (\`ci.yml\`)`

In `.github/workflows/dev-mesh-autofix.yml`, the line:
- `FORBIDDEN: never merge or close the PR yourself (no auto-merge) — a human holds the`
  → `FORBIDDEN: never merge or close the PR yourself — agents never self-merge; dev-mesh-automerge handles merging when enabled. A human/Reviewer holds the`
(Keep the rest of that sentence intact — only reword up to "holds the".)

In `.github/workflows/dev-mesh-memory-automerge.yml`, the header line:
- `# `schedule` trigger is the robust way to pick them up...` is fine; update the opening comment `# Dev-mesh · memory auto-merge — the ONE sanctioned auto-merge in the mesh.`
  → `# Dev-mesh · memory auto-merge — the memory-only auto-merge path (quick.json, never code).`
  (It is no longer the ONLY one; dev-mesh-automerge is the gated code path.)

VERIFY each exact string exists before replacing (grep first); if the wording differs slightly, match the real text while preserving the intent (agents never self-merge; dev-mesh-automerge handles merging when enabled).

- [ ] **Step 3: Sanity — workflows still parse, no broken references**

Run: `node --test test/automerge-workflow.test.js test/integration-workflow.test.js`
Expected: PASS (comment edits don't change structure).
Run: `grep -rn "a human holds the merge gate" .github/workflows/ || echo "no stale gate comments"`
Expected: `no stale gate comments`.

- [ ] **Step 4: Commit**

```bash
git add PROJECT.md .github/workflows/dev-mesh-backlog.yml .github/workflows/dev-mesh-autofix.yml .github/workflows/dev-mesh-memory-automerge.yml
git commit -m "docs(automerge): document the gated auto-merge policy (relax human-merge-gate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full-suite verification + safe live dry-run

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all existing + new (`automerge-eligibility` 8, `automerge-sweep` 5, `automerge-workflow` 3); 0 failures.

- [ ] **Step 2: Safe live dry-run (real `gh`, NO merges)**

This proves the end-to-end path against the real repo WITHOUT merging anything (dry-run + reads only):
```bash
AUTOMERGE_ENABLED=true GITHUB_REPOSITORY=danabaxia/agent_mesh node scripts/automerge-sweep.mjs --dry-run
```
Expected: `automerge: merged [..] (dry-run) · skipped 0 · ineligible N` — listing which open PRs WOULD merge (likely none unless an approved+CLEAN PR exists right now), and `automerge result: {...}`. No PR is actually merged (dry-run).

Also confirm the default-OFF gate:
```bash
GITHUB_REPOSITORY=danabaxia/agent_mesh node scripts/automerge-sweep.mjs
```
Expected: `automerge: disabled (AUTOMERGE_ENABLED != true)` — no `gh` call.

- [ ] **Step 3: Commit (empty if clean)**

```bash
git commit --allow-empty -m "test(automerge): Phase 1 verified — npm test green + safe live dry-run

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Activation (post-merge, operator step — NOT in the PR)

After this merges to `main`, auto-merge stays **OFF** until you set the repo variable:
```bash
gh variable set AUTOMERGE_ENABLED --body true --repo danabaxia/agent_mesh
```
To pause instantly at any time: `gh variable set AUTOMERGE_ENABLED --body false …` (or delete the variable).

---

## Self-review notes (author)

- **Spec: workflow (cloud, cron, default-OFF, mechanical)** → Task 4. ✓
- **Spec: merge bar CLEAN+APPROVED + rails (fork/draft/hold)** → Task 1 (`isAutoMergeable`, every disqualifier tested). ✓
- **Spec: kill switch `AUTOMERGE_ENABLED` default-OFF** → Task 2 (`enabled!==true` no-op) + Task 3 (`=== 'true'`) + Task 4 (`vars.AUTOMERGE_ENABLED`). ✓
- **Spec: same-repo only / never forks** → Task 1 (`isCrossRepository`). ✓
- **Spec: merge-commit + delete branch, idempotent, per-PR failure isolation** → Task 2 (`--merge --delete-branch`, per-PR try/catch). ✓
- **Spec: pure predicate + injectable sweep + thin CLI** → Tasks 1/2/3. ✓
- **Spec: reuse memory-automerge auth** → Task 4 (`GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`). ✓
- **Spec: doc the invariant change (PROJECT.md + stale comments)** → Task 5. ✓
- **Spec: hermetic tests + lint test** → Tasks 1/2/4; safe live dry-run → Task 6. ✓
- **Naming consistency:** `isAutoMergeable`, `runSweep`, `DEFAULT_HOLD_LABELS`, `AUTOMERGE_ENABLED`, `mergeStateStatus`, `reviewDecision`, `isCrossRepository` — identical across tasks.
- **Deferred (per spec):** Phase 2 A2A orchestration; per-PR `automerge` label mode; cooldown.
