// Concierge unit + route + host-gate allowlist tests (spec 2026-06-21, issue #362).
// Hermetic: no real claude / gh / tailscale — all IO is injected or stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';

import { createConcierge, parseProposal, validateLabels, ConciergeError } from '../src/dashboard/concierge.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';

// --------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------

test('parseProposal extracts a fenced concierge-proposal block', () => {
  const reply = 'Sure, let\'s do it.\n```concierge-proposal\n{"title":"Add dark mode","body":"Toggle in settings","labels":["idea"]}\n```\nSound good?';
  const p = parseProposal(reply);
  assert.equal(p.title, 'Add dark mode');
  assert.equal(p.body, 'Toggle in settings');
  assert.deepEqual(p.labels, ['idea']);
});

test('parseProposal returns null for a plain reply (no block)', () => {
  assert.equal(parseProposal('Just chatting, no proposal here.'), null);
});

test('parseProposal returns null on malformed JSON', () => {
  assert.equal(parseProposal('```concierge-proposal\n{not json}\n```'), null);
});

test('parseProposal drops non-allowlisted labels and defaults to idea', () => {
  const p = parseProposal('```concierge-proposal\n{"title":"X","body":"y","labels":["danger","approved"]}\n```');
  assert.deepEqual(p.labels, ['approved']);
  const p2 = parseProposal('```concierge-proposal\n{"title":"X","labels":["bogus"]}\n```');
  assert.deepEqual(p2.labels, ['idea']);
});

test('validateLabels rejects unknown labels before any spawn', () => {
  assert.throws(() => validateLabels(['idea', 'rm-rf']), (e) => e instanceof ConciergeError && e.status === 400);
  assert.deepEqual(validateLabels(['approved', 'route:a2a', 'approved']), ['approved', 'route:a2a']);
  assert.deepEqual(validateLabels([]), ['idea']);
});

// --------------------------------------------------------------------------
// createConcierge — write gating
// --------------------------------------------------------------------------

test('message() runs ask only and NEVER files an issue', async () => {
  let ghCalls = 0;
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async () => 'Here is a thought.\n```concierge-proposal\n{"title":"T","body":"B","labels":["idea"]}\n```',
    runGh: async () => { ghCalls++; return { url: 'x' }; }
  });
  const out = await c.message({ text: 'I have an idea' });
  assert.equal(ghCalls, 0, 'gh must not be called during a chat turn');
  assert.ok(out.proposal, 'a proposal should be parsed');
  assert.equal(out.proposal.title, 'T');
  assert.ok(!out.reply.includes('concierge-proposal'), 'fence stripped from the visible reply');
});

test('message() rejects empty text without spawning', async () => {
  let asked = 0;
  const c = createConcierge({ meshRoot: '/tmp/nope', runAsk: async () => { asked++; return ''; }, runGh: async () => ({}) });
  await assert.rejects(() => c.message({ text: '   ' }), (e) => e instanceof ConciergeError && e.status === 400);
  assert.equal(asked, 0);
});

test('confirm() is the only path that files an issue, and validates labels first', async () => {
  let ghArgs = null;
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async () => 'noop',
    runGh: async (a) => { ghArgs = a; return { url: 'https://github.com/x/y/issues/1' }; }
  });
  // bad label → no spawn
  await assert.rejects(() => c.confirm({ title: 'T', labels: ['evil'] }), (e) => e.status === 400);
  assert.equal(ghArgs, null);
  // good → gh called with allowlisted labels
  const out = await c.confirm({ title: 'Ship it', body: 'do the thing', labels: ['approved', 'route:a2a'] });
  assert.deepEqual(ghArgs.labels, ['approved', 'route:a2a']);
  assert.equal(out.url, 'https://github.com/x/y/issues/1');
});

// --------------------------------------------------------------------------
// Route + host-gate integration
// --------------------------------------------------------------------------

