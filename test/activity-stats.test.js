// test/activity-stats.test.js — unit tests for the pure activity-stats reducer
// (Phase 4 Task 1; contract LOCKED in docs/superpowers/plans/2026-06-11-dashboard-redesign-phase4-activity.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivityStats, rangeBounds } from '../src/dashboard/activity-stats.js';

// Injected "now": local 2026-06-11 12:00:00 (reducer must never call Date.now()).
const NOW = new Date(2026, 5, 11, 12, 0, 0);
const T = (h, m = 0) => new Date(2026, 5, 11, h, m).toISOString();   // today
const Y = (h, m = 0) => new Date(2026, 5, 10, h, m).toISOString();   // yesterday
const DAY_MS = 24 * 60 * 60 * 1000;

const AGENT = 'library';
const base = { agent: AGENT, records: [], sessions: null, artifacts: [], toolCounts: null, now: NOW, range: 'today' };
const build = (over = {}) => buildActivityStats({ ...base, ...over });

// Record fixtures (shapes match the real run logs).
const delegateDone = { id: 'd1', route: 'ask', status: 'done', started_at: T(9), finished_at: T(9, 5) };
const delegateRunning = { id: 'd2', route: 'do', started_at: T(11) };
const delegateYesterday = { id: 'd0', route: 'ask', started_at: Y(9), finished_at: Y(9, 1) };
const a2aIn = { kind: 'a2a', from: 'coder', to: AGENT, mode: 'ask', status: 'completed', started_at: T(10), finished_at: T(10, 1) };
const a2aOutOk = { kind: 'a2a', from: AGENT, to: 'coder', mode: 'ask', status: null, started_at: T(8), finished_at: T(8, 2) };

test('rangeBounds: today = local midnight of injected now; week = now-7d; month = now-31d; from/to ISO in output', () => {
  const t = rangeBounds('today', NOW);
  assert.equal(t.from.getTime(), new Date(2026, 5, 11, 0, 0, 0, 0).getTime());
  assert.equal(t.to.getTime(), NOW.getTime());

  const w = rangeBounds('week', NOW);
  assert.equal(w.from.getTime(), NOW.getTime() - 7 * DAY_MS);
  assert.equal(w.to.getTime(), NOW.getTime());

  const m = rangeBounds('month', NOW);
  assert.equal(m.from.getTime(), NOW.getTime() - 31 * DAY_MS);
  assert.equal(m.to.getTime(), NOW.getTime());

  assert.throws(() => rangeBounds('bogus', NOW));

  const out = build({});
  assert.equal(out.range, 'today');
  assert.equal(out.from, new Date(2026, 5, 11, 0, 0, 0, 0).toISOString());
  assert.equal(out.to, NOW.toISOString());
});

test('served counts delegate runs + a2a to===agent, in range only', () => {
  const records = [delegateDone, delegateRunning, delegateYesterday, a2aIn, a2aOutOk];
  // today: 2 delegates + 1 a2a served (yesterday's delegate excluded; a2a-out never served)
  assert.equal(build({ records }).kpis.served, 3);
  // week: yesterday's delegate now in range
  assert.equal(build({ records, range: 'week' }).kpis.served, 4);
});

test('a2aOut splits ok/fail: fail = status failed or error-ish truthy; null/ok/completed are ok', () => {
  const o = (id, status) => ({ kind: 'a2a', id, from: AGENT, to: 'coder', mode: 'do', status, started_at: T(7, id), finished_at: T(7, id + 1) });
  const records = [
    o(1, null), o(2, 'ok'), o(3, 'completed'),     // ok
    o(4, 'failed'), o(5, 'error'),                 // fail
    a2aIn                                          // inbound: not counted in a2aOut
  ];
  const { a2aOut } = build({ records }).kpis;
  assert.deepEqual(a2aOut, { total: 5, ok: 3, fail: 2 });
});

