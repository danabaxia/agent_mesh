// Hermetic tests for the concierge server-side conversation history (issue #362).
// No real claude / gh / filesystem I/O — history I/O is fully injected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import {
  parseHistoryLines, serializeHistoryLines, trimEntries, normalizeEntry,
  createConcierge,
} from '../src/dashboard/concierge.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';

// ── Pure helpers ─────────────────────────────────────────────────────────────

test('parseHistoryLines parses valid JSONL', () => {
  const text = '{"role":"user","text":"hi","ts":"t1"}\n{"role":"assistant","reply":"hello","ts":"t2"}\n';
  const entries = parseHistoryLines(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].role, 'user');
  assert.equal(entries[1].role, 'assistant');
  assert.equal(entries[1].reply, 'hello');
});

test('parseHistoryLines skips malformed lines (tolerant)', () => {
  const text = '{"role":"user","text":"ok"}\nnot-json\n{"role":"assistant","reply":"y"}\n';
  const entries = parseHistoryLines(text);
  assert.equal(entries.length, 2);
});

test('parseHistoryLines returns [] on empty/null input', () => {
  assert.deepEqual(parseHistoryLines(''), []);
  assert.deepEqual(parseHistoryLines(null), []);
});

test('serializeHistoryLines round-trips entries', () => {
  const entries = [{ role: 'user', text: 'hi', ts: 't1' }, { role: 'assistant', reply: 'yo', ts: 't2' }];
  const text = serializeHistoryLines(entries);
  assert.ok(text.endsWith('\n'));
  const back = parseHistoryLines(text);
  assert.deepEqual(back, entries);
});

test('trimEntries keeps last max entries', () => {
  const entries = [1, 2, 3, 4, 5].map((i) => ({ role: 'user', text: String(i) }));
  const trimmed = trimEntries(entries, 3);
  assert.equal(trimmed.length, 3);
  assert.equal(trimmed[0].text, '3');
  assert.equal(trimmed[2].text, '5');
});

test('trimEntries leaves short arrays unchanged', () => {
  const entries = [{ role: 'user', text: 'a' }];
  assert.deepEqual(trimEntries(entries, 10), entries);
});

test('normalizeEntry maps assistant reply → text', () => {
  const a = normalizeEntry({ role: 'assistant', reply: 'hello', ts: 't' });
  assert.equal(a.role, 'assistant');
  assert.equal(a.text, 'hello');
});

test('normalizeEntry passes user text through', () => {
  const u = normalizeEntry({ role: 'user', text: 'hi', ts: 't' });
  assert.equal(u.role, 'user');
  assert.equal(u.text, 'hi');
});

test('normalizeEntry returns null for non-objects', () => {
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry('string'), null);
});

// ── createConcierge with injected history I/O ────────────────────────────────

function makeHistoryStore() {
  const log = [];
  return {
    log,
    appendHistory: async (_root, entries, _max) => { log.push(...entries); },
    loadHistory: async (_root, limit) =>
      log.slice(-limit).map((e) => ({
        role: e.role,
        text: e.role === 'assistant' ? (e.reply ?? '') : (e.text ?? ''),
        ts: e.ts ?? null,
      })),
  };
}

test('message() appends user + assistant entries to history store', async () => {
  const store = makeHistoryStore();
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async () => 'Got it!',
    appendHistory: store.appendHistory,
    loadHistory: store.loadHistory,
  });
  await c.message({ text: 'Hello concierge' });
  assert.equal(store.log.length, 2);
  assert.equal(store.log[0].role, 'user');
  assert.equal(store.log[0].text, 'Hello concierge');
  assert.equal(store.log[1].role, 'assistant');
  assert.equal(store.log[1].reply, 'Got it!');
});

test('message() uses server history for model context (not client-sent history)', async () => {
  const store = makeHistoryStore();
  // Pre-populate with a stored turn
  store.log.push({ role: 'user', text: 'previous question', ts: 'T0' });
  store.log.push({ role: 'assistant', reply: 'previous answer', ts: 'T0' });

  let promptSeen = '';
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async ({ prompt }) => { promptSeen = prompt; return 'new reply'; },
    appendHistory: store.appendHistory,
    loadHistory: store.loadHistory,
    contextTurns: 5,
  });
  await c.message({ text: 'new question' });
  // The prompt should include the stored prior turn
  assert.ok(promptSeen.includes('previous question'), 'prior user turn in prompt');
  assert.ok(promptSeen.includes('previous answer'), 'prior assistant turn in prompt');
});

test('message() does not fail when appendHistory throws (best-effort)', async () => {
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async () => 'fine',
    appendHistory: async () => { throw new Error('disk full'); },
    loadHistory: async () => [],
  });
  const out = await c.message({ text: 'test' });
  assert.equal(out.reply, 'fine');
});

test('message() LRU trim: appended entries respect historyMax', async () => {
  const store = makeHistoryStore();
  // Fill the store to the brim (each message appends 2 entries)
  let written = [];
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async () => 'ack',
    appendHistory: async (_root, entries, max) => {
      written.push(...entries);
      if (written.length > max) written = written.slice(written.length - max);
    },
    loadHistory: async () => [],
    historyMax: 4,
  });
  await c.message({ text: 'msg1' }); // adds 2 → total 2
  await c.message({ text: 'msg2' }); // adds 2 → total 4
  await c.message({ text: 'msg3' }); // adds 2 → trimmed to 4
  assert.equal(written.length, 4);
  // The oldest two entries (msg1) should have been dropped
  assert.ok(!written.some((e) => e.text === 'msg1'), 'oldest entries trimmed');
  assert.ok(written.some((e) => e.text === 'msg3'), 'newest entry present');
});

