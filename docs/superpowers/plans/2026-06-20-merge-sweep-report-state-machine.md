# Merge-Sweep Report-First State Machine Implementation Plan (①)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local, structurally read-only daemon job (`merge-sweep`) that every 15 min classifies the three housekeeping concerns (issue-gate · automerge · memory) and writes a state report (`mesh/reports/merge-sweep.json`), surfaced on the dashboard. No merges, no label edits.

**Architecture:** Read-only decision functions (`classifyIssueGate` extracted from the issue-gate sweep; `classifyAutomergePr` extending the eligibility predicate; new `classifyMemoryPr`) feed a pure `buildMergeSweepReport`. A daemon builtin runs them on read-only `gh` data and atomically writes the report; the dashboard serves it at `/api/merge-sweep` and renders a `◆ MERGE-SWEEP` panel. The existing GitHub crons and local `automerge-sweep` mutator are untouched.

**Tech Stack:** Node ≥ 20 ESM, `node --test` (zero deps), the dashboard's vanilla-JS Graph view.

Spec: `docs/superpowers/specs/2026-06-20-merge-sweep-report-state-machine-design.md` (Codex-reviewed, 4 rounds).

---

## Background the implementer needs

- Repo: zero deps; `node --test` files under `test/`; ES modules; Node ≥ 20. Run one file `node --test test/<f>.js`; all `npm test`.
- **`src/automerge/eligibility.js`** exports the pure `isAutoMergeable(pr, {holdLabels})` and `DEFAULT_HOLD_LABELS = ['do-not-merge','hold','wip','blocked-by-issue']`. Checks in order: `isDraft!==false` · `isCrossRepository!==false` · `mergeStateStatus!=='CLEAN'` · `reviewDecision!=='APPROVED'` · any hold label.
- **`src/automerge/issue-gate-sweep.js`** `runIssueGate({gh,repo,enabled,dryRun})`: lists open PRs (`--json number,labels`), for each gets `closingIssuesReferences`, gets each linked issue's labels, computes `gateDecision(names(pr.labels), shouldHoldForIssues(labelSets))` → `'add'|'remove'|null`; mutation (`pr edit --add/remove-label ISSUE_HOLD_LABEL`) is behind `if(!dryRun)`. Helpers `gateDecision`, `shouldHoldForIssues`, `names`, `ISSUE_HOLD_LABEL` are in the module. Returns `{held:number[], cleared:number[], errors}` (or `{...,error}` on list failure, `{disabled:true,...}` if `enabled!==true`).
- **`src/quick-memory.js`** exports `validateQuickMemory(quick)` — **throws** on shape/cap violation (fail-closed); `MAX_CORE_ENTRIES = 20`.
- **`scripts/dev-society-daemon.mjs`** has a `builtins` map; `sh`, `repoRoot`, `cfg.repo`, `SCHED_MESH_ROOT = join(repoRoot,'dev-mesh')` exist. Builtins return `{status:'ok'|'fail', output|error}`. The scheduler dispatches `builtins[job.builtin]`, so a schedule entry needs both `kind:"builtin"` and `builtin:"<name>"`.
- **`src/dashboard/server.js`** routes are `if (pathname === '/api/X' && req.method === 'GET') { … }`; the server is constructed with `{meshRoot, …}` and reads under `join(meshRoot,'mesh',…)`.
- **`src/dashboard/public/graph-view.js`** has foldable `#sec-*` panels and an `esc()` helper; CSS in `graph-view.css`.

---

## File Structure

- **Modify** `src/automerge/issue-gate-sweep.js` — extract read-only `classifyIssueGate`; `runIssueGate` delegates to it.
- **Modify** `src/automerge/eligibility.js` — add pure `classifyAutomergePr`; re-express `isAutoMergeable` via it.
- **Create** `src/automerge/memory-classify.js` — pure-ish read-only `classifyMemoryPr`.
- **Create** `src/merge-sweep/report.js` — pure `buildMergeSweepReport` + `mergeSweepReportPath`.
- **Modify** `scripts/dev-society-daemon.mjs` — the `merge-sweep` builtin.
- **Modify** `dev-mesh/maintainer/.agent/schedule.json` — the schedule entry.
- **Modify** `src/dashboard/server.js` — `GET /api/merge-sweep`.
- **Modify** `src/dashboard/public/graph-view.js` + `graph-view.css` — the `◆ MERGE-SWEEP` panel.
- **Create** tests per task under `test/`.

---

## Task 1: `classifyIssueGate` (read-only extract)

**Files:** Modify `src/automerge/issue-gate-sweep.js`; Test `test/issue-gate-classify.test.js`.

- [ ] **Step 1: Write the failing test**

