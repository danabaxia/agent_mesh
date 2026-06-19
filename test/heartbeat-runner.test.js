import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHeartbeat } from '../src/mesh-health/heartbeat-runner.js';

const NOW = new Date('2026-06-18T12:00:00Z');
const TH = { failThreshold: 3, overdueGraceMs: 900_000, staleMs: 1_800_000, escalateAfter: 2 };
const overdueJob = { agent: 'orchestrator', id: 'p', enabled: true, cadence: { kind: 'every', minutes: 5 }, running: false, lastStatus: 'ok', lastRunAt: '2026-06-18T11:00:00Z', nextRunAt: '2026-06-18T11:00:00Z', consecutiveFailures: 0 };

function harness({ prev = null, jobs = [overdueJob] } = {}) {
  const calls = { heals: [], issues: [], snapshots: [] };
  return {
    calls,
    deps: {
      meshRoot: '/mesh', now: NOW, thresholds: TH,
      listSchedules: async () => jobs,
      readSnapshot: async () => prev,
      writeSnapshot: async (s) => { calls.snapshots.push(s); },
      applyHeal: async (h) => { calls.heals.push(h); },
      openIssue: async (e) => { calls.issues.push(e); },
    },
  };
}

test('overdue → rearm heal applied + snapshot written; warn (no escalation) on first sight', async () => {
  const { calls, deps } = harness();
  const r = await runHeartbeat(deps);
  assert.equal(r.status, 'ok');
  assert.equal(calls.heals[0].action, 'rearm');
  assert.equal(calls.snapshots.length, 1);
  assert.equal(calls.snapshots[0].findings[0].condition, 'overdue');
  assert.equal(calls.issues.length, 0);
});

test('snapshot is written BEFORE issues are opened (gh failure keeps the snapshot)', async () => {
  const prev = { findings: [{ agent: 'orchestrator', jobId: 'p', condition: 'overdue', seenCount: 1, since: NOW.toISOString() }], openEscalations: [] };
  const { calls, deps } = harness({ prev });
  let order = [];
  deps.writeSnapshot = async (s) => { order.push('snapshot'); calls.snapshots.push(s); };
  deps.openIssue = async () => { order.push('issue'); throw new Error('gh down'); };
  const r = await runHeartbeat(deps);
  assert.equal(r.status, 'fail');
  assert.deepEqual(order, ['snapshot', 'issue']);
  assert.equal(calls.snapshots.length, 1);
});

test('recovery closes the issue', async () => {
  const prev = { findings: [], openEscalations: ['mesh-heartbeat:orchestrator/p/overdue'] };
  const healthy = { ...overdueJob, nextRunAt: '2026-06-18T12:04:00Z' };
  const { calls, deps } = harness({ prev, jobs: [healthy] });
  await runHeartbeat(deps);
  assert.equal(calls.issues[0].action, 'close');
});