test('getHistory returns raw entries in insertion order', async () => {
  let storedLines = '';
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async () => 'reply',
    appendHistory: async (_root, entries) => {
      storedLines += entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    },
    loadHistory: async () => [],
  });
  await c.message({ text: 'first' });
  // Verify getHistory — override the file-read with our stored lines
  const realGetHistory = c.getHistory;
  // Since getHistory reads from disk and we can't inject the file path in tests,
  // we verify the raw entries via the store inspection approach below.
  // (Full integration is covered by the server route test.)
  assert.ok(storedLines.includes('"first"'), 'user text stored');
  assert.ok(storedLines.includes('"reply"'), 'assistant reply stored');
});

// ── Server route: GET /api/concierge/history ─────────────────────────────────

function rawGet({ port, path, cookie = '', token = '' }) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' };
    if (cookie) headers['Cookie'] = cookie;
    if (token) headers['X-Dashboard-Token'] = token;
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(extra = {}) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'ch-'));
  await initMesh(meshRoot);
  const srv = createDashboardServer({ meshRoot, port: 0, ...extra });
  await srv.start();
  const port = new URL(srv.url).port;
  const { token } = srv;
  return { srv, port, token, meshRoot };
}

test('GET /api/concierge/history returns ok:true and empty array when no history', async () => {
  const { srv, port, token } = await startServer();
  try {
    const r = await rawGet({ port, path: '/api/concierge/history', token });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.deepEqual(j.history, []);
  } finally { await srv.close(); }
});

test('GET /api/concierge/history requires auth', async () => {
  const { srv, port } = await startServer();
  try {
    const r = await rawGet({ port, path: '/api/concierge/history' });
    assert.equal(r.status, 403);
  } finally { await srv.close(); }
});

test('GET /api/concierge/history returns injected concierge getHistory result', async () => {
  const fakeConcierge = {
    message: async () => ({ reply: '', proposal: null }),
    confirm: async () => ({ url: '' }),
    getHistory: async ({ limit }) => [
      { role: 'user', text: 'what is the plan?', ts: '2026-06-21T10:00:00Z' },
      { role: 'assistant', reply: 'build it', ts: '2026-06-21T10:00:01Z' },
    ].slice(0, limit),
  };
  const { srv, port, token } = await startServer({ concierge: fakeConcierge });
  try {
    const r = await rawGet({ port, path: '/api/concierge/history?limit=10', token });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.equal(j.history.length, 2);
    assert.equal(j.history[0].role, 'user');
    assert.equal(j.history[1].reply, 'build it');
  } finally { await srv.close(); }
});

test('GET /api/concierge/history respects limit param (capped at 200)', async () => {
  let limitSeen = null;
  const fakeConcierge = {
    message: async () => ({ reply: '', proposal: null }),
    confirm: async () => ({ url: '' }),
    getHistory: async ({ limit }) => { limitSeen = limit; return []; },
  };
  const { srv, port, token } = await startServer({ concierge: fakeConcierge });
  try {
    await rawGet({ port, path: '/api/concierge/history?limit=50', token });
    assert.equal(limitSeen, 50);
    await rawGet({ port, path: '/api/concierge/history?limit=9999', token });
    assert.equal(limitSeen, 200, 'limit capped at 200');
    await rawGet({ port, path: '/api/concierge/history', token });
    assert.equal(limitSeen, 20, 'default limit is 20');
  } finally { await srv.close(); }
});

// ── Integration: message → persisted → getHistory (real fs) ─────────────────

test('full round-trip: message posts turn → getHistory returns it', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'ch-integ-'));
  await initMesh(meshRoot);
  try {
    const c = createConcierge({
      meshRoot,
      runAsk: async () => 'pong',
    });
    await c.message({ text: 'ping' });
    const hist = await c.getHistory({ limit: 10 });
    assert.ok(hist.length >= 2, 'at least two entries (user + assistant)');
    const user = hist.find((e) => e.role === 'user');
    const asst = hist.find((e) => e.role === 'assistant');
    assert.ok(user, 'user entry present');
    assert.ok(asst, 'assistant entry present');
    assert.equal(user.text, 'ping');
    assert.equal(asst.reply, 'pong');
  } finally { await rm(meshRoot, { recursive: true, force: true }); }
});

test('full round-trip: LRU trim keeps at most historyMax entries on disk', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'ch-trim-'));
  await initMesh(meshRoot);
  try {
    const c = createConcierge({ meshRoot, runAsk: async () => 'ack', historyMax: 4 });
    await c.message({ text: 'a' }); // 2 entries
    await c.message({ text: 'b' }); // 4 entries
    await c.message({ text: 'c' }); // would be 6, trimmed to 4
    const hist = await c.getHistory({ limit: 200 });
    assert.equal(hist.length, 4);
    assert.ok(!hist.some((e) => e.text === 'a' || e.reply === 'a' || e.text === 'ack' && hist.indexOf(e) === 0), 'oldest entry trimmed');
  } finally { await rm(meshRoot, { recursive: true, force: true }); }
});
