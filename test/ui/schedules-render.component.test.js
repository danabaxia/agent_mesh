// test/ui/schedules-render.component.test.js — COMPONENT tier (jsdom + axe).
// Mounts the REAL Schedules-view string builder (src/dashboard/public/
// schedules-render.js) into a jsdom document and asserts structure via
// role/text + data-testid, then runs axe for the categories meaningful under
// jsdom (name/role/value, ARIA, structure — NOT contrast/focus, see _jsdom-axe.js).
//
// Deterministic: the only time-dependent input (relative timestamps) is injected
// via the `rel` callback, so no Date / clock is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobResultLine } from '../../src/dashboard/public/schedules-render.js';
import { mount, inMain, runAxe, assertNoAxeViolations } from './_jsdom-axe.js';

// The shipped builder emits a bare <div> with no test hook; for the component
// test we mount its real output inside a labelled list-item context (mirroring
// how board2 nests it) and tag the row so role/label/testid assertions are stable.
function scheduleRow(job, rel) {
  const line = jobResultLine(job, rel); // REAL render code under test
  return inMain(
    `<ul aria-label="cron jobs"><li data-testid="sched-row"><h3>${job.id}</h3>${line}</li></ul>`,
    'Schedules',
  );
}

test('component: a cron job row renders its summary + injected relative time', async () => {
  const rel = (iso) => (iso === '2026-06-20T00:00:00Z' ? '2m ago' : '');
  const job = { id: 'merge-sweep', lastSummary: '3 flagged, 12 clean', lastStatus: 'ok', lastRunAt: '2026-06-20T00:00:00Z' };
  const { document, byTestId, text } = mount(scheduleRow(job, rel));

  const row = byTestId('sched-row');
  assert.ok(row, 'sched-row mounted');
  assert.match(text(), /3 flagged, 12 clean/, 'summary text present');
  assert.match(text(), /2m ago/, 'injected relative time rendered (deterministic)');

  // structure: the result line carries the non-fail class
  const result = document.querySelector('.sched-result');
  assert.ok(result && !result.classList.contains('fail'), 'ok status → no fail class');

  const results = await runAxe(document);
  assertNoAxeViolations(results, assert);
});

test('component: a FAILED cron job row gets the fail class and stays a11y-clean', async () => {
  const job = { id: 'tester-suite-run', lastSummary: 'suite red: 2 files', lastStatus: 'fail', lastRunAt: '2026-06-20T01:00:00Z' };
  const { document, text } = mount(scheduleRow(job, () => '5m ago'));

  assert.match(text(), /suite red: 2 files/);
  const result = document.querySelector('.sched-result.fail');
  assert.ok(result, 'fail status → .sched-result.fail');

  const results = await runAxe(document);
  assertNoAxeViolations(results, assert);
});

test('component: a hostile summary is HTML-escaped (no injected nodes in the DOM)', async () => {
  const job = { id: 'evil', lastSummary: '<img src=x onerror=alert(1)>', lastStatus: 'ok' };
  const { document } = mount(scheduleRow(job, () => ''));

  // The escaping must hold at the DOM level: no real <img> element materialized.
  assert.equal(document.querySelectorAll('img').length, 0, 'escaped summary did not create an <img> node');
  assert.match(document.querySelector('.sched-result').textContent, /<img src=x/, 'literal text preserved, not parsed as HTML');

  const results = await runAxe(document);
  assertNoAxeViolations(results, assert);
});