Create `test/issue-gate-classify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIssueGate } from '../src/automerge/issue-gate-sweep.js';

// Fake gh: records commands, returns canned JSON by shape.
function fakeGh(map) {
  const calls = [];
  return { calls, gh: async (args) => { calls.push(args.join(' ')); return map(args) ?? '[]'; } };
}

test('classifyIssueGate: holds a PR whose linked issue is blocked; clears one that is not; issues NO pr edit', async () => {
  const { calls, gh } = fakeGh((args) => {
    const a = args.join(' ');
    if (a.includes('pr list')) return JSON.stringify([{ number: 1, labels: [] }, { number: 2, labels: [{ name: 'blocked-by-issue' }] }]);
    if (a.includes('pr view 1')) return JSON.stringify({ closingIssuesReferences: [{ number: 10 }] });
    if (a.includes('pr view 2')) return JSON.stringify({ closingIssuesReferences: [{ number: 20 }] });
    if (a.includes('issue view 10')) return JSON.stringify({ labels: [{ name: 'blocked' }] });   // → hold #1
    if (a.includes('issue view 20')) return JSON.stringify({ labels: [{ name: 'ready' }] });      // → clear #2
    return '[]';
  });
  const r = await classifyIssueGate({ gh, repo: 'o/r' });
  assert.deepEqual(r.held, [1]);
  assert.deepEqual(r.cleared, [2]);
  assert.ok(!calls.some((c) => c.includes('pr edit')), 'must not edit labels');
});

test('classifyIssueGate: pr list failure → {error}, never throws', async () => {
  const r = await classifyIssueGate({ gh: async () => { throw new Error('boom'); }, repo: 'o/r' });
  assert.equal(r.held.length, 0);
  assert.match(r.error, /boom/);
});
```

- [ ] **Step 2: Run it — FAIL** (`classifyIssueGate` not exported).
Run: `node --test test/issue-gate-classify.test.js`

- [ ] **Step 3: Extract `classifyIssueGate`; delegate `runIssueGate` to it.**

In `src/automerge/issue-gate-sweep.js`, add the read-only decision function (reusing the existing `gateDecision`/`shouldHoldForIssues`/`names`/`ISSUE_HOLD_LABEL`) and refactor `runIssueGate` to call it then apply labels:

```js
// Read-only: list PRs, resolve linked issues, decide held/cleared. NO label edits.
export async function classifyIssueGate({ gh, repo, log = () => {} }) {
  let prs;
  try {
    prs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,labels', '--limit', '100']));
  } catch (e) {
    log('issue-gate: pr list failed: ' + (e?.message || e));
    return { held: [], cleared: [], error: e?.message || String(e) };
  }
  const held = [], cleared = []; let errors = 0;
  for (const pr of (Array.isArray(prs) ? prs : [])) {
    try {
      const view = JSON.parse(await gh(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'closingIssuesReferences']));
      const issueNums = (view.closingIssuesReferences || []).map((r) => r && r.number).filter(Boolean);
      const labelSets = [];
      for (const n of issueNums) {
        const iss = JSON.parse(await gh(['issue', 'view', String(n), '--repo', repo, '--json', 'labels']));
        labelSets.push(names(iss.labels));
      }
      const action = gateDecision(names(pr.labels), shouldHoldForIssues(labelSets));
      if (action === 'add') held.push(pr.number);
      else if (action === 'remove') cleared.push(pr.number);
    } catch (e) { errors++; log(`issue-gate: #${pr.number} skipped: ${e?.message || e}`); }
  }
  return { held, cleared, errors };
}

export async function runIssueGate({ gh, repo, enabled, dryRun = false, log = () => {} }) {
  if (enabled !== true) { log('issue-gate: disabled (AUTOMERGE_ENABLED != true)'); return { disabled: true, held: [], cleared: [] }; }
  const r = await classifyIssueGate({ gh, repo, log });
  if (r.error) return r;
  if (!dryRun) {
    for (const n of r.held)    await gh(['pr', 'edit', String(n), '--repo', repo, '--add-label', ISSUE_HOLD_LABEL]);
    for (const n of r.cleared) await gh(['pr', 'edit', String(n), '--repo', repo, '--remove-label', ISSUE_HOLD_LABEL]);
  }
  log(`issue-gate: held [${r.held.join(',')}] · cleared [${r.cleared.join(',')}]${dryRun ? ' (dry-run)' : ''} · errors ${r.errors}`);
  return { held: r.held, cleared: r.cleared, errors: r.errors };
}
```

- [ ] **Step 4: Run — PASS** (new file) **and** the existing issue-gate tests still pass.
Run: `node --test test/issue-gate-classify.test.js && node --test test/issue-gate-sweep.test.js` (or whichever existing file covers it; run `npm test` to be safe).

- [ ] **Step 5: Commit**
```bash
git add src/automerge/issue-gate-sweep.js test/issue-gate-classify.test.js
git commit -m "refactor(automerge): extract read-only classifyIssueGate; runIssueGate delegates"
```

---

## Task 2: `classifyAutomergePr` (pure, with gate overlay + fail-closed)

**Files:** Modify `src/automerge/eligibility.js`; Test `test/automerge-classify.test.js`.

- [ ] **Step 1: Write the failing test**

Create `test/automerge-classify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAutomergePr, isAutoMergeable } from '../src/automerge/eligibility.js';

const clean = { number: 5, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [] };
const okGate = { held: new Set(), cleared: new Set(), ok: true };

