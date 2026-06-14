// test/dev-mesh-health.test.js — the Dev-mesh health classifier (pure).
// Encodes the 2026-06-14 lesson: a green CI job can hide an errored/no-op model
// run, so health is judged on the result ENVELOPE, not the job conclusion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRunHealth, assessMesh, renderHealthReport } from '../src/dev-mesh/health.js';

test('classifyRunHealth: the real masking bug — is_error despite "success" subtype', () => {
  // The exact envelope from the first live intake run.
  const env = { type: 'result', subtype: 'success', is_error: true, duration_ms: 218, num_turns: 1, total_cost_usd: 0 };
  const h = classifyRunHealth(env);
  assert.equal(h.healthy, false);
  assert.equal(h.status, 'errored');
});

test('classifyRunHealth: green-but-no-op ($0 / ≤1 turn) is unhealthy', () => {
  const h = classifyRunHealth({ is_error: false, num_turns: 1, total_cost_usd: 0 });
  assert.equal(h.healthy, false);
  assert.equal(h.status, 'noop');
});

test('classifyRunHealth: a real working run (cost + turns) is healthy', () => {
  const h = classifyRunHealth({ is_error: false, num_turns: 6, total_cost_usd: 0.12 });
  assert.equal(h.healthy, true);
  assert.equal(h.status, 'ok');
});

test('classifyRunHealth: missing/garbage envelope is unknown (unhealthy, never throws)', () => {
  for (const bad of [null, undefined, 42, 'nope', []]) {
    const h = classifyRunHealth(bad);
    assert.equal(h.healthy, false);
    assert.equal(h.status, 'unknown');
  }
});

test('assessMesh: healthy only when every probe ok AND conformance clean', () => {
  const ok = { is_error: false, num_turns: 4, total_cost_usd: 0.05 };
  assert.equal(assessMesh({ runs: [{ name: 'dogfood', envelope: ok }] }).healthy, true);
  // one bad probe → unhealthy
  const bad = assessMesh({ runs: [{ name: 'dogfood', envelope: { is_error: true } }] });
  assert.equal(bad.healthy, false);
  assert.match(bad.summary, /UNHEALTHY/);
  // conformance drift alone → unhealthy even with a good probe
  const drift = assessMesh({ runs: [{ name: 'dogfood', envelope: ok }], conformanceFlags: ['maintainer registry drifted'] });
  assert.equal(drift.healthy, false);
});

test('renderHealthReport: emits a Markdown table and flags section', () => {
  const a = assessMesh({
    runs: [{ name: 'dogfood', envelope: { is_error: true, duration_ms: 218, num_turns: 1, total_cost_usd: 0 } }],
    conformanceFlags: ['coder .mcp.json missing peer bridge'],
  });
  const md = renderHealthReport(a);
  assert.match(md, /Dev-mesh health: 🔴 unhealthy/);
  assert.match(md, /\| dogfood \| 🔴 errored \|/);
  assert.match(md, /coder \.mcp\.json missing peer bridge/);
});
