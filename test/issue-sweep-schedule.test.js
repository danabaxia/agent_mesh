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
  assert.match(d, /core\.routeFor/, 'routes via routeFor');
  assert.match(d, /function sweep\(/, 'defines sweep()');
  assert.match(d, /listAllOpen/, 'lists all open issues');
  assert.doesNotMatch(d, /async function tick\(/, 'old tick() loop retired');
  assert.doesNotMatch(d, /async function listEligible\(/, 'old listEligible removed');
  assert.match(d, /issue-sweep'[\s\S]{0,200}status: 'ok'/, 'issue-sweep builtin returns a status object');
});

test('maintainer schedules issue-sweep every 10 minutes', () => {
  const sched = JSON.parse(repo('dev-mesh/maintainer/.agent/schedule.json'));
  const job = (sched.jobs || []).find((j) => j.builtin === 'issue-sweep');
  assert.ok(job, 'issue-sweep job present');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.cadence.kind, 'every');
  assert.equal(job.cadence.minutes, 10);
  assert.equal(job.enabled, true);
});