test('clean PR with empty ok gate → would-merge', () => {
  assert.deepEqual(classifyAutomergePr(clean, { gate: okGate }), { state: 'would-merge', reason: null });
});
test('gate.held overrides → blocked/pending-issue-gate', () => {
  const r = classifyAutomergePr(clean, { gate: { held: new Set([5]), cleared: new Set(), ok: true } });
  assert.deepEqual(r, { state: 'blocked', reason: 'pending-issue-gate' });
});
test('gate.cleared ignores a stale blocked-by-issue label → would-merge', () => {
  const pr = { ...clean, labels: [{ name: 'blocked-by-issue' }] };
  const r = classifyAutomergePr(pr, { gate: { held: new Set(), cleared: new Set([5]), ok: true } });
  assert.deepEqual(r, { state: 'would-merge', reason: null });
});
test('draft / fork / not-clean / not-approved / hold-label each give the right reason', () => {
  assert.equal(classifyAutomergePr({ ...clean, isDraft: true }, { gate: okGate }).reason, 'draft');
  assert.equal(classifyAutomergePr({ ...clean, isCrossRepository: true }, { gate: okGate }).reason, 'fork');
  assert.match(classifyAutomergePr({ ...clean, mergeStateStatus: 'BLOCKED' }, { gate: okGate }).reason, /^not-clean:/);
  assert.match(classifyAutomergePr({ ...clean, reviewDecision: 'REVIEW_REQUIRED' }, { gate: okGate }).reason, /^not-approved:/);
  assert.equal(classifyAutomergePr({ ...clean, labels: [{ name: 'do-not-merge' }] }, { gate: okGate }).state, 'held');
});
test('fail-closed: gate.ok=false suppresses would-merge → blocked/gate-unknown', () => {
  assert.deepEqual(classifyAutomergePr(clean, { gate: { held: new Set(), cleared: new Set(), ok: false } }),
    { state: 'blocked', reason: 'gate-unknown' });
});
test('isAutoMergeable still agrees with would-merge under an empty ok gate', () => {
  assert.equal(isAutoMergeable(clean), true);
  assert.equal(isAutoMergeable({ ...clean, isDraft: true }), false);
});
```

- [ ] **Step 2: Run — FAIL** (`classifyAutomergePr` not exported).

- [ ] **Step 3: Implement.** In `src/automerge/eligibility.js`, add `classifyAutomergePr` and re-express `isAutoMergeable` through it. `blocked-by-issue` is handled ONLY by the gate overlay (so it must not also be matched as a generic hold label):

```js
const HOLD_LABELS_NO_GATE = DEFAULT_HOLD_LABELS.filter((l) => l !== 'blocked-by-issue');

function prLabelNames(pr) {
  return Array.isArray(pr?.labels)
    ? pr.labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || ''))
    : [];
}

/**
 * @param {object} pr  a gh pr row (PR_FIELDS) with a numeric `number`
 * @param {{holdLabels?:string[], gate:{held:Set<number>,cleared:Set<number>,ok:boolean}}} opts
 * @returns {{state:string, reason:string|null}}
 */
export function classifyAutomergePr(pr, { holdLabels = HOLD_LABELS_NO_GATE, gate } = {}) {
  if (!pr || typeof pr !== 'object') return { state: 'blocked', reason: 'no-pr' };
  const names = prLabelNames(pr);
  const gated = gate?.held?.has(pr.number) ? true
              : gate?.cleared?.has(pr.number) ? false
              : names.includes('blocked-by-issue');
  if (gated) return { state: 'blocked', reason: 'pending-issue-gate' };
  if (pr.isDraft !== false) return { state: 'blocked', reason: 'draft' };
  if (pr.isCrossRepository !== false) return { state: 'blocked', reason: 'fork' };
  if (pr.mergeStateStatus !== 'CLEAN') return { state: 'blocked', reason: `not-clean:${pr.mergeStateStatus}` };
  if (pr.reviewDecision !== 'APPROVED') return { state: 'blocked', reason: `not-approved:${pr.reviewDecision}` };
  const hold = names.find((n) => holdLabels.includes(n));
  if (hold) return { state: 'held', reason: hold };
  if (!gate?.ok) return { state: 'blocked', reason: 'gate-unknown' };
  return { state: 'would-merge', reason: null };
}
```

Then re-express the existing predicate (keep its exported name/signature):

```js
export function isAutoMergeable(pr, { holdLabels = DEFAULT_HOLD_LABELS } = {}) {
  // a PR with blocked-by-issue must still be excluded here (the gate isn't consulted)
  if (Array.isArray(pr?.labels) && prLabelNames(pr).includes('blocked-by-issue')) return false;
  return classifyAutomergePr(pr, { holdLabels: holdLabels.filter((l) => l !== 'blocked-by-issue'),
    gate: { held: new Set(), cleared: new Set(), ok: true } }).state === 'would-merge';
}
```

- [ ] **Step 4: Run — PASS** (new file) and the existing automerge/eligibility tests stay green (`npm test`).

- [ ] **Step 5: Commit**
```bash
git add src/automerge/eligibility.js test/automerge-classify.test.js
git commit -m "feat(automerge): classifyAutomergePr (gate overlay + fail-closed reasons)"
```

---

## Task 3: `classifyMemoryPr` (read-only memory pre-check)

**Files:** Create `src/automerge/memory-classify.js`; Test `test/memory-classify.test.js`.

- [ ] **Step 1: Write the failing test**

Create `test/memory-classify.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMemoryPr } from '../src/automerge/memory-classify.js';

const validQuick = JSON.stringify({});   // empty store is valid shape
const okPr = { number: 7, isCrossRepository: false,
  files: ['dev-mesh/coder/memory/quick.json', 'dev-mesh/coder/memory/MEMORY.md'],
  quickJsonContents: [validQuick] };

