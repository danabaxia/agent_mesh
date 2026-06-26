// test/mesh-improvement-run.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, syncReport } from '../src/mesh-improvement/run.js';
import { gate } from '../src/mesh-improvement/policy.js';

const inputs = {
  tests: { summary: { files: 180, green: 180, red: 0 }, results: [] },
  behavior: { aggregate: { trials: 9, passed: 6, passRate: 0.6 }, scenarios: [] },
  adversarial: { aggregate: { trials: 7, passed: 7, passRate: 1 }, scenarios: [] },
  perf: null, runLogs: [],
};
const previousMir = {
  schema: 'mesh-improvement-report/v1', at: '2026-06-19T06:30:00Z', ref: { commit: 'prev' },
  summary: { behavior: { passRate: 0.9 } },
  findings: [{ id: 'behavior:overall:pass-rate', metric: { name: 'passRate', value: 0.9 } }],
  ledger: { 'behavior:overall:pass-rate': { firstSeen: '2026-06-19', lastSeen: '2026-06-19', occurrences: 1, cleanRuns: 0, issueNumber: null } },
  trend: { passRate: [0.9], quality_per_1k_tokens: [] },
};

test('buildReport composes into a gated MIR with deltas', () => {
  const mir = buildReport({ inputs, previousMir, at: '2026-06-20T06:30:00Z',
    ref: { commit: 'cur', branch: 'main' }, noiseBandPct: 10, trendN: 10 });
  const beh = mir.findings.find((f) => f.id === 'behavior:overall:pass-rate');
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
  assert.equal(persisted.ledger['behavior:overall:pass-rate'].issueNumber, 777);
});

test('repo is targeted explicitly via --repo on every issue mutation (not cwd git auto-detect)', async () => {
  const mir = buildReport({ inputs, previousMir, at: '2026-06-20T06:30:00Z',
    ref: { commit: 'cur', branch: 'main' }, noiseBandPct: 10, trendN: 10 });
  const calls = [];
  await syncReport({ mir, mirDir: '/tmp/mir', dryRun: false, repo: 'o/r',
    gh: async (args) => { calls.push(args); return args[0] === 'issue' && args[1] === 'create' ? 'https://github.com/o/r/issues/9' : ''; },
    writeFile: () => {}, recoverRuns: 2, scanLabel: 'generated:mesh-scan' });
  const issueCalls = calls.filter((a) => a[0] === 'issue');
  assert.ok(issueCalls.length >= 1, 'expected at least one issue mutation');
  for (const a of issueCalls) {
    const i = a.indexOf('--repo');
    assert.ok(i !== -1 && a[i + 1] === 'o/r', `every issue mutation must carry --repo o/r: ${a.join(' ')}`);
  }
});

test('no repo provided → --repo omitted (back-compat)', async () => {
  const mir = buildReport({ inputs, previousMir, at: '2026-06-20T06:30:00Z',
    ref: { commit: 'cur', branch: 'main' }, noiseBandPct: 10, trendN: 10 });
  const calls = [];
  await syncReport({ mir, mirDir: '/tmp/mir', dryRun: false,
    gh: async (args) => { calls.push(args); return args[0] === 'issue' && args[1] === 'create' ? 'https://github.com/o/r/issues/9' : ''; },
    writeFile: () => {}, recoverRuns: 2, scanLabel: 'generated:mesh-scan' });
  assert.ok(calls.filter((a) => a[0] === 'issue').every((a) => !a.includes('--repo')));
});

test('direction-aware: improvement gets perf-improvement cluster, info severity, fileable=false', () => {
  const mir = {
    findings: [{
      id: 'perf:3x-disjoint:latency_ms', tier: 'soft', cluster: 'perf-regression',
      metric: { name: 'latency_ms', value: 400, baseline: 500, deltaPct: 20 },
      fileable: null, severity: null,
    }],
  };
  const result = gate(mir, { noiseBandPct: 10 });
  const f = result.findings[0];
  assert.equal(f.cluster, 'perf-improvement');
  assert.equal(f.severity, 'info');
  assert.equal(f.fileable, false);
});

