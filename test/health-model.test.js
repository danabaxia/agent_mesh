import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHealthReport, renderHealthReport } from '../src/dashboard/health-model.js';

const NOW = new Date('2026-06-21T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 86_400_000;

function iso(msAgo) { return new Date(NOW.getTime() - msAgo).toISOString(); }

test('empty input → nominal, valid empty report (degradation)', () => {
  const m = buildHealthReport({ now: NOW });
  assert.equal(m.overall, 'nominal');
  assert.deepEqual(m.agentVitals, []);
  assert.equal(typeof m.report.markdown, 'string');
  assert.match(m.report.markdown, /All systems nominal/);
  // backward-compat keys present for the old Graph-view panel
  assert.ok(m.summary && Array.isArray(m.findings) && Array.isArray(m.openEscalations));
});

test('recently-active agent → alive', () => {
  const m = buildHealthReport({
    now: NOW,
    agents: [{ name: 'orchestrator' }],
    perAgentRuns: { orchestrator: [{ started_at: iso(5 * 60_000), state: 'done', status: 'done' }] },
  });
  assert.equal(m.agentVitals[0].liveness, 'alive');
  assert.equal(m.organs.agents.status, 'ok');
  assert.equal(m.overall, 'nominal');
});

test('honesty rule: jobless agent silent for days → idle, never dead', () => {
  const m = buildHealthReport({
    now: NOW,
    agents: [{ name: 'docs', hasEnabledJobs: false }],
    perAgentRuns: { docs: [{ started_at: iso(5 * DAY), state: 'done', status: 'done' }] },
  });
  assert.equal(m.agentVitals[0].liveness, 'idle');
  assert.notEqual(m.agentVitals[0].liveness, 'dead');
  assert.equal(m.overall, 'nominal');   // idle is informational, not a problem
});

test('honesty rule: job-bearing agent silent past dead threshold → dead → critical', () => {
  const m = buildHealthReport({
    now: NOW,
    agents: [{ name: 'tester', hasEnabledJobs: true }],
    perAgentRuns: { tester: [{ started_at: iso(3 * DAY), state: 'done', status: 'done' }] },
  });
  assert.equal(m.agentVitals[0].liveness, 'dead');
  assert.equal(m.organs.agents.status, 'critical');
  assert.equal(m.overall, 'critical');
  assert.match(m.report.markdown, /CRITICAL/);
});

test('heartbeat finding maps to liveness: stuck → critical', () => {
  const m = buildHealthReport({
    now: NOW,
    agents: [{ name: 'builder', hasEnabledJobs: true }],
    perAgentRuns: { builder: [{ started_at: iso(10 * 60_000), state: 'done', status: 'done' }] },
    heartbeat: { summary: { ok: 0, failing: 0, overdue: 0, stuck: 1, escalated: 0 }, findings: [{ agent: 'builder', jobId: 'nightly', condition: 'stuck', severity: 'error', since: iso(HOUR) }], openEscalations: [] },
  });
  assert.equal(m.agentVitals[0].liveness, 'stuck');
  assert.equal(m.organs.jobs.status, 'critical');
  assert.equal(m.overall, 'critical');
});

test('overdue job-bearing agent, recently seen → overdue (warn), not dead', () => {
  const m = buildHealthReport({
    now: NOW,
    agents: [{ name: 'analyst', hasEnabledJobs: true }],
    perAgentRuns: { analyst: [{ started_at: iso(20 * 60_000), state: 'done', status: 'done' }] },
    heartbeat: { findings: [{ agent: 'analyst', jobId: 'daily', condition: 'overdue', severity: 'warn', since: iso(HOUR) }] },
  });
  assert.equal(m.agentVitals[0].liveness, 'overdue');
  assert.equal(m.organs.agents.status, 'warn');
});

test('stale daemon heart → jobs organ critical + report line', () => {
  const m = buildHealthReport({
    now: NOW,
    daemon: { lastTickAt: iso(2 * HOUR), logMtime: iso(2 * HOUR) },
  });
  assert.equal(m.organs.jobs.daemonAlive, false);
  assert.equal(m.organs.jobs.status, 'critical');
  assert.match(m.report.markdown, /daemon.*heart stopped/);
});

test('fresh daemon heart → daemonAlive true', () => {
  const m = buildHealthReport({ now: NOW, daemon: { logMtime: iso(60_000) } });
  assert.equal(m.organs.jobs.daemonAlive, true);
  assert.equal(m.organs.jobs.status, 'ok');
});

test('stale board task → board warn + stuck-handoff report line', () => {
  const m = buildHealthReport({
    now: NOW,
    boardStaleTasks: [{ id: 't1', from: 'a', to: 'b', state: 'assigned', last_at: iso(2 * DAY), age_ms: 2 * DAY }],
  });
  assert.equal(m.organs.board.status, 'warn');
  assert.equal(m.overall, 'warn');
  assert.match(m.report.markdown, /Stuck handoffs/);
});

test('cognition flags: oversize prompt + low headroom + no memory separation', () => {
  const m = buildHealthReport({
    now: NOW,
    agents: [{ name: 'orchestrator' }],
    perAgentRuns: { orchestrator: [{ started_at: iso(60_000), state: 'done', status: 'done' }] },
    cognition: { orchestrator: { promptBytes: 40_000, headroomPct: 10, memoryShortBytes: 500, memoryLongBytes: 0 } },
    thresholds: { agentStaleMs: HOUR, agentDeadMs: DAY, daemonStaleMs: 900_000, promptSoftBytes: 16_384, headroomWarnPct: 25, historyDays: 14 },
  });
  const flags = m.agentVitals[0].cognition.flags;
  assert.ok(flags.includes('prompt_oversize'));
  assert.ok(flags.includes('low_headroom'));
  assert.ok(flags.includes('no_memory_separation'));
  assert.equal(m.organs.cognition.status, 'warn');
  assert.match(m.report.markdown, /Cognition flags/);
});

test('separated memory + small prompt → no cognition flags', () => {
  const m = buildHealthReport({
    now: NOW,
    agents: [{ name: 'lib' }],
    perAgentRuns: { lib: [{ started_at: iso(60_000), state: 'done', status: 'done' }] },
    cognition: { lib: { promptBytes: 2_000, headroomPct: 80, memoryShortBytes: 500, memoryLongBytes: 800 } },
  });
  assert.deepEqual(m.agentVitals[0].cognition.flags, []);
  assert.equal(m.agentVitals[0].cognition.memorySeparation, true);
});

test('activity history: per-agent daily buckets aligned to window', () => {
  const m = buildHealthReport({
    now: NOW,
    agents: [{ name: 'x' }],
    perAgentRuns: { x: [
      { started_at: iso(0), state: 'done', status: 'done' },          // today
      { started_at: iso(DAY), state: 'done', status: 'done' },        // yesterday
      { started_at: iso(DAY), state: 'done', status: 'done' },        // yesterday
    ] },
    thresholds: { agentStaleMs: HOUR, agentDeadMs: DAY * 30, daemonStaleMs: 900_000, promptSoftBytes: 16_384, headroomWarnPct: 25, historyDays: 3 },
  });
  const { days, perAgent } = m.activityHistory;
  assert.equal(days.length, 3);
  assert.equal(days[days.length - 1], '2026-06-21');           // today is newest
  assert.equal(perAgent.x[2], 1);                               // today: 1 run
  assert.equal(perAgent.x[1], 2);                               // yesterday: 2 runs
  assert.equal(m.agentVitals[0].recentRuns, 3);
});

test('recentFailures counts non-ok finals', () => {
  const m = buildHealthReport({
    now: NOW,
    agents: [{ name: 'y' }],
    perAgentRuns: { y: [
      { started_at: iso(60_000), state: 'done', status: 'error' },
      { started_at: iso(120_000), state: 'done', status: 'done' },
    ] },
  });
  assert.equal(m.agentVitals[0].recentFailures, 1);
});

test('event feed: newest-first and capped', () => {
  const events = [];
  for (let i = 0; i < 150; i++) events.push({ ts: iso(i * 60_000), agent: 'x', type: 'run', level: 'info', summary: `e${i}` });
  const m = buildHealthReport({ now: NOW, activityEvents: events });
  assert.equal(m.activityHistory.events.length, 100);
  assert.equal(m.activityHistory.events[0].summary, 'e0');     // newest first
});

test('renderHealthReport tolerates a junk model', () => {
  assert.match(renderHealthReport(null), /no data/);
});

test('pipeline stalled drain → pipeline warn', () => {
  const m = buildHealthReport({ now: NOW, pipeline: { openIssues: 5, openPRs: 2, drainTrend: 'stalled' } });
  assert.equal(m.organs.pipeline.status, 'warn');
  assert.equal(m.overall, 'warn');
});

test('thresholds resolve from env bag when not passed explicitly', () => {
  const m = buildHealthReport({
    now: NOW,
    env: { AGENT_MESH_HEALTH_HISTORY_DAYS: '7' },
    agents: [{ name: 'x' }],
    perAgentRuns: { x: [] },
  });
  assert.equal(m.activityHistory.days.length, 7);
});
