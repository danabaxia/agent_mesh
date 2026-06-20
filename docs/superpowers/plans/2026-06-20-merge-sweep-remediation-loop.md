# Merge-Sweep Remediation Loop Implementation Plan (②)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A level-triggered backstop builtin that reads ①'s merge-sweep report, escalates only items the auto-fixers couldn't clear / don't cover as one deduped `needs-human` issue per item, tracks a per-item state machine, and self-closes with hysteresis — never re-running a fixer, never double-filing.

**Architecture:** A pure `planRemediation` state machine + an impure `runRemediation` (read-only `gh` + `issue create/close` + state file) wired as a daemon builtin. A small bidirectional-dedup edit to `escalation-sweep`. A dashboard overlay shows each item's lifecycle. Built on the Kubernetes reconcile-loop + probot/stale + Prometheus-`keep_firing_for` patterns (see spec).

**Tech Stack:** Node ≥ 20 ESM, `node --test` (zero deps), `gh` CLI, the dashboard Graph view.

Spec: `docs/superpowers/specs/2026-06-20-merge-sweep-remediation-loop-design.md` (Codex round-1 reviewed).

---

## Background the implementer needs

- Repo: zero deps; `node --test` under `test/`; ES modules; Node ≥ 20. One file: `node --test test/<f>.js`; all: `npm test`.
- **① report** (`src/merge-sweep/report.js`): `mergeSweepReportPath(meshRoot)` → `<meshRoot>/mesh/reports/merge-sweep.json`; shape `{ ranAt, cadenceMinutes, checkpoints:[{ name, status, items:[{ ref:'PR#240', number:240, state, detail, firstSeen, ageRuns }] }], summary }`.
- **`{available}` pattern** (`src/dashboard/merge-sweep-api.js:4` `readMergeSweepApi`): reads the report file, `catch { return { available:false }; }` else `{...rep, available:true}`. ② reuses this exact shape for its read guard.
- **escalation** helpers (`src/automerge/escalation.js`): `parsePrNumber(title)` → number|null. **`escalation-sweep.js`**: lists open `needs-triage` issues (`number,title`), builds `existingPrNums` (lines 37-41), `ensureLabels(gh, [labels], {repo})` self-heals a label.
- **Daemon builtins** (`scripts/dev-society-daemon.mjs`): `builtins` map (return `{status,output|error}`); `sh`, `cfg.repo`, `SCHED_MESH_ROOT` in scope; scheduler dispatches `builtins[job.builtin]`; schedule needs `kind:"builtin"`+`builtin:"<id>"`. ① wired `merge-sweep` here as the template.
- **Dashboard**: `/api/merge-sweep` route in `src/dashboard/server.js` (uses `sendJson`, `meshRoot`, returns `readMergeSweepApi(...)`); `renderMergeSweep(rep)` (`src/dashboard/public/merge-sweep-render.js`, pure, `esc()`-escaped) renders the expand.

**Exemption (v1 scope, refined from spec):** a human-applied `exempt`/`pinned` label on ②'s escalation **issue** prevents ② from auto-closing it (keeps it open for human tracking). Pre-escalation PR-label exemption is deferred. (Research-aligned: k8s test-infra's "don't auto-close important items".)

---

## File Structure

- **Create** `src/merge-sweep/remediation.js` — pure: `planRemediation`, `markerFor`, `MARKER_RE`, `itemKey`, `ACTIONABLE`.
- **Create** `src/merge-sweep/remediation-run.js` — impure `runRemediation` (read-only `gh` + issue create/close + state file).
- **Modify** `scripts/dev-society-daemon.mjs` — `merge-sweep-remediate` builtin.
- **Modify** `dev-mesh/maintainer/.agent/schedule.json` — schedule entry.
- **Modify** `src/automerge/escalation-sweep.js` — bidirectional dedup.
- **Modify** `src/dashboard/merge-sweep-api.js` — overlay remediation state into the report.
- **Modify** `src/dashboard/public/merge-sweep-render.js` — per-item remediation badge.
- **Create** tests under `test/`.

---

## Task 1: `planRemediation` — the pure state machine

**Files:** Create `src/merge-sweep/remediation.js`; Test `test/remediation-plan.test.js`.