test('valid same-repo memory PR → merge-candidate', () => {
  assert.deepEqual(classifyMemoryPr(okPr), { state: 'merge-candidate', reason: null });
});
test('fork → needs-human/fork', () => {
  assert.deepEqual(classifyMemoryPr({ ...okPr, isCrossRepository: true }), { state: 'needs-human', reason: 'fork' });
});
test('non-memory path → needs-human/non-memory-path', () => {
  assert.deepEqual(classifyMemoryPr({ ...okPr, files: ['src/index.js'] }), { state: 'needs-human', reason: 'non-memory-path' });
});
test('invalid quick.json → needs-human/invalid-quick-json', () => {
  const r = classifyMemoryPr({ ...okPr, quickJsonContents: ['{ not json'] });
  assert.equal(r.state, 'needs-human'); assert.equal(r.reason, 'invalid-quick-json');
});
```

- [ ] **Step 2: Run — FAIL** (module missing).

- [ ] **Step 3: Implement.** Create `src/automerge/memory-classify.js` reusing `validateQuickMemory`:

```js
// Pure read-only pre-check for a memory:promote PR. Mirrors the workflow's static
// guards (same-repo · memory-paths-only · current quick.json valid). NOT the live
// merge: returns `merge-candidate`, never `would-merge`.
import { validateQuickMemory } from '../quick-memory.js';

const MEMORY_PATH = /^dev-mesh\/[^/]+\/memory\/(quick\.json|([^/]+\/)?[^/]+\.md)$/;

/**
 * @param {{number:number, isCrossRepository?:boolean, files:string[], quickJsonContents:string[]}} pr
 * @returns {{state:'merge-candidate'|'needs-human', reason:string|null}}
 */
export function classifyMemoryPr(pr) {
  if (!pr || pr.isCrossRepository !== false) return { state: 'needs-human', reason: 'fork' };
  const files = Array.isArray(pr.files) ? pr.files : [];
  if (files.length === 0 || !files.every((f) => MEMORY_PATH.test(f))) return { state: 'needs-human', reason: 'non-memory-path' };
  for (const raw of (pr.quickJsonContents || [])) {
    try { validateQuickMemory(JSON.parse(raw)); }
    catch { return { state: 'needs-human', reason: 'invalid-quick-json' }; }
  }
  return { state: 'merge-candidate', reason: null };
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit**
```bash
git add src/automerge/memory-classify.js test/memory-classify.test.js
git commit -m "feat(automerge): read-only classifyMemoryPr (merge-candidate pre-check)"
```

---

## Task 4: `buildMergeSweepReport` + `mergeSweepReportPath` (pure)

**Files:** Create `src/merge-sweep/report.js`; Test `test/merge-sweep-report.test.js`.

- [ ] **Step 1: Write the failing test**

Create `test/merge-sweep-report.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMergeSweepReport, mergeSweepReportPath } from '../src/merge-sweep/report.js';
import { join } from 'node:path';

const NOW = new Date('2026-06-20T12:00:00.000Z');
const cp = (name, status, items = []) => ({ name, status, items });

test('flagged when an item is non-resolved; clean when none; error when checkpoint errored', () => {
  const r = buildMergeSweepReport([
    cp('issue-gate', 'flagged', [{ ref: 'PR#1', number: 1, state: 'would-clear', detail: '' }]),
    cp('automerge', 'clean', []),
    { name: 'memory-automerge', status: 'error', error: 'boom', items: [] },
  ], {}, NOW);
  assert.equal(r.summary.flagged, 1); assert.equal(r.summary.ok, 1); assert.equal(r.summary.errors, 1);
  assert.equal(r.checkpoints[0].items[0].ageRuns, 1);
  assert.equal(r.checkpoints[0].items[0].firstSeen, NOW.toISOString());
});

test('age increments when same ref+state persists; resets when state changes', () => {
  const prev = { checkpoints: [{ name: 'automerge', items: [
    { ref: 'PR#9', number: 9, state: 'held', firstSeen: '2026-06-20T11:00:00.000Z', ageRuns: 2 }] }] };
  const inc = buildMergeSweepReport([cp('automerge', 'flagged', [{ ref: 'PR#9', number: 9, state: 'held', detail: '' }])], prev, NOW);
  assert.equal(inc.checkpoints[0].items[0].ageRuns, 3);
  assert.equal(inc.checkpoints[0].items[0].firstSeen, '2026-06-20T11:00:00.000Z');
  const reset = buildMergeSweepReport([cp('automerge', 'flagged', [{ ref: 'PR#9', number: 9, state: 'blocked', detail: '' }])], prev, NOW);
  assert.equal(reset.checkpoints[0].items[0].ageRuns, 1);
});

test('resolved: a ref flagged in prev but absent now is emitted once as resolved, then dropped', () => {
  const prev = { checkpoints: [{ name: 'automerge', items: [{ ref: 'PR#9', number: 9, state: 'held', firstSeen: NOW.toISOString(), ageRuns: 1 }] }] };
  const r1 = buildMergeSweepReport([cp('automerge', 'clean', [])], prev, NOW);
  const it = r1.checkpoints[0].items.find((i) => i.ref === 'PR#9');
  assert.equal(it.state, 'resolved');
  // next run, prev already shows resolved → dropped
  const r2 = buildMergeSweepReport([cp('automerge', 'clean', [])], r1, NOW);
  assert.ok(!r2.checkpoints[0].items.some((i) => i.ref === 'PR#9'));
});

test('mergeSweepReportPath is deterministic under a meshRoot', () => {
  assert.equal(mergeSweepReportPath('/m/dev-mesh'), join('/m/dev-mesh', 'mesh', 'reports', 'merge-sweep.json'));
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** Create `src/merge-sweep/report.js`:

```js
import { join } from 'node:path';

export function mergeSweepReportPath(meshRoot) {
  return join(meshRoot, 'mesh', 'reports', 'merge-sweep.json');
}

// checkpoints: [{ name, status:'clean'|'flagged'|'error', error?, items:[{ref,number,state,detail}] }]
// prev: the previous report object ({} if none). now: Date. Pure.
export function buildMergeSweepReport(checkpoints, prev, now) {
  const iso = now.toISOString();
  const prevByName = Object.fromEntries(((prev && prev.checkpoints) || []).map((c) => [c.name, c]));
  const out = checkpoints.map((c) => {
    const prevItems = (prevByName[c.name] && prevByName[c.name].items) || [];
    const prevByRef = Object.fromEntries(prevItems.map((i) => [i.ref, i]));
    const items = (c.items || []).map((it) => {
      const p = prevByRef[it.ref];
      const same = p && p.state === it.state && p.state !== 'resolved';
      return { ...it, firstSeen: same ? p.firstSeen : iso, ageRuns: same ? (p.ageRuns || 1) + 1 : 1 };
    });
    // resolved carry-once: refs flagged in prev (non-resolved) but absent now
    const curRefs = new Set(items.map((i) => i.ref));
    for (const p of prevItems) {
      if (p.state !== 'resolved' && !curRefs.has(p.ref)) {
        items.push({ ref: p.ref, number: p.number, state: 'resolved', detail: '', firstSeen: iso, ageRuns: 1 });
      }
    }
    const status = c.status === 'error' ? 'error'
      : items.some((i) => i.state !== 'resolved') ? 'flagged' : 'clean';
    return { name: c.name, status, error: c.error || null, items };
  });
  const summary = out.reduce((s, c) => {
    if (c.status === 'error') s.errors++; else if (c.status === 'flagged') s.flagged++; else s.ok++; return s;
  }, { ok: 0, flagged: 0, errors: 0 });
  return { ranAt: iso, mode: 'report', cadenceMinutes: 15, checkpoints: out, summary };
}
```

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Commit**
```bash
git add src/merge-sweep/report.js test/merge-sweep-report.test.js
git commit -m "feat(merge-sweep): pure buildMergeSweepReport + path helper (age, resolved-carry)"
```

---

## Task 5: `merge-sweep` builtin + schedule entry (read-only)

**Files:** Modify `scripts/dev-society-daemon.mjs`; Modify `dev-mesh/maintainer/.agent/schedule.json`; Test `test/merge-sweep-builtin.test.js`, `test/merge-sweep-schedule.test.js`.

The builtin logic that talks to `gh` is extracted into a pure-shell function
`runMergeSweep({ gh, repo, meshRoot, readReport, writeReport, now })` (in
`src/merge-sweep/report.js` or a sibling `src/merge-sweep/run.js`) so it is
testable with a fake `gh`; the daemon wires the real `gh`/fs.

- [ ] **Step 1: Write the failing test** — `test/merge-sweep-builtin.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runMergeSweep } from '../src/merge-sweep/run.js';

