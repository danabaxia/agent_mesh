import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSweep } from '../src/concierge/sweep.js';
import { readAlerts } from '../src/concierge/alerts-store.js';

test('sweep gathers health, writes alerts, returns ok', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sw-'));
  const health = {
    checkConformance: async () => ({ ok: false, counts: { fail: 1 }, problems: [{ rule: 'r', level: 'fail', detail: 'd' }] }),
    triageLogs: async () => ({ agents: {} }),
    listStaleTasks: async () => ({ tasks: [] })
  };
  const out = await runSweep({ meshRoot: root, health, now: '2026-06-21T10:00:00Z' });
  assert.equal(out.status, 'ok');
  const { alerts } = await readAlerts(root);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'critical');
});

test('sweep tolerates a failing verb (never throws, still completes)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sw-'));
  const health = { checkConformance: async () => { throw new Error('boom'); },
    triageLogs: async () => ({ agents: {} }), listStaleTasks: async () => ({ tasks: [] }) };
  const out = await runSweep({ meshRoot: root, health, now: '2026-06-21T10:00:00Z' });
  assert.equal(out.status, 'ok');
});
