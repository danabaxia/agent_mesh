// test/perf-harness.test.js — hermetic coverage of the performance benchmark.
// The benchmark needs a real model; the harness must NOT. Stubbed/synthetic only.
// Spec: docs/superpowers/specs/2026-06-13-mesh-perf-benchmark-design.md §10.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { routing, efficiency, quality } from '../eval/perf/meters.mjs';
import { deriveSample, aggregate, summarize, renderMarkdown, exitCode } from '../eval/perf/perfcard.mjs';
import { buildJudgePrompt, parseJudgeScore } from '../eval/perf/judge.mjs';
import { buildRoutingMesh, routingTasks, cleanupMesh } from '../eval/perf/harness.mjs';
import { readManagedRegistry } from '../src/a2a/registry.js';

// ── meters (synthetic ctx — the core logic, no spawn) ────────────────────────

const dur = (ms) => ({ started_at: '2026-06-13T00:00:00.000Z', finished_at: new Date(Date.parse('2026-06-13T00:00:00.000Z') + ms).toISOString() });
const rec = (id, parent, ms, usage) => ({ id, parent_run_id: parent, ...dur(ms), usage });

function ctxFor(runs, { correctPeer = 'billing', acceptablePeers = ['billing'], minimalHops = 1, groundTruth = 'TRUTH', answer = 'the value is TRUTH', judgeScore = 1, metrics = { total_ms: 100, worker_run_ms: 70 } } = {}) {
  return {
    task: { correctPeer, acceptablePeers, minimalHops, groundTruth },
    result: { runId: 'rA', answer, task: { metadata: { 'agentmesh/metrics': metrics } } },
    runs, fixture: { driven: 'A' }, judgeScore
  };
}

test('routing meter: correct single delegation → precision/recall 1, no wasted hops', () => {
  const ctx = ctxFor({
    A: [rec('rA', null, 100, { input_tokens: 10, output_tokens: 5, total_cost_usd: 0.01 })],
    billing: [rec('rB', 'rA', 50, { input_tokens: 20, output_tokens: 8, total_cost_usd: 0.02 })],
    weather: []
  });
  const m = routing().compute(ctx);
  assert.equal(m.delegated_peers, 1);
  assert.equal(m.precision, 1);
  assert.equal(m.recall, 1);
  assert.equal(m.wrong_peer, 0);
  assert.equal(m.wasted_hops, 0);
});

test('routing meter: wrong peer → precision/recall 0, wrong_peer flagged', () => {
  const ctx = ctxFor({ A: [rec('rA', null, 100)], weather: [rec('rW', 'rA', 50)], billing: [] });
  const m = routing().compute(ctx);
  assert.equal(m.precision, 0);
  assert.equal(m.recall, 0);
  assert.equal(m.wrong_peer, 1);
});

test('routing meter: over-delegation (broadcast) → low precision + wasted hops', () => {
  const ctx = ctxFor({
    A: [rec('rA', null, 100)],
    billing: [rec('rB', 'rA', 50)], weather: [rec('rW', 'rA', 50)], payments: [rec('rP', 'rA', 50)]
  });
  const m = routing().compute(ctx);
  assert.equal(m.delegated_peers, 3);
  assert.equal(m.precision, 1 / 3);
  assert.equal(m.recall, 1);              // correct peer was among them
  assert.equal(m.wasted_hops, 2);         // 3 hops − 1 minimal
});

test('routing meter: two-hop chain counts in wasted_hops subtree', () => {
  const ctx = ctxFor({
    A: [rec('rA', null, 100)],
    billing: [rec('rB', 'rA', 50)],
    sub: [rec('rS', 'rB', 50)]            // billing → sub (second hop)
  });
  const m = routing().compute(ctx);
  assert.equal(m.delegated_peers, 1);     // only billing is a DIRECT delegate of A
  assert.equal(m.wasted_hops, 1);         // 2 edges in subtree − 1 minimal
});

test('routing meter: none needed & none done → precision 1', () => {
  const ctx = ctxFor({ A: [rec('rA', null, 100)] }, { acceptablePeers: [], correctPeer: null });
  const m = routing().compute(ctx);
  assert.equal(m.precision, 1);
  assert.equal(m.delegated_peers, 0);
});

