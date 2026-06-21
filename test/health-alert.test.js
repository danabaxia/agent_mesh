// test/health-alert.test.js — hermetic tests for the health-alert pure module.
// Zero I/O: inject built health reports, assert on toOpen/toClose/nextState.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alertKeysFor,
  alertTitle,
  alertBody,
  recoveryComment,
  computeAlertActions,
} from '../src/mesh-health/health-alert.js';

// Minimal health report factories.
function nominalReport(overrides = {}) {
  return {
    overall: 'nominal',
    generatedAt: '2026-06-21T12:00:00.000Z',
    organs: {
      agents:   { status: 'ok' },
      jobs:     { status: 'ok' },
      board:    { status: 'ok' },
      pipeline: { status: 'ok' },
      cognition:{ status: 'ok' },
    },
    report: { markdown: '# Mesh Vital Signs — 🟢 All systems nominal\n' },
    ...overrides,
  };
}

function criticalReport(organOverrides = {}) {
  return nominalReport({
    overall: 'critical',
    organs: {
      agents:   { status: 'critical' },
      jobs:     { status: 'ok' },
      board:    { status: 'ok' },
      pipeline: { status: 'ok' },
      cognition:{ status: 'ok' },
      ...organOverrides,
    },
    report: { markdown: '# Mesh Vital Signs — 🔴 CRITICAL — dead mechanism(s) detected\n' },
  });
}

// ── alertKeysFor ──────────────────────────────────────────────────────────────

test('alertKeysFor: nominal report → no keys', () => {
  const keys = alertKeysFor(nominalReport());
  assert.equal(keys.size, 0);
});

test('alertKeysFor: null/missing report → no keys (never throws)', () => {
  assert.equal(alertKeysFor(null).size, 0);
  assert.equal(alertKeysFor(undefined).size, 0);
  assert.equal(alertKeysFor({}).size, 0);
});

test('alertKeysFor: critical overall + critical agents organ → two keys', () => {
  const keys = alertKeysFor(criticalReport());
  assert.ok(keys.has('overall:critical'), 'overall:critical missing');
  assert.ok(keys.has('organ:agents:critical'), 'organ:agents:critical missing');
  assert.equal(keys.size, 2);
});

test('alertKeysFor: only jobs organ critical (not overall) → organ key only', () => {
  const report = nominalReport({
    organs: {
      agents:   { status: 'ok' },
      jobs:     { status: 'critical' },
      board:    { status: 'ok' },
      pipeline: { status: 'ok' },
      cognition:{ status: 'ok' },
    },
  });
  const keys = alertKeysFor(report);
  assert.ok(keys.has('organ:jobs:critical'));
  assert.ok(!keys.has('overall:critical'));
  assert.equal(keys.size, 1);
});

test('alertKeysFor: warn organs are NOT alerted (only critical)', () => {
  const report = nominalReport({
    organs: {
      agents:   { status: 'warn' },
      jobs:     { status: 'ok' },
      board:    { status: 'ok' },
      pipeline: { status: 'ok' },
      cognition:{ status: 'ok' },
    },
  });
  const keys = alertKeysFor(report);
  assert.equal(keys.size, 0);
});

// ── alertTitle / alertBody / recoveryComment ───────────────────────────────────

test('alertTitle: overall:critical has a descriptive title', () => {
  const t = alertTitle('overall:critical');
  assert.match(t, /CRITICAL/i);
  assert.match(t, /mesh-health/i);
});

test('alertTitle: organ key uses the organ label', () => {
  assert.match(alertTitle('organ:agents:critical'), /Agents/);
  assert.match(alertTitle('organ:jobs:critical'), /Jobs/);
  assert.match(alertTitle('organ:board:critical'), /Task Board/);
});

test('alertBody: contains the key, timestamp, and rendered report', () => {
  const report = criticalReport();
  const body = alertBody('overall:critical', report);
  assert.match(body, /overall:critical/);
  assert.match(body, /2026-06-21/);
  assert.match(body, /CRITICAL/);
  // contains the unique dedup comment so gh search can find it
  assert.match(body, /mesh-health-alert-key: overall:critical/);
});

test('alertBody: works with null report (degrades, never throws)', () => {
  const body = alertBody('overall:critical', null);
  assert.match(body, /overall:critical/);
  assert.ok(typeof body === 'string');
});

test('recoveryComment: includes key and resolution', () => {
  const comment = recoveryComment('overall:critical', nominalReport());
  assert.match(comment, /overall:critical/);
  assert.match(comment, /recovered/i);
  assert.match(comment, /nominal/);
});

// ── computeAlertActions ────────────────────────────────────────────────────────

test('computeAlertActions: nominal report + empty state → no actions', () => {
  const { toOpen, toClose, nextState } = computeAlertActions(nominalReport(), {});
  assert.deepEqual(toOpen, []);
  assert.deepEqual(toClose, []);
  assert.deepEqual(nextState.open, {});
});