test('direction-aware: regression past noise floor gets perf-regression, warning, fileable=true', () => {
  // latency_ms has metric-level noiseBandPct: 20, so need > 20% to trigger
  const mir = {
    findings: [{
      id: 'perf:3x-disjoint:latency_ms', tier: 'soft', cluster: 'perf-regression',
      metric: { name: 'latency_ms', value: 630, baseline: 500, deltaPct: -26 },
      fileable: null, severity: null,
    }],
  };
  const result = gate(mir, { noiseBandPct: 10 });
  const f = result.findings[0];
  assert.equal(f.cluster, 'perf-regression');
  assert.equal(f.severity, 'warning');
  assert.equal(f.fileable, true);
});

test('direction-aware: within-band regression is neutral (fileable=false, severity=null)', () => {
  const mir = {
    findings: [{
      id: 'perf:3x-disjoint:latency_ms', tier: 'soft', cluster: 'perf-regression',
      metric: { name: 'latency_ms', value: 510, baseline: 500, deltaPct: -2 },
      fileable: null, severity: null,
    }],
  };
  const result = gate(mir, { noiseBandPct: 10 });
  const f = result.findings[0];
  assert.equal(f.fileable, false);
  assert.equal(f.severity, null);
});

test('direction-aware: cold-start (no baseline) has fileable=false, severity=null', () => {
  const mir = {
    findings: [{
      id: 'perf:3x-disjoint:latency_ms', tier: 'soft', cluster: 'perf-regression',
      metric: { name: 'latency_ms', value: 500, baseline: null, deltaPct: null },
      fileable: null, severity: null,
    }],
  };
  const result = gate(mir, { noiseBandPct: 10 });
  const f = result.findings[0];
  assert.equal(f.fileable, false);
  assert.equal(f.severity, null);
});

test('direction-aware: favorable latency_ms move (−17%) via buildReport is never perf-regression', () => {
  const perfInputs = {
    tests: { summary: { files: 1, green: 1, red: 0 }, results: [] },
    behavior: null, adversarial: null, runLogs: [],
    perf: {
      scenarios: [{
        cell: { peers: 3, overlap: 'disjoint' },
        summary: { latency_ms: { p50: 415 } },
        scorecardPath: null,
      }],
    },
  };
  const prevMir = {
    schema: 'mesh-improvement-report/v1', at: '2026-06-23T06:30:00Z', ref: { commit: 'prev' },
    summary: { behavior: { passRate: null }, perf: { quality_per_1k_tokens_p50: null }, tests: { green: 1, red: 0 }, adversarial: { invariantsPassed: null } },
    findings: [{ id: 'perf:3x-disjoint:latency_ms', metric: { name: 'latency_ms', value: 500 } }],
    ledger: { 'perf:3x-disjoint:latency_ms': { firstSeen: '2026-06-23', lastSeen: '2026-06-23', occurrences: 1, cleanRuns: 0, issueNumber: null } },
    trend: { passRate: [], quality_per_1k_tokens: [] },
  };
  const mir = buildReport({ inputs: perfInputs, previousMir: prevMir, at: '2026-06-24T06:30:00Z',
    ref: { commit: 'cur', branch: 'main' }, noiseBandPct: 10, trendN: 10 });
  const f = mir.findings.find((x) => x.id === 'perf:3x-disjoint:latency_ms');
  assert.ok(f, 'finding must exist');
  assert.notEqual(f.cluster, 'perf-regression', 'favorable latency move must not be perf-regression');
  assert.equal(f.cluster, 'perf-improvement');
  assert.equal(f.fileable, false);
});

test('live-run self-heals labels: every create label is `gh label create`d before the first issue create', async () => {
  const mir = buildReport({ inputs, previousMir, at: '2026-06-20T06:30:00Z',
    ref: { commit: 'cur', branch: 'main' }, noiseBandPct: 10, trendN: 10 });
  const order = [];
  await syncReport({ mir, mirDir: '/tmp/mir', dryRun: false,
    gh: async (args) => {
      order.push(args.slice(0, 2).join(' '));
      return args[0] === 'issue' && args[1] === 'create' ? 'https://github.com/o/r/issues/1' : '';
    },
    writeFile: () => {}, recoverRuns: 2, scanLabel: 'generated:mesh-scan' });
  const firstCreate = order.indexOf('issue create');
  const firstLabel = order.indexOf('label create');
  assert.ok(firstLabel !== -1, 'expected a `gh label create` (ensureLabels) call');
  assert.ok(firstLabel < firstCreate, 'labels must be ensured before the first issue create');
});
