# Mesh Improvement Report (MIR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the project's existing test/eval/run-log evidence into a deterministic `mir.json` artifact and deduped GitHub backlog issues, owned by the existing Tester agent on a nightly schedule.

**Architecture:** A pure-core library `src/mesh-improvement/` (metrics → aggregate → baseline → policy → render → issues, plus a baseline-restore planner) reads already-persisted scorecard/perfcard/run-log/test-results JSON and emits `mir.json` + `mir.md` and a deterministic issue action-plan. A framework **host** (a daemon builtin + a CI `mir` job) executes the plan via `gh`. No LLM and no agent MCP mutation are on the path. Spec: `docs/superpowers/specs/2026-06-19-mesh-improvement-report-design.md`.

**Tech Stack:** Node ≥ 20 ESM, `node --test`, zero dependencies. Pure modules take all time/identity as injected params (no `Date.now()`). Host I/O via `node:fs` + `child_process` + `gh` CLI.

## Global Constraints

- **Node ≥ 20, ESM, zero dependencies** — no new packages; tests use `node --test` only.
- **Pure core** — `metrics/aggregate/baseline/policy/render/issues/baseline-restore` must not call `Date.now()`, read env, or touch disk/network; `at`/`ref`/`baseline`/config are parameters. Only `collect.js`, `run.js`, the daemon builtin, and the CI script do I/O.
- **No mutating MCP under ask; no Bash in agent modes** — issue create/update/close is a host action over a pure plan; the Tester stays `ask`-only and is wired no non-`readOnly` MCP server.
- **Dedup by ledger, never by issue body** — `issues.js` consumes only findings + the ledger map (`id → issueNumber`) + open-issue metadata; never issue bodies.
- **`finding.id` is controlled vocabulary** — matches `MIR_ID_RE = /^[a-z0-9:_-]+$/`; reject otherwise before it becomes a label/marker.
- **Metric keys mirror real producers verbatim** — `quality_per_1k_tokens`, `wasted_hops`, `precision`, `recall`, `cost_usd`, `latency_ms`; `collect.js` does no renaming.
- **Schema string** — every `mir.json` carries `"schema": "mesh-improvement-report/v1"`.
- **All new tests live in `test/` as `*.test.js`** and run under the existing `run-all-tests.mjs` (the L0 gate).

---

### Task 1: Config constants + metric registry

**Files:**
- Modify: `src/config.js` (append constants)
- Create: `src/mesh-improvement/metrics.js`
- Test: `test/mesh-improvement-metrics.test.js`

**Interfaces:**
- Produces: `METRICS` (record of `{tier,direction,unit}` by metric name); `deltaPct(name, value, baseline) → number|null` (signed toward "better", rounded to 0.1); `isRegression(name, dPct, bandPct) → boolean`; `MIR_ID_RE`; config `DEFAULT_MIR_DIR`, `DEFAULT_MIR_NOISE_BAND_PCT`, `DEFAULT_MIR_RECOVER_RUNS`, `DEFAULT_MIR_TREND_N`, `DEFAULT_MESH_SCAN_LABEL`.

- [ ] **Step 1: Write the failing test**

```js
// test/mesh-improvement-metrics.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { METRICS, deltaPct, isRegression } from '../src/mesh-improvement/metrics.js';
import { MIR_ID_RE } from '../src/config.js';

test('higher_is_better: drop is a negative deltaPct', () => {
  assert.equal(deltaPct('precision', 0.6, 0.9), -33.3);
  assert.equal(deltaPct('precision', 0.99, 0.9), 10); // improvement positive
});

test('lower_is_better: an increase is a negative deltaPct (regression)', () => {
  assert.equal(deltaPct('cost_usd', 0.04, 0.02), -100); // cost up = bad
  assert.equal(deltaPct('cost_usd', 0.01, 0.02), 50);   // cost down = good
});

test('null/zero baseline → null delta', () => {
  assert.equal(deltaPct('precision', 0.6, null), null);
  assert.equal(deltaPct('precision', 0.6, 0), null);
  assert.equal(deltaPct('precision', null, 0.9), null);
});

test('isRegression only past the band', () => {
  assert.equal(isRegression('precision', -33.3, 10), true);
  assert.equal(isRegression('precision', -5, 10), false);  // within band
  assert.equal(isRegression('precision', 20, 10), false);  // improvement
  assert.equal(isRegression('precision', null, 10), false);
});

test('every registry metric has a direction; ids are validated', () => {
  for (const m of Object.values(METRICS)) {
    assert.ok(['higher_is_better', 'lower_is_better'].includes(m.direction));
  }
  assert.ok(MIR_ID_RE.test('perf:6x-confusable:routing-precision'));
  assert.ok(!MIR_ID_RE.test('perf:<script>'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-improvement-metrics.test.js`
Expected: FAIL — `Cannot find module '../src/mesh-improvement/metrics.js'`.

- [ ] **Step 3: Append config constants**

Append to `src/config.js`:

```js
// Mesh Improvement Report (MIR) — spec 2026-06-19. All optional; see CLAUDE.md Config.
export const DEFAULT_MIR_DIR = '.dev-society/mir';
export const DEFAULT_MIR_NOISE_BAND_PCT = 10;   // soft-finding regression threshold (%)
export const DEFAULT_MIR_RECOVER_RUNS = 2;       // consecutive clean runs before an issue closes
export const DEFAULT_MIR_TREND_N = 10;           // trend-history length + ledger GC bound
export const DEFAULT_MESH_SCAN_LABEL = 'generated:mesh-scan';
// finding.id controlled vocabulary — becomes a label/marker, so it must be injection-safe.
export const MIR_ID_RE = /^[a-z0-9:_-]+$/;
```

- [ ] **Step 4: Write `metrics.js`**

```js
// src/mesh-improvement/metrics.js — pure metric registry + direction-aware deltas.
export const METRICS = {
  passRate:              { tier: 'soft', direction: 'higher_is_better', unit: 'ratio' },
  precision:             { tier: 'soft', direction: 'higher_is_better', unit: 'ratio' },
  recall:                { tier: 'soft', direction: 'higher_is_better', unit: 'ratio' },
  quality_per_1k_tokens: { tier: 'soft', direction: 'higher_is_better', unit: 'score' },
  cost_usd:              { tier: 'soft', direction: 'lower_is_better',  unit: 'usd' },
  latency_ms:            { tier: 'soft', direction: 'lower_is_better',  unit: 'ms' },
  wasted_hops:           { tier: 'soft', direction: 'lower_is_better',  unit: 'count' },
};

/** Signed percent toward "better" per the metric's direction; null if undefined. */
export function deltaPct(name, value, baseline) {
  if (typeof value !== 'number' || typeof baseline !== 'number') return null;
  if (baseline === 0) return null;
  const raw = ((value - baseline) / Math.abs(baseline)) * 100;
  const signed = METRICS[name]?.direction === 'lower_is_better' ? -raw : raw;
  return Math.round(signed * 10) / 10;
}

/** A regression is a negative signed delta whose magnitude exceeds the band. */
export function isRegression(name, dPct, bandPct) {
  return typeof dPct === 'number' && dPct < 0 && Math.abs(dPct) > bandPct;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/mesh-improvement-metrics.test.js`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config.js src/mesh-improvement/metrics.js test/mesh-improvement-metrics.test.js
git commit -m "feat(mir): config constants + direction-aware metric registry"
```

---

### Task 2: `aggregate.js` — raw inputs → MIR summary + findings

**Files:**
- Create: `src/mesh-improvement/aggregate.js`
- Test: `test/mesh-improvement-aggregate.test.js`

**Interfaces:**
- Consumes: `METRICS` from Task 1.
- Produces: `aggregate(inputs, { at, ref }) → { schema, at, ref, summary, findings }`. `inputs = { tests, behavior, adversarial, perf, runLogs }` (any may be null). `findings[]` items: `{ id, tier, cluster, severity:null, metric:{name,value,baseline:null,direction,deltaPct:null}, weakestCell, evidence, fileable:null }`. `summary` carries headline numbers with `delta:null` (Task 3 fills baseline/delta/fileable/severity).

- [ ] **Step 1: Write the failing test**

```js
// test/mesh-improvement-aggregate.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate } from '../src/mesh-improvement/aggregate.js';

const AT = '2026-06-20T06:30:00.000Z';
const REF = { commit: 'abc1234', branch: 'main' };

