// test/absorption.test.js — repetition detection (spec §9). Pure, no spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTokens, jaccard, artifactSignature, recurringClusters } from '../src/absorption.js';

test('taskTokens: salient lowercased tokens, stopwords dropped', () => {
  const t = taskTokens('Please create a file to deploy the billing service');
  assert.ok(t.has('deploy') && t.has('billing') && t.has('service'));
  assert.ok(!t.has('the') && !t.has('create') && !t.has('file') && !t.has('to'));
});

test('jaccard: similarity bounds', () => {
  assert.equal(jaccard(taskTokens('deploy billing service'), taskTokens('deploy billing service')), 1);
  assert.equal(jaccard(taskTokens('deploy billing'), taskTokens('weather forecast tomorrow')), 0);
  assert.ok(jaccard(taskTokens('deploy billing service'), taskTokens('deploy billing module')) > 0.4);
});

test('artifactSignature: dir-shape + ext, order-insensitive, dedup', () => {
  assert.equal(artifactSignature(['src/a.js', 'src/b.js']), '/src/*.js'.replace('/src', 'src'));
  // same shape regardless of count/order
  assert.equal(artifactSignature(['src/b.js', 'src/a.js']), artifactSignature(['src/c.js']));
  assert.equal(artifactSignature(['notes/x.md']), artifactSignature(['notes/y.md']));
  assert.notEqual(artifactSignature(['src/a.js']), artifactSignature(['notes/a.md']));
  assert.equal(artifactSignature(null), '');
});

test('recurringClusters: BOTH signals must agree (task-sim AND artifact-diff)', () => {
  const runs = [
    { id: 'r1', task: 'deploy the billing service', result: { files_changed: ['deploy/billing.yaml'] } },
    { id: 'r2', task: 'deploy the billing module', result: { files_changed: ['deploy/audit.yaml'] } },   // ext differs (.yaml vs .yaml? make same)
    { id: 'r3', task: 'forecast tomorrow weather', result: { files_changed: ['weather/x.json'] } }
  ];
  // r1/r2: similar task BUT different artifact shape (.yaml dir 'deploy') — make them share
  runs[0].result.files_changed = ['deploy/billing.yaml'];
  runs[1].result.files_changed = ['deploy/audit.yaml'];
  const clusters = recurringClusters(runs, { simThreshold: 0.4 });
  // r1,r2 share task-sim (deploy/billing) AND artifact shape (deploy/*.yaml) → one cluster
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].size, 2);
  assert.deepEqual(clusters[0].runIds.sort(), ['r1', 'r2']);
});

test('recurringClusters: single signal (task-sim only) does NOT cluster', () => {
  const runs = [
    { id: 'r1', task: 'deploy the billing service', result: { files_changed: ['deploy/x.yaml'] } },
    { id: 'r2', task: 'deploy the billing service again', result: { files_changed: ['totally/different.js'] } } // task-sim high, artifact differs
  ];
  assert.equal(recurringClusters(runs, { simThreshold: 0.4 }).length, 0);   // artifact disagrees → no cluster
});

test('recurringClusters: empty / no-artifact runs yield nothing', () => {
  assert.deepEqual(recurringClusters([], {}), []);
  assert.deepEqual(recurringClusters([{ id: 'r1', task: 'deploy billing', result: {} }], {}), []); // no artifact signature
});
