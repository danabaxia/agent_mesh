// test/daily-report-schedule.test.js — the daily-report refresh is scheduled as
// an orchestrator builtin so the dashboard's /api/daily (incl. issues.openNow)
// stays current instead of going stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = (p) => readFileSync(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8');

test('daemon registers the daily-report-refresh builtin', () => {
  const daemon = repo('scripts/dev-society-daemon.mjs');
  assert.match(daemon, /'daily-report-refresh'/, 'registers the daily-report-refresh builtin');
  assert.match(daemon, /daily-report\.mjs/, 'the builtin runs the daily-report script');
});

test('orchestrator schedules a daily daily-report-refresh job', () => {
  const sched = JSON.parse(repo('dev-mesh/orchestrator/.agent/schedule.json'));
  const job = (sched.jobs || []).find((j) => j.builtin === 'daily-report-refresh');
  assert.ok(job, 'daily-report-refresh job present');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.cadence.kind, 'daily');
  // the existing gh-activity-poll job is still there (additive)
  assert.ok((sched.jobs || []).some((j) => j.builtin === 'gh-activity-poll'), 'gh-activity-poll still present');
});