const inputs = {
  tests: { summary: { files: 180, green: 179, red: 1 },
           results: [{ f: 'routing.test.js', status: 'FAIL', pass: '12', fail: '1', secs: '3' }] },
  behavior: { aggregate: { trials: 9, passed: 8, passRate: 0.889 }, scenarios: [] },
  adversarial: { aggregate: { trials: 7, passed: 6, passRate: 0.857 },
                 scenarios: [{ name: 'I3-out-of-root-write', passRate: 0, trials: [
                   { pass: false, probes: [{ name: 'noExternalWrite', pass: false, detail: 'wrote /tmp/x' }] }] }] },
  perf: { scenarios: [{ name: '6x-confusable', cell: { peers: 6, overlap: 'confusable' },
           summary: { precision: { p50: 0.6, mean: 0.6 }, quality_per_1k_tokens: { p50: 333 },
                      wasted_hops: { p50: 1 }, cost_usd: { p50: 0.03 }, latency_ms: { p50: 3200 } } }] },
  runLogs: [{ id: 'delegate-1', route: 'ask', status: 'timeout', summary: 'killed at 600s',
              log_path: '.agent-mesh/logs/delegate-2026-06-20.jsonl' }],
};

test('hard findings: red test, failed invariant, error/timeout run-log', () => {
  const mir = aggregate(inputs, { at: AT, ref: REF });
  const hard = mir.findings.filter((f) => f.tier === 'hard').map((f) => f.id);
  assert.ok(hard.includes('test:routing.test.js:red'));
  assert.ok(hard.includes('adversarial:i3-out-of-root-write:failed'));
  assert.ok(hard.includes('runlog:ask:timeout'));
});

test('soft candidate findings carry value + direction, no delta yet', () => {
  const mir = aggregate(inputs, { at: AT, ref: REF });
  const prec = mir.findings.find((f) => f.id === 'perf:6x-confusable:precision');
  assert.equal(prec.tier, 'soft');
  assert.equal(prec.metric.value, 0.6);
  assert.equal(prec.metric.direction, 'higher_is_better');
  assert.equal(prec.metric.deltaPct, null);
  assert.equal(prec.fileable, null);
  assert.deepEqual(prec.weakestCell, { peers: 6, overlap: 'confusable' });
  const beh = mir.findings.find((f) => f.id === 'behavior:overall:passRate');
  assert.equal(beh.metric.value, 0.889);
});

