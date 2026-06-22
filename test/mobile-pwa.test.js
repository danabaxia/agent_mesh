// Zero-dep unit tests for the mobile PWA pure helpers and the Tailscale serve
// helper. No DOM, no real tailscale — the browser glue is guarded by `typeof
// document`, so importing app.js in node only loads the exported pure functions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, toggleLabel, summarizeStatus, summarizeActivity, relTime, summarizeAlerts, summarizeTaskColumns, pickPoll } from '../src/dashboard/public/mobile/app.js';
import { buildTaskBoard } from '../src/dashboard/public/tasks-model.js';
import { resolveMagicHost, bootstrapUrl, serveArgs, run as serveRun } from '../scripts/mesh-mobile-serve.mjs';

// ---- app.js pure helpers ----

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<script>"x"&\'y\''), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
});

test('toggleLabel toggles within the allowlist, preserving order, ignoring unknowns', () => {
  assert.deepEqual(toggleLabel([], 'idea'), ['idea']);
  assert.deepEqual(toggleLabel(['idea'], 'idea'), []);
  assert.deepEqual(toggleLabel(['route:a2a'], 'approved'), ['approved', 'route:a2a']);
  assert.deepEqual(toggleLabel(['idea'], 'evil'), ['idea']);   // unknown ignored
});

test('summarizeStatus tolerates missing data and classifies health', () => {
  const cards = summarizeStatus({ health: { status: 'ok', findings: [] }, daily: { openPrs: 3 } });
  const health = cards.find((c) => c.title === 'Health');
  assert.ok(health.rows.some((r) => r.value === 'ok' && r.cls === 'ok'));
  const daily = cards.find((c) => c.title === 'Daily report');
  assert.ok(daily.rows.some((r) => r.label === 'Open PRs' && r.value === '3'));

  const empty = summarizeStatus({});
  assert.equal(empty.length, 1);
  assert.equal(empty[0].rows[0].value, '—');

  const bad = summarizeStatus({ health: { status: 'failing' } });
  assert.ok(bad[0].rows[0].cls === 'bad');
});

test('summarizeStatus renders the real daily-report shape (no [object Object])', () => {
  const cards = summarizeStatus({ daily: {
    prs: { merged: [{}, {}], openNow: 2 },
    issues: { openNow: 17 },
    tokens: { total: { input: 20577, output: 22855, costUsd: 2.0809 } }
  }});
  const daily = cards.find((c) => c.title === 'Daily report');
  const flat = JSON.stringify(daily.rows);
  assert.ok(!flat.includes('[object Object]'), 'never stringifies an object');
  assert.ok(daily.rows.some((r) => r.label === 'PRs merged' && r.value === '2'));
  assert.ok(daily.rows.some((r) => r.label === 'PRs open' && r.value === '2'));
  assert.ok(daily.rows.some((r) => r.label === 'Issues open' && r.value === '17'));
  assert.ok(daily.rows.some((r) => r.label === 'Cost (24h)' && r.value === '$2.08'));
  assert.ok(daily.rows.some((r) => r.label === 'Tokens in+out' && r.value === (20577 + 22855).toLocaleString()));
});

test('relTime renders compact relative ages', () => {
  const now = Date.parse('2026-06-21T12:00:00Z');
  assert.equal(relTime('2026-06-21T11:59:30Z', now), '30s');
  assert.equal(relTime('2026-06-21T11:55:00Z', now), '5m');
  assert.equal(relTime('2026-06-21T09:00:00Z', now), '3h');
  assert.equal(relTime('2026-06-19T12:00:00Z', now), '2d');
  assert.equal(relTime('not-a-date', now), '');
});

test('summarizeActivity renders recent events newest-first with level color + relative time', () => {
  const now = Date.parse('2026-06-21T12:00:00Z');
  const card = summarizeActivity([
    { ts: '2026-06-21T11:58:00Z', type: 'pr_opened', summary: 'PR #9 opened', agent: 'coder', level: 'info' },
    { ts: '2026-06-21T11:30:00Z', type: 'ci_failed', summary: 'CI red', agent: 'tester', level: 'error' }
  ], { now });
  assert.equal(card.title, 'Recent activity');
  assert.equal(card.rows[0].label, 'PR #9 opened · coder');
  assert.equal(card.rows[0].value, '2m');
  assert.equal(card.rows[1].cls, 'bad');     // error → bad
  assert.equal(card.rows[1].value, '30m');
});

test('summarizeActivity handles empty/missing feed', () => {
  assert.equal(summarizeActivity([]).rows[0].value, '—');
  assert.equal(summarizeActivity(undefined).rows[0].cls, 'muted');
});