function rawRequest({ port, path = '/', method = 'GET', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function startServer(extra = {}) {
  const meshRoot = await mkdtemp(join(tmpdir(), 'concierge-'));
  await initMesh(meshRoot);
  const srv = createDashboardServer({ meshRoot, port: 0, ...extra });
  await srv.start();
  const port = new URL(srv.url).port;
  const token = srv.token;
  // bootstrap to get a cookie
  const boot = await rawRequest({ port, path: `/?t=${token}`, headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' } });
  const cookie = (boot.headers['set-cookie']?.[0] || '').split(';')[0];
  return { srv, port, token, cookie, meshRoot };
}

test('POST /api/concierge/message returns reply + proposal via injected concierge', async () => {
  const fakeConcierge = {
    message: async ({ text }) => ({ reply: `echo:${text}`, proposal: { title: 'P', body: 'b', labels: ['idea'] } }),
    confirm: async () => ({ url: 'u' })
  };
  const { srv, port, cookie } = await startServer({ concierge: fakeConcierge });
  try {
    const res = await rawRequest({
      port, path: '/api/concierge/message', method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello', history: [] })
    });
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    assert.equal(j.reply, 'echo:hello');
    assert.equal(j.proposal.title, 'P');
  } finally { await srv.close(); }
});

test('POST /api/concierge/confirm surfaces a ConciergeError status', async () => {
  const fakeConcierge = {
    message: async () => ({ reply: '', proposal: null }),
    confirm: async () => { throw new ConciergeError('bad label', { status: 400 }); }
  };
  const { srv, port, cookie } = await startServer({ concierge: fakeConcierge });
  try {
    const res = await rawRequest({
      port, path: '/api/concierge/confirm', method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'T', labels: ['evil'] })
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).ok, false);
  } finally { await srv.close(); }
});

test('host-gate: *.ts.net host accepted when cookie present', async () => {
  const { srv, port, cookie } = await startServer();
  try {
    const res = await rawRequest({
      port, path: '/api/health',
      headers: { Host: 'my-mac.tailnet-abc.ts.net', 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }
    });
    assert.equal(res.status, 200, 'tailnet host should pass the gate');
  } finally { await srv.close(); }
});

test('host-gate: arbitrary public host rejected (allowlist is not a wildcard)', async () => {
  const { srv, port, cookie } = await startServer();
  try {
    const res = await rawRequest({
      port, path: '/api/health',
      headers: { Host: 'evil.example.com', 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }
    });
    assert.equal(res.status, 403);
  } finally { await srv.close(); }
});

test('host-gate: allowlisted tailnet host STILL requires the token (no auth bypass)', async () => {
  const { srv, port } = await startServer();
  try {
    const res = await rawRequest({
      port, path: '/api/health',
      headers: { Host: 'my-mac.tailnet-abc.ts.net', 'Sec-Fetch-Site': 'same-origin' }  // no cookie
    });
    assert.equal(res.status, 403, 'allowlist widens Host, never removes auth');
  } finally { await srv.close(); }
});

test('host-gate: explicit env-listed host accepted', async () => {
  const { srv, port, cookie } = await startServer({ allowedHosts: ['mybox.local'] });
  try {
    const res = await rawRequest({
      port, path: '/api/health',
      headers: { Host: 'mybox.local', 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }
    });
    assert.equal(res.status, 200);
  } finally { await srv.close(); }
});

test('bootstrap also works at /m?t= (mobile entry)', async () => {
  const { srv, port, token } = await startServer();
  try {
    const res = await rawRequest({ port, path: `/m?t=${token}`, headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' } });
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/m');
    assert.ok((res.headers['set-cookie']?.[0] || '').includes('am_dash='));
  } finally { await srv.close(); }
});

// --------------------------------------------------------------------------
// History persistence (spec issue #362)
// --------------------------------------------------------------------------

test('message() appends user + assistant entries to history log', async () => {
  const historyPath = join(await mkdtemp(join(tmpdir(), 'ch-')), 'history.jsonl');
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async () => 'The answer is 42.',
    runGh: async () => ({ url: 'x' }),
    historyPath,
  });
  await c.message({ text: 'What is the answer?' });
  // Give the fire-and-forget appendHistory a tick to settle.
  await new Promise((r) => setTimeout(r, 50));
  const raw = await readFile(historyPath, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'one user + one assistant entry');
  const [userEntry, assistantEntry] = lines.map((l) => JSON.parse(l));
  assert.equal(userEntry.role, 'user');
  assert.equal(userEntry.text, 'What is the answer?');
  assert.equal(assistantEntry.role, 'assistant');
  assert.equal(assistantEntry.text, 'The answer is 42.');
  assert.ok(typeof userEntry.ts === 'string', 'ts field present on user entry');
});

test('history() returns stored turns up to limit', async () => {
  const historyPath = join(await mkdtemp(join(tmpdir(), 'ch-')), 'history.jsonl');
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async (_, i) => `reply ${Date.now()}`,
    runGh: async () => ({ url: 'x' }),
    historyPath,
  });
  // Send two turns (= 4 entries).
  await c.message({ text: 'Turn 1' });
  await c.message({ text: 'Turn 2' });
  await new Promise((r) => setTimeout(r, 50));
  const all = await c.history({ limit: 10 });
  assert.equal(all.length, 4, 'two user + two assistant entries total');
  const limited = await c.history({ limit: 2 });
  assert.equal(limited.length, 2, 'limit is respected');
});

