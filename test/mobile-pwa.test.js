// Zero-dep unit tests for the mobile PWA pure helpers and the Tailscale serve
// helper. No DOM, no real tailscale — the browser glue is guarded by `typeof
// document`, so importing app.js in node only loads the exported pure functions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, toggleLabel, summarizeStatus } from '../src/dashboard/public/mobile/app.js';
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

// ---- mesh-mobile-serve helpers ----

test('resolveMagicHost strips the trailing dot', () => {
  assert.equal(resolveMagicHost({ Self: { DNSName: 'mac.tailnet.ts.net.' } }), 'mac.tailnet.ts.net');
  assert.equal(resolveMagicHost({ Self: {} }), null);
});

test('bootstrapUrl + serveArgs are well formed', () => {
  assert.equal(bootstrapUrl('mac.ts.net', 'abc'), 'https://mac.ts.net/m?t=abc');
  assert.deepEqual(serveArgs(7077), ['serve', '--bg', '--https=443', '127.0.0.1:7077']);
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
  assert.equal(res.url, 'https://mac.tailnet.ts.net/m?t=tok123');
  assert.ok(logs.join('\n').includes('https://mac.tailnet.ts.net/m?t=tok123'));
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
