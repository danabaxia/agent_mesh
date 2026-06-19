// test/swebench-harness.test.js — hermetic coverage of the SWE-bench L5 harness.
// No Docker, no real claude, no network — all logic tested with synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { scoreTextMatch } from '../eval/swebench/scorer.mjs';
import { buildTopology, PHASE1_TOPOLOGIES, ALL_TOPOLOGIES } from '../eval/swebench/topologies.mjs';
import { aggregate, renderMarkdown, exitCode } from '../eval/swebench/report.mjs';

// ── scorer (text match) ─────────────────────────────────────────────────────

test('scoreTextMatch: all keywords found → pass', () => {
  const task = { expected_keywords: ['foo', 'bar'], min_keyword_hits: 2 };
  const r = scoreTextMatch(task, 'The fix is in foo and also bar.');
  assert.equal(r.pass, true);
  assert.equal(r.hits, 2);
  assert.equal(r.total, 2);
});

test('scoreTextMatch: only 1 of 2 keywords found → fail (min_keyword_hits=2)', () => {
  const task = { expected_keywords: ['foo', 'bar'], min_keyword_hits: 2 };
  const r = scoreTextMatch(task, 'Only foo here.');
  assert.equal(r.pass, false);
  assert.equal(r.hits, 1);
});

test('scoreTextMatch: default min_keyword_hits=1 → pass with one match', () => {
  const task = { expected_keywords: ['alpha', 'beta'] };
  const r = scoreTextMatch(task, 'The answer mentions alpha.');
  assert.equal(r.pass, true);
  assert.equal(r.hits, 1);
});

test('scoreTextMatch: keyword check is case-insensitive', () => {
  const r = scoreTextMatch({ expected_keywords: ['FooBar'] }, 'The foobar function is here.');
  assert.equal(r.pass, true);
});

test('scoreTextMatch: empty answer → fail when keywords defined', () => {
  const r = scoreTextMatch({ expected_keywords: ['something'], min_keyword_hits: 1 }, '');
  assert.equal(r.pass, false);
  assert.equal(r.hits, 0);
});

test('scoreTextMatch: no keywords defined → pass if answer is non-empty', () => {
  const r = scoreTextMatch({}, 'Any text.');
  assert.equal(r.pass, true);
  assert.equal(r.total, 0);
});

test('scoreTextMatch: no keywords + empty answer → fail', () => {
  const r = scoreTextMatch({}, '');
  assert.equal(r.pass, false);
});

// ── topology factory ─────────────────────────────────────────────────────────

test('buildTopology: single_worker has one agent named worker', () => {
  const spec = buildTopology('single_worker');
  assert.deepEqual(Object.keys(spec.agents), ['worker']);
  assert.equal(spec.driven, 'worker');
  assert.ok(!spec.agents.worker.peers);
});

test('buildTopology: ask_chain has coordinator + specialist; coordinator has peers', () => {
  const spec = buildTopology('ask_chain');
  assert.deepEqual(Object.keys(spec.agents).sort(), ['coordinator', 'specialist']);
  assert.equal(spec.driven, 'coordinator');
  assert.deepEqual(spec.agents.coordinator.peers, ['specialist']);
  assert.ok(!spec.agents.specialist.peers);
});

test('buildTopology: architect_editor throws Phase 2 error', () => {
  assert.throws(() => buildTopology('architect_editor'), /Phase 2/);
});

test('buildTopology: unknown name throws', () => {
  assert.throws(() => buildTopology('nonexistent'), /unknown topology/);
});

test('PHASE1_TOPOLOGIES includes single_worker and ask_chain but not architect_editor', () => {
  assert.ok(PHASE1_TOPOLOGIES.includes('single_worker'));
  assert.ok(PHASE1_TOPOLOGIES.includes('ask_chain'));
  assert.ok(!PHASE1_TOPOLOGIES.includes('architect_editor'));
});

