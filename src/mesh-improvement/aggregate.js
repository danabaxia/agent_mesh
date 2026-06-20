// src/mesh-improvement/aggregate.js — pure: raw producer JSON → MIR summary + findings.
// No deltas/ledger/trend here; baseline.js adds those. No Date.now().
import { METRICS } from './metrics.js';

const SCHEMA = 'mesh-improvement-report/v1';
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
const cellId = (cell) => (cell ? slug(`${cell.peers}x-${cell.overlap}`) : 'overall');
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
      id: 'behavior:overall:pass-rate', cluster: 'behavior-regression',
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
