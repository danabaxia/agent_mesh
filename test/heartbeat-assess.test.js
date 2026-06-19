import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessMeshHealth } from '../src/mesh-health/heartbeat.js';

const NOW = new Date('2026-06-18T12:00:00Z');
const TH = { failThreshold: 3, overdueGraceMs: 900_000, staleMs: 1_800_000, escalateAfter: 2 };
const base = { agent: 'orchestrator', id: 'p', enabled: true, cadence: { kind: 'every', minutes: 5 }, running: false, lastStatus: 'ok', lastRunAt: '2026-06-18T11:59:00Z', nextRunAt: '2026-06-18T11:59:00Z', consecutiveFailures: 0 };

test('healthy job → ok, no findings/heals/escalations', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, nextRunAt: '2026-06-18T12:04:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.summary.ok, 1);
  assert.equal(r.findings.length, 0);
  assert.equal(r.heals.length, 0);
  assert.equal(r.escalations.length, 0);
});

test('disabled job is never assessed (counts ok)', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, enabled: false, running: true, lastRunAt: '2020-01-01T00:00:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.findings.length, 0);
  assert.equal(r.summary.ok, 1);
});

test('stuck: running with stale lastRunAt → clear_stale heal', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, running: true, lastRunAt: '2026-06-18T11:00:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.findings[0].condition, 'stuck');
  assert.deepEqual(r.heals[0], { agent: 'orchestrator', jobId: 'p', action: 'clear_stale', reason: r.heals[0].reason });
  assert.equal(r.summary.stuck, 1);
});

test('overdue: not running, nextRunAt far past → rearm heal', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, nextRunAt: '2026-06-18T11:00:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.findings[0].condition, 'overdue');
  assert.equal(r.heals[0].action, 'rearm');
});

test('failing: consecutiveFailures ≥ threshold → no heal (escalation path only)', () => {
  const r = assessMeshHealth({ jobs: [{ ...base, lastStatus: 'fail', consecutiveFailures: 3, nextRunAt: '2026-06-18T12:04:00Z' }], now: NOW, thresholds: TH });
  assert.equal(r.findings[0].condition, 'failing');
  assert.equal(r.findings[0].consecutiveFailures, 3);
  assert.equal(r.heals.length, 0);
});

test('precedence: stuck > failing > overdue', () => {
  const j = { ...base, running: true, lastRunAt: '2026-06-18T11:00:00Z', consecutiveFailures: 9, nextRunAt: '2026-06-18T10:00:00Z' };
  const r = assessMeshHealth({ jobs: [j], now: NOW, thresholds: TH });
  assert.equal(r.findings[0].condition, 'stuck');
});

test('seenCount carries from prev; escalates at escalateAfter (open then update); closes on recovery', () => {
  const job = [{ ...base, nextRunAt: '2026-06-18T11:00:00Z' }];
  const r1 = assessMeshHealth({ jobs: job, now: NOW, thresholds: TH, prev: null });
  assert.equal(r1.findings[0].seenCount, 1);
  assert.equal(r1.findings[0].severity, 'warn');
  assert.equal(r1.escalations.length, 0);
  const r2 = assessMeshHealth({ jobs: job, now: NOW, thresholds: TH, prev: r1 });
  assert.equal(r2.findings[0].seenCount, 2);
  assert.equal(r2.findings[0].severity, 'error');
  assert.equal(r2.escalations[0].action, 'open');
  assert.deepEqual(r2.openEscalations, ['mesh-heartbeat:orchestrator/p/overdue']);
  const r3 = assessMeshHealth({ jobs: job, now: NOW, thresholds: TH, prev: r2 });
  assert.equal(r3.escalations[0].action, 'update');
  const r4 = assessMeshHealth({ jobs: [{ ...base, nextRunAt: '2026-06-18T12:04:00Z' }], now: NOW, thresholds: TH, prev: r3 });
  assert.equal(r4.escalations[0].action, 'close');
  assert.equal(r4.escalations[0].key, 'mesh-heartbeat:orchestrator/p/overdue');
  assert.deepEqual(r4.openEscalations, []);
});