test('summarizeActivity caps to max rows', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ts: '2026-06-21T11:00:00Z', summary: `e${i}` }));
  assert.equal(summarizeActivity(many, { max: 12 }).rows.length, 12);
});

test('summarizeAlerts ranks by severity with colour; empty → placeholder', () => {
  const card = summarizeAlerts([
    { id: 'a', severity: 'warn', summary: 'stale task t1' },
    { id: 'b', severity: 'critical', summary: 'conformance fail' }
  ]);
  assert.equal(card.title, 'Alerts');
  assert.equal(card.rows[0].cls, 'bad');                      // critical first
  assert.ok(card.rows[0].label.includes('conformance fail'));
  assert.equal(summarizeAlerts([]).rows[0].value, '—');
  assert.equal(summarizeAlerts(undefined).rows[0].cls, 'muted');
});

test('summarizeTaskColumns → one card per non-empty state with ticket rows', () => {
  const board = buildTaskBoard([
    { id: 'a-b-1', from: 'a', to: 'b', title: 'Run suite', state: 'assigned', history: [] },
    { id: 'a-b-2', from: 'a', to: 'b', title: 'Done thing', state: 'done', result: 'ok', history: [] },
  ]);
  const cards = summarizeTaskColumns(board);
  const assigned = cards.find((c) => c.title.startsWith('Assigned'));
  assert.ok(assigned.rows.some((r) => r.label.includes('Run suite')));
  const done = cards.find((c) => c.title.startsWith('Done'));
  assert.ok(done && done.rows[0].value.includes('✓'));
  // empty input → a single "no tasks" card
  assert.equal(summarizeTaskColumns(buildTaskBoard([]))[0].rows[0].value, '—');
});

test('pickPoll returns the active data tab to refresh, never chat, never when hidden', () => {
  assert.equal(pickPoll('status', { hidden: false }), 'status');
  assert.equal(pickPoll('alerts', { hidden: false }), 'alerts');
  assert.equal(pickPoll('tasks', { hidden: false }), 'tasks');
  assert.equal(pickPoll('chat', { hidden: false }), null);   // chat is never auto-polled
  assert.equal(pickPoll('tasks', { hidden: true }), null);    // paused when backgrounded
});

// ---- mesh-mobile-serve helpers ----

test('resolveMagicHost strips the trailing dot', () => {
  assert.equal(resolveMagicHost({ Self: { DNSName: 'mac.tailnet.ts.net.' } }), 'mac.tailnet.ts.net');
  assert.equal(resolveMagicHost({ Self: {} }), null);
});

test('bootstrapUrl + serveArgs are well formed (HTTP-over-tailnet, no TLS-cert dependency)', () => {
  assert.equal(bootstrapUrl('mac.ts.net', 'abc'), 'http://mac.ts.net/m?t=abc');
  // bare local port (NOT 127.0.0.1:port, which the CLI rejects); --http avoids the
  // tailnet "HTTPS Certificates" feature being required (OFF by default).
  assert.deepEqual(serveArgs(7077), ['serve', '--bg', '--http=80', '7077']);
});

test('serveRun fails cleanly when tailscale is absent (no token leak, non-ok)', () => {
  const logs = [];
  const res = serveRun({
    meshRoot: '/tmp/x', printOnly: true,
    run: () => { throw new Error('command not found'); },
    loadToken: () => 'secret',
    log: (m) => logs.push(m), err: () => {}
  });
  assert.equal(res.ok, false);
  assert.equal(res.message, 'tailscale-missing');
  assert.ok(!logs.join('\n').includes('secret'), 'token never printed on failure');
});

test('serveRun prints the bootstrap link on success (print-only, stubbed tailscale)', () => {
  const logs = [];
  const exec = (cmd, args) => {
    if (args[0] === 'version') return 'tailscale 1.0';
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tailnet.ts.net.' } });
    return '';
  };
  const res = serveRun({
    meshRoot: '/tmp/x', printOnly: true, run: exec,
    loadToken: () => 'tok123', log: (m) => logs.push(m), err: () => {}
  });
  assert.equal(res.ok, true);
  assert.equal(res.url, 'http://mac.tailnet.ts.net/m?t=tok123');
  assert.ok(logs.join('\n').includes('http://mac.tailnet.ts.net/m?t=tok123'));
});

test('serveRun refuses when not connected', () => {
  const exec = (cmd, args) => {
    if (args[0] === 'version') return 'ok';
    if (args[0] === 'status') return JSON.stringify({ BackendState: 'Stopped', Self: { DNSName: 'x.ts.net.' } });
    return '';
  };
  const res = serveRun({ meshRoot: '/tmp/x', printOnly: true, run: exec, loadToken: () => 't', log: () => {}, err: () => {} });
  assert.equal(res.ok, false);
  assert.equal(res.message, 'tailscale-down');
});