test('computeAlertActions: first critical → opens new issues', () => {
  const report = criticalReport();
  const { toOpen, toClose, nextState } = computeAlertActions(report, {});
  assert.ok(toOpen.length >= 1, 'should open at least one issue');
  assert.deepEqual(toClose, []);
  // nextState marks them pending (null) until the shell fills in the real number
  for (const o of toOpen) {
    assert.equal(nextState.open[o.key], null);
  }
  assert.ok('overall:critical' in nextState.open || 'organ:agents:critical' in nextState.open);
});

test('computeAlertActions: dedup — already-open key is NOT re-opened', () => {
  const report = criticalReport();
  // Simulate prior state where overall:critical is already open as issue #42.
  const prior = { open: { 'overall:critical': 42, 'organ:agents:critical': 43 } };
  const { toOpen, toClose, nextState } = computeAlertActions(report, prior);
  // No new opens — both keys are already tracked.
  assert.deepEqual(toOpen, []);
  assert.deepEqual(toClose, []);
  assert.equal(nextState.open['overall:critical'], 42);
  assert.equal(nextState.open['organ:agents:critical'], 43);
});

test('computeAlertActions: recovery — open issue is closed when organ recovers', () => {
  const recovered = nominalReport(); // no longer critical
  const prior = { open: { 'overall:critical': 42, 'organ:agents:critical': 43 } };
  const { toOpen, toClose, nextState } = computeAlertActions(recovered, prior);
  assert.deepEqual(toOpen, []);
  assert.equal(toClose.length, 2);
  const closedKeys = toClose.map((c) => c.key).sort();
  assert.deepEqual(closedKeys, ['organ:agents:critical', 'overall:critical']);
  // Issue numbers match prior state
  const byKey = Object.fromEntries(toClose.map((c) => [c.key, c.number]));
  assert.equal(byKey['overall:critical'], 42);
  assert.equal(byKey['organ:agents:critical'], 43);
  // nextState no longer tracks those keys
  assert.ok(!('overall:critical' in nextState.open));
  assert.ok(!('organ:agents:critical' in nextState.open));
});

test('computeAlertActions: partial recovery — one organ recovers, another stays critical', () => {
  // agents recovered but jobs newly critical
  const report = nominalReport({
    overall: 'critical',
    organs: {
      agents:   { status: 'ok' },
      jobs:     { status: 'critical' },
      board:    { status: 'ok' },
      pipeline: { status: 'ok' },
      cognition:{ status: 'ok' },
    },
  });
  const prior = { open: { 'overall:critical': 10, 'organ:agents:critical': 11 } };
  const { toOpen, toClose, nextState } = computeAlertActions(report, prior);
  // agents closed, jobs newly opened
  assert.equal(toClose.length, 1);
  assert.equal(toClose[0].key, 'organ:agents:critical');
  assert.equal(toClose[0].number, 11);
  // overall:critical stays open; organ:jobs:critical newly opened
  assert.equal(toOpen.length, 1);
  assert.equal(toOpen[0].key, 'organ:jobs:critical');
  assert.equal(nextState.open['overall:critical'], 10);
  assert.ok(!('organ:agents:critical' in nextState.open));
  assert.equal(nextState.open['organ:jobs:critical'], null);
});

test('computeAlertActions: empty/corrupt priorState is tolerated', () => {
  for (const bad of [null, undefined, {}, { open: null }, { open: 'garbage' }]) {
    const { toOpen, toClose } = computeAlertActions(nominalReport(), bad);
    assert.deepEqual(toOpen, []);
    assert.deepEqual(toClose, []);
  }
});

test('computeAlertActions: null report → no actions (never throws)', () => {
  const { toOpen, toClose, nextState } = computeAlertActions(null, {});
  assert.deepEqual(toOpen, []);
  assert.deepEqual(toClose, []);
  assert.deepEqual(nextState.open, {});
});

test('computeAlertActions: toOpen entries have title and body', () => {
  const { toOpen } = computeAlertActions(criticalReport(), {});
  for (const o of toOpen) {
    assert.ok(typeof o.key === 'string' && o.key.length > 0, 'key missing');
    assert.ok(typeof o.title === 'string' && o.title.length > 0, 'title missing');
    assert.ok(typeof o.body === 'string' && o.body.length > 0, 'body missing');
  }
});

test('computeAlertActions: toClose entries have number and comment', () => {
  const prior = { open: { 'overall:critical': 99 } };
  const { toClose } = computeAlertActions(nominalReport(), prior);
  assert.equal(toClose.length, 1);
  assert.equal(toClose[0].number, 99);
  assert.ok(typeof toClose[0].comment === 'string' && toClose[0].comment.length > 0);
});
