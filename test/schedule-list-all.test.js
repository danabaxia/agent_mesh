// test/schedule-list-all.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { listAllSchedules } from '../src/schedule/list-all.js';

// Injected fs/manifest stubs keep it hermetic.
// Keys are built with the same join/resolve the production code uses so they
// match on both POSIX (/m/coder/...) and Windows (D:\m\coder\...).
function fixture() {
  const meshRoot = '/m';
  const root = resolve(meshRoot);
  const coderRoot = resolve(join(root, './coder'));
  const reviewerRoot = resolve(join(root, './reviewer'));
  const manifest = { agents: [
    { name: 'coder', root: './coder' },
    { name: 'reviewer', root: './reviewer' },
  ] };
  const files = {
    // coder: one enabled daily job with state + explicit description
    [join(coderRoot, '.agent', 'schedule.json')]: { jobs: [{ id: 'j1', name: 'Nightly', cadence: { kind: 'daily', at: '07:00' }, enabled: true, description: 'My job desc' }] },
    [join(coderRoot, '.agent-mesh', 'schedule-state.json')]: { j1: { lastRunAt: '2026-06-18T07:00:00Z', lastStatus: 'ok', lastSummary: 'done', nextRunAt: '2026-06-19T07:00:00Z', running: false } },
    // reviewer: one disabled job with prompt fallback, no state
    [join(reviewerRoot, '.agent', 'schedule.json')]: { jobs: [{ id: 'j2', name: 'Hourly', cadence: { kind: 'every', minutes: 60 }, enabled: false, prompt: 'Do the thing\nmore' }] },
  };
  const readManifestFn = async () => manifest;
  const readJsonFn = async (path, fallback) => (path in files ? files[path] : fallback);
  return { readManifestFn, readJsonFn, meshRoot };
}

test('listAllSchedules aggregates every agent job with merged state + cadence label', async () => {
  const { readManifestFn, readJsonFn, meshRoot } = fixture();
  const { jobs } = await listAllSchedules({ meshRoot, readManifestFn, readJsonFn });
  assert.equal(jobs.length, 2);
  const j1 = jobs.find((j) => j.id === 'j1');
  assert.equal(j1.agent, 'coder');
  assert.equal(j1.enabled, true);
  assert.equal(j1.lastStatus, 'ok');
  assert.equal(j1.nextRunAt, '2026-06-19T07:00:00Z');
  assert.ok(/daily|07:00/i.test(j1.cadenceLabel), 'has a human cadence label');
  const j2 = jobs.find((j) => j.id === 'j2');
  assert.equal(j2.agent, 'reviewer');
  assert.equal(j2.enabled, false);
  assert.equal(j2.lastStatus, null);   // no state file → nulls
  assert.equal(j2.running, false);
  // description field: explicit description and prompt-first-line fallback
  const byId = Object.fromEntries(jobs.map((j) => [j.id, j]));
  assert.equal(byId['j1'].description, 'My job desc');
  assert.equal(byId['j2'].description, 'Do the thing');   // prompt first-line fallback
});

test('listAllSchedules on unreadable manifest → empty', async () => {
  const { jobs } = await listAllSchedules({ meshRoot: '/m', readManifestFn: async () => { throw new Error('nope'); }, readJsonFn: async (_p, f) => f });
  assert.deepEqual(jobs, []);
});