test('summary + schema are populated; missing inputs tolerated', () => {
  const mir = aggregate(inputs, { at: AT, ref: REF });
  assert.equal(mir.schema, 'mesh-improvement-report/v1');
  assert.equal(mir.summary.tests.red, 1);
  assert.equal(mir.summary.behavior.passRate, 0.889);
  assert.equal(mir.summary.adversarial.invariantsPassed, '6/7');
  const empty = aggregate({ tests: null, behavior: null, adversarial: null, perf: null, runLogs: [] }, { at: AT, ref: REF });
  assert.equal(empty.findings.length, 0);
  assert.equal(empty.summary.behavior.passRate, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-improvement-aggregate.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `aggregate.js`**

```js
// src/mesh-improvement/aggregate.js — pure: raw producer JSON → MIR summary + findings.
// No deltas/ledger/trend here; baseline.js adds those. No Date.now().
import { METRICS } from './metrics.js';

const SCHEMA = 'mesh-improvement-report/v1';
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
const cellId = (cell) => (cell ? `${cell.peers}x-${cell.overlap}` : 'overall');
// Soft perf metrics surfaced per scenario cell. precision/recall read `mean`, the rest `p50`.
const PERF_SOFT = [
  { name: 'precision', stat: 'mean' }, { name: 'recall', stat: 'mean' },
  { name: 'quality_per_1k_tokens', stat: 'p50' }, { name: 'wasted_hops', stat: 'p50' },
  { name: 'cost_usd', stat: 'p50' }, { name: 'latency_ms', stat: 'p50' },
];

function softFinding({ id, cluster, name, value, weakestCell, evidence }) {
  return {
    id, tier: 'soft', cluster, severity: null,
    metric: { name, value: typeof value === 'number' ? value : null,
              baseline: null, direction: METRICS[name]?.direction ?? null, deltaPct: null },
    weakestCell: weakestCell ?? null, evidence: evidence ?? {}, fileable: null,
  };
}
function hardFinding({ id, cluster, evidence }) {
  return {
    id, tier: 'hard', cluster, severity: null,
    metric: { name: 'hard_signal', value: 1, baseline: null, direction: null, deltaPct: null },
    weakestCell: null, evidence: evidence ?? {}, fileable: null,
  };
}

export function aggregate(inputs, { at, ref }) {
  const { tests, behavior, adversarial, perf, runLogs } = inputs;
  const findings = [];

  // HARD — red test files.
  for (const r of tests?.results ?? []) {
    if (r.status !== 'PASS') {
      findings.push(hardFinding({
        id: `test:${slug(r.f)}:red`, cluster: 'test-failure',
        evidence: { trace: `${r.status} (pass=${r.pass} fail=${r.fail})`, scorecardPath: null },
      }));
    }
  }
  // HARD — failed security invariants (scenario passRate < 1).
  for (const s of adversarial?.scenarios ?? []) {
    if ((s.passRate ?? 1) < 1) {
      const probe = (s.trials?.flatMap((t) => t.probes ?? []).find((p) => !p.pass)) || {};
      findings.push(hardFinding({
        id: `adversarial:${slug(s.name)}:failed`, cluster: 'security-invariant',
        evidence: { trace: probe.detail || probe.name || 'invariant failed' },
      }));
    }
  }
  // HARD — error/timeout run-log records (dedup by id, last wins).
  const seen = new Set();
  for (const rec of runLogs ?? []) {
    if (rec.status === 'error' || rec.status === 'timeout') {
      const id = `runlog:${slug(rec.route || 'unknown')}:${rec.status}`;
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push(hardFinding({
        id, cluster: 'delegation-failure',
        evidence: { trace: rec.summary || rec.status, runId: rec.id || null, logPath: rec.log_path || null },
      }));
    }
  }
  // SOFT — behavior overall pass rate.
  if (typeof behavior?.aggregate?.passRate === 'number') {
    findings.push(softFinding({
      id: 'behavior:overall:passRate', cluster: 'behavior-regression',
      name: 'passRate', value: behavior.aggregate.passRate,
    }));
  }
  // SOFT — per perf scenario cell.
  for (const s of perf?.scenarios ?? []) {
    for (const { name, stat } of PERF_SOFT) {
      const value = s.summary?.[name]?.[stat];
      if (typeof value !== 'number') continue;
      findings.push(softFinding({
        id: `perf:${cellId(s.cell)}:${name}`, cluster: 'perf-regression',
        name, value, weakestCell: s.cell || null,
        evidence: { scorecardPath: s.scorecardPath || null },
      }));
    }
  }

  const summary = {
    tests: { green: tests?.summary?.green ?? null, red: tests?.summary?.red ?? null, delta: null },
    behavior: { passRate: behavior?.aggregate?.passRate ?? null, delta: null },
    adversarial: { invariantsPassed: adversarial?.aggregate
      ? `${adversarial.aggregate.passed}/${adversarial.aggregate.trials}` : null, delta: null },
    perf: { quality_per_1k_tokens_p50: meanOfScenarioStat(perf, 'quality_per_1k_tokens', 'p50'),
            wasted_hops_p50: meanOfScenarioStat(perf, 'wasted_hops', 'p50'), delta: null },
  };
  return { schema: SCHEMA, at, ref, summary, findings };
}

function meanOfScenarioStat(perf, name, stat) {
  const xs = (perf?.scenarios ?? []).map((s) => s.summary?.[name]?.[stat]).filter((v) => typeof v === 'number');
  return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-improvement-aggregate.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-improvement/aggregate.js test/mesh-improvement-aggregate.test.js
git commit -m "feat(mir): aggregate producer JSON into MIR summary + findings"
```

---

### Task 3: `baseline.js` — deltas, trend, and the carried-forward ledger

**Files:**
- Create: `src/mesh-improvement/baseline.js`
- Test: `test/mesh-improvement-baseline.test.js`

**Interfaces:**
- Consumes: `deltaPct` from Task 1; the `aggregate()` output shape from Task 2.
- Produces: `applyBaseline(current, previous, { at, trendN }) → mir` where `mir` adds: `baseline` (`previous?.ref || null`), `metric.baseline` + `metric.deltaPct` per finding, `summary.<k>.delta`, top-level `ledger` (map `id → {firstSeen,lastSeen,occurrences,cleanRuns,issueNumber}`), and `trend` (`{passRate:[], quality_per_1k_tokens:[]}`). `previous` may be null (first run). Date strings use `at.slice(0,10)`.

- [ ] **Step 1: Write the failing test**

```js
// test/mesh-improvement-baseline.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBaseline } from '../src/mesh-improvement/baseline.js';

const AT = '2026-06-20T06:30:00.000Z';
const mk = (passRate, precision, extraFindings = []) => ({
  schema: 'mesh-improvement-report/v1', at: AT, ref: { commit: 'cur', branch: 'main' },
  summary: { tests: { green: 179, red: 1, delta: null }, behavior: { passRate, delta: null },
             adversarial: { invariantsPassed: '7/7', delta: null },
             perf: { quality_per_1k_tokens_p50: 333, wasted_hops_p50: 1, delta: null } },
  findings: [
    { id: 'behavior:overall:passRate', tier: 'soft', cluster: 'behavior-regression', severity: null,
      metric: { name: 'passRate', value: passRate, baseline: null, direction: 'higher_is_better', deltaPct: null },
      weakestCell: null, evidence: {}, fileable: null },
    { id: 'perf:6x-confusable:precision', tier: 'soft', cluster: 'perf-regression', severity: null,
      metric: { name: 'precision', value: precision, baseline: null, direction: 'higher_is_better', deltaPct: null },
      weakestCell: { peers: 6, overlap: 'confusable' }, evidence: {}, fileable: null },
    ...extraFindings,
  ],
});

test('first run: null baseline, null deltas, fresh ledger', () => {
  const mir = applyBaseline(mk(0.889, 0.9), null, { at: AT, trendN: 10 });
  assert.equal(mir.baseline, null);
  assert.equal(mir.findings[0].metric.deltaPct, null);
  assert.equal(mir.ledger['perf:6x-confusable:precision'].occurrences, 1);
  assert.equal(mir.ledger['perf:6x-confusable:precision'].cleanRuns, 0);
  assert.deepEqual(mir.trend.passRate, [0.889]);
});

test('second run computes signed deltas vs previous finding values', () => {
  const prev = applyBaseline(mk(0.9, 0.9), null, { at: '2026-06-19T06:30:00.000Z', trendN: 10 });
  const cur = applyBaseline(mk(0.889, 0.6), prev, { at: AT, trendN: 10 });
  const prec = cur.findings.find((f) => f.id === 'perf:6x-confusable:precision');
  assert.equal(prec.metric.baseline, 0.9);
  assert.equal(prec.metric.deltaPct, -33.3);
  assert.equal(cur.baseline.commit, 'cur');
  assert.deepEqual(cur.trend.passRate, [0.9, 0.889]);
});

test('absent id carries forward with cleanRuns++ until GC; present id resets cleanRuns', () => {
  const stale = { id: 'perf:3x-disjoint:cost_usd', tier: 'soft', cluster: 'perf-regression', severity: null,
    metric: { name: 'cost_usd', value: 0.02, baseline: null, direction: 'lower_is_better', deltaPct: null },
    weakestCell: null, evidence: {}, fileable: null };
  const prev = applyBaseline(mk(0.9, 0.9, [stale]), null, { at: '2026-06-19T06:30:00.000Z', trendN: 10 });
  prev.ledger['perf:3x-disjoint:cost_usd'].issueNumber = 99; // simulate it was filed
  const cur = applyBaseline(mk(0.889, 0.9), prev, { at: AT, trendN: 10 }); // stale id absent now
  assert.equal(cur.ledger['perf:3x-disjoint:cost_usd'].cleanRuns, 1);
  assert.equal(cur.ledger['perf:3x-disjoint:cost_usd'].issueNumber, 99); // retained until closed
  assert.equal(cur.ledger['perf:6x-confusable:precision'].cleanRuns, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-improvement-baseline.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `baseline.js`**

```js
// src/mesh-improvement/baseline.js — pure: add deltas, trend, and the carried ledger.
import { deltaPct } from './metrics.js';

const TREND_KEYS = ['passRate', 'quality_per_1k_tokens'];

export function applyBaseline(current, previous, { at, trendN }) {
  const day = at.slice(0, 10);
  const prevFindings = new Map((previous?.findings ?? []).map((f) => [f.id, f]));
  const prevLedger = previous?.ledger ?? {};

  // Per-finding baseline + signed delta from the previous run's same-id finding.
  const findings = current.findings.map((f) => {
    const base = prevFindings.get(f.id)?.metric?.value ?? null;
    const dPct = deltaPct(f.metric.name, f.metric.value, base);
    return { ...f, metric: { ...f.metric, baseline: base, deltaPct: dPct } };
  });

  // Summary deltas (numeric headline fields only).
  const summary = structuredClone(current.summary);
  summary.behavior.delta = subtract(summary.behavior.passRate, previous?.summary?.behavior?.passRate);
  summary.perf.delta = subtract(summary.perf.quality_per_1k_tokens_p50, previous?.summary?.perf?.quality_per_1k_tokens_p50);
  summary.tests.delta = subtract(summary.tests.red, previous?.summary?.tests?.red);

  // Ledger: union of previous ids and this run's finding ids.
  const presentIds = new Set(findings.map((f) => f.id));
  const ledger = {};
  for (const f of findings) {
    const p = prevLedger[f.id];
    ledger[f.id] = {
      firstSeen: p?.firstSeen ?? day, lastSeen: day,
      occurrences: (p?.occurrences ?? 0) + 1, cleanRuns: 0,
      issueNumber: p?.issueNumber ?? null,
    };
  }
  for (const [id, p] of Object.entries(prevLedger)) {
    if (presentIds.has(id)) continue;
    const cleanRuns = (p.cleanRuns ?? 0) + 1;
    // GC: drop entries that were never filed and have been clean for trendN runs.
    if (p.issueNumber == null && cleanRuns >= trendN) continue;
    ledger[id] = { ...p, cleanRuns };
  }

  // Trend: append this run's headline values, keep last trendN.
  const trend = {};
  for (const k of TREND_KEYS) {
    const v = k === 'passRate' ? summary.behavior.passRate : summary.perf.quality_per_1k_tokens_p50;
    const prior = previous?.trend?.[k] ?? [];
    trend[k] = [...prior, v].filter((x) => typeof x === 'number').slice(-trendN);
  }

  return { ...current, baseline: previous?.ref ?? null, summary, findings, ledger, trend };
}

function subtract(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? Math.round((a - b) * 1000) / 1000 : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-improvement-baseline.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-improvement/baseline.js test/mesh-improvement-baseline.test.js
git commit -m "feat(mir): baseline deltas, trend, and carried-forward ledger"
```

---

### Task 4: `policy.js` — the tiered fileable gate

**Files:**
- Create: `src/mesh-improvement/policy.js`
- Test: `test/mesh-improvement-policy.test.js`

**Interfaces:**
- Consumes: `isRegression` from Task 1; the `applyBaseline()` output shape from Task 3.
- Produces: `gate(mir, { noiseBandPct }) → mir` with each finding's `fileable` (bool) + `severity` set. Hard → `fileable:true, severity:'error'`. Soft → `fileable: baseline!=null && isRegression(...)`, `severity:'warning'`.

- [ ] **Step 1: Write the failing test**

```js
// test/mesh-improvement-policy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate } from '../src/mesh-improvement/policy.js';

const finding = (over) => ({
  id: 'x', tier: 'soft', cluster: 'c', severity: null,
  metric: { name: 'precision', value: 0.6, baseline: 0.9, direction: 'higher_is_better', deltaPct: -33.3 },
  weakestCell: null, evidence: {}, fileable: null, ...over,
});

test('hard findings are always fileable as errors', () => {
  const mir = gate({ findings: [finding({ tier: 'hard',
    metric: { name: 'hard_signal', value: 1, baseline: null, direction: null, deltaPct: null } })] },
    { noiseBandPct: 10 });
  assert.equal(mir.findings[0].fileable, true);
  assert.equal(mir.findings[0].severity, 'error');
});

test('soft regression past the band is fileable as a warning', () => {
  const mir = gate({ findings: [finding()] }, { noiseBandPct: 10 });
  assert.equal(mir.findings[0].fileable, true);
  assert.equal(mir.findings[0].severity, 'warning');
});

test('soft within band is not fileable', () => {
  const mir = gate({ findings: [finding({ metric: { name: 'precision', value: 0.88, baseline: 0.9,
    direction: 'higher_is_better', deltaPct: -2.2 } })] }, { noiseBandPct: 10 });
  assert.equal(mir.findings[0].fileable, false);
});

test('first/zero baseline soft never fileable', () => {
  const mir = gate({ findings: [finding({ metric: { name: 'precision', value: 0.6, baseline: null,
    direction: 'higher_is_better', deltaPct: null } })] }, { noiseBandPct: 10 });
  assert.equal(mir.findings[0].fileable, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-improvement-policy.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `policy.js`**

```js
// src/mesh-improvement/policy.js — pure tiered fileable gate.
import { isRegression } from './metrics.js';

export function gate(mir, { noiseBandPct }) {
  const findings = mir.findings.map((f) => {
    if (f.tier === 'hard') return { ...f, fileable: true, severity: 'error' };
    const fileable = f.metric.baseline != null &&
      isRegression(f.metric.name, f.metric.deltaPct, noiseBandPct);
    return { ...f, fileable, severity: 'warning' };
  });
  return { ...mir, findings };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-improvement-policy.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-improvement/policy.js test/mesh-improvement-policy.test.js
git commit -m "feat(mir): tiered fileable gate (hard always, soft past band)"
```

---

### Task 5: `issues.js` — deterministic issue action-plan

**Files:**
- Create: `src/mesh-improvement/issues.js`
- Test: `test/mesh-improvement-issues.test.js`

**Interfaces:**
- Consumes: `MIR_ID_RE`, `DEFAULT_MESH_SCAN_LABEL` from Task 1; the gated `mir` (with `findings` + `ledger`) from Tasks 3–4.
- Produces: `planIssues(mir, { recoverRuns, scanLabel }) → [{ id, issueNumber, action, title, body, labels, marker }]`. Dedup strictly by `mir.ledger[id].issueNumber`. Throws `Error` if any planned `finding.id` violates `MIR_ID_RE`.

- [ ] **Step 1: Write the failing test**

```js
// test/mesh-improvement-issues.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIssues } from '../src/mesh-improvement/issues.js';

const base = {
  at: '2026-06-20T06:30:00.000Z',
  findings: [
    { id: 'perf:6x-confusable:precision', tier: 'soft', cluster: 'perf-regression', severity: 'warning',
      fileable: true, weakestCell: { peers: 6, overlap: 'confusable' },
      metric: { name: 'precision', value: 0.6, baseline: 0.9, deltaPct: -33.3 }, evidence: {} },
  ],
  ledger: { 'perf:6x-confusable:precision': { firstSeen: '2026-06-18', lastSeen: '2026-06-20',
            occurrences: 3, cleanRuns: 0, issueNumber: null } },
};

test('fileable + no issueNumber → create with scan label + marker', () => {
  const plan = planIssues(base, { recoverRuns: 2, scanLabel: 'generated:mesh-scan' });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'create');
  assert.ok(plan[0].labels.includes('idea'));
  assert.ok(plan[0].labels.includes('generated:mesh-scan'));
  assert.equal(plan[0].marker, '<!-- mesh-scan:perf:6x-confusable:precision -->');
  assert.match(plan[0].body, /-33\.3/);
});

test('fileable + existing issueNumber → update that issue', () => {
  const mir = structuredClone(base);
  mir.ledger['perf:6x-confusable:precision'].issueNumber = 412;
  const plan = planIssues(mir, { recoverRuns: 2, scanLabel: 'generated:mesh-scan' });
  assert.equal(plan[0].action, 'update');
  assert.equal(plan[0].issueNumber, 412);
});

test('absent id with cleanRuns >= N and an issue → close; below N → no-op', () => {
  const mir = { at: base.at, findings: [], ledger: {
    'perf:x:cost_usd': { firstSeen: '2026-06-10', lastSeen: '2026-06-17', occurrences: 2, cleanRuns: 2, issueNumber: 50 },
    'perf:y:cost_usd': { firstSeen: '2026-06-10', lastSeen: '2026-06-19', occurrences: 2, cleanRuns: 1, issueNumber: 51 },
  } };
  const plan = planIssues(mir, { recoverRuns: 2, scanLabel: 'generated:mesh-scan' });
  assert.deepEqual(plan.map((p) => [p.action, p.issueNumber]), [['close', 50]]);
});

test('invalid finding.id is rejected before becoming a label/marker', () => {
  const mir = structuredClone(base);
  mir.findings[0].id = 'perf:<script>';
  mir.ledger = { 'perf:<script>': { occurrences: 1, cleanRuns: 0, issueNumber: null } };
  assert.throws(() => planIssues(mir, { recoverRuns: 2, scanLabel: 'generated:mesh-scan' }), /invalid finding id/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-improvement-issues.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `issues.js`**

```js
// src/mesh-improvement/issues.js — pure: gated MIR → GitHub issue action-plan.
// Dedup is by ledger[id].issueNumber ONLY — never by reading issue bodies.
import { MIR_ID_RE } from '../config.js';

const marker = (id) => `<!-- mesh-scan:${id} -->`;

function assertId(id) {
  if (!MIR_ID_RE.test(id)) throw new Error(`invalid finding id: ${JSON.stringify(id)}`);
}
function tierLabel(f) {
  if (f.tier === 'hard') return f.cluster === 'security-invariant' ? 'security' : 'regression';
  return f.cluster === 'behavior-regression' ? 'behavior' : 'perf';
}
function title(f) {
  const m = f.metric;
  if (f.tier === 'hard') return `[mesh-scan] ${f.cluster}: ${f.id}`;
  return `[mesh-scan] ${f.cluster}: ${m.name} regressed (${m.deltaPct}%)`;
}
function body(f, mir) {
  const m = f.metric;
  return [
    marker(f.id),
    `**Finding** \`${f.id}\` (${f.severity})`, '',
    f.tier === 'soft'
      ? `- metric: \`${m.name}\` = ${m.value} (baseline ${m.baseline}, Δ ${m.deltaPct}%)`
      : `- hard signal: ${f.evidence?.trace ?? f.cluster}`,
    f.weakestCell ? `- weakest cell: ${f.weakestCell.peers}× ${f.weakestCell.overlap}` : null,
    f.evidence?.logPath ? `- log: \`${f.evidence.logPath}\`` : null,
    f.evidence?.scorecardPath ? `- scorecard: \`${f.evidence.scorecardPath}\`` : null,
    '', `_Generated by the Mesh Improvement Report at ${mir.at}._`,
  ].filter((x) => x != null).join('\n');
}

export function planIssues(mir, { recoverRuns, scanLabel }) {
  const plan = [];
  const fileable = mir.findings.filter((f) => f.fileable);
  const fileableIds = new Set(fileable.map((f) => f.id));

  for (const f of fileable) {
    assertId(f.id);
    const issueNumber = mir.ledger?.[f.id]?.issueNumber ?? null;
    plan.push({
      id: f.id, issueNumber, action: issueNumber == null ? 'create' : 'update',
      title: title(f), body: body(f, mir),
      labels: ['idea', scanLabel, tierLabel(f)], marker: marker(f.id),
    });
  }
  // Close issues whose finding has been clean for >= recoverRuns and is not fileable now.
  for (const [id, entry] of Object.entries(mir.ledger ?? {})) {
    if (fileableIds.has(id)) continue;
    if (entry.issueNumber != null && (entry.cleanRuns ?? 0) >= recoverRuns) {
      assertId(id);
      plan.push({
        id, issueNumber: entry.issueNumber, action: 'close',
        title: null, labels: [], marker: marker(id),
        body: `${marker(id)}\nResolved: clean for ${entry.cleanRuns} consecutive runs as of ${mir.at}.`,
      });
    }
  }
  return plan;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-improvement-issues.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-improvement/issues.js test/mesh-improvement-issues.test.js
git commit -m "feat(mir): deterministic issue action-plan (dedup by ledger)"
```

---

### Task 6: `render.js` — `mir.md`

**Files:**
- Create: `src/mesh-improvement/render.js`
- Test: `test/mesh-improvement-render.test.js`

**Interfaces:**
- Consumes: the full `mir` object (Tasks 2–4).
- Produces: `renderMarkdown(mir) → string` beginning with `<!-- mir:<YYYY-MM-DD> -->`, then a summary table and a fileable-findings list.

- [ ] **Step 1: Write the failing test**

```js
// test/mesh-improvement-render.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/mesh-improvement/render.js';

const mir = {
  at: '2026-06-20T06:30:00.000Z', ref: { commit: 'abc1234', branch: 'main' },
  summary: { tests: { green: 179, red: 1, delta: -1 }, behavior: { passRate: 0.889, delta: 0.02 },
             adversarial: { invariantsPassed: '7/7', delta: 0 },
             perf: { quality_per_1k_tokens_p50: 333, wasted_hops_p50: 1, delta: -18 } },
  findings: [{ id: 'perf:6x-confusable:precision', tier: 'soft', severity: 'warning', fileable: true,
    metric: { name: 'precision', value: 0.6, baseline: 0.9, deltaPct: -33.3 }, evidence: {} }],
};

test('renders the idempotent marker, summary, and fileable findings', () => {
  const md = renderMarkdown(mir);
  assert.match(md, /^<!-- mir:2026-06-20 -->/);
  assert.match(md, /Mesh Improvement Report/);
  assert.match(md, /precision/);
  assert.match(md, /-33\.3/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-improvement-render.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `render.js`**

```js
// src/mesh-improvement/render.js — pure: MIR → human markdown with an idempotent marker.
export function renderMarkdown(mir) {
  const day = mir.at.slice(0, 10);
  const d = (v) => (typeof v === 'number' ? (v >= 0 ? `+${v}` : `${v}`) : '—');
  const s = mir.summary;
  const lines = [
    `<!-- mir:${day} -->`,
    `# Mesh Improvement Report — ${day}`,
    `commit \`${mir.ref?.commit ?? '?'}\` · baseline \`${mir.baseline?.commit ?? 'none'}\``, '',
    '| signal | value | Δ |', '|---|---|---|',
    `| tests green/red | ${s.tests.green}/${s.tests.red} | ${d(s.tests.delta)} |`,
    `| behavior passRate | ${s.behavior.passRate ?? '—'} | ${d(s.behavior.delta)} |`,
    `| adversarial | ${s.adversarial.invariantsPassed ?? '—'} | ${d(s.adversarial.delta)} |`,
    `| perf q/1k p50 | ${s.perf.quality_per_1k_tokens_p50 ?? '—'} | ${d(s.perf.delta)} |`,
    '', '## Fileable findings', '',
  ];
  const fileable = mir.findings.filter((f) => f.fileable);
  if (!fileable.length) lines.push('_None this run._');
  for (const f of fileable) {
    const m = f.metric;
    lines.push(f.tier === 'hard'
      ? `- **[${f.severity}]** \`${f.id}\` — ${f.evidence?.trace ?? f.cluster}`
      : `- **[${f.severity}]** \`${f.id}\` — ${m.name} ${m.value} (base ${m.baseline}, Δ ${m.deltaPct}%)`);
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-improvement-render.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-improvement/render.js test/mesh-improvement-render.test.js
git commit -m "feat(mir): render mir.md with idempotent marker"
```

---

### Task 7: `baseline-restore.js` — CI baseline-run selection planner

**Files:**
- Create: `src/mesh-improvement/baseline-restore.js`
- Test: `test/mesh-improvement-baseline-restore.test.js`

**Interfaces:**
- Produces: `selectBaselineRun(runs) → run|null`. `runs[] = { databaseId, createdAt, conclusion, hasMir }`. Returns the newest-by-`createdAt` run with `hasMir === true`, **regardless of `conclusion`** (incl. `failure`); `null` if none.

- [ ] **Step 1: Write the failing test**

```js
// test/mesh-improvement-baseline-restore.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBaselineRun } from '../src/mesh-improvement/baseline-restore.js';

test('picks newest run with a mir artifact regardless of conclusion', () => {
  const runs = [
    { databaseId: 1, createdAt: '2026-06-18T07:00:00Z', conclusion: 'success', hasMir: true },
    { databaseId: 2, createdAt: '2026-06-19T07:00:00Z', conclusion: 'failure', hasMir: true },
    { databaseId: 3, createdAt: '2026-06-20T07:00:00Z', conclusion: 'success', hasMir: false },
  ];
  assert.equal(selectBaselineRun(runs).databaseId, 2); // newest WITH a mir artifact, even though it failed
});

test('none with a mir artifact → null (first-run semantics)', () => {
  assert.equal(selectBaselineRun([{ databaseId: 9, createdAt: '2026-06-20T07:00:00Z', conclusion: 'success', hasMir: false }]), null);
  assert.equal(selectBaselineRun([]), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-improvement-baseline-restore.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `baseline-restore.js`**

```js
// src/mesh-improvement/baseline-restore.js — pure CI baseline-selection planner.
// A failed nightly is exactly where hard findings live, so we DO NOT gate on conclusion.
export function selectBaselineRun(runs) {
  const withMir = (runs ?? []).filter((r) => r.hasMir);
  if (!withMir.length) return null;
  return withMir.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-improvement-baseline-restore.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-improvement/baseline-restore.js test/mesh-improvement-baseline-restore.test.js
git commit -m "feat(mir): CI baseline-run selection planner"
```

---

### Task 8: `collect.js` — read latest producer artifacts from disk

**Files:**
- Create: `src/mesh-improvement/collect.js`
- Test: `test/mesh-improvement-collect.test.js`

**Interfaces:**
- Produces: `collectInputs({ resultsRoots, logDir, mirDir }) → { inputs, previousMir }`. `resultsRoots = { tests, behavior, adversarial, perf }` are directories/paths; helper `latestJson(dir, filename)` returns the newest matching JSON or null. `inputs` matches Task 2's shape. `previousMir` = newest `mir-*.json` in `mirDir` or null.

- [ ] **Step 1: Write the failing test**

```js
// test/mesh-improvement-collect.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectInputs } from '../src/mesh-improvement/collect.js';

test('reads latest scorecards, run-logs, and previous mir', () => {
  const root = mkdtempSync(join(tmpdir(), 'mir-collect-'));
  const beh = join(root, 'eval-results', '2026-06-20T06-00-00');
  mkdirSync(beh, { recursive: true });
  writeFileSync(join(beh, 'scorecard.json'), JSON.stringify({ aggregate: { trials: 9, passed: 8, passRate: 0.889 }, scenarios: [] }));
  const logDir = join(root, 'logs'); mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'delegate-2026-06-20.jsonl'),
    JSON.stringify({ id: 'd1', state: 'done', route: 'ask', status: 'timeout', summary: 'killed' }) + '\n');
  const mirDir = join(root, 'mir'); mkdirSync(mirDir, { recursive: true });
  writeFileSync(join(mirDir, 'mir-2026-06-19.json'), JSON.stringify({ schema: 'mesh-improvement-report/v1', at: '2026-06-19T06:30:00Z' }));

  const { inputs, previousMir } = collectInputs({
    resultsRoots: { tests: join(root, 'test-results.json'), behavior: join(root, 'eval-results'),
                    adversarial: join(root, 'adversarial-results'), perf: join(root, 'perf-results') },
    logDir, mirDir });
  assert.equal(inputs.behavior.aggregate.passRate, 0.889);
  assert.equal(inputs.runLogs.length, 1);
  assert.equal(inputs.runLogs[0].status, 'timeout');
  assert.equal(inputs.tests, null);            // missing test-results.json tolerated
  assert.equal(previousMir.at, '2026-06-19T06:30:00Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-improvement-collect.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `collect.js`**

```js
// src/mesh-improvement/collect.js — impure: locate + read already-persisted producer JSON.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Newest `filename` under any immediate subdir of `dir` (eval runners write timestamped dirs). */
export function latestJson(dir, filename) {
  if (!dir || !existsSync(dir)) return null;
  let best = null, bestMtime = -1;
  for (const entry of readdirSync(dir)) {
    const candidate = join(dir, entry, filename);
    if (!existsSync(candidate)) continue;
    const m = statSync(candidate).mtimeMs;
    if (m > bestMtime) { bestMtime = m; best = candidate; }
  }
  return best ? readJson(best) : null;
}

function readRunLogs(logDir) {
  if (!logDir || !existsSync(logDir)) return [];
  const byId = new Map();
  for (const f of readdirSync(logDir)) {
    if (!/^delegate-.*\.jsonl$/.test(f)) continue;
    for (const line of readFileSync(join(logDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.id) byId.set(r.id, r); } catch { /* skip */ }
    }
  }
  return [...byId.values()].filter((r) => r.state === 'done' || r.status);
}

function latestMir(mirDir) {
  if (!mirDir || !existsSync(mirDir)) return null;
  const files = readdirSync(mirDir).filter((f) => /^mir-.*\.json$/.test(f)).sort();
  return files.length ? readJson(join(mirDir, files[files.length - 1])) : null;
}

export function collectInputs({ resultsRoots, logDir, mirDir }) {
  const inputs = {
    tests: resultsRoots.tests && existsSync(resultsRoots.tests) ? readJson(resultsRoots.tests) : null,
    behavior: latestJson(resultsRoots.behavior, 'scorecard.json'),
    adversarial: latestJson(resultsRoots.adversarial, 'scorecard.json'),
    perf: latestJson(resultsRoots.perf, 'perfcard.json'),
    runLogs: readRunLogs(logDir),
  };
  return { inputs, previousMir: latestMir(mirDir) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-improvement-collect.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-improvement/collect.js test/mesh-improvement-collect.test.js
git commit -m "feat(mir): collect latest producer artifacts + previous MIR"
```

---

### Task 9: `run-all-tests.mjs --json` producer

**Files:**
- Modify: `run-all-tests.mjs`
- Test: `test/run-all-tests-json.test.js`

**Interfaces:**
- Produces: when invoked with `--json <path>`, writes `{ at, results:[{f,status,pass,fail,secs}], summary:{files,green,red} }` to `<path>` **before** the process's nonzero exit on red.

- [ ] **Step 1: Write the failing test**

```js
// test/run-all-tests-json.test.js — exercises the --json writer via a tiny fake suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../run-all-tests.mjs', import.meta.url));

test('--json writes the report before a nonzero exit on red', () => {
  const root = mkdtempSync(join(tmpdir(), 'mir-rat-'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'red.test.js'),
    "import t from 'node:test';import a from 'node:assert';t('x',()=>a.equal(1,2));");
  const out = join(root, 'tr.json');
  const r = spawnSync(process.execPath, [runner, '--json', out], { cwd: root, encoding: 'utf8' });
  assert.notEqual(r.status, 0);                 // red suite still exits nonzero
  assert.ok(existsSync(out));                    // ...but the JSON was written first
  const json = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(json.summary.red, 1);
  assert.equal(json.results[0].f, 'red.test.js');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/run-all-tests-json.test.js`
Expected: FAIL — no JSON file written (flag unsupported).

- [ ] **Step 3: Edit `run-all-tests.mjs`**

Add the import near the top (with the existing `node:fs` import):

```js
import { readdirSync, writeFileSync } from 'node:fs';
```

Replace the final block:

```js
const bad = results.filter((r) => r.status !== 'PASS');
console.log('\n=== SUMMARY ===');
console.log(`files: ${results.length}, green: ${results.length - bad.length}, red: ${bad.length}`);
for (const r of bad) console.log(`  ${r.status} ${r.f} (pass=${r.pass} fail=${r.fail})`);
process.exit(bad.length ? 1 : 0);
```

with:

```js
const bad = results.filter((r) => r.status !== 'PASS');
console.log('\n=== SUMMARY ===');
console.log(`files: ${results.length}, green: ${results.length - bad.length}, red: ${bad.length}`);
for (const r of bad) console.log(`  ${r.status} ${r.f} (pass=${r.pass} fail=${r.fail})`);

// --json <path>: persist a machine-readable report BEFORE the nonzero exit, so a
// red suite (which exits 1) still leaves the L0 signal on disk for the MIR.
const jsonIdx = process.argv.indexOf('--json');
if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({
    at: new Date().toISOString(),
    results,
    summary: { files: results.length, green: results.length - bad.length, red: bad.length },
  }, null, 2));
}
process.exit(bad.length ? 1 : 0);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/run-all-tests-json.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add run-all-tests.mjs test/run-all-tests-json.test.js
git commit -m "feat(mir): run-all-tests.mjs --json writes report before nonzero exit"
```

---

### Task 10: `run.js` — host orchestrator (compose + write artifacts + gh sync)

**Files:**
- Create: `src/mesh-improvement/run.js`
- Test: `test/mesh-improvement-run.test.js`

**Interfaces:**
- Consumes: every pure module (Tasks 2–6) + `collectInputs` (Task 8).
- Produces: `buildReport({ inputs, previousMir, at, ref, noiseBandPct, trendN }) → mir` (pure compose: aggregate → applyBaseline → gate); and `syncReport({ mir, mirDir, dryRun, gh, writeFile, recoverRuns, scanLabel }) → { plan, written, mutations }` where `gh(args) → Promise<string>` is injected. On `dryRun:true`, `gh` is **never called** (`mutations === 0`); created issue numbers are written back into the ledger before `mir.json` is persisted.

- [ ] **Step 1: Write the failing test**

```js
// test/mesh-improvement-run.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, syncReport } from '../src/mesh-improvement/run.js';

const inputs = {
  tests: { summary: { files: 180, green: 180, red: 0 }, results: [] },
  behavior: { aggregate: { trials: 9, passed: 6, passRate: 0.6 }, scenarios: [] },
  adversarial: { aggregate: { trials: 7, passed: 7, passRate: 1 }, scenarios: [] },
  perf: null, runLogs: [],
};
const previousMir = {
  schema: 'mesh-improvement-report/v1', at: '2026-06-19T06:30:00Z', ref: { commit: 'prev' },
  summary: { behavior: { passRate: 0.9 } },
  findings: [{ id: 'behavior:overall:passRate', metric: { name: 'passRate', value: 0.9 } }],
  ledger: { 'behavior:overall:passRate': { firstSeen: '2026-06-19', lastSeen: '2026-06-19', occurrences: 1, cleanRuns: 0, issueNumber: null } },
  trend: { passRate: [0.9], quality_per_1k_tokens: [] },
};

test('buildReport composes into a gated MIR with deltas', () => {
  const mir = buildReport({ inputs, previousMir, at: '2026-06-20T06:30:00Z',
    ref: { commit: 'cur', branch: 'main' }, noiseBandPct: 10, trendN: 10 });
  const beh = mir.findings.find((f) => f.id === 'behavior:overall:passRate');
  assert.equal(beh.metric.baseline, 0.9);
  assert.ok(beh.metric.deltaPct < -10);
  assert.equal(beh.fileable, true);            // regressed past band
});

test('dry-run never calls gh; live-run creates and records issueNumber', async () => {
  const mir = buildReport({ inputs, previousMir, at: '2026-06-20T06:30:00Z',
    ref: { commit: 'cur', branch: 'main' }, noiseBandPct: 10, trendN: 10 });
  const writes = {};
  const writeFile = (p, c) => { writes[p] = c; };

  let ghCalls = 0;
  const dry = await syncReport({ mir, mirDir: '/tmp/mir', dryRun: true,
    gh: async () => { ghCalls++; return ''; }, writeFile, recoverRuns: 2, scanLabel: 'generated:mesh-scan' });
  assert.equal(ghCalls, 0);
  assert.equal(dry.mutations, 0);
  assert.ok(dry.plan.some((p) => p.action === 'create'));

  const live = await syncReport({ mir, mirDir: '/tmp/mir', dryRun: false,
    gh: async (args) => (args[0] === 'issue' && args[1] === 'create' ? 'https://github.com/o/r/issues/777' : ''),
    writeFile, recoverRuns: 2, scanLabel: 'generated:mesh-scan' });
  assert.ok(live.mutations >= 1);
  const persisted = JSON.parse(writes[Object.keys(writes).find((k) => k.endsWith('.json'))]);
  assert.equal(persisted.ledger['behavior:overall:passRate'].issueNumber, 777);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/mesh-improvement-run.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `run.js`**

```js
// src/mesh-improvement/run.js — host orchestrator: compose pure modules, write
// artifacts, and apply the issue plan via an injected `gh`. Pure compose +
// thin I/O so it is unit-testable with fakes.
import { join } from 'node:path';
import { aggregate } from './aggregate.js';
import { applyBaseline } from './baseline.js';
import { gate } from './policy.js';
import { renderMarkdown } from './render.js';
import { planIssues } from './issues.js';

export function buildReport({ inputs, previousMir, at, ref, noiseBandPct, trendN }) {
  const raw = aggregate(inputs, { at, ref });
  const based = applyBaseline(raw, previousMir, { at, trendN });
  return gate(based, { noiseBandPct });
}

/** Parse the trailing issue number from `gh issue create` URL output. */
function issueNumberFromUrl(out) {
  const m = String(out).trim().match(/\/issues\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export async function syncReport({ mir, mirDir, dryRun, gh, writeFile, recoverRuns, scanLabel }) {
  const plan = planIssues(mir, { recoverRuns, scanLabel });
  let mutations = 0;

  if (!dryRun) {
    for (const item of plan) {
      if (item.action === 'create') {
        const out = await gh(['issue', 'create', '--title', item.title, '--body', item.body,
          ...item.labels.flatMap((l) => ['--label', l])]);
        const num = issueNumberFromUrl(out);
        if (num && mir.ledger[item.id]) mir.ledger[item.id].issueNumber = num;
        mutations++;
      } else if (item.action === 'update') {
        await gh(['issue', 'comment', String(item.issueNumber), '--body', item.body]);
        mutations++;
      } else if (item.action === 'close') {
        await gh(['issue', 'close', String(item.issueNumber), '--comment', item.body]);
        if (mir.ledger[item.id]) mir.ledger[item.id].issueNumber = null;
        mutations++;
      }
    }
  }

  const day = mir.at.slice(0, 10);
  const jsonPath = join(mirDir, `mir-${day}.json`);
  const mdPath = join(mirDir, `mir-${day}.md`);
  writeFile(jsonPath, JSON.stringify(mir, null, 2));
  writeFile(mdPath, renderMarkdown(mir));
  return { plan, written: [jsonPath, mdPath], mutations };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/mesh-improvement-run.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mesh-improvement/run.js test/mesh-improvement-run.test.js
git commit -m "feat(mir): host orchestrator — compose, write artifacts, gh sync"
```

---

### Task 11: Daemon builtin `tester-suite-run` + on-demand CLI verb

**Files:**
- Modify: `scripts/dev-society-daemon.mjs` (add the builtin to the `builtins` map)
- Create: `scripts/mir-run.mjs` (shared entry used by both the builtin and the CLI verb)
- Test: `test/tester-suite-run-builtin.test.js`

**Interfaces:**
- Consumes: `buildReport`/`syncReport` (Task 10), `collectInputs` (Task 8), config (Task 1).
- Produces: `scripts/mir-run.mjs` exports `runMir({ repoRoot, ref, dryRun, runSuites, gh, now })` returning `{ status:'ok'|'fail', summary, mutations }`. The daemon's `'tester-suite-run'` builtin calls `runMir(...)` with the real `gh` (via `sh`) and returns `{ status, output|error }`.

- [ ] **Step 1: Write the failing test**

```js
// test/tester-suite-run-builtin.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runMir } from '../scripts/mir-run.mjs';

const daemon = readFileSync(fileURLToPath(new URL('../scripts/dev-society-daemon.mjs', import.meta.url)), 'utf8');

test('the tester-suite-run builtin is registered in the daemon', () => {
  assert.match(daemon, /'tester-suite-run'\s*:/);
});

test('runMir dry-run produces a plan and performs no gh mutation', async () => {
  let ghCalls = 0;
  const res = await runMir({
    repoRoot: process.cwd(), ref: { commit: 'test', branch: 'main' },
    dryRun: true, runSuites: false, gh: async () => { ghCalls++; return ''; },
    now: () => new Date('2026-06-20T06:30:00Z'),
  });
  assert.equal(res.status, 'ok');
  assert.equal(ghCalls, 0);
  assert.equal(res.mutations, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tester-suite-run-builtin.test.js`
Expected: FAIL — `Cannot find module '../scripts/mir-run.mjs'`.

- [ ] **Step 3: Write `scripts/mir-run.mjs`**

```js
// scripts/mir-run.mjs — shared MIR entry for the daemon builtin and the CLI verb.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectInputs } from '../src/mesh-improvement/collect.js';
import { buildReport, syncReport } from '../src/mesh-improvement/run.js';
import {
  DEFAULT_MIR_DIR, DEFAULT_MIR_NOISE_BAND_PCT, DEFAULT_MIR_RECOVER_RUNS,
  DEFAULT_MIR_TREND_N, DEFAULT_MESH_SCAN_LABEL, DEFAULT_LOG_DIR,
} from '../src/config.js';

const env = (k, d) => (process.env[k] ?? d);

export async function runMir({ repoRoot, ref, dryRun, runSuites, gh, now }) {
  try {
    const at = now().toISOString();
    const mirDir = join(repoRoot, env('AGENT_MESH_MIR_DIR', DEFAULT_MIR_DIR));
    mkdirSync(mirDir, { recursive: true });

    if (runSuites) {
      spawnSync(process.execPath, ['run-all-tests.mjs', '--json', join(mirDir, 'test-results.json')],
        { cwd: repoRoot, stdio: 'inherit' });
    }
    const { inputs, previousMir } = collectInputs({
      resultsRoots: {
        tests: join(mirDir, 'test-results.json'),
        behavior: join(repoRoot, 'eval-results'),
        adversarial: join(repoRoot, 'adversarial-results'),
        perf: join(repoRoot, 'perf-results'),
      },
      logDir: join(repoRoot, env('AGENT_MESH_LOG_DIR', DEFAULT_LOG_DIR)),
      mirDir,
    });

    const mir = buildReport({
      inputs, previousMir, at, ref,
      noiseBandPct: Number(env('AGENT_MESH_MIR_NOISE_BAND_PCT', DEFAULT_MIR_NOISE_BAND_PCT)),
      trendN: Number(env('AGENT_MESH_MIR_TREND_N', DEFAULT_MIR_TREND_N)),
    });
    const { plan, mutations } = await syncReport({
      mir, mirDir, dryRun, gh, writeFile: (p, c) => writeFileSync(p, c),
      recoverRuns: Number(env('AGENT_MESH_MIR_RECOVER_RUNS', DEFAULT_MIR_RECOVER_RUNS)),
      scanLabel: env('MESH_SCAN_LABEL', DEFAULT_MESH_SCAN_LABEL),
    });
    const fileable = mir.findings.filter((f) => f.fileable).length;
    return { status: 'ok', summary: `${fileable} fileable, ${plan.length} planned, ${mutations} applied`, mutations };
  } catch (e) {
    return { status: 'fail', summary: e?.message || String(e), mutations: 0 };
  }
}

// CLI: `node scripts/mir-run.mjs [--dry-run] [--run-suites]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  const runSuites = process.argv.includes('--run-suites');
  const gh = async (args) => spawnSync('gh', args, { encoding: 'utf8' }).stdout || '';
  const res = await runMir({ repoRoot: process.cwd(),
    ref: { commit: process.env.GITHUB_SHA || 'local', branch: 'main' },
    dryRun, runSuites, gh, now: () => new Date() });
  console.log(JSON.stringify(res));
  process.exit(res.status === 'ok' ? 0 : 1);
}
```

- [ ] **Step 4: Register the builtin in `scripts/dev-society-daemon.mjs`**

Add an import near the top with the other imports:

```js
import { runMir } from './mir-run.mjs';
```

Add this entry to the `builtins` object (next to `'daily-report-refresh'`):

```js
    // Tester-owned: run the suites + emit mir.json/mir.md and sync backlog issues.
    'tester-suite-run': async () => {
      const res = await runMir({
        repoRoot,
        ref: { commit: process.env.GITHUB_SHA || 'local', branch: 'main' },
        dryRun: false,
        runSuites: true,
        gh: async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout,
        now: () => new Date(),
      });
      return res.status === 'ok'
        ? { status: 'ok', output: res.summary }
        : { status: 'fail', error: res.summary };
    },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/tester-suite-run-builtin.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/mir-run.mjs scripts/dev-society-daemon.mjs test/tester-suite-run-builtin.test.js
git commit -m "feat(mir): tester-suite-run daemon builtin + on-demand CLI entry"
```

---

### Task 12: Wire the Tester agent's schedule + identity

**Files:**
- Create: `dev-mesh/tester/.agent/schedule.json`
- Modify: `dev-mesh/tester/AGENT.md`, `dev-mesh/tester/agent.json`
- Test: `test/tester-agent-schedule.test.js`

**Interfaces:**
- Consumes: `validateCadence` from `src/schedule/schedule-cadence.js`; the mesh manifest `dev-mesh/mesh.json`.
- Produces: a valid `tester-suite-run` job; a Tester that remains `ask`-only with no non-`readOnly` MCP server.

- [ ] **Step 1: Write the failing test**

```js
// test/tester-agent-schedule.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateCadence } from '../src/schedule/schedule-cadence.js';

const p = (rel) => fileURLToPath(new URL(`../dev-mesh/tester/${rel}`, import.meta.url));

test('tester schedule.json has a valid tester-suite-run builtin job', () => {
  const sched = JSON.parse(readFileSync(p('.agent/schedule.json'), 'utf8'));
  const job = sched.jobs.find((j) => j.id === 'tester-suite-run');
  assert.ok(job, 'tester-suite-run job present');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.builtin, 'tester-suite-run');
  assert.equal(validateCadence(job.cadence).ok, true);
});

test('tester stays ask-only and is wired no mutating MCP server', () => {
  const mesh = JSON.parse(readFileSync(fileURLToPath(new URL('../dev-mesh/mesh.json', import.meta.url)), 'utf8'));
  const tester = mesh.agents.find((a) => a.name === 'tester');
  assert.deepEqual(tester.enabledModes, ['ask']);
  // No mutating MCP config is added to the tester folder (issue mutation is host-side).
  assert.equal(existsSync(p('.mcp.json')), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/tester-agent-schedule.test.js`
Expected: FAIL — `.agent/schedule.json` missing.

- [ ] **Step 3: Create `dev-mesh/tester/.agent/schedule.json`**

```json
{
  "jobs": [
    {
      "id": "tester-suite-run",
      "name": "Suite + improvement report",
      "kind": "builtin",
      "builtin": "tester-suite-run",
      "cadence": { "kind": "daily", "at": "06:30" },
      "enabled": true,
      "saveArtifact": false
    }
  ]
}
```

- [ ] **Step 4: Update `dev-mesh/tester/AGENT.md`**

Append this paragraph:

```markdown

On a nightly schedule I own the `tester-suite-run` job: the framework runs the
suites and the Mesh Improvement Report aggregator, which writes `mir.json` /
`mir.md` and files deduped backlog issues for regressions. I never run shell and
never mutate GitHub myself — the host applies the deterministic plan; I interpret
`mir.json` for humans on request.
```

- [ ] **Step 5: Update `dev-mesh/tester/agent.json`**

In the `skills` array, append:

```json
    {
      "id": "file-improvement-findings",
      "name": "File improvement findings",
      "description": "Interpret mir.json and explain the filed regression findings.",
      "tags": ["mir", "backlog"]
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/tester-agent-schedule.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add dev-mesh/tester/.agent/schedule.json dev-mesh/tester/AGENT.md dev-mesh/tester/agent.json test/tester-agent-schedule.test.js
git commit -m "feat(mir): schedule + identity for the Tester-owned suite-run job"
```

---

### Task 13: CI — `l0-json` producer + `mir` aggregation job

**Files:**
- Modify: `.github/workflows/integration.yml`
- Modify: `test/integration-workflow.test.js` (append assertions)

**Interfaces:**
- Consumes: existing `l2-behavior`/`l3-adversarial`/`l4-perf` artifact uploads; `scripts/mir-run.mjs` (Task 11).
- Produces: an `l0-json` job that uploads `test-results.json` with `if: always()`, and a `mir` job (`needs: [l0-json, l2-behavior, l3-adversarial, l4-perf]`, `if: always()`) that downloads artifacts, runs the MIR, and syncs issues — live on `schedule`, `--dry-run` on `workflow_dispatch`.

- [ ] **Step 1: Write the failing test (append to `test/integration-workflow.test.js`)**

```js
test('integration workflow: l0-json producer uploads test-results before exit', () => {
  assert.match(wf, /l0-json:/);
  assert.match(wf, /run-all-tests\.mjs --json test-results\.json/);
  // the upload must survive a red suite (nonzero exit) → if: always()
  assert.match(wf, /name: l0-json-results[\s\S]*?if: always\(\)/);
});

test('integration workflow: mir job aggregates, with permissions and schedule-gated mutation', () => {
  assert.match(wf, /\n  mir:/);
  assert.match(wf, /needs:\s*\[l0-json, l2-behavior, l3-adversarial, l4-perf\]/);
  assert.match(wf, /\n    if: always\(\)/);
  assert.match(wf, /issues: write/);
  assert.match(wf, /actions: read/);
  // live mutation only on schedule; workflow_dispatch is dry-run.
  assert.match(wf, /github\.event_name == 'schedule'/);
  assert.match(wf, /--dry-run/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/integration-workflow.test.js`
Expected: FAIL — the new assertions don't match (jobs absent).

- [ ] **Step 3: Add the `l0-json` job to `integration.yml`**

Insert after the `l1-e2e` job (sibling jobs, same indentation):

```yaml
  l0-json:
    name: L0 hermetic suite (JSON producer for MIR)
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ env.INTEGRATION_REF }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: L0 — full suite, writing test-results.json before any nonzero exit
        run: node run-all-tests.mjs --json test-results.json || true
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: l0-json-results
          path: test-results.json
          retention-days: 14
          if-no-files-found: warn
```

- [ ] **Step 4: Add the `mir` aggregation job to `integration.yml`**

Append as the last job:

```yaml
  mir:
    name: Mesh Improvement Report (aggregate + file findings)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    needs: [l0-json, l2-behavior, l3-adversarial, l4-perf]
    if: always()              # a failed producer is a hard finding — never skip
    permissions:
      contents: read
      actions: read           # download baseline artifact + list prior runs
      issues: write           # the deterministic issue sync
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ env.INTEGRATION_REF }}
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Download this run's producer artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts
      - name: Stage artifacts into the layout the MIR collector expects
        run: |
          mkdir -p .dev-society/mir eval-results adversarial-results perf-results
          cp -r artifacts/l2-behavior-scorecard/* eval-results/ 2>/dev/null || true
          cp -r artifacts/l3-adversarial-results/* adversarial-results/ 2>/dev/null || true
          cp -r artifacts/l4-perf-scorecard/* perf-results/ 2>/dev/null || true
          cp artifacts/l0-json-results/test-results.json .dev-society/mir/test-results.json 2>/dev/null || true
      - name: Restore the previous MIR as baseline (latest prior run with a mir artifact, any conclusion)
        run: |
          PREV=$(gh run list --workflow integration.yml --json databaseId,createdAt --limit 30 --jq '.[].databaseId' | while read id; do
            if gh run download "$id" -n mir-artifact -D /tmp/prevmir 2>/dev/null; then echo "$id"; break; fi
          done || true)
          if [ -d /tmp/prevmir ]; then cp /tmp/prevmir/mir-*.json .dev-society/mir/ 2>/dev/null || true; fi
      - name: Run the MIR (live on schedule, dry-run otherwise)
        run: |
          if [ "${{ github.event_name }}" = "schedule" ]; then
            GITHUB_SHA=${{ github.sha }} node scripts/mir-run.mjs
          else
            GITHUB_SHA=${{ github.sha }} node scripts/mir-run.mjs --dry-run
          fi
      - name: Summarize MIR
        if: always()
        run: find .dev-society/mir -name 'mir-*.md' -exec cat {} >> "$GITHUB_STEP_SUMMARY" \; 2>/dev/null || true
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: mir-artifact
          path: .dev-society/mir/mir-*.json
          retention-days: 30
          if-no-files-found: ignore
```

- [ ] **Step 5: Run the workflow-lint test to verify it passes**

Run: `node --test test/integration-workflow.test.js`
Expected: PASS (existing tests + the 2 new ones).

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/integration.yml test/integration-workflow.test.js
git commit -m "feat(mir): CI l0-json producer + mir aggregation job"
```

---

### Task 14: Full-suite green + docs

**Files:**
- Modify: `CLAUDE.md` (Config section — append the MIR env vars)

- [ ] **Step 1: Run the whole suite**

Run: `node run-all-tests.mjs`
Expected: SUMMARY shows `red: 0` (ignore the known `change-detect` container git-signing flake noted in the Tester's `interpret-scorecard` skill if it appears).

- [ ] **Step 2: Append MIR env vars to the `CLAUDE.md` Config paragraph**

Add to the Config list:

```markdown
`AGENT_MESH_MIR_DIR` (`.dev-society/mir`) · `AGENT_MESH_MIR_NOISE_BAND_PCT` (10) · `AGENT_MESH_MIR_RECOVER_RUNS` (2) · `AGENT_MESH_MIR_TREND_N` (10) · `MESH_SCAN_LABEL` (`generated:mesh-scan`) — Mesh Improvement Report (spec 2026-06-19): the Tester-owned nightly `tester-suite-run` builtin reads the eval/test/run-log artifacts, writes `mir.json`/`mir.md` under MIR_DIR, and files deduped backlog issues for regressions (hard signals always; soft signals past the noise band).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(mir): document the Mesh Improvement Report env + nightly job"
```

---

## Self-Review

**Spec coverage:**
- §4 execution (daemon builtin + CI mir job) → Tasks 11, 13. ✅
- §5 host-not-agent filing → Tasks 10 (`syncReport` + injected `gh`), 12 (no mutating MCP). ✅
- §6 Tester schedule/identity → Task 12. ✅
- §7 `mir.json` schema (summary/findings/ledger/trend) → Tasks 2, 3. ✅
- §8 `issues.js` plan + dedup-by-ledger + id validation → Task 5. ✅
- §9 metric registry + tiered gate → Tasks 1, 4. ✅
- §10 baseline + ledger durability + restore planner → Tasks 3, 7, 13 (restore step). ✅
- §3 `run-all-tests --json` producer → Task 9. ✅
- §12 test coverage (incl. builtin registration, dry-run no-mutation, baseline-restore, mode-gating guard) → Tasks 5, 7, 10, 11, 12. ✅
- §13 config + CI permissions → Tasks 1, 13. ✅
- §14 invariants → enforced by Tasks 5 (id validation, metadata-only), 10 (dry-run), 12 (ask-only). ✅

**Placeholder scan:** No TBD/TODO; every code step carries complete code; every run step has an explicit command + expected result.

**Type consistency:** `aggregate → applyBaseline → gate → planIssues/renderMarkdown` pass one `mir` shape; `finding.metric.{name,value,baseline,direction,deltaPct}`, top-level `ledger[id].{firstSeen,lastSeen,occurrences,cleanRuns,issueNumber}`, and `plan[].{id,issueNumber,action,title,body,labels,marker}` are used identically across Tasks 2–10. `runMir`/`syncReport`/`buildReport` signatures match between Tasks 10 and 11.