`cfg = { escalateAfter:4, hysteresisK:3, capPerRun:5, backoffBaseMs:1800000 }` (30 min).
Inputs: `report` (a `{available:true, checkpoints}` object), `prev` (the state map keyed by `itemKey`), `ownIssues` (map `key → { issueNumber, open, exempt }` from ②'s markers), `triagePrNums` (Set of PR numbers with an open `needs-triage`), `now` (Date).
Output: `{ file:[{key,number,checkpoint,ref,detail}], close:[{key,issueNumber}], skip:[key], nextState }`.

- [ ] **Step 1: Write the failing tests** — `test/remediation-plan.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRemediation, markerFor, itemKey, ACTIONABLE } from '../src/merge-sweep/remediation.js';

const CFG = { escalateAfter: 4, hysteresisK: 3, capPerRun: 5, backoffBaseMs: 1_800_000 };
const NOW = new Date('2026-06-20T12:00:00.000Z');
// report builder: one automerge checkpoint with the given items
const rep = (items, cp = 'automerge') => ({ available: true, checkpoints: [{ name: cp, status: 'flagged', items }] });
const blocked = (n, age, detail = 'not-clean:DIRTY') => ({ ref: `PR#${n}`, number: n, state: 'blocked', detail, ageRuns: age });

test('ACTIONABLE: only automerge not-clean:* and memory needs-human', () => {
  assert.equal(ACTIONABLE('automerge', { state: 'blocked', detail: 'not-clean:DIRTY' }), true);
  assert.equal(ACTIONABLE('automerge', { state: 'blocked', detail: 'pending-issue-gate' }), false);
  assert.equal(ACTIONABLE('automerge', { state: 'would-merge' }), false);
  assert.equal(ACTIONABLE('automerge', { state: 'held', detail: 'do-not-merge' }), false);
  assert.equal(ACTIONABLE('memory-automerge', { state: 'needs-human' }), true);
  assert.equal(ACTIONABLE('memory-automerge', { state: 'merge-candidate' }), false);
});

test('open-gate: ageRuns < N → watching, no file; ≥ N → propose file', () => {
  const young = planRemediation({ report: rep([blocked(1, 3)]), prev: {}, ownIssues: {}, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(young.file, []);
  assert.equal(young.nextState['automerge:PR#1'].state, 'watching');
  const old = planRemediation({ report: rep([blocked(1, 4)]), prev: {}, ownIssues: {}, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.equal(old.file.length, 1);
  assert.equal(old.file[0].key, 'automerge:PR#1');
  assert.equal(old.nextState['automerge:PR#1'].state, 'escalated');
});

test('dedup: existing OPEN own issue → no file (escalated); open needs-triage for the PR → no file', () => {
  const own = planRemediation({ report: rep([blocked(1, 9)]), prev: {}, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(own.file, []);
  assert.equal(own.nextState['automerge:PR#1'].state, 'escalated');
  assert.equal(own.nextState['automerge:PR#1'].issueNumber, 50);
  const tri = planRemediation({ report: rep([blocked(1, 9)]), prev: {}, ownIssues: {}, triagePrNums: new Set([1]), now: NOW, cfg: CFG });
  assert.deepEqual(tri.file, []);
  assert.equal(tri.nextState['automerge:PR#1'].state, 'escalated');
});

test('cap: more than capPerRun eligible → only capPerRun proposed', () => {
  const items = Array.from({ length: 7 }, (_, i) => blocked(i + 1, 9));
  const r = planRemediation({ report: rep(items), prev: {}, ownIssues: {}, triagePrNums: new Set(), now: NOW, cfg: { ...CFG, capPerRun: 5 } });
  assert.equal(r.file.length, 5);
});

test('human-ack: our issue CLOSED while still stuck (we had not self-closed) → acked, never re-file', () => {
  const prev = { 'automerge:PR#1': { state: 'escalated', issueNumber: 50 } };
  const r = planRemediation({ report: rep([blocked(1, 9)]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: false } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.file, []);
  assert.equal(r.nextState['automerge:PR#1'].state, 'acked');
});

test('delayed close: resolved 1 sweep → cooldown (issue stays open); after hysteresisK → propose close → done', () => {
  let prev = { 'automerge:PR#1': { state: 'escalated', issueNumber: 50, healthyStreak: 0 } };
  // sweep 1 absent
  let r = planRemediation({ report: rep([]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.close, []);
  assert.equal(r.nextState['automerge:PR#1'].state, 'cooldown');
  assert.equal(r.nextState['automerge:PR#1'].healthyStreak, 1);
  // advance to streak 2 then 3 (=K) → close
  prev = r.nextState;
  r = planRemediation({ report: rep([]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.equal(r.nextState['automerge:PR#1'].healthyStreak, 2);
  assert.deepEqual(r.close, []);
  prev = r.nextState;
  r = planRemediation({ report: rep([]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.close, [{ key: 'automerge:PR#1', issueNumber: 50 }]);
  assert.equal(r.nextState['automerge:PR#1'].state, 'done');
});

test('cooldown item re-stuck → escalated, SAME open issue, no new file', () => {
  const prev = { 'automerge:PR#1': { state: 'cooldown', issueNumber: 50, healthyStreak: 1 } };
  const r = planRemediation({ report: rep([blocked(1, 9)]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.file, []);
  assert.equal(r.nextState['automerge:PR#1'].state, 'escalated');
});

test('done → re-stuck applies backoff (nextEligibleAt), no immediate file', () => {
  const prev = { 'automerge:PR#1': { state: 'done', issueNumber: 50, reopenCount: 0 } };
  const r = planRemediation({ report: rep([blocked(1, 9)]), prev, ownIssues: {}, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.file, []);
  assert.equal(r.nextState['automerge:PR#1'].state, 'cooldown');
  assert.equal(r.nextState['automerge:PR#1'].reopenCount, 1);
  assert.ok(Date.parse(r.nextState['automerge:PR#1'].nextEligibleAt) > NOW.getTime());
});

test('exempt issue → never auto-closed', () => {
  const prev = { 'automerge:PR#1': { state: 'cooldown', issueNumber: 50, healthyStreak: 2 } };
  const r = planRemediation({ report: rep([]), prev, ownIssues: { 'automerge:PR#1': { issueNumber: 50, open: true, exempt: true } }, triagePrNums: new Set(), now: NOW, cfg: CFG });
  assert.deepEqual(r.close, []);   // would have closed at streak 3, but exempt
});

test('markerFor / itemKey', () => {
  assert.equal(itemKey('automerge', 'PR#7'), 'automerge:PR#7');
  assert.equal(markerFor('automerge:PR#7'), '<!-- needs-human:automerge:PR#7 -->');
});
```

- [ ] **Step 2: Run — FAIL** (`node --test test/remediation-plan.test.js` → module missing).

- [ ] **Step 3: Implement** `src/merge-sweep/remediation.js`:

```js
// src/merge-sweep/remediation.js — pure backstop state machine for ②. No I/O.
// Reads ①'s report (the desired-state source, re-derived each run) + a tracked
// state cache; proposes deduped escalation file/close actions with age-gate,
// delayed-close hysteresis, reopen backoff, cap, and human-ack. The runner commits
// state only after the gh action succeeds.

export const itemKey = (checkpoint, ref) => `${checkpoint}:${ref}`;
export const markerFor = (key) => `<!-- needs-human:${key} -->`;
export const MARKER_RE = /<!--\s*needs-human:([a-z0-9:#_-]+)\s*-->/i;

// What ② escalates: automerge PRs the fixers couldn't clear, and memory PRs needing a human.
export function ACTIONABLE(checkpoint, it) {
  if (checkpoint === 'automerge') return it.state === 'blocked' && String(it.detail || '').startsWith('not-clean:');
  if (checkpoint === 'memory-automerge') return it.state === 'needs-human';
  return false;
}

export function planRemediation({ report, prev = {}, ownIssues = {}, triagePrNums = new Set(), now, cfg }) {
  const { escalateAfter, hysteresisK, capPerRun, backoffBaseMs } = cfg;
  const iso = now.toISOString();
  const tNow = now.getTime();

  // current stuck set (actionable items only), keyed
  const stuck = new Map();
  for (const cp of (report.checkpoints || [])) {
    for (const it of (cp.items || [])) {
      if (ACTIONABLE(cp.name, it)) stuck.set(itemKey(cp.name, it.ref), { ...it, checkpoint: cp.name });
    }
  }

  const file = [], close = [], skip = [];
  const nextState = {};
  let filed = 0;

  // 1) currently-stuck items
  for (const [key, it] of stuck) {
    const p = prev[key] || { state: 'watching', healthyStreak: 0, reopenCount: 0 };
    const own = ownIssues[key];                                   // { issueNumber, open, exempt }

    // human closed our still-open escalation (we only self-close 'done' items)
    if (own && own.open === false && p.state !== 'done') { nextState[key] = { ...p, state: 'acked', issueNumber: own.issueNumber }; continue; }
    if (p.state === 'acked') { nextState[key] = p; continue; }
    // an open escalation already covers it (ours, or escalation-sweep's needs-triage) → track, no file
    if (own && own.open) { nextState[key] = { ...p, state: 'escalated', issueNumber: own.issueNumber }; continue; }
    if (it.checkpoint === 'automerge' && Number.isInteger(it.number) && triagePrNums.has(it.number)) { nextState[key] = { ...p, state: 'escalated' }; continue; }
    // give the fixers their window
    if ((it.ageRuns || 1) < escalateAfter) { nextState[key] = { ...p, state: 'watching', healthyStreak: 0 }; continue; }
    // a previously-done item that re-sticks → start a widening backoff before re-filing
    if (p.state === 'done') {
      const reopenCount = (p.reopenCount || 0) + 1;
      nextState[key] = { ...p, state: 'cooldown', reopenCount, nextEligibleAt: new Date(tNow + backoffBaseMs * 2 ** reopenCount).toISOString(), healthyStreak: 0 };
      continue;
    }
    // still within an active backoff window → wait
    if (p.nextEligibleAt && tNow < Date.parse(p.nextEligibleAt)) { nextState[key] = { ...p, state: 'cooldown' }; continue; }
    if (filed >= capPerRun) { nextState[key] = { ...p, state: 'watching' }; continue; }
    // eligible → propose file
    file.push({ key, number: it.number, checkpoint: it.checkpoint, ref: it.ref, detail: it.detail });
    nextState[key] = { ...p, state: 'escalated', firstEscalatedAt: p.firstEscalatedAt || iso, healthyStreak: 0, nextEligibleAt: null };
    filed++;
  }

  // 2) resolve edge — tracked items NOT currently stuck (close is DELAYED by hysteresis)
  for (const [key, p] of Object.entries(prev)) {
    if (stuck.has(key) || nextState[key]) continue;             // handled above or still stuck
    if (p.state === 'acked' || p.state === 'done') { nextState[key] = p; continue; }
    if (p.state === 'escalated') { nextState[key] = { ...p, state: 'cooldown', healthyStreak: 1 }; continue; }   // issue stays OPEN
    if (p.state === 'cooldown') {
      const hs = (p.healthyStreak || 1) + 1;
      const own = ownIssues[key];
      if (hs >= hysteresisK && p.issueNumber && !(own && own.exempt)) { close.push({ key, issueNumber: p.issueNumber }); nextState[key] = { ...p, state: 'done', healthyStreak: hs }; }
      else nextState[key] = { ...p, state: 'cooldown', healthyStreak: hs };
      continue;
    }
    nextState[key] = p;                                          // watching → drop is fine; carry others
  }

  return { file, close, skip, nextState };
}
```

- [ ] **Step 4: Run — PASS** (`node --test test/remediation-plan.test.js`) and `npm test`.

- [ ] **Step 5: Commit**
```bash
git add src/merge-sweep/remediation.js test/remediation-plan.test.js
git commit -m "feat(remediation): pure planRemediation backstop state machine"
```

---

## Task 2: `runRemediation` + builtin + schedule

**Files:** Create `src/merge-sweep/remediation-run.js`; Modify `scripts/dev-society-daemon.mjs`, `dev-mesh/maintainer/.agent/schedule.json`; Test `test/remediation-run.test.js`, `test/remediation-schedule.test.js`.

- [ ] **Step 1: Write the failing tests** — `test/remediation-run.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRemediation } from '../src/merge-sweep/remediation-run.js';

function recGh(map) { const calls = []; return { calls, gh: async (a) => { calls.push(a.join(' ')); return map(a) ?? ''; } }; }
const CFG = { escalateAfter: 4, hysteresisK: 3, capPerRun: 5, backoffBaseMs: 1_800_000 };
const reportWith = (items) => ({ available: true, checkpoints: [{ name: 'automerge', status: 'flagged', items }] });

test('report unavailable → no create/close, state preserved, status fail', async () => {
  const { calls, gh } = recGh(() => '[]');
  let wrote = false;
  const r = await runRemediation({ gh, repo: 'o/r', meshRoot: '/m', readReport: () => ({ available: false }), readState: () => ({ x: 1 }), writeState: () => { wrote = true; }, now: new Date('2026-06-20T12:00:00Z'), cfg: CFG });
  assert.equal(r.status, 'fail');
  assert.ok(!calls.some((c) => /issue (create|close)/.test(c)), 'no create/close on unavailable report');
});

test('files one deduped needs-human issue for an aged stuck PR; read-only otherwise', async () => {
  const { calls, gh } = recGh((a) => {
    const s = a.join(' ');
    if (s.includes('issue list') && s.includes('needs-human')) return '[]';
    if (s.includes('issue list') && s.includes('needs-triage')) return '[]';
    if (s.includes('pr view 1')) return JSON.stringify({ number: 1, state: 'OPEN' });
    if (s.includes('issue create')) return 'https://github.com/o/r/issues/77';
    return '[]';
  });
  let state = null;
  const r = await runRemediation({ gh, repo: 'o/r', meshRoot: '/m', readReport: () => reportWith([{ ref: 'PR#1', number: 1, state: 'blocked', detail: 'not-clean:DIRTY', ageRuns: 9 }]), readState: () => ({}), writeState: (_p, s2) => { state = s2; }, now: new Date('2026-06-20T12:00:00Z'), cfg: CFG });
  const forbidden = calls.filter((c) => /pr merge|pr edit|pr comment| api |git (push|commit|merge|checkout)/.test(c));
  assert.deepEqual(forbidden, [], 'no mutating commands');
  assert.ok(calls.some((c) => /issue create .*needs-human/.test(c)), 'filed a needs-human issue');
  assert.equal(state['automerge:PR#1'].state, 'escalated');
  assert.equal(state['automerge:PR#1'].issueNumber, 77);
  assert.equal(r.status, 'ok');
});

test('a failing issue create leaves the item in prior state (not escalated)', async () => {
  const { gh } = recGh((a) => {
    const s = a.join(' ');
    if (s.includes('issue list')) return '[]';
    if (s.includes('pr view')) return JSON.stringify({ state: 'OPEN' });
    if (s.includes('issue create')) throw new Error('rate limited');
    return '[]';
  });
  let state = null;
  await runRemediation({ gh, repo: 'o/r', meshRoot: '/m', readReport: () => reportWith([{ ref: 'PR#1', number: 1, state: 'blocked', detail: 'not-clean:DIRTY', ageRuns: 9 }]), readState: () => ({}), writeState: (_p, s2) => { state = s2; }, now: new Date('2026-06-20T12:00:00Z'), cfg: CFG });
  assert.notEqual(state['automerge:PR#1']?.state, 'escalated');
});

test('closed own marker issue (human-ack) for a still-stuck item → acked, no create', async () => {
  const { calls, gh } = recGh((a) => {
    const s = a.join(' ');
    if (s.includes('issue list') && s.includes('needs-human')) return JSON.stringify([{ number: 80, state: 'CLOSED', body: '<!-- needs-human:automerge:PR#1 -->', labels: [] }]);
    if (s.includes('issue list')) return '[]';
    if (s.includes('pr view')) return JSON.stringify({ state: 'OPEN' });
    return '[]';
  });
  let state = null;
  await runRemediation({ gh, repo: 'o/r', meshRoot: '/m', readReport: () => reportWith([{ ref: 'PR#1', number: 1, state: 'blocked', detail: 'not-clean:DIRTY', ageRuns: 9 }]), readState: () => ({ 'automerge:PR#1': { state: 'escalated', issueNumber: 80 } }), writeState: (_p, s2) => { state = s2; }, now: new Date('2026-06-20T12:00:00Z'), cfg: CFG });
  assert.ok(!calls.some((c) => /issue create/.test(c)), 'no re-file of an acked item');
  assert.equal(state['automerge:PR#1'].state, 'acked');
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `src/merge-sweep/remediation-run.js`:

```js
// src/merge-sweep/remediation-run.js — impure orchestration for ②. Injected gh + fs.
// Read-mostly: gh issue list (needs-human --state all, needs-triage), gh pr view (pre-file guard);
// writes only gh issue create/close, gh label create (idempotent), and the state file.
import { join } from 'node:path';
import { planRemediation, markerFor, MARKER_RE } from './remediation.js';
import { parsePrNumber } from '../automerge/escalation.js';

export const remediationPath = (meshRoot) => join(meshRoot, 'mesh', 'reports', 'merge-sweep-remediation.json');
const EXEMPT = new Set(['exempt', 'pinned']);
const labelNames = (iss) => (Array.isArray(iss.labels) ? iss.labels.map((l) => (typeof l === 'string' ? l : l && l.name)) : []);

export async function runRemediation({ gh, repo, meshRoot, readReport, readState, writeState, now, cfg, log = () => {} }) {
  const report = readReport();
  if (!report || report.available === false) {
    return { status: 'fail', error: 'merge-sweep report unavailable — no remediation this tick (state preserved)' };
  }
  const prev = readState() || {};

  // own needs-human issues (OPEN + CLOSED) → key → { issueNumber, open, exempt }
  let ownList = [];
  try { ownList = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'all', '--label', 'needs-human', '--json', 'number,state,body,labels', '--limit', '200'])); } catch (e) { log('remediate: needs-human list failed: ' + (e?.message || e)); }
  const ownIssues = {};
  for (const iss of (Array.isArray(ownList) ? ownList : [])) {
    const m = MARKER_RE.exec(String(iss.body || ''));
    if (!m) continue;
    const open = String(iss.state).toUpperCase() === 'OPEN';
    // newest-open wins; otherwise keep a closed record for ack detection
    const cur = ownIssues[m[1]];
    if (!cur || (open && !cur.open)) ownIssues[m[1]] = { issueNumber: iss.number, open, exempt: labelNames(iss).some((n) => EXEMPT.has(n)) };
  }

  // escalation-sweep dedup: open needs-triage PR numbers
  let triage = [];
  try { triage = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', 'needs-triage', '--json', 'number,title', '--limit', '100'])); } catch (e) { log('remediate: needs-triage list failed: ' + (e?.message || e)); }
  const triagePrNums = new Set();
  for (const iss of (Array.isArray(triage) ? triage : [])) { const n = parsePrNumber(iss.title); if (n != null) triagePrNums.add(n); }

  const plan = planRemediation({ report, prev, ownIssues, triagePrNums, now, cfg });
  const state = { ...plan.nextState };

  // commit state ONLY after each gh action succeeds
  let ensured = false;
  for (const f of plan.file) {
    try {
      // pre-file live guard: skip if the PR is no longer open (merged/closed since the report)
      if (Number.isInteger(f.number)) {
        const pv = JSON.parse(await gh(['pr', 'view', String(f.number), '--repo', repo, '--json', 'state']));
        if (pv && String(pv.state).toUpperCase() !== 'OPEN') { state[f.key] = prev[f.key] || { state: 'watching' }; continue; }
      }
      if (!ensured) { try { await gh(['label', 'create', 'needs-human', '--repo', repo, '--color', 'B60205']); } catch { /* exists */ } ensured = true; }
      const title = f.checkpoint === 'automerge'
        ? `needs-human: ${f.ref} stuck (${f.detail}) — auto-fix exhausted`
        : `needs-human: ${f.ref} (${f.detail || 'memory review'})`;
      const body = `${markerFor(f.key)}\n\n🤖 dev-mesh ② backstop: this item has been flagged for ≥${cfg.escalateAfter} sweeps and the automatic fixers could not clear it. A human review is needed.\n\n- item: \`${f.key}\`\n- detail: ${f.detail || ''}`;
      const url = await gh(['issue', 'create', '--repo', repo, '--label', 'needs-human', '--title', title, '--body', body]);
      const n = Number.parseInt(String(url).trim().split('/').pop(), 10);
      state[f.key] = { ...state[f.key], state: 'escalated', issueNumber: Number.isFinite(n) ? n : null };
    } catch (e) { log(`remediate: file ${f.key} failed: ${e?.message || e}`); state[f.key] = prev[f.key] || { state: 'watching' }; }
  }
  for (const c of plan.close) {
    try { await gh(['issue', 'close', String(c.issueNumber), '--repo', repo, '--comment', '🤖 dev-mesh ②: item resolved — closing this escalation.']); state[c.key] = { ...state[c.key], state: 'done' }; }
    catch (e) { log(`remediate: close ${c.key} failed: ${e?.message || e}`); state[c.key] = prev[c.key]; }
  }

  writeState(remediationPath(meshRoot), state);
  return { status: 'ok', output: `escalated ${plan.file.length}, closed ${plan.close.length}, tracking ${Object.keys(state).length}` };
}
```

- [ ] **Step 4: Register the builtin** in `scripts/dev-society-daemon.mjs` (import `runRemediation`, `remediationPath` from `../src/merge-sweep/remediation-run.js`; reuse `readFileSync/writeFileSync/mkdirSync/renameSync/dirname` already imported by ①'s builtin). Add to `builtins`:

```js
    'merge-sweep-remediate': async () => runRemediation({
      gh: async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout,
      repo: cfg.repo, meshRoot: SCHED_MESH_ROOT,
      readReport: () => { try { return { ...JSON.parse(readFileSync(mergeSweepReportPath(SCHED_MESH_ROOT), 'utf8')), available: true }; } catch { return { available: false }; } },
      readState: () => { try { return JSON.parse(readFileSync(remediationPath(SCHED_MESH_ROOT), 'utf8')); } catch { return {}; } },
      writeState: (p, st) => { mkdirSync(dirname(p), { recursive: true }); const t = `${p}.tmp`; writeFileSync(t, JSON.stringify(st)); renameSync(t, p); },
      now: new Date(), cfg: { escalateAfter: 4, hysteresisK: 3, capPerRun: 5, backoffBaseMs: 1_800_000 },
      log: (...a) => log('remediate:', ...a),
    }),
```
(import `mergeSweepReportPath` from `../src/merge-sweep/report.js` if not already imported.)

- [ ] **Step 5: Add the schedule entry** to `dev-mesh/maintainer/.agent/schedule.json` `jobs`:

```json
    {
      "id": "merge-sweep-remediate",
      "name": "Merge-sweep remediation (backstop)",
      "kind": "builtin",
      "builtin": "merge-sweep-remediate",
      "cadence": { "kind": "every", "minutes": 30 },
      "enabled": true,
      "description": "Backstop: escalate report items the fixers couldn't clear as deduped needs-human issues; track lifecycle. No code changes."
    }
```

- [ ] **Step 6: Schedule lint test** — `test/remediation-schedule.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('maintainer schedule has a dispatchable merge-sweep-remediate builtin', () => {
  const p = fileURLToPath(new URL('../dev-mesh/maintainer/.agent/schedule.json', import.meta.url));
  const job = JSON.parse(readFileSync(p, 'utf8')).jobs.find((j) => j.id === 'merge-sweep-remediate');
  assert.ok(job); assert.equal(job.kind, 'builtin'); assert.equal(job.builtin, 'merge-sweep-remediate');
  assert.equal(job.cadence.minutes, 30);
});
```

- [ ] **Step 7: Run — PASS** (`node --test test/remediation-run.test.js test/remediation-schedule.test.js`), `node --check scripts/dev-society-daemon.mjs`, `npm test`.

- [ ] **Step 8: Commit**
```bash
git add src/merge-sweep/remediation-run.js scripts/dev-society-daemon.mjs dev-mesh/maintainer/.agent/schedule.json test/remediation-run.test.js test/remediation-schedule.test.js
git commit -m "feat(remediation): runRemediation builtin + maintainer schedule (backstop)"
```

---

## Task 3: bidirectional dedup in `escalation-sweep`

**Files:** Modify `src/automerge/escalation-sweep.js`; Test `test/escalation-sweep.test.js` (extend).

- [ ] **Step 1: Write the failing test** — append to `test/escalation-sweep.test.js`:

```js
test('escalation dedups against ②\'s open needs-human marker for the same PR', async () => {
  const calls = [];
  const gh = async (a) => {
    const s = a.join(' '); calls.push(s);
    if (s.includes('pr list')) return JSON.stringify([{ number: 5, title: 'x', isDraft: false, isCrossRepository: false, mergeStateStatus: 'DIRTY', reviewDecision: 'APPROVED', updatedAt: '2000-01-01T00:00:00Z', labels: [] }]);
    if (s.includes('issue list') && s.includes('needs-triage')) return '[]';
    if (s.includes('issue list') && s.includes('needs-human')) return JSON.stringify([{ number: 90, body: '<!-- needs-human:automerge:PR#5 -->' }]);
    return '[]';
  };
  const { runEscalation } = await import('../src/automerge/escalation-sweep.js');
  const r = await runEscalation({ gh, repo: 'o/r', enabled: true, staleMs: 0, now: Date.now(), dryRun: false, log: () => {} });
  assert.ok(!calls.some((c) => /issue create/.test(c)), 'must not open a needs-triage when ② already escalated PR #5');
  assert.deepEqual(r.opened, []);
});
```

- [ ] **Step 2: Run — FAIL** (escalation-sweep still files for PR #5).

- [ ] **Step 3: Implement.** In `src/automerge/escalation-sweep.js`, after the `triage` list + `existingPrNums` build (≈ lines 30-41), add a second list and union ②'s marker PR numbers. Insert after the `existingPrNums` loop:

```js
  // Bidirectional dedup with ② (merge-sweep-remediate): a PR already escalated as a
  // needs-human (carrying `<!-- needs-human:automerge:PR#N -->`) must not also get a
  // needs-triage here. Best-effort: a failed list just means no extra dedup.
  try {
    const human = JSON.parse(await gh(['issue', 'list', '--repo', repo, '--state', 'open', '--label', 'needs-human', '--json', 'number,body', '--limit', '200']));
    for (const iss of (Array.isArray(human) ? human : [])) {
      const m = /<!--\s*needs-human:automerge:PR#(\d+)\s*-->/i.exec(String(iss.body || ''));
      if (m) existingPrNums.add(Number.parseInt(m[1], 10));
    }
  } catch (e) { log('escalation: needs-human dedup list failed: ' + (e?.message || e)); }
```

- [ ] **Step 4: Run — PASS** (`node --test test/escalation-sweep.test.js`) and `npm test` (existing escalation tests still green).

- [ ] **Step 5: Commit**
```bash
git add src/automerge/escalation-sweep.js test/escalation-sweep.test.js
git commit -m "fix(escalation): bidirectional dedup against ②'s needs-human markers"
```

---

## Task 4: dashboard remediation overlay + badge

**Files:** Modify `src/dashboard/merge-sweep-api.js`, `src/dashboard/public/merge-sweep-render.js`; Test `test/merge-sweep-api.test.js` (extend), `test/merge-sweep-panel.test.js` (extend).

- [ ] **Step 1: Write the failing tests.**

Append to `test/merge-sweep-api.test.js`:
```js
test('overlay: merges remediation state onto report items by checkpoint:ref', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { readMergeSweepApi } = await import('../src/dashboard/merge-sweep-api.js');
  const mesh = mkdtempSync(join(tmpdir(), 'mesh-')); const d = join(mesh, 'mesh', 'reports'); mkdirSync(d, { recursive: true });
  const now = new Date('2026-06-20T12:00:00Z');
  writeFileSync(join(d, 'merge-sweep.json'), JSON.stringify({ ranAt: now.toISOString(), cadenceMinutes: 15, summary: {}, checkpoints: [{ name: 'automerge', status: 'flagged', items: [{ ref: 'PR#1', number: 1, state: 'blocked', detail: 'x' }] }] }));
  writeFileSync(join(d, 'merge-sweep-remediation.json'), JSON.stringify({ 'automerge:PR#1': { state: 'escalated', issueNumber: 77 } }));
  const out = readMergeSweepApi(mesh, now);
  assert.equal(out.checkpoints[0].items[0].remediation.state, 'escalated');
  assert.equal(out.checkpoints[0].items[0].remediation.issueNumber, 77);
});
```

Append to `test/merge-sweep-panel.test.js`:
```js
test('renders a remediation badge linking to the escalation issue', () => {
  const html = renderMergeSweep({ available: true, stale: false, summary: { flagged: 1, ok: 0 }, checkpoints: [
    { name: 'automerge', status: 'flagged', items: [{ ref: 'PR#1', number: 1, state: 'blocked', detail: 'x', ageRuns: 9, remediation: { state: 'escalated', issueNumber: 77 } }] }] });
  assert.match(html, /escalated/);
  assert.match(html, /\/issues\/77/);
});
```

- [ ] **Step 2: Run — FAIL** (overlay + badge missing).

- [ ] **Step 3a: Implement the overlay** in `src/dashboard/merge-sweep-api.js`. Replace the body of `readMergeSweepApi` so it also merges the remediation state:

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeSweepReportPath } from '../merge-sweep/report.js';

export function readMergeSweepApi(meshRoot, now) {
  let rep;
  try { rep = JSON.parse(readFileSync(mergeSweepReportPath(meshRoot), 'utf8')); }
  catch { return { available: false }; }
  let remediation = {};
  try { remediation = JSON.parse(readFileSync(join(meshRoot, 'mesh', 'reports', 'merge-sweep-remediation.json'), 'utf8')); } catch { /* none yet */ }
  for (const cp of (rep.checkpoints || [])) {
    for (const it of (cp.items || [])) {
      const r = remediation[`${cp.name}:${it.ref}`];
      if (r) it.remediation = { state: r.state, issueNumber: r.issueNumber ?? null };
    }
  }
  const age = now.getTime() - new Date(rep.ranAt).getTime();
  const stale = !(age >= 0) || age > 2 * (rep.cadenceMinutes || 15) * 60_000;
  return { ...rep, available: true, stale };
}
```

- [ ] **Step 3b: Implement the badge** in `src/dashboard/public/merge-sweep-render.js`. In the per-item map, after the existing state chip + link, append a remediation badge when present:

```js
      const rem = it.remediation
        ? ` <span class="ms-rem ms-rem-${esc(it.remediation.state)}">${esc(it.remediation.state)}${it.remediation.issueNumber ? ` <a href="https://github.com/${REPO}/issues/${Number(it.remediation.issueNumber)}" target="_blank" rel="noopener">#${Number(it.remediation.issueNumber)}</a>` : ''}</span>`
        : '';
```
and include `${rem}` in the returned item row HTML (just before the closing `</div>` of `.ms-item`). Add minimal CSS to `graph-view.css`:
```css
#view-graph .ms-rem{font:600 9px var(--mono);padding:1px 6px;border-radius:4px;background:#eef0f4;color:#475}
#view-graph .ms-rem-escalated{background:var(--amber-bg);color:var(--amber)} #view-graph .ms-rem-done{background:#e7f3ee;color:var(--good)} #view-graph .ms-rem-acked{background:#f1e9f8;color:#6d3f9c}
#view-graph .ms-rem a{color:inherit}
```

- [ ] **Step 4: Run — PASS** (`node --test test/merge-sweep-api.test.js test/merge-sweep-panel.test.js`) and `npm test`.

- [ ] **Step 5: Commit**
```bash
git add src/dashboard/merge-sweep-api.js src/dashboard/public/merge-sweep-render.js src/dashboard/public/graph-view.css test/merge-sweep-api.test.js test/merge-sweep-panel.test.js
git commit -m "feat(dashboard): overlay ② remediation state as a per-item badge"
```

---

## Verification (manual, on the host — after merge)

1. Maintainer schedule shows `merge-sweep-remediate` (30m); `mesh/reports/merge-sweep-remediation.json` appears after a tick.
2. A PR stuck `not-clean:DIRTY` with `ageRuns ≥ 4` and no existing escalation → exactly one `needs-human` issue with the `<!-- needs-human:automerge:PR#N -->` marker; a second tick files nothing more; `escalation-sweep` does not file a `needs-triage` for it.
3. Fix/merge the PR → after `hysteresisK` healthy sweeps ② closes its issue; the dashboard badge flips `escalated → done`. A human-closed escalation → `acked`, never re-filed.
4. Run-log shows only read `gh` + `issue create/close` + `label create` — no `pr merge`/`pr edit`.

---

## Self-Review notes (author)

- **Spec coverage:** ACTIONABLE filter + open-gate + dedup + cap + delayed-close hysteresis + reopen backoff + human-ack + exempt (T1) · report-unavailable guard + read-only allowlist + state-after-mutation + pre-file live guard + builtin + schedule (T2) · bidirectional dedup (T3) · overlay + badge (T4). All spec §components + Round-1 fixes mapped.
- **Type consistency:** `planRemediation({report,prev,ownIssues,triagePrNums,now,cfg}) → {file,close,skip,nextState}`; `itemKey(cp,ref)`, `markerFor(key)`, `MARKER_RE`, `ACTIONABLE(cp,it)`; `runRemediation({gh,repo,meshRoot,readReport,readState,writeState,now,cfg,log})`; `remediationPath(meshRoot)`; state record `{state,issueNumber,firstEscalatedAt,healthyStreak,reopenCount,nextEligibleAt}` — consistent across tasks. `available` shape matches ①'s `readMergeSweepApi`.
- **No placeholders:** full code in every step; exact commands + expected pass/fail.