test('turns sums sessions[].turns; null + sessionsAvailable=false when sessions null (degrade)', () => {
  const sessions = [
    { id: 's1', turns: 3, firstPrompt: 'hello', originSource: 'cli' },
    { id: 's2', turns: 2, firstPrompt: 'world', originSource: 'dashboard' }
  ];
  const withS = build({ sessions });
  assert.equal(withS.kpis.turns, 5);
  assert.equal(withS.sessionsAvailable, true);

  const noS = build({ sessions: null });
  assert.equal(noS.kpis.turns, null);
  assert.equal(noS.sessionsAvailable, false);
});

test('toolCalls sums toolCounts; null + empty toolUsage when toolCounts null', () => {
  const withT = build({ toolCounts: { Read: 5, Bash: 2 } });
  assert.equal(withT.kpis.toolCalls, 7);

  const noT = build({ toolCounts: null });
  assert.equal(noT.kpis.toolCalls, null);
  assert.deepEqual(noT.toolUsage, []);
});

test('artifactsSaved counts savedAt in range only', () => {
  const artifacts = [
    { id: 'a1', title: 'Today art', savedAt: T(9, 30) },
    { id: 'a0', title: 'Old art', savedAt: Y(9) }
  ];
  assert.equal(build({ artifacts }).kpis.artifactsSaved, 1);
  assert.equal(build({ artifacts, range: 'week' }).kpis.artifactsSaved, 2);
  assert.equal(build({ artifacts, range: 'month' }).kpis.artifactsSaved, 2);
});

test('avgRunMs = mean over completed in-range runs only; null when none completed', () => {
  // delegateDone: 5 min = 300000 ms; a2aOutOk: 2 min = 120000 ms; running excluded.
  const records = [delegateDone, a2aOutOk, delegateRunning];
  assert.equal(build({ records }).kpis.avgRunMs, 210000);
  // only a running record → null
  assert.equal(build({ records: [delegateRunning] }).kpis.avgRunMs, null);
});

test('toolUsage sorted desc by count; toolUsageTruncated passed through', () => {
  const out = build({ toolCounts: { Bash: 2, Read: 9, Edit: 5 }, toolUsageTruncated: true });
  assert.deepEqual(out.toolUsage, [
    { name: 'Read', count: 9 },
    { name: 'Edit', count: 5 },
    { name: 'Bash', count: 2 }
  ]);
  assert.equal(out.toolUsageTruncated, true);
  assert.equal(build({}).toolUsageTruncated, false);
});

test('worklog merges all sources newest-first with channel/status/summary mapping', () => {
  const a2aOutFail = { kind: 'a2a', from: AGENT, to: 'coder', mode: 'do', status: 'failed', started_at: T(8), finished_at: T(8, 2) };
  const session = {
    id: 's1', turns: 3, firstPrompt: 'summarize the wiki', originSource: 'cli',
    startedAt: new Date(2026, 5, 11, 7).getTime(), endedAt: new Date(2026, 5, 11, 7, 30).getTime()
  };
  const artifact = { id: 'a1', title: 'Survey notes', savedAt: T(11, 30) };
  const out = build({
    records: [delegateDone, a2aOutFail, a2aIn, delegateRunning],
    sessions: [session],
    artifacts: [artifact]
  });
  assert.deepEqual(out.worklog, [
    { at: T(11, 30), end: null, channel: 'artifact-save', status: 'saved', summary: 'Survey notes' },
    { at: T(11), end: null, channel: 'delegate', status: 'running', summary: 'do' },
    { at: T(10), end: T(10, 1), channel: 'a2a-served', status: 'ok', summary: 'from coder (ask)' },
    { at: T(9), end: T(9, 5), channel: 'delegate', status: 'ok', summary: 'ask' },
    { at: T(8), end: T(8, 2), channel: 'a2a-out', status: 'fail', summary: 'to coder (do)' },
    { at: T(7), end: T(7, 30), channel: 'session', status: 'ok', summary: 'summarize the wiki' }
  ]);
});

test('worklog capped at 50 entries', () => {
  const records = [];
  for (let i = 0; i < 60; i++) {
    records.push({ id: `d${i}`, route: 'ask', started_at: T(1, Math.floor(i / 60 * 59)), finished_at: T(2) });
  }
  const out = build({ records });
  assert.equal(out.worklog.length, 50);
});
