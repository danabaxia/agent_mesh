import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowToAgent, runsToActivityRecords } from '../src/dev-society/gh-activity.js';

test('workflowToAgent maps dev-mesh workflows to role agents (catch-all → orchestrator)', () => {
  assert.equal(workflowToAgent('dev-mesh-review'), 'reviewer');
  assert.equal(workflowToAgent('dev-mesh-review-respond'), 'reviewer');
  assert.equal(workflowToAgent('dev-mesh-triage'), 'triager');
  assert.equal(workflowToAgent('dev-mesh-research'), 'analyst');
  assert.equal(workflowToAgent('dev-mesh-intake'), 'analyst');
  assert.equal(workflowToAgent('dev-mesh-backlog'), 'maintainer');
  assert.equal(workflowToAgent('dev-mesh-curate'), 'curator');
  assert.equal(workflowToAgent('dev-mesh-autofix'), 'coder');
  assert.equal(workflowToAgent('dev-mesh-ci-sweep'), 'coder');
  assert.equal(workflowToAgent('dev-mesh-mergefix'), 'coder');
  assert.equal(workflowToAgent('dev-mesh-dogfood'), 'orchestrator');
  assert.equal(workflowToAgent('dev-mesh-pr-janitor'), 'orchestrator');
  assert.equal(workflowToAgent('ci'), 'orchestrator');
});

test('runsToActivityRecords: in-progress run → working node + active orchestrator→agent arc', () => {
  const recs = runsToActivityRecords([
    { databaseId: 5, workflowName: 'dev-mesh-review', status: 'in_progress', conclusion: null, createdAt: '2026-06-18T10:00:00Z', updatedAt: '2026-06-18T10:01:00Z' },
  ]);
  const node = recs.find((r) => r.id === 'gh-5');
  assert.equal(node.agent, 'reviewer');
  assert.equal(node.route, 'ci:dev-mesh-review');
  assert.equal(node.finished_at, undefined);
  const edge = recs.find((r) => r.id === 'gh-5:e');
  assert.equal(edge.kind, 'a2a'); assert.equal(edge.from, 'orchestrator'); assert.equal(edge.to, 'reviewer');
  assert.equal(edge.status, null); assert.equal(edge.finished_at, undefined);
});

test('runsToActivityRecords: completed run → done node + settled edge with conclusion', () => {
  const recs = runsToActivityRecords([
    { databaseId: 6, workflowName: 'dev-mesh-triage', status: 'completed', conclusion: 'success', createdAt: '2026-06-18T10:00:00Z', updatedAt: '2026-06-18T10:05:00Z' },
  ]);
  assert.equal(recs.find((r) => r.id === 'gh-6').finished_at, '2026-06-18T10:05:00Z');
  const edge = recs.find((r) => r.id === 'gh-6:e');
  assert.equal(edge.to, 'triager'); assert.equal(edge.status, 'success'); assert.equal(edge.finished_at, '2026-06-18T10:05:00Z');
});

test('runsToActivityRecords: orchestrator-owned workflow emits NO self-edge (only node)', () => {
  const recs = runsToActivityRecords([
    { databaseId: 7, workflowName: 'dev-mesh-dogfood', status: 'in_progress', conclusion: null, createdAt: '2026-06-18T10:00:00Z', updatedAt: '2026-06-18T10:00:30Z' },
  ]);
  assert.equal(recs.filter((r) => r.id.startsWith('gh-7')).length, 1);
  assert.equal(recs[0].agent, 'orchestrator');
});

test('workflowToAgent tolerates null/undefined/non-string → orchestrator', () => {
  assert.equal(workflowToAgent(null), 'orchestrator');
  assert.equal(workflowToAgent(undefined), 'orchestrator');
  assert.equal(workflowToAgent(42), 'orchestrator');
});

test('runsToActivityRecords: queued (non-completed) run → treated as in-progress (no finished_at)', () => {
  const recs = runsToActivityRecords([
    { databaseId: 8, workflowName: 'dev-mesh-review', status: 'queued', conclusion: null, createdAt: '2026-06-18T10:00:00Z', updatedAt: '2026-06-18T10:00:10Z' },
  ]);
  const node = recs.find((r) => r.id === 'gh-8');
  assert.equal(node.finished_at, undefined);
  const edge = recs.find((r) => r.id === 'gh-8:e');
  assert.equal(edge.status, null);
  assert.equal(edge.finished_at, undefined);
});

test('runsToActivityRecords: completed run with null updatedAt → finished_at from injected now()', () => {
  const fixed = new Date('2026-06-18T12:34:56Z');
  const recs = runsToActivityRecords([
    { databaseId: 9, workflowName: 'dev-mesh-triage', status: 'completed', conclusion: 'success', createdAt: '2026-06-18T10:00:00Z', updatedAt: null },
  ], { now: () => fixed });
  assert.equal(recs.find((r) => r.id === 'gh-9').finished_at, '2026-06-18T12:34:56.000Z');
  assert.equal(recs.find((r) => r.id === 'gh-9:e').finished_at, '2026-06-18T12:34:56.000Z');
});