test('LRU trim fires when entry count exceeds historyMax', async () => {
  const historyPath = join(await mkdtemp(join(tmpdir(), 'ch-')), 'history.jsonl');
  // historyMax=4 → trim to last 4 entries after each append.
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async () => 'ok',
    runGh: async () => ({ url: 'x' }),
    historyPath,
    historyMax: 4,
  });
  // Three turns = 6 entries; after trim only 4 remain.
  await c.message({ text: 'A' });
  await c.message({ text: 'B' });
  await c.message({ text: 'C' });
  await new Promise((r) => setTimeout(r, 80));
  const all = await c.history({ limit: 100 });
  assert.ok(all.length <= 4, `expected ≤4 entries after trim, got ${all.length}`);
});

test('server-side history feeds into buildPrompt on the next turn', async () => {
  const historyPath = join(await mkdtemp(join(tmpdir(), 'ch-')), 'history.jsonl');
  const promptsSeen = [];
  const c = createConcierge({
    meshRoot: '/tmp/nope',
    runAsk: async ({ prompt }) => { promptsSeen.push(prompt); return 'reply'; },
    runGh: async () => ({ url: 'x' }),
    historyPath,
  });
  await c.message({ text: 'First message' });
  await new Promise((r) => setTimeout(r, 50));
  await c.message({ text: 'Second message' });
  // The second prompt should include the first turn's text.
  assert.ok(promptsSeen.length >= 2, 'two prompts built');
  assert.match(promptsSeen[1], /First message/, 'second prompt includes prior turn');
});

test('GET /api/concierge/history returns stored turns', async () => {
  const historyPath = join(await mkdtemp(join(tmpdir(), 'ch-')), 'history.jsonl');
  const fakeConcierge = {
    message: async ({ text }) => ({ reply: `echo:${text}`, proposal: null }),
    confirm: async () => ({ url: 'u' }),
    history: async ({ limit }) => [
      { role: 'user', text: 'hello', ts: '2026-06-21T00:00:00Z' },
      { role: 'assistant', text: 'hi there', ts: '2026-06-21T00:00:01Z' },
    ].slice(-limit),
  };
  const { srv, port, cookie } = await startServer({ concierge: fakeConcierge });
  try {
    const res = await rawRequest({
      port, path: '/api/concierge/history?limit=10',
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }
    });
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    assert.ok(j.ok);
    assert.equal(j.turns.length, 2);
    assert.equal(j.turns[0].role, 'user');
    assert.equal(j.turns[0].text, 'hello');
  } finally { await srv.close(); }
});

test('GET /api/concierge/history returns empty array when concierge has no history method', async () => {
  const fakeConcierge = {
    message: async () => ({ reply: '', proposal: null }),
    confirm: async () => ({ url: 'u' }),
    // no history method
  };
  const { srv, port, cookie } = await startServer({ concierge: fakeConcierge });
  try {
    const res = await rawRequest({
      port, path: '/api/concierge/history',
      headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie }
    });
    assert.equal(res.status, 200);
    const j = JSON.parse(res.body);
    assert.ok(j.ok);
    assert.deepEqual(j.turns, []);
  } finally { await srv.close(); }
});
