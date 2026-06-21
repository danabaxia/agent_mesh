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
  assert.ok(plan[0].labels.includes('bug'));
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

test('routing: EVERY report finding is filed as `bug` → auto-routes to the Coder', () => {
  const findings = [
    { tier: 'hard', cluster: 'test-failure', id: 'test:foo-test-js:red', descLabel: 'regression' },
    { tier: 'hard', cluster: 'security-invariant', id: 'sec:i3-single-root:break', descLabel: 'security' },
    { tier: 'soft', cluster: 'perf-regression', id: 'perf:6x:cost_usd', descLabel: 'perf',
      metric: { name: 'cost_usd', value: 2, baseline: 1, deltaPct: 100 } },
  ];
  for (const f of findings) {
    const mir = {
      at: base.at,
      findings: [{ ...f, severity: null, fileable: true, evidence: { trace: 't' } }],
      ledger: { [f.id]: { occurrences: 1, cleanRuns: 0, issueNumber: null } },
    };
    const plan = planIssues(mir, { recoverRuns: 2, scanLabel: 'generated:mesh-scan' });
    assert.ok(plan[0].labels.includes('bug'), `${f.cluster} must carry bug → Coder auto-fix`);
    assert.ok(!plan[0].labels.includes('idea'), `${f.cluster} is no longer human-gated`);
    assert.ok(plan[0].labels.includes(f.descLabel), `${f.cluster} keeps its descriptive ${f.descLabel} label`);
  }
});

test('invalid finding.id is rejected before becoming a label/marker', () => {
  const mir = structuredClone(base);
  mir.findings[0].id = 'perf:<script>';
  mir.ledger = { 'perf:<script>': { occurrences: 1, cleanRuns: 0, issueNumber: null } };
  assert.throws(() => planIssues(mir, { recoverRuns: 2, scanLabel: 'generated:mesh-scan' }), /invalid finding id/);
});
