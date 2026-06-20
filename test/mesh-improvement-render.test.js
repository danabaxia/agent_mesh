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