function recordingGh(map) {
  const calls = [];
  return { calls, gh: async (args) => { calls.push(args.join(' ')); return map(args) ?? '[]'; } };
}

test('runMergeSweep is read-only (only pr list/view, issue view) and writes one report', async () => {
  const { calls, gh } = recordingGh((args) => {
    const a = args.join(' ');
    if (a.includes('pr list') && a.includes('memory:promote')) return '[]';
    if (a.includes('pr list')) return JSON.stringify([{ number: 1, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [] }]);
    if (a.includes('pr view')) return JSON.stringify({ closingIssuesReferences: [] });
    return '[]';
  });
  let written = null;
  const r = await runMergeSweep({
    gh, repo: 'o/r', meshRoot: '/m/dev-mesh',
    readReport: () => ({}), writeReport: (path, rep) => { written = { path, rep }; }, now: new Date('2026-06-20T12:00:00Z'),
  });
  // ONLY read-only gh commands
  const forbidden = calls.filter((c) => /pr merge|pr edit|pr comment|api |git (push|commit|merge|checkout)/.test(c));
  assert.deepEqual(forbidden, [], 'must issue no mutating commands');
  assert.ok(written && written.path.endsWith('mesh/reports/merge-sweep.json'));
  assert.equal(written.rep.mode, 'report');
  assert.equal(r.status, 'ok');
});