test('efficiency meter: tokens/cost from run records, latency/overhead from root metrics', () => {
  const ctx = ctxFor({
    A: [rec('rA', null, 120, { input_tokens: 10, output_tokens: 5, total_cost_usd: 0.01 })],
    billing: [rec('rB', 'rA', 50, { input_tokens: 20, output_tokens: 8, total_cost_usd: 0.02 })]
  });
  const m = efficiency().compute(ctx);
  assert.equal(m.tokens_in, 30);
  assert.equal(m.tokens_out, 13);
  assert.equal(m.tokens_total, 43);
  assert.equal(Number(m.cost_usd.toFixed(4)), 0.03);
  assert.equal(m.hops, 1);
  assert.equal(m.latency_ms, 100);        // from root metrics total_ms
  assert.equal(m.overhead_ms, 30);        // total_ms − worker_run_ms
  assert.equal(m.worker_ms, 170);         // 120 + 50 wall durations
});

test('efficiency meter: missing metrics block → latency falls back to root duration, overhead null', () => {
  const ctx = ctxFor({ A: [rec('rA', null, 90)] }, { metrics: null });
  const m = efficiency().compute(ctx);
  assert.equal(m.latency_ms, 90);
  assert.equal(m.overhead_ms, null);
});

test('quality meter: contains-truth proxy + judge score passthrough', () => {
  assert.deepEqual(quality().compute(ctxFor({ A: [rec('rA', null, 1)] }, { answer: 'has TRUTH', judgeScore: 0.5 })),
    { contains_truth: 1, judge_score: 0.5 });
  assert.deepEqual(quality().compute(ctxFor({ A: [rec('rA', null, 1)] }, { answer: 'nope', judgeScore: null })),
    { contains_truth: 0, judge_score: null });
});

// ── perfcard math ────────────────────────────────────────────────────────────

test('perfcard: derived anti-gaming metrics (quality per token / hop)', () => {
  const d = deriveSample({ judge_score: 1, tokens_total: 2000, hops: 4 });
  assert.equal(d.quality_per_1k_tokens, 0.5);
  assert.equal(d.quality_per_hop, 0.25);
  // a broadcaster: same quality, 10× the tokens → 10× worse per-token score
  const b = deriveSample({ judge_score: 1, tokens_total: 20000, hops: 10 });
  assert.ok(b.quality_per_1k_tokens < d.quality_per_1k_tokens);
});

test('perfcard: summarize p50/p95/mean and aggregate over samples', () => {
  const rep = aggregate([{ name: 's', cell: { peers: 6, overlap: 'confusable' }, samples: [
    { judge_score: 1, cost_usd: 0.02, tokens_total: 1000, hops: 1, precision: 1, recall: 1 },
    { judge_score: 0, cost_usd: 0.10, tokens_total: 5000, hops: 3, precision: 0, recall: 0 }
  ] }]);
  const s = rep.scenarios[0];
  assert.equal(s.n, 2);
  assert.equal(s.summary.precision.mean, 0.5);
  assert.equal(s.summary.cost_usd.p50, 0.02);            // nearest-rank p50 of 2 → lower
  assert.equal(s.summary.cost_usd.p95, 0.10);            // p95 → upper
  assert.equal(s.scatter.length, 2);
  const md = renderMarkdown(rep);
  assert.match(md, /Mesh PerfCard/);
  assert.match(md, /6×confusable/);
});

test('perfcard: exit code 0 unless an explicit gate is violated', () => {
  const rep = aggregate([{ name: 's', samples: [{ judge_score: 0.4, cost_usd: 0.5, precision: 0.3 }] }]);
  assert.equal(exitCode(rep, {}), 0);                    // no gates
  assert.equal(exitCode(rep, { minQuality: 0.3 }), 0);   // p50 0.4 ≥ 0.3
  assert.equal(exitCode(rep, { minQuality: 0.6 }), 1);   // 0.4 < 0.6
  assert.equal(exitCode(rep, { maxCostUsd: 0.4 }), 1);   // 0.5 > 0.4
  assert.equal(exitCode(rep, { minPrecision: 0.5 }), 1); // 0.3 < 0.5
});

// ── judge (pure prompt + parse + calibration) ────────────────────────────────

test('judge: prompt carries the three inputs and the SCORE instruction, nothing else', () => {
  const p = buildJudgePrompt({ prompt: 'Q?', groundTruth: 'FACT-9', answer: 'it is FACT-9' });
  assert.match(p, /Q\?/);
  assert.match(p, /FACT-9/);
  assert.match(p, /it is FACT-9/);
  assert.match(p, /SCORE: <0 \| 0\.5 \| 1>/);
});

