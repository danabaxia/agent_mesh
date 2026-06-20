// test/ci-schedules.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCronWorkflows, normalizeCiStatus, latestCiRuns, listCiSchedules } from '../src/dev-society/ci-schedules.js';

const integ = { name: 'integration.yml', text:
`name: Integration (nightly)
on:
  schedule:
    - cron: '0 7 * * *'
  workflow_dispatch:
jobs:
  l1:
    name: L1 e2e
    steps:
      - name: run
        run: echo hi
` };
const backlog = { name: 'dev-mesh-backlog.yml', text:
`name: dev-mesh-backlog
on:
  schedule:
    - cron: '*/30 * * * *' # poll
    - cron: '5 0 * * *'
` };
const commented = { name: 'cm.yml', text:
`name: cm
on:
  schedule:
    # - cron: '0 0 * * *'
    - cron: '15 * * * *'
` };
const noName = { name: 'anon.yml', text: `on:\n  schedule:\n    - cron: '1 * * * *'\n` };
const pushOnly = { name: 'ci.yml', text: `name: ci\non:\n  push:\n    branches: [main]\njobs:\n  t:\n    steps:\n      - name: x\n        run: y\n` };

test('parseCronWorkflows: top-level name only, multi-cron, inline + full-line comments, schedule-less excluded', () => {
  const got = parseCronWorkflows([integ, backlog, commented, noName, pushOnly]);
  const by = Object.fromEntries(got.map((w) => [w.file, w]));
  assert.equal(by['integration.yml'].workflow, 'Integration (nightly)');   // quoted special-char name
  assert.deepEqual(by['integration.yml'].crons, ['0 7 * * *']);             // nested job/step `name:` ignored
  assert.deepEqual(by['dev-mesh-backlog.yml'].crons, ['*/30 * * * *', '5 0 * * *']); // inline comment stripped, multi
  assert.deepEqual(by['cm.yml'].crons, ['15 * * * *']);                     // commented cron excluded
  assert.equal(by['anon.yml'].workflow, 'anon');                            // basename fallback
  assert.equal(by['ci.yml'], undefined);                                    // push-only excluded
});

test('normalizeCiStatus maps GitHub conclusions', () => {
  assert.equal(normalizeCiStatus('success'), 'ok');
  assert.equal(normalizeCiStatus('failure'), 'fail');
  assert.equal(normalizeCiStatus('timed_out'), 'fail');
  assert.equal(normalizeCiStatus('cancelled'), null);
  assert.equal(normalizeCiStatus(null), null);
  assert.equal(normalizeCiStatus(undefined), null);
});

test('latestCiRuns keys by display name, latest wins, status from :e edge, running when unfinished', () => {
  const gh = [
    { id: 'gh-1', route: 'ci:dev-mesh-backlog', started_at: '2026-06-20T01:00:00Z', finished_at: '2026-06-20T01:01:00Z' },
    { id: 'gh-1:e', status: 'success' },
    { id: 'gh-2', route: 'ci:dev-mesh-backlog', started_at: '2026-06-20T02:00:00Z' }, // newer, unfinished, no edge
  ];
  const m = latestCiRuns(gh);
  const e = m.get('dev-mesh-backlog');
  assert.equal(e.lastRunAt, '2026-06-20T02:00:00Z');  // latest by started_at
  assert.equal(e.running, true);
  assert.equal(e.status, null);                        // newest has no edge
});

test('listCiSchedules: enriched / orchestrator-no-edge / absent-from-cache all yield a row', () => {
  const gh = [
    { id: 'gh-9', route: 'ci:dev-mesh-backlog', started_at: '2026-06-20T01:00:00Z', finished_at: '2026-06-20T01:01:00Z' },
    { id: 'gh-9:e', status: 'failure' },
    { id: 'gh-7', route: 'ci:Integration (nightly)', started_at: '2026-06-20T07:00:00Z', finished_at: '2026-06-20T07:30:00Z' }, // no :e
  ];
  const rows = listCiSchedules({ files: [integ, backlog, commented], ghActivity: gh });
  const by = Object.fromEntries(rows.map((r) => [r.file, r]));
  assert.equal(by['dev-mesh-backlog.yml'].status, 'fail');                  // edge → normalized
  assert.equal(by['dev-mesh-backlog.yml'].executor, 'GitHub Actions');
  assert.match(by['dev-mesh-backlog.yml'].cadenceLabel, /\*\/30 \* \* \* \*/);
  assert.equal(by['integration.yml'].lastRunAt, '2026-06-20T07:30:00Z');    // run cached
  assert.equal(by['integration.yml'].status, null);                        // orchestrator-mapped, no edge
  assert.equal(by['cm.yml'].lastRunAt, null);                              // absent from cache → still a row
  assert.equal(by['cm.yml'].status, null);
});
