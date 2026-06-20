// test/issue-sweep-schedule.test.js — the label-aware sweep is a maintainer builtin
// scheduled every 10 minutes; the daemon routes via core.routeFor, not the old loop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = (p) => readFileSync(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8');

test('daemon registers the issue-sweep builtin and routes via routeFor', () => {
  const d = repo('scripts/dev-society-daemon.mjs');
  assert.match(d, /'issue-sweep'/, 'registers the issue-sweep builtin');
  assert.match(d, /'label-repair-sweep'/, 'registers the label-repair-sweep builtin');
  assert.match(d, /core\.planLabelRepair/, 'label-repair-sweep uses the pure repair policy');
  assert.match(d, /core\.routeFor/, 'routes via routeFor');
  assert.match(d, /function sweep\(/, 'defines sweep()');
  assert.match(d, /function labelRepairSweep\(/, 'defines labelRepairSweep()');
  assert.match(d, /listAllOpen/, 'lists all open issues');
  assert.doesNotMatch(d, /async function tick\(/, 'old tick() loop retired');
  assert.doesNotMatch(d, /async function listEligible\(/, 'old listEligible removed');
  assert.match(d, /issue-sweep'[\s\S]{0,200}status: 'ok'/, 'issue-sweep builtin returns a status object');
  assert.match(d, /label-repair-sweep'[\s\S]{0,200}status: 'ok'/, 'label-repair-sweep builtin returns a status object');
});

test('maintainer schedules label repair before issue-sweep every 10 minutes', () => {
  const sched = JSON.parse(repo('dev-mesh/maintainer/.agent/schedule.json'));
  const labelRepair = (sched.jobs || []).find((j) => j.builtin === 'label-repair-sweep');
  const job = (sched.jobs || []).find((j) => j.builtin === 'issue-sweep');
  assert.ok(labelRepair, 'label-repair-sweep job present');
  assert.ok(job, 'issue-sweep job present');
  assert.ok(sched.jobs.findIndex((j) => j.builtin === 'label-repair-sweep') < sched.jobs.findIndex((j) => j.builtin === 'issue-sweep'),
    'label repair should run before issue-sweep so repaired issues are eligible in the same scheduler cycle');
  assert.equal(labelRepair.kind, 'builtin');
  assert.equal(labelRepair.cadence.kind, 'every');
  assert.equal(labelRepair.cadence.minutes, 10);
  assert.equal(labelRepair.enabled, true);
  assert.equal(job.kind, 'builtin');
  assert.equal(job.cadence.kind, 'every');
  assert.equal(job.cadence.minutes, 10);
  assert.equal(job.enabled, true);
});