test('judge: parseJudgeScore maps ordinals and fails closed', () => {
  assert.equal(parseJudgeScore('reasoning...\nSCORE: 1'), 1);
  assert.equal(parseJudgeScore('SCORE: 0.5'), 0.5);
  assert.equal(parseJudgeScore('SCORE: 0'), 0);
  assert.equal(parseJudgeScore('first SCORE: 0\nrevised SCORE: 1'), 1);  // last wins
  assert.equal(parseJudgeScore('no verdict here'), null);                // fail-closed
  assert.equal(parseJudgeScore(''), null);
});

test('judge rubric parsing: golden judge-outputs rank good > partial > bad', () => {
  // Tests the PARSER + rubric mapping, NOT the model. Real judge drift (the model
  // emitting a wrong score) is uncatchable hermetically — covered at eval time.
  const golden = [
    { label: 'good', out: 'conveys the fact faithfully.\nSCORE: 1', expect: 1 },
    { label: 'partial', out: 'gestures at it.\nSCORE: 0.5', expect: 0.5 },
    { label: 'bad', out: 'fabricated, contradicts the fact.\nSCORE: 0', expect: 0 }
  ];
  const scored = golden.map((g) => ({ ...g, got: parseJudgeScore(g.out) }));
  for (const s of scored) assert.equal(s.got, s.expect, s.label);
  // ranking is monotonic good > partial > bad
  assert.ok(scored[0].got > scored[1].got && scored[1].got > scored[2].got);
});

// ── fixture generator + scenarios ────────────────────────────────────────────

test('buildRoutingMesh: marker-valid registry, N domain peers, planted facts', async () => {
  const mesh = await buildRoutingMesh({ peers: 3, overlap: 'disjoint', claude: '/bin/true' });
  try {
    assert.equal(mesh.driven, 'A');
    assert.equal(mesh.domains.length, 3);
    assert.deepEqual(Object.keys(mesh.agents).sort(), ['A', ...mesh.domains.map((d) => d.name)].sort());
    const reg = await readManagedRegistry(mesh.agents.A.root);
    assert.equal(reg.ok, true);
    assert.equal(Object.keys(reg.registry.peers).length, 3);
    // each peer's planted fact is in its own folder
    const d0 = mesh.domains[0];
    const facts = await readFile(join(mesh.agents[d0.name].root, 'facts.md'), 'utf8');
    assert.match(facts, new RegExp(d0.fact));
    // routingTasks: ground-truth-labelled, functional prompts
    const tasks = routingTasks(mesh, { count: 3 });
    assert.equal(tasks.length, 3);
    for (const t of tasks) {
      assert.ok(t.correctPeer && t.groundTruth && t.prompt);
      assert.deepEqual(t.acceptablePeers, [t.correctPeer]);
      assert.ok(!t.prompt.includes(t.correctPeer), 'prompt is functional, not naming the peer');
    }
  } finally { await cleanupMesh(mesh); }
});

test('buildRoutingMesh: guards — claude required, peers within pool, known overlap', async () => {
  await assert.rejects(() => buildRoutingMesh({ peers: 3, overlap: 'disjoint' }), /claude binary/);
  await assert.rejects(() => buildRoutingMesh({ peers: 99, overlap: 'disjoint', claude: '/bin/true' }), /exceeds/);
  await assert.rejects(() => buildRoutingMesh({ peers: 2, overlap: 'nope', claude: '/bin/true' }), /unknown overlap/);
});

test('perf scenarios: all export {name, cell, setup} and setup yields a valid fixture', async () => {
  const dir = fileURLToPath(new URL('../eval/perf/scenarios/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort();
  assert.ok(files.length >= 3, `expected perf scenario files, got ${files.length}`);
  const { api } = await import('../eval/perf/runner.mjs');
  const callApi = { ...api, claudeBin: '/bin/true' };
  for (const f of files) {
    const s = (await import(pathToFileURL(join(dir, f)).href)).default;
    assert.ok(s.name && s.cell && typeof s.setup === 'function', `${f} shape`);
    const setup = await s.setup(callApi);
    try {
      assert.ok(setup.mesh && Array.isArray(setup.tasks) && setup.tasks.length > 0, `${f} fixture`);
      assert.ok(Array.isArray(setup.meters) && setup.meters.length === 3, `${f} meters`);
      for (const t of setup.tasks) assert.ok(t.prompt && t.correctPeer && t.groundTruth, `${f} task labels`);
    } finally { await cleanupMesh(setup.mesh); }
  }
});