test('gate read failure → automerge fails closed (no would-merge), status fail', async () => {
  const { gh } = recordingGh((args) => {
    const a = args.join(' ');
    if (a.includes('pr list') && a.includes('memory:promote')) return '[]';
    if (a.includes('pr list')) {
      // first call is the issue-gate list; make it throw by returning invalid JSON only for gate? simplest: always list 1 clean PR
      return JSON.stringify([{ number: 1, isDraft: false, isCrossRepository: false, mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', labels: [] }]);
    }
    if (a.includes('pr view')) throw new Error('gate read fail');   // breaks issue-gate per-PR resolution
    return '[]';
  });
  let written = null;
  await runMergeSweep({ gh, repo: 'o/r', meshRoot: '/m/dev-mesh', readReport: () => ({}), writeReport: (_p, rep) => { written = rep; }, now: new Date('2026-06-20T12:00:00Z') });
  const am = written.checkpoints.find((c) => c.name === 'automerge');
  assert.ok(!am.items.some((i) => i.state === 'would-merge'), 'no false would-merge when gate unknown');
});
```

- [ ] **Step 2: Run — FAIL** (`runMergeSweep` missing).

- [ ] **Step 3: Implement `runMergeSweep`** in `src/merge-sweep/run.js` (read-only orchestration; gate.ok fail-closed; per-checkpoint try/catch):

```js
import { classifyIssueGate } from '../automerge/issue-gate-sweep.js';
import { classifyAutomergePr } from '../automerge/eligibility.js';
import { classifyMemoryPr } from '../automerge/memory-classify.js';
import { buildMergeSweepReport, mergeSweepReportPath } from './report.js';

const PR_FIELDS = 'number,title,isDraft,isCrossRepository,mergeStateStatus,reviewDecision,labels';

async function safe(name, fn) {
  try { return await fn(); }
  catch (e) { return { name, status: 'error', error: e?.message || String(e), items: [] }; }
}

export async function runMergeSweep({ gh, repo, meshRoot, readReport, writeReport, now }) {
  // issue-gate (read-only)
  const g = await classifyIssueGate({ gh, repo }).catch((e) => ({ held: [], cleared: [], error: e?.message || String(e) }));
  const gate = { held: new Set(g.held || []), cleared: new Set(g.cleared || []), ok: !g.error && !(g.errors > 0) };
  const issueGateCp = {
    name: 'issue-gate', status: gate.ok ? 'derived' : 'error', error: g.error || (g.errors ? `${g.errors} per-PR error(s)` : null),
    items: [
      ...(g.held || []).map((n) => ({ ref: `PR#${n}`, number: n, state: 'would-label', detail: 'linked issue blocked' })),
      ...(g.cleared || []).map((n) => ({ ref: `PR#${n}`, number: n, state: 'would-clear', detail: 'linked issue clear' })),
    ],
  };
  issueGateCp.status = issueGateCp.status === 'error' ? 'error' : (issueGateCp.items.length ? 'flagged' : 'clean');

  const automergeCp = await safe('automerge', async () => {
    const prs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--json', PR_FIELDS, '--limit', '100']));
    const items = (Array.isArray(prs) ? prs : []).map((pr) => {
      const { state, reason } = classifyAutomergePr(pr, { gate });
      return { ref: `PR#${pr.number}`, number: pr.number, state, detail: reason || (pr.title || '') };
    }).filter((i) => i.state !== 'blocked' || i.detail !== '');   // keep all; filter is identity here
    return { name: 'automerge', status: items.some((i) => i.state !== 'resolved') ? 'flagged' : 'clean', items };
  });

  const memoryCp = await safe('memory-automerge', async () => {
    const prs = JSON.parse(await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--label', 'memory:promote', '--json', 'number,title,isCrossRepository', '--limit', '100']));
    const items = [];
    for (const pr of (Array.isArray(prs) ? prs : [])) {
      const files = JSON.parse(await gh(['pr', 'view', String(pr.number), '--repo', repo, '--json', 'files'])).files?.map((f) => f.path) || [];
      const quicks = files.filter((f) => f.endsWith('quick.json'));
      const quickJsonContents = [];
      for (const f of quicks) {
        try { quickJsonContents.push(await gh(['pr', 'view', String(pr.number), '--repo', repo])); } catch { /* best-effort: contents fetched read-only elsewhere */ }
      }
      const { state, reason } = classifyMemoryPr({ number: pr.number, isCrossRepository: pr.isCrossRepository, files, quickJsonContents });
      items.push({ ref: `PR#${pr.number}`, number: pr.number, state, detail: reason || (pr.title || '') });
    }
    return { name: 'memory-automerge', status: items.length ? 'flagged' : 'clean', items };
  });

  const prev = readReport(mergeSweepReportPath(meshRoot)) || {};
  const report = buildMergeSweepReport([issueGateCp, automergeCp, memoryCp], prev, now);
  writeReport(mergeSweepReportPath(meshRoot), report);
  const s = report.summary;
  return s.errors ? { status: 'fail', error: `${s.errors} checkpoint error(s); ${s.flagged} flagged` }
                  : { status: 'ok', output: `${s.flagged} flagged, ${s.ok} clean (report-only)` };
}
```

> Note for the implementer: fetching `quick.json` *contents* read-only is via
> `gh api repos/{repo}/contents/...?ref=<headRef>` — keep it inside the `safe`
> wrapper, and if contents can't be fetched, classify that memory PR
> `needs-human:'unreadable'` rather than `merge-candidate` (never optimistic on
> missing data). Wire the exact contents fetch when implementing; the test above
> pins the read-only + fail-closed contract.

- [ ] **Step 4: Register the builtin** in `scripts/dev-society-daemon.mjs` `builtins`:

```js
'merge-sweep': async () => {
  const gh = async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout;
  return runMergeSweep({
    gh, repo: cfg.repo, meshRoot: SCHED_MESH_ROOT,
    readReport: (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } },
    writeReport: (p, rep) => { mkdirSync(dirname(p), { recursive: true }); const t = `${p}.tmp`; writeFileSync(t, JSON.stringify(rep)); renameSync(t, p); },
    now: new Date(),
  });
},
```

(import `runMergeSweep` at the top of the daemon; `readFileSync/writeFileSync/mkdirSync/renameSync/dirname` are already imported or add them.)

- [ ] **Step 5: Add the schedule entry** to `dev-mesh/maintainer/.agent/schedule.json` `jobs`:

```json
{ "id": "merge-sweep", "name": "Merge sweep (report-only)", "kind": "builtin",
  "builtin": "merge-sweep", "cadence": { "kind": "every", "minutes": 15 }, "enabled": true,
  "description": "Read-only inspect: issue-gate → automerge → memory; writes mesh/reports/merge-sweep.json. No merges/labels." }
```

- [ ] **Step 6: Schedule lint test** — `test/merge-sweep-schedule.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('maintainer schedule has a dispatchable merge-sweep builtin job', () => {
  const p = fileURLToPath(new URL('../dev-mesh/maintainer/.agent/schedule.json', import.meta.url));
  const job = JSON.parse(readFileSync(p, 'utf8')).jobs.find((j) => j.id === 'merge-sweep');
  assert.ok(job, 'merge-sweep job present');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.builtin, 'merge-sweep');   // scheduler dispatches builtins[job.builtin]
  assert.equal(job.cadence.kind, 'every'); assert.equal(job.cadence.minutes, 15);
});
```

- [ ] **Step 7: Run — PASS** (`node --test test/merge-sweep-builtin.test.js test/merge-sweep-schedule.test.js`) and `npm test`.

- [ ] **Step 8: Commit**
```bash
git add src/merge-sweep/run.js scripts/dev-society-daemon.mjs dev-mesh/maintainer/.agent/schedule.json test/merge-sweep-builtin.test.js test/merge-sweep-schedule.test.js
git commit -m "feat(merge-sweep): read-only daemon builtin + maintainer schedule (report-only)"
```

---

## Task 6: `GET /api/merge-sweep` (dashboard endpoint + staleness)

**Files:** Modify `src/dashboard/server.js`; Test `test/merge-sweep-api.test.js`.

- [ ] **Step 1: Write the failing test** — `test/merge-sweep-api.test.js` (mirror an existing `*-routes`/server test's harness; if the repo tests routes via a helper, reuse it; otherwise call the handler with a temp meshRoot):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMergeSweepApi } from '../src/dashboard/merge-sweep-api.js';

function seed(report) {
  const mesh = mkdtempSync(join(tmpdir(), 'mesh-'));
  if (report) { const d = join(mesh, 'mesh', 'reports'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'merge-sweep.json'), JSON.stringify(report)); }
  return mesh;
}

test('absent report → {available:false}', () => {
  assert.deepEqual(readMergeSweepApi(seed(null), new Date()), { available: false });
});
test('present + fresh → report with stale:false', () => {
  const now = new Date('2026-06-20T12:00:00Z');
  const rep = { ranAt: now.toISOString(), cadenceMinutes: 15, checkpoints: [], summary: { ok: 0, flagged: 0, errors: 0 } };
  const out = readMergeSweepApi(seed(rep), now);
  assert.equal(out.available, true); assert.equal(out.stale, false);
});
test('present + old → stale:true (> 2*cadence)', () => {
  const ran = new Date('2026-06-20T12:00:00Z');
  const rep = { ranAt: ran.toISOString(), cadenceMinutes: 15, checkpoints: [], summary: {} };
  const out = readMergeSweepApi(seed(rep), new Date('2026-06-20T12:31:00Z'));   // 31m > 30m
  assert.equal(out.stale, true);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** the pure reader `src/dashboard/merge-sweep-api.js`:

```js
import { readFileSync } from 'node:fs';
import { mergeSweepReportPath } from '../merge-sweep/report.js';

export function readMergeSweepApi(meshRoot, now) {
  let rep;
  try { rep = JSON.parse(readFileSync(mergeSweepReportPath(meshRoot), 'utf8')); }
  catch { return { available: false }; }
  const age = now.getTime() - new Date(rep.ranAt).getTime();
  const stale = !(age >= 0) || age > 2 * (rep.cadenceMinutes || 15) * 60_000;
  return { ...rep, available: true, stale };
}
```

Then wire the route in `src/dashboard/server.js` next to the other `/api/*` GETs:

```js
if (pathname === '/api/merge-sweep' && req.method === 'GET') {
  return sendJson(res, 200, readMergeSweepApi(meshRoot, new Date()));
}
```
(import `readMergeSweepApi`; use the file's existing `sendJson`/JSON-response helper and `meshRoot` in scope.)

- [ ] **Step 4: Run — PASS** and `npm test`.

- [ ] **Step 5: Commit**
```bash
git add src/dashboard/merge-sweep-api.js src/dashboard/server.js test/merge-sweep-api.test.js
git commit -m "feat(dashboard): GET /api/merge-sweep with staleness flag"
```

---

## Task 7: `◆ MERGE-SWEEP` dashboard panel (escaped, numeric-ref links)

**Files:** Modify `src/dashboard/public/graph-view.js`, `src/dashboard/public/graph-view.css`; Test `test/merge-sweep-panel.test.js`.

The render is factored into a pure `renderMergeSweep(report)` returning an HTML
string (testable for escaping), called by the panel loader.

- [ ] **Step 1: Write the failing test** — `test/merge-sweep-panel.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMergeSweep } from '../src/dashboard/public/merge-sweep-render.js';

test('lists checkpoints + flagged items with state chips and numeric-ref links', () => {
  const html = renderMergeSweep({ available: true, stale: false, summary: { ok: 1, flagged: 1, errors: 0 },
    checkpoints: [{ name: 'automerge', status: 'flagged', items: [{ ref: 'PR#12', number: 12, state: 'would-merge', detail: 'ok', ageRuns: 2 }] }] });
  assert.match(html, /automerge/);
  assert.match(html, /would-merge/);
  assert.match(html, /\/pull\/12/);          // link built from numeric number
  assert.match(html, /2 runs?/);
});

test('escapes hostile PR titles (no raw HTML)', () => {
  const html = renderMergeSweep({ available: true, stale: false, summary: {}, checkpoints: [
    { name: 'automerge', status: 'flagged', items: [{ ref: 'PR#1', number: 1, state: 'held', detail: '<img src=x onerror=alert(1)>', ageRuns: 1 }] }] });
  assert.ok(!html.includes('<img src=x'), 'detail must be escaped');
  assert.match(html, /&lt;img/);
});

test('available:false → placeholder', () => {
  assert.match(renderMergeSweep({ available: false }), /no merge-sweep report/i);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `src/dashboard/public/merge-sweep-render.js` (pure; reuses an `esc` like graph-view's):

```js
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const REPO = 'danabaxia/agent_mesh';

export function renderMergeSweep(rep) {
  if (!rep || rep.available === false) return '<div class="gv-empty">no merge-sweep report yet</div>';
  const s = rep.summary || {};
  const head = `<div class="ms-head">flagged ${s.flagged || 0} · clean ${s.ok || 0} · report-only${rep.stale ? ' <span class="ms-stale">stale</span>' : ''}</div>`;
  const rows = (rep.checkpoints || []).map((c) => {
    const items = (c.items || []).map((it) => {
      const n = Number.isInteger(it.number) ? it.number : null;
      const link = n ? `<a href="https://github.com/${REPO}/pull/${n}" target="_blank" rel="noopener">${esc(it.ref)}</a>` : esc(it.ref);
      const age = (it.ageRuns || 1) > 1 ? ` · ${it.ageRuns} runs` : '';
      return `<div class="ms-item"><span class="ms-state ms-${esc(it.state)}">${esc(it.state)}</span> ${link} <span class="ms-detail">${esc(it.detail)}</span><span class="ms-age">${age}</span></div>`;
    }).join('');
    return `<div class="ms-cp"><div class="ms-cp-h"><b>${esc(c.name)}</b> <span class="ms-status ms-st-${esc(c.status)}">${esc(c.status)}</span></div>${items}</div>`;
  }).join('');
  return head + rows;
}
```

- [ ] **Step 4: Wire it into the Graph view.** In `graph-view.js`: add a `#sec-merge-sweep` foldable section to the template (header `◆ MERGE-SWEEP`), a `loadMergeSweep()` that `fetch('/api/merge-sweep')` then sets the section body to `renderMergeSweep(json)` (import it), and call `loadMergeSweep()` from `loadAll()` + the SSE `activity` handler. Add `.ms-*` styles to `graph-view.css` (state chips, stale badge) following the existing panel styles.

- [ ] **Step 5: Run — PASS** (`node --test test/merge-sweep-panel.test.js`) and `npm test`.

- [ ] **Step 6: Commit**
```bash
git add src/dashboard/public/merge-sweep-render.js src/dashboard/public/graph-view.js src/dashboard/public/graph-view.css test/merge-sweep-panel.test.js
git commit -m "feat(dashboard): MERGE-SWEEP panel (escaped, numeric-ref links, staleness)"
```

---

## Verification (manual, on the host — after merge)

1. After deploy-sync pulls this, the maintainer schedule shows `merge-sweep` every 15m; within a tick `dev-mesh/mesh/reports/merge-sweep.json` appears.
2. Dashboard → `◆ MERGE-SWEEP` lists checkpoints + flagged PRs/issues with state + age; an old report shows the `stale` badge.
3. Confirm the `merge-sweep` run-log shows only read `gh` calls (no `pr merge`/`pr edit`) — any PR state changes come from the unchanged existing mutators.

---

## Self-Review notes (author)

- **Spec coverage:** classifyIssueGate extract (T1) · classifyAutomergePr + gate overlay + fail-closed (T2) · classifyMemoryPr merge-candidate (T3) · buildMergeSweepReport + age + resolved-carry + path helper (T4) · builtin + read-only allowlist test + schedule entry w/ `builtin` field + schedule lint (T5) · /api/merge-sweep + staleness (T6) · panel + XSS escaping + numeric-ref links (T7). All spec components + the read-only/fail-closed/escaping invariants mapped.
- **Type consistency:** `classifyAutomergePr(pr,{holdLabels,gate:{held:Set,cleared:Set,ok}})→{state,reason}`, `classifyMemoryPr(pr)→{state,reason}`, `classifyIssueGate({gh,repo})→{held,cleared,error?}`, `buildMergeSweepReport(checkpoints,prev,now)→report`, `mergeSweepReportPath(meshRoot)`, `runMergeSweep({gh,repo,meshRoot,readReport,writeReport,now})→{status,output|error}`, `readMergeSweepApi(meshRoot,now)`, `renderMergeSweep(rep)→html` — used identically across tasks. Item-state vocabulary (`would-merge|merge-candidate|held|blocked|would-clear|would-label|needs-human|resolved`) consistent.
- **Open implementation note (flagged, not a placeholder):** T5's read-only `quick.json` *contents* fetch (`gh api …/contents?ref=`) is described with its fail-closed rule (`needs-human:'unreadable'` on fetch failure); the unit test pins the read-only + no-false-would-merge contract, and the exact `gh api` invocation is wired during implementation.
