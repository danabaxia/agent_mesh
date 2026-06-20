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
