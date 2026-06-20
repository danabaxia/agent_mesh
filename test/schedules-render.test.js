import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobResultLine, jobHasReport } from '../src/dashboard/public/schedules-render.js';

test('jobResultLine shows lastSummary + relative time', () => {
  const html = jobResultLine({ lastSummary: '3 flagged, 0 clean', lastStatus: 'ok', lastRunAt: 'x' }, () => '2m ago');
  assert.match(html, /3 flagged, 0 clean/);
  assert.match(html, /2m ago/);
});

test('jobResultLine escapes a hostile summary (no raw HTML)', () => {
  const html = jobResultLine({ lastSummary: '<img src=x onerror=alert(1)>', lastStatus: 'ok' });
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img/);
});

test('jobResultLine: fail status → fail class', () => {
  assert.match(jobResultLine({ lastSummary: 'boom', lastStatus: 'fail' }), /sched-result fail/);
});

test('jobResultLine: no lastSummary → empty string', () => {
  assert.equal(jobResultLine({}), '');
  assert.equal(jobResultLine(null), '');
});

test('jobHasReport: only report-producing jobs (extensible set)', () => {
  assert.equal(jobHasReport('merge-sweep'), true);
  assert.equal(jobHasReport('issue-sweep'), false);
  assert.equal(jobHasReport('automerge-sweep'), false);
});
