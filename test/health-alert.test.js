import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planHealthAlerts, organAlertKey } from '../src/mesh-health/health-alert.js';

const NOW = new Date('2026-06-21T03:00:00Z');

// Minimal HealthReport shape the planner reads: organs[*].status + report.markdown.
function report(organStatuses = {}, markdown = '# Mesh Vital Signs\n\nbody\n') {
  const organs = {};
  for (const [k, status] of Object.entries(organStatuses)) organs[k] = { status };
  return { organs, report: { markdown } };
}

test('organ → critical files a needs-human open with the rendered report attached', () => {
  const r = report({ agents: 'critical', jobs: 'ok' }, '# Mesh Vital Signs — CRITICAL\n');
  const { opens, closes, state } = planHealthAlerts({ report: r, prev: null, now: NOW });
  assert.equal(opens.length, 1);
  assert.equal(closes.length, 0);
  assert.equal(opens[0].organ, 'agents');
  assert.equal(opens[0].key, organAlertKey('agents'));
  assert.match(opens[0].title, /Agents is CRITICAL/);
  assert.match(opens[0].body, /Mesh Vital Signs — CRITICAL/);     // renderHealthReport text attached
  assert.match(opens[0].body, new RegExp(`<!-- ${organAlertKey('agents')} -->`));
  assert.deepEqual(state.openAlerts, [organAlertKey('agents')]);
});

test('dedup: an already-open critical organ does not re-file', () => {
  const r = report({ agents: 'critical' });
  const prev = { openAlerts: [organAlertKey('agents')] };
  const { opens, closes, state } = planHealthAlerts({ report: r, prev, now: NOW });
  assert.equal(opens.length, 0);
  assert.equal(closes.length, 0);
  assert.deepEqual(state.openAlerts, [organAlertKey('agents')]);   // stays open
});

test('recovery: a previously-open organ now ok/idle gets closed with a comment', () => {
  const r = report({ agents: 'ok' });
  const prev = { openAlerts: [organAlertKey('agents')] };
  const { opens, closes, state } = planHealthAlerts({ report: r, prev, now: NOW });
  assert.equal(opens.length, 0);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].organ, 'agents');
  assert.match(closes[0].body, /recovered/);
  assert.match(closes[0].body, /now `ok`/);
  assert.deepEqual(state.openAlerts, []);
});

test('re-open: after recovery, a fresh critical files again', () => {
  const r = report({ agents: 'critical' });
  const prev = { openAlerts: [] };   // recovered last sweep → not open
  const { opens } = planHealthAlerts({ report: r, prev, now: NOW });
  assert.equal(opens.length, 1);
  assert.equal(opens[0].organ, 'agents');
});

test('warn is not critical: a warn organ neither opens nor closes', () => {
  const r = report({ agents: 'warn', cognition: 'warn' });
  const { opens, closes } = planHealthAlerts({ report: r, prev: null, now: NOW });
  assert.equal(opens.length, 0);
  assert.equal(closes.length, 0);
});

test('multiple critical organs each file their own alert; one recovers independently', () => {
  const r = report({ agents: 'critical', jobs: 'critical', board: 'ok' });
  const prev = { openAlerts: [organAlertKey('board')] };   // board was critical, now recovered
  const { opens, closes, state } = planHealthAlerts({ report: r, prev, now: NOW });
  assert.deepEqual(opens.map((o) => o.organ).sort(), ['agents', 'jobs']);
  assert.deepEqual(closes.map((c) => c.organ), ['board']);
  assert.deepEqual(state.openAlerts.sort(), [organAlertKey('agents'), organAlertKey('jobs')].sort());
});

test('empty/nominal report is a no-op', () => {
  const { opens, closes, state } = planHealthAlerts({ report: report({ agents: 'ok', jobs: 'ok' }), prev: null, now: NOW });
  assert.equal(opens.length, 0);
  assert.equal(closes.length, 0);
  assert.deepEqual(state.openAlerts, []);
  assert.equal(state.generatedAt, NOW.toISOString());
});