test('ALL_TOPOLOGIES includes all three topology names', () => {
  assert.ok(ALL_TOPOLOGIES.includes('single_worker'));
  assert.ok(ALL_TOPOLOGIES.includes('ask_chain'));
  assert.ok(ALL_TOPOLOGIES.includes('architect_editor'));
});

// ── report / scorecard ───────────────────────────────────────────────────────

test('aggregate: computes passRate and costPerPass correctly', () => {
  const results = [
    { taskId: 't1', topology: 'single_worker', pass: true, costUsd: 0.02, durationMs: 100 },
    { taskId: 't2', topology: 'single_worker', pass: false, costUsd: 0.01, durationMs: 80 },
    { taskId: 't3', topology: 'single_worker', pass: true, costUsd: 0.03, durationMs: 90 }
  ];
  const card = aggregate(results);
  assert.equal(card.topologies.length, 1);
  const t = card.topologies[0];
  assert.equal(t.name, 'single_worker');
  assert.equal(t.passed, 2);
  assert.equal(t.runnable, 3);
  assert.ok(Math.abs(t.passRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(t.costPerPass - (0.02 + 0.01 + 0.03) / 2) < 1e-9);
  assert.ok(Math.abs(card.aggregate.passRate - 2 / 3) < 1e-9);
});

test('aggregate: skipped tasks do not count in runnable', () => {
  const results = [
    { taskId: 't1', topology: 'single_worker', pass: false, skipped: true, costUsd: 0, durationMs: 0 },
    { taskId: 't2', topology: 'single_worker', pass: true, costUsd: 0.01, durationMs: 50 }
  ];
  const card = aggregate(results);
  const t = card.topologies[0];
  assert.equal(t.runnable, 1);
  assert.equal(t.total, 2);
  assert.equal(t.passed, 1);
  assert.equal(t.passRate, 1);
});

test('aggregate: empty results → passRate 0', () => {
  const card = aggregate([]);
  assert.equal(card.aggregate.passRate, 0);
  assert.equal(card.aggregate.tasks, 0);
});

test('aggregate: costPerPass is null when no tasks passed', () => {
  const results = [
    { taskId: 't1', topology: 'single_worker', pass: false, costUsd: 0.05, durationMs: 50 }
  ];
  const card = aggregate(results);
  assert.equal(card.topologies[0].costPerPass, null);
});

test('renderMarkdown: contains topology name and pass-rate', () => {
  const card = aggregate([
    { taskId: 't1', topology: 'single_worker', pass: true, costUsd: 0.01, durationMs: 10 }
  ]);
  const md = renderMarkdown(card);
  assert.ok(md.includes('single_worker'));
  assert.ok(md.includes('100%'));
});

test('exitCode: no threshold → always 0', () => {
  const card = aggregate([
    { taskId: 't1', topology: 'single_worker', pass: false, costUsd: 0, durationMs: 0 }
  ]);
  assert.equal(exitCode(card, undefined), 0);
  assert.equal(exitCode(card, null), 0);
});

test('exitCode: threshold met → 0', () => {
  const card = aggregate([
    { taskId: 't1', topology: 'single_worker', pass: true, costUsd: 0, durationMs: 0 }
  ]);
  assert.equal(exitCode(card, 1.0), 0);
});

test('exitCode: threshold not met → 1', () => {
  const card = aggregate([
    { taskId: 't1', topology: 'single_worker', pass: false, costUsd: 0, durationMs: 0 }
  ]);
  assert.equal(exitCode(card, 0.5), 1);
});

// ── task loader ──────────────────────────────────────────────────────────────

import { loadTasks } from '../eval/swebench/harness.mjs';
// loadTasks reads from eval/swebench/tasks/<suite>.json; mesh-bench.json is committed empty.

test('loadTasks: mesh-bench.json is empty array (placeholder)', async () => {
  const tasks = await loadTasks('mesh-bench');
  assert.ok(Array.isArray(tasks));
  assert.equal(tasks.length, 0);
});

test('loadTasks: non-existent suite throws', async () => {
  await assert.rejects(() => loadTasks('does-not-exist'), /cannot read task file/);
});
