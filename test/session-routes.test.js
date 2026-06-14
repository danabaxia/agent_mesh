/**
 * test/session-routes.test.js — GET /session/list gating + capability migration
 * (sessionLogEnabled replaces sessionEnabled/mirrorEnabled on /api/mesh).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';
import { parseTranscriptLine } from '../src/dashboard/session-events.js';
import { writeSessionId } from '../src/dashboard/session-store.js';
import { createSessionLive } from '../src/dashboard/session-live.js';
import { encodeProjectDir } from '../src/dashboard/session-index.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'sroutes-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot, agentRoot };
}
async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const get = (srv, port, cookie, p, extra = {}, ac) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, ...extra }, signal: ac?.signal });

test('session/list gated: 403 without allow-shell; sessionLogEnabled false; sessionEnabled gone', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await get(srv, port, cookie, '/api/agent/library/session/list')).status, 403);
    const mesh = await (await get(srv, port, cookie, '/api/mesh')).json();
    assert.equal(mesh.sessionLogEnabled, false);
    assert.equal('sessionEnabled' in mesh, false);   // removed
    assert.equal('mirrorEnabled' in mesh, false);     // removed
  } finally { await srv.close(); }
});

test('session/list enabled (injected index) → rows + sessionLogEnabled true', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const sessionIndex = { listSessions: async () => ([{ id: 'a', turns: 2, firstPrompt: 'hi', originSource: 'cli', active: true, transcriptPath: '/x', lineCount: 4 }]) };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex });
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/session/list');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.sessions[0].firstPrompt, 'hi');
    // projectsDir: harness uses injected sessionIndex so transcripts are not under homedir;
    // assert structural correctness only (includes 'projects' + encoded agent root suffix).
    const canonRoot = await realpath(agentRoot);
    assert.ok(j.projectsDir && j.projectsDir.includes('projects'), 'projectsDir must include "projects"');
    assert.ok(j.projectsDir.includes(encodeProjectDir(canonRoot)), 'projectsDir must include encoded agent root');
    const mesh = await (await get(srv, port, cookie, '/api/mesh')).json();
    assert.equal(mesh.sessionLogEnabled, true);
  } finally { await srv.close(); }
});

test('canonical live session renders before Claude checkpoints a transcript', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const canonRoot = await realpath(agentRoot);
  const id = '12121212-1212-1212-1212-121212121212';
  await writeSessionId(meshRoot, canonRoot, id);
  const sessionIndex = {
    listSessions: async () => [],
    resolveTranscript: async () => { const e = new Error('not found'); e.code = 'not_found'; throw e; }
  };
  const sessionLive = createSessionLive();
  const turn = sessionLive.start(id);
  turn.append([{ type: 'user_text', text: 'hi' }]);
  turn.append([{ type: 'text', text: 'hello from live stdout' }]);
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionLive });
  try {
    const listed = await (await get(srv, port, cookie, '/api/agent/library/session/list')).json();
    assert.equal(listed.canonicalId, id);
    assert.equal(listed.sessions[0].id, id);
    assert.equal(listed.sessions[0].checkpointPending, true);

    const transcript = await (await get(srv, port, cookie, `/api/agent/library/session/${id}/transcript`)).json();
    assert.deepEqual(transcript.records.map((r) => r.seq), [1, 2]);
    assert.equal(transcript.records[0].events[0].text, 'hi');
    assert.equal(transcript.records[1].events[0].text, 'hello from live stdout');

    const ac = new AbortController();
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream?fromSeq=1`, {}, ac);
    const reader = res.body.getReader();
    const text = await readUntil(reader, (t) => t.includes('hello from live stdout'));
    assert.ok(!text.includes('"hi"'));
    assert.ok(text.includes('hello from live stdout'));
    ac.abort();
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally { await srv.close(); }
});

test('session/list with runner-only backend → 503 session_index_unavailable (no NPE/500)', async () => {
  const { meshRoot } = await buildMesh();
  // Inject ONLY a runner, no index/mirror: the /session/ gate passes on the
  // runner, but `list` needs the index. Must be a clean 503, never an NPE/500.
  const sessionRunner = { subscribe: () => ({ close() {} }), runTurn: async () => ({ turnId: 't' }), stop: async () => {} };
  const { srv, port, cookie } = await authed(meshRoot, { sessionRunner });
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/session/list');
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'session_index_unavailable');
  } finally { await srv.close(); }
});

test('session/:id/transcript returns windowed line records resolved via resolveTranscript', async () => {
  const { meshRoot } = await buildMesh();
  // a tiny real transcript file + an index stub that resolves to it
  const tdir = await mkdtemp(join(tmpdir(), 'tx-'));
  const f = join(tdir, 's.jsonl');
  await writeFile(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n' +
                     JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } }) + '\n', 'utf8');
  const id = '11111111-1111-1111-1111-111111111111';
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async (_r, sid) => (sid === id ? f : (() => { throw Object.assign(new Error('nf'), { code: 'not_found' }); })()) };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex });
  try {
    const r = await get(srv, port, cookie, `/api/agent/library/session/${id}/transcript`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.records[0].seq, 1);                 // line index cursor
    assert.equal(j.records[0].events[0].type, 'user_text');
    // bad id → 404
    assert.equal((await get(srv, port, cookie, `/api/agent/library/session/not-a-uuid/transcript`)).status, 404);
  } finally { await srv.close(); }
});

test('session/:id/transcript respects beforeSeq + limit (reverse pagination)', async () => {
  const { meshRoot } = await buildMesh();
  const tdir = await mkdtemp(join(tmpdir(), 'tx2-'));
  const f = join(tdir, 's.jsonl');
  // 5 user-prompt lines → seq 1..5
  const lines = [];
  for (let i = 1; i <= 5; i++) lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `m${i}` } }));
  await writeFile(f, lines.join('\n') + '\n', 'utf8');
  const id = '55555555-5555-5555-5555-555555555555';
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => f };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex });
  try {
    // newest window (no cursor): last 2 records → seq 4,5
    const r1 = await (await get(srv, port, cookie, `/api/agent/library/session/${id}/transcript?limit=2`)).json();
    assert.deepEqual(r1.records.map((x) => x.seq), [4, 5]);
    assert.equal(r1.hasMore, true);
    assert.equal(r1.nextCursor, 4);
    // page back before seq 4 → seq 2,3
    const r2 = await (await get(srv, port, cookie, `/api/agent/library/session/${id}/transcript?beforeSeq=4&limit=2`)).json();
    assert.deepEqual(r2.records.map((x) => x.seq), [2, 3]);
    assert.equal(r2.nextCursor, 2);
    // page back before seq 2 → only seq 1, no more
    const r3 = await (await get(srv, port, cookie, `/api/agent/library/session/${id}/transcript?beforeSeq=2&limit=2`)).json();
    assert.deepEqual(r3.records.map((x) => x.seq), [1]);
    assert.equal(r3.hasMore, false);
  } finally { await srv.close(); }
});

test('session/:id/transcript gated: 403 without allow-shell', async () => {
  const { meshRoot } = await buildMesh();
  const id = '66666666-6666-6666-6666-666666666666';
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await get(srv, port, cookie, `/api/agent/library/session/${id}/transcript`)).status, 403);
  } finally { await srv.close(); }
});

test('session/:id/transcript with no index backend → 503 session_index_unavailable', async () => {
  const { meshRoot } = await buildMesh();
  const id = '77777777-7777-7777-7777-777777777777';
  // runner-only: /session/ gate passes, but transcript needs the index
  const sessionRunner = { subscribe: () => ({ close() {} }), runTurn: async () => ({ turnId: 't' }), stop: async () => {} };
  const { srv, port, cookie } = await authed(meshRoot, { sessionRunner });
  try {
    const r = await get(srv, port, cookie, `/api/agent/library/session/${id}/transcript`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'session_index_unavailable');
  } finally { await srv.close(); }
});

// Read SSE chunks until `pred(text)` is true (or timeout), then return the
// accumulated text. Avoids flaky fixed sleeps: we await actual bytes.
async function readUntil(reader, pred, timeoutMs = 4000) {
  const dec = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
    if (pred(text)) return text;
  }
  return text;
}

test('session/:id/stream is an SSE feeding mirror line records (the iTerm→dashboard mirror)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '22222222-2222-2222-2222-222222222222';
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/tmp/x.jsonl' };
  const sessionMirror = { subscribe: (sid, path, fn) => { setImmediate(() => fn({ seq: 1, events: [{ type: 'user_text', text: 'hi from iterm' }] })); return { close() {} }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionMirror });
  try {
    const ac = new AbortController();
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream`, {}, ac);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const reader = res.body.getReader();
    const text = await readUntil(reader, (t) => t.includes('hi from iterm'));
    assert.ok(text.includes('hi from iterm'));
    assert.ok(/id: 1\b/.test(text));        // seq = transcript line index
    assert.ok(/event: record/.test(text));
    ac.abort();
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { await srv.close(); }
});

test('session/:id/stream resolves id via resolveTranscript (passes path to mirror)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '23232323-2323-2323-2323-232323232323';
  let resolvedRoot = null, gotPath = null, gotSid = null;
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async (root) => { resolvedRoot = root; return '/resolved/transcript.jsonl'; } };
  const sessionMirror = { subscribe: (sid, path, fn) => { gotSid = sid; gotPath = path; setImmediate(() => fn({ seq: 1, events: [{ type: 'text', text: 'ok' }] })); return { close() {} }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionMirror });
  try {
    const ac = new AbortController();
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream`, {}, ac);
    const reader = res.body.getReader();
    await readUntil(reader, (t) => t.includes('"ok"'));
    assert.equal(gotSid, id);
    assert.equal(gotPath, '/resolved/transcript.jsonl');
    assert.ok(resolvedRoot); // resolveTranscript was invoked with the canon agent root
    ac.abort();
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { await srv.close(); }
});

test('session/:id/stream honors Last-Event-ID (resumes from that seq via the mirror)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '24242424-2424-2424-2424-242424242424';
  let seenLastSeq = null;
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/tmp/x.jsonl' };
  // mirror replays only seq > lastSeq from its buffer (just like the real mirror).
  const buffer = [
    { seq: 1, events: [{ type: 'user_text', text: 'first' }] },
    { seq: 2, events: [{ type: 'text', text: 'second' }] },
    { seq: 3, events: [{ type: 'text', text: 'third' }] }
  ];
  const sessionMirror = { subscribe: (sid, path, fn, lastSeq = 0) => { seenLastSeq = lastSeq; setImmediate(() => { for (const r of buffer) if (r.seq > lastSeq) fn(r); }); return { close() {} }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionMirror });
  try {
    const ac = new AbortController();
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream`, { 'Last-Event-ID': '2' }, ac);
    const reader = res.body.getReader();
    const text = await readUntil(reader, (t) => t.includes('third'));
    assert.equal(seenLastSeq, 2);             // the server threaded Last-Event-ID into the mirror
    assert.ok(!text.includes('first'));        // seq 1 not re-sent
    assert.ok(!text.includes('second'));       // seq 2 not re-sent
    assert.ok(text.includes('third'));         // seq 3 delivered
    ac.abort();
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { await srv.close(); }
});

test('session/:id/stream ?fromSeq sets the initial resume cursor (no Last-Event-ID)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '29292929-2929-2929-2929-292929292929';
  let seenLastSeq = null;
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/tmp/x.jsonl' };
  const buffer = [
    { seq: 1, events: [{ type: 'user_text', text: 'first' }] },
    { seq: 2, events: [{ type: 'text', text: 'second' }] },
    { seq: 3, events: [{ type: 'text', text: 'third' }] },
    { seq: 4, events: [{ type: 'text', text: 'fourth' }] }
  ];
  const sessionMirror = { subscribe: (sid, path, fn, lastSeq = 0) => { seenLastSeq = lastSeq; setImmediate(() => { for (const r of buffer) if (r.seq > lastSeq) fn(r); }); return { close() {} }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionMirror });
  try {
    const ac = new AbortController();
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream?fromSeq=3`, {}, ac);
    const reader = res.body.getReader();
    const text = await readUntil(reader, (t) => t.includes('fourth'));
    assert.equal(seenLastSeq, 3);              // fromSeq threaded into the mirror as the initial cursor
    assert.ok(!text.includes('first'));
    assert.ok(!text.includes('second'));
    assert.ok(!text.includes('third'));        // seq 3 not re-sent (only seq > 3)
    assert.ok(text.includes('fourth'));
    ac.abort();
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { await srv.close(); }
});

test('session/:id/stream absent fromSeq + absent Last-Event-ID → lastSeq 0', async () => {
  const { meshRoot } = await buildMesh();
  const id = '2a2a2a2a-2a2a-2a2a-2a2a-2a2a2a2a2a2a';
  let seenLastSeq = null;
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/tmp/x.jsonl' };
  const sessionMirror = { subscribe: (sid, path, fn, lastSeq = 0) => { seenLastSeq = lastSeq; setImmediate(() => fn({ seq: 1, events: [{ type: 'text', text: 'go' }] })); return { close() {} }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionMirror });
  try {
    const ac = new AbortController();
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream`, {}, ac);
    const reader = res.body.getReader();
    await readUntil(reader, (t) => t.includes('go'));
    assert.equal(seenLastSeq, 0);
    ac.abort();
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { await srv.close(); }
});

test('session/:id/stream Last-Event-ID header wins over ?fromSeq query', async () => {
  const { meshRoot } = await buildMesh();
  const id = '2b2b2b2b-2b2b-2b2b-2b2b-2b2b2b2b2b2b';
  let seenLastSeq = null;
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/tmp/x.jsonl' };
  const sessionMirror = { subscribe: (sid, path, fn, lastSeq = 0) => { seenLastSeq = lastSeq; setImmediate(() => fn({ seq: 6, events: [{ type: 'text', text: 'six' }] })); return { close() {} }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionMirror });
  try {
    const ac = new AbortController();
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream?fromSeq=2`, { 'Last-Event-ID': '5' }, ac);
    const reader = res.body.getReader();
    await readUntil(reader, (t) => t.includes('six'));
    assert.equal(seenLastSeq, 5);             // header wins over the query param
    ac.abort();
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { await srv.close(); }
});

test('resume validates id via resolveTranscript: unknown id → 404, no setActiveSession', async () => {
  const { meshRoot } = await buildMesh();
  const id = '35353535-3535-3535-3535-353535353535';
  let setCalls = 0;
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => { const e = new Error('nf'); e.code = 'not_found'; throw e; } };
  const sessionRunner = { setActiveSession: async () => { setCalls++; return { activeId: id, rev: 1 }; }, runTurn: async () => ({ turnId: 'T' }), stop: async () => {}, subscribe: () => ({ close() {} }) };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionRunner, sessionIndex });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await post(`/api/agent/library/session/${id}/resume`, {});
    assert.equal(r.status, 404);
    assert.equal(setCalls, 0);                  // never reached setActiveSession
    assert.equal((await r.json()).error.code, 'not_found');
  } finally { await srv.close(); }
});

test('resume with valid id → 200 {activeId,rev}; missing index backend → 503', async () => {
  const { meshRoot } = await buildMesh();
  const id = '36363636-3636-3636-3636-363636363636';
  // valid id (resolveTranscript succeeds) → 200
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/x' };
  const sessionRunner = { setActiveSession: async (_a, sid) => ({ activeId: sid, rev: 2 }), runTurn: async () => ({ turnId: 'T' }), stop: async () => {}, subscribe: () => ({ close() {} }) };
  const a = await authed(meshRoot, { allowShell: true, sessionRunner, sessionIndex });
  const postA = (p, b) => fetch(`${a.srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${a.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: a.cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await postA(`/api/agent/library/session/${id}/resume`, {});
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.activeId, id);
    assert.equal(j.rev, 2);
  } finally { await a.srv.close(); }
  // runner-only (no index): resume now needs the index → 503 session_index_unavailable
  const runnerOnly = { setActiveSession: async (_a, sid) => ({ activeId: sid, rev: 1 }), runTurn: async () => ({ turnId: 'T' }), stop: async () => {}, subscribe: () => ({ close() {} }) };
  const b = await authed(meshRoot, { sessionRunner: runnerOnly });
  const postB = (p, body) => fetch(`${b.srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: b.cookie }, body: JSON.stringify(body || {}) });
  try {
    const r = await postB(`/api/agent/library/session/${id}/resume`, {});
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'session_index_unavailable');
  } finally { await b.srv.close(); }
});

test('session/:id/stream emits a gap signal on replay_gap (resume older than buffer)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '25252525-2525-2525-2525-252525252525';
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/tmp/x.jsonl' };
  // Resume point is older than the buffer → the mirror emits { type:'replay_gap' }.
  const sessionMirror = { subscribe: (sid, path, fn) => { setImmediate(() => fn({ type: 'replay_gap' })); return { close() {} }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionMirror });
  try {
    const ac = new AbortController();
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream`, { 'Last-Event-ID': '1' }, ac);
    const reader = res.body.getReader();
    const text = await readUntil(reader, (t) => /event: gap/.test(t));
    assert.ok(/event: gap/.test(text));        // client told to re-fetch a full window
    assert.ok(!/event: record/.test(text));    // no record framed for the gap signal
    ac.abort();
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { await srv.close(); }
});

test('session/:id/stream releases the mirror subscription on client disconnect (no leak)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '26262626-2626-2626-2626-262626262626';
  let opened = 0, closed = 0;
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/tmp/x.jsonl' };
  const sessionMirror = { subscribe: (sid, path, fn) => { opened++; setImmediate(() => fn({ seq: 1, events: [{ type: 'text', text: 'live' }] })); return { close() { closed++; } }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionMirror });
  const ac = new AbortController();
  try {
    // Deterministic teardown via the injected-mirror spy. The route registers the
    // live response so srv.close() ends it, which fires the request 'close' handler
    // → sub.close() (releasing the subscription / file watcher — a prior flakiness
    // source). Asserting on the spy keeps the test free of undici keep-alive
    // socket-abort timing artifacts.
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream`, {}, ac);
    const reader = res.body.getReader();
    await readUntil(reader, (t) => t.includes('live'));
    assert.equal(opened, 1);            // exactly one subscription opened
    assert.equal(closed, 0);            // not torn down while connected
    await srv.close();                  // server-side teardown ends the live stream
    assert.equal(closed, 1, 'sub.close() must run when the live stream is torn down (no leaked watcher)');
    reader.cancel().catch(() => {});
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { ac.abort(); await srv.close(); }
});

test('session/:id/stream gated: 403 without allow-shell (no mirror backend)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '27272727-2727-2727-2727-272727272727';
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await get(srv, port, cookie, `/api/agent/library/session/${id}/stream`)).status, 403);
  } finally { await srv.close(); }
});

test('session/:id/stream with no mirror backend → 503 session_mirror_unavailable', async () => {
  const { meshRoot } = await buildMesh();
  const id = '28282828-2828-2828-2828-282828282828';
  // runner-only: /session/ gate passes, but stream needs the mirror.
  const sessionRunner = { subscribe: () => ({ close() {} }), runTurn: async () => ({ turnId: 't' }), stop: async () => {} };
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/x' };
  const { srv, port, cookie } = await authed(meshRoot, { sessionRunner, sessionIndex });
  try {
    const r = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'session_mirror_unavailable');
  } finally { await srv.close(); }
});

test('resume selects (→{activeId,rev}); message carries expectedActiveId (→409 active_changed)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '33333333-3333-3333-3333-333333333333';
  const calls = [];
  const sessionRunner = {
    setActiveSession: async (_a, sid) => { calls.push(['select', sid]); return { activeId: sid, rev: 1 }; },
    runTurn: async ({ expectedActiveId }) => {
      if (expectedActiveId === 'stale') { const e = new Error('x'); e.code = 'active_changed'; e.activeId = id; throw e; }
      return { turnId: 'T', done: Promise.resolve({ ok: true }) };
    },
    stop: async () => {}, subscribe: () => ({ close() {} })
  };
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/x' };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionRunner, sessionIndex });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    // resume → setActiveSession → {activeId, rev}
    const r1 = await post(`/api/agent/library/session/${id}/resume`, {});
    assert.equal(r1.status, 200);
    const j1 = await r1.json();
    assert.equal(j1.activeId, id);
    assert.equal(j1.rev, 1);
    assert.deepEqual(calls[0], ['select', id]);
    // stale expectedActiveId → 409 active_changed with current activeId in body
    const r2 = await post(`/api/agent/library/session/message`, { text: 'hi', expectedActiveId: 'stale' });
    assert.equal(r2.status, 409);
    const j2 = await r2.json();
    assert.equal(j2.error.code, 'active_changed');
    assert.equal(j2.error.activeId, id);   // current activeId so the client can reconcile
    // matching/absent expectedActiveId → proceeds (happy path)
    const r3 = await post(`/api/agent/library/session/message`, { text: 'hi', expectedActiveId: id });
    assert.equal(r3.status, 202);
    assert.equal((await r3.json()).turnId, 'T');
  } finally { await srv.close(); }
});

test('resume gated: 403 without allow-shell; 503 without runner backend', async () => {
  const { meshRoot } = await buildMesh();
  const id = '34343434-3434-3434-3434-343434343434';
  // 403 without allow-shell (no backends at all)
  const a = await authed(meshRoot);
  try {
    assert.equal((await fetch(`${a.srv.url}/api/agent/library/session/${id}/resume`, { method: 'POST', headers: { Host: `127.0.0.1:${a.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: a.cookie }, body: '{}' })).status, 403);
  } finally { await a.srv.close(); }
  // 503 with index-only (gate passes on the index, but resume needs the runner)
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/x' };
  const b = await authed(meshRoot, { sessionIndex });
  try {
    const r = await fetch(`${b.srv.url}/api/agent/library/session/${id}/resume`, { method: 'POST', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: b.cookie }, body: '{}' });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'session_runner_unavailable');
  } finally { await b.srv.close(); }
});

test('session/:id/transcript skips malformed transcript lines without throwing', async () => {
  const { meshRoot } = await buildMesh();
  const tdir = await mkdtemp(join(tmpdir(), 'tx3-'));
  const f = join(tdir, 's.jsonl');
  // line 1: valid user prompt; line 2: garbage (not JSON); line 3: valid assistant
  await writeFile(f, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n' +
                     '{not json' + '\n' +
                     JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }] } }) + '\n', 'utf8');
  const id = '88888888-8888-8888-8888-888888888888';
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => f };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex });
  try {
    const r = await get(srv, port, cookie, `/api/agent/library/session/${id}/transcript`);
    assert.equal(r.status, 200);
    const j = await r.json();
    // all three lines produce a record (the malformed line → a `raw` event); seq preserved
    assert.deepEqual(j.records.map((x) => x.seq), [1, 2, 3]);
    assert.equal(j.records[0].events[0].type, 'user_text');
    assert.equal(j.records[2].events[0].type, 'text');
  } finally { await srv.close(); }
});

test('open-terminal builds an exact --resume plan + records {kind:open,source:terminal} (no lease)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '44444444-4444-4444-4444-444444444444';
  const events = [];
  const resolved = [];
  let leaseCalls = 0;
  const sessionIndex = {
    listSessions: async () => [{ id }],
    resolveTranscript: async (_r, sid) => { resolved.push(sid); return '/x'; },
    recordEvent: async (_m, ev) => events.push(ev)
  };
  const built = [];
  const launched = [];
  const shellLauncher = {
    buildPlan: async (a) => { built.push(a); return { planId: 'p', command: `claude --resume ${a.resumeId}`, supported: true }; },
    launch: async (planId) => { launched.push(planId); return { opened: true }; }
  };
  // a runner that would fail the assertion if any lease/turn were taken
  const sessionRunner = { runTurn: async () => { leaseCalls++; throw new Error('no turn expected'); }, setActiveSession: async () => { leaseCalls++; throw new Error('no select expected'); }, stop: async () => {}, subscribe: () => ({ close() {} }) };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, shellLauncher, sessionRunner });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await post(`/api/agent/library/session/${id}/open-terminal`, {});
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.match(j.command, /--resume 44444444/);
    assert.ok(j.warning);                                  // warns: independent terminal-owned session
    assert.equal(j.opened, true);                          // terminal actually opened (launch chained after buildPlan)
    assert.equal(resolved[0], id);                         // id validated via resolveTranscript
    assert.equal(built[0].resumeId, id);                   // launcher got the exact id, never a recency heuristic
    assert.equal(built[0].continueSession, undefined);
    assert.deepEqual(launched, ['p']);                     // and launch(planId) was called with the same planId
    assert.equal(events[0].kind, 'open');
    assert.equal(events[0].source, 'terminal');
    assert.equal(leaseCalls, 0);                            // NO lease/turn taken
  } finally { await srv.close(); }
});

test('open-terminal uses exact --resume when requested session is not newest', async () => {
  const { meshRoot } = await buildMesh();
  const id = '44444444-4444-4444-4444-444444444444';
  const newer = '99999999-9999-9999-9999-999999999999';
  const sessionIndex = {
    listSessions: async () => [{ id: newer }, { id }],
    resolveTranscript: async () => '/x',
    recordEvent: async () => {}
  };
  const built = [];
  const shellLauncher = {
    buildPlan: async (a) => { built.push(a); return { planId: 'p', command: `claude --resume ${a.resumeId}`, supported: true }; },
    launch: async () => ({ opened: true })
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, shellLauncher });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await post(`/api/agent/library/session/${id}/open-terminal`, {});
    assert.equal(r.status, 200);
    assert.equal(built[0].resumeId, id);
    assert.equal(built[0].continueSession, undefined);
  } finally { await srv.close(); }
});

test('open-terminal still succeeds when provenance recording is denied', async () => {
  const { meshRoot } = await buildMesh();
  const id = '44444444-4444-4444-4444-444444444444';
  const sessionIndex = {
    listSessions: async () => [{ id }],
    resolveTranscript: async () => '/x',
    recordEvent: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }
  };
  const shellLauncher = {
    buildPlan: async (a) => ({ planId: 'p', command: `claude --resume ${a.resumeId}`, supported: true }),
    launch: async () => ({ opened: true })
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, shellLauncher });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await post(`/api/agent/library/session/${id}/open-terminal`, {});
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.opened, true);
    assert.deepEqual(j.provenanceWarning, { code: 'EPERM' });
  } finally { await srv.close(); }
});

test('open-terminal with unknown id → clean 4xx, no launch', async () => {
  const { meshRoot } = await buildMesh();
  const id = '55555555-5555-5555-5555-555555555555';
  let built = 0;
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => { const e = new Error('nf'); e.code = 'not_found'; throw e; }, recordEvent: async () => {} };
  const shellLauncher = { buildPlan: async () => { built++; return { planId: 'p', command: 'c' }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, shellLauncher });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await post(`/api/agent/library/session/${id}/open-terminal`, {});
    assert.equal(r.status, 404);
    assert.equal(built, 0);                                 // no terminal launched
  } finally { await srv.close(); }
});

test('open-terminal on the reserved canonical id without a transcript → seeds via --session-id (no 404)', async () => {
  // Regression: shell/plan reserves the canonical id BEFORE any transcript
  // exists (claude may never have started). /session/list surfaces that id, the
  // pane opens it, and ⌘ Terminal then hit resolveTranscript → 404 not_found —
  // a dead button on a session the UI itself offered. First launch of the
  // canonical id must seed (--session-id), mirroring shell/plan.
  const { meshRoot, agentRoot } = await buildMesh();
  const id = '66666666-6666-6666-6666-666666666666';
  const canonRoot = await realpath(agentRoot);
  await writeSessionId(meshRoot, canonRoot, id);            // reserved, never started
  const built = [];
  const launched = [];
  const sessionIndex = {
    listSessions: async () => [{ id }],
    resolveTranscript: async () => { const e = new Error('nf'); e.code = 'not_found'; throw e; },
    recordEvent: async () => {}
  };
  const shellLauncher = {
    buildPlan: async (a) => { built.push(a); return { planId: 'p', command: `claude --session-id ${a.sessionId}`, supported: true }; },
    launch: async (planId) => { launched.push(planId); return { opened: true }; }
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, shellLauncher });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await post(`/api/agent/library/session/${id}/open-terminal`, {});
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.opened, true);
    assert.equal(built[0].sessionId, id);                   // seeded…
    assert.equal(built[0].resumeId, undefined);             // …not resumed
    assert.deepEqual(launched, ['p']);
  } finally { await srv.close(); }
});

test('open-terminal with a non-canonical unknown id still 404s (no seed bypass)', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const canonRoot = await realpath(agentRoot);
  await writeSessionId(meshRoot, canonRoot, '66666666-6666-6666-6666-666666666666');
  let built = 0;
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => { const e = new Error('nf'); e.code = 'not_found'; throw e; }, recordEvent: async () => {} };
  const shellLauncher = { buildPlan: async () => { built++; return { planId: 'p', command: 'c' }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, shellLauncher });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await post(`/api/agent/library/session/77777777-7777-7777-7777-777777777777/open-terminal`, {});
    assert.equal(r.status, 404);
    assert.equal(built, 0);
  } finally { await srv.close(); }
});

test('rename validates id then setLabel; returns {ok,label}; gated 403/503', async () => {
  const { meshRoot } = await buildMesh();
  const id = '99999999-9999-9999-9999-999999999999';
  // happy path
  let setArgs = null;
  const sessionIndex = {
    listSessions: async () => [],
    resolveTranscript: async () => '/x',
    setLabel: async (mr, sid, name) => { setArgs = [mr, sid, name]; return name.trim().slice(0, 80); }
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await post(`/api/agent/library/session/${id}/rename`, { name: 'My label' });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.label, 'My label');
    assert.equal(setArgs[1], id);              // setLabel got the session id
    assert.equal(setArgs[2], 'My label');
    // unknown id → 404, no setLabel
    const badIndex = { listSessions: async () => [], resolveTranscript: async () => { const e = new Error('nf'); e.code = 'not_found'; throw e; }, setLabel: async () => { throw new Error('must not run'); } };
    const b = await authed(meshRoot, { allowShell: true, sessionIndex: badIndex });
    const postB = (p, body) => fetch(`${b.srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: b.cookie }, body: JSON.stringify(body || {}) });
    try {
      assert.equal((await postB(`/api/agent/library/session/${id}/rename`, { name: 'x' })).status, 404);
    } finally { await b.srv.close(); }
  } finally { await srv.close(); }
});

test('rename gated: 403 without allow-shell; 503 without index backend', async () => {
  const { meshRoot } = await buildMesh();
  const id = '91919191-9191-9191-9191-919191919191';
  // 403 without allow-shell (no backends)
  const a = await authed(meshRoot);
  try {
    const r = await fetch(`${a.srv.url}/api/agent/library/session/${id}/rename`, { method: 'POST', headers: { Host: `127.0.0.1:${a.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: a.cookie }, body: '{"name":"x"}' });
    assert.equal(r.status, 403);
  } finally { await a.srv.close(); }
  // 503 with runner-only (gate passes, but rename needs the index)
  const sessionRunner = { subscribe: () => ({ close() {} }), runTurn: async () => ({ turnId: 't' }), stop: async () => {} };
  const b = await authed(meshRoot, { sessionRunner });
  try {
    const r = await fetch(`${b.srv.url}/api/agent/library/session/${id}/rename`, { method: 'POST', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: b.cookie }, body: '{"name":"x"}' });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'session_index_unavailable');
  } finally { await b.srv.close(); }
});

test('delete calls deleteSession (resolve+unlink) → {ok}; unknown id → 404; gated 403/503', async () => {
  const { meshRoot } = await buildMesh();
  const id = '90909090-9090-9090-9090-909090909090';
  let deleted = null, labelDropped = null;
  const sessionIndex = {
    listSessions: async () => [],
    resolveTranscript: async () => '/x',
    deleteSession: async (root, sid) => { deleted = sid; return { ok: true }; },
    deleteLabel: async (mr, sid) => { labelDropped = sid; }
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex });
  const post = (p) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
  try {
    const r = await post(`/api/agent/library/session/${id}/delete`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);
    assert.equal(deleted, id);                  // deleteSession invoked with the id
    assert.equal(labelDropped, id);             // label dropped too
  } finally { await srv.close(); }
  // unknown/bad id → 404 (deleteSession throws a resolve error)
  const badIndex = { listSessions: async () => [], resolveTranscript: async () => '/x', deleteSession: async () => { const e = new Error('nf'); e.code = 'not_found'; throw e; }, deleteLabel: async () => {} };
  const b = await authed(meshRoot, { allowShell: true, sessionIndex: badIndex });
  try {
    const r = await fetch(`${b.srv.url}/api/agent/library/session/${id}/delete`, { method: 'POST', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: b.cookie }, body: '{}' });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.code, 'not_found');
  } finally { await b.srv.close(); }
});

test('delete gated: 403 without allow-shell; 503 without index backend', async () => {
  const { meshRoot } = await buildMesh();
  const id = '80808080-8080-8080-8080-808080808080';
  const a = await authed(meshRoot);
  try {
    const r = await fetch(`${a.srv.url}/api/agent/library/session/${id}/delete`, { method: 'POST', headers: { Host: `127.0.0.1:${a.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: a.cookie }, body: '{}' });
    assert.equal(r.status, 403);
  } finally { await a.srv.close(); }
  const sessionRunner = { subscribe: () => ({ close() {} }), runTurn: async () => ({ turnId: 't' }), stop: async () => {} };
  const b = await authed(meshRoot, { sessionRunner });
  try {
    const r = await fetch(`${b.srv.url}/api/agent/library/session/${id}/delete`, { method: 'POST', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: b.cookie }, body: '{}' });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'session_index_unavailable');
  } finally { await b.srv.close(); }
});

test('board2 static assets served with valid auth: /board2.html and /board2-model.js', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const html = await get(srv, port, cookie, '/board2.html');
    assert.equal(html.status, 200);
    assert.ok((await html.text()).includes('board2'));
    const js = await get(srv, port, cookie, '/board2-model.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') || '', /javascript/);
  } finally { await srv.close(); }
});

test('open-terminal gated: 403 without allow-shell; 503 without launcher backend', async () => {
  const { meshRoot } = await buildMesh();
  const id = '66666666-6666-6666-6666-666666666666';
  // 403 without allow-shell (no backends)
  const a = await authed(meshRoot);
  try {
    const r = await fetch(`${a.srv.url}/api/agent/library/session/${id}/open-terminal`, { method: 'POST', headers: { Host: `127.0.0.1:${a.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: a.cookie }, body: '{}' });
    assert.equal(r.status, 403);
  } finally { await a.srv.close(); }
  // 503 with index-only (gate passes on the index, but open-terminal needs the launcher)
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/x' };
  const b = await authed(meshRoot, { sessionIndex });
  try {
    const r = await fetch(`${b.srv.url}/api/agent/library/session/${id}/open-terminal`, { method: 'POST', headers: { Host: `127.0.0.1:${b.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: b.cookie }, body: '{}' });
    assert.equal(r.status, 503);
    assert.equal((await r.json()).error.code, 'shell_launcher_unavailable');
  } finally { await b.srv.close(); }
});

test('session list exposes digesting + rotationError from the rotation manager', async () => {
  const { meshRoot } = await buildMesh();
  const sessionIndex = { listSessions: async () => [] };
  const rotation = { isDigesting: (name) => name === 'library', lastErrorFor: () => 'digest_contract_invalid' };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, rotation });
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/session/list');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.digesting, true);
    assert.equal(j.rotationError, 'digest_contract_invalid');
  } finally { await srv.close(); }
});

const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WORKER_SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGENT_NAME = 'library';

test('resume-command route: exact id, latest (user-origin first), new, 404', async () => {
  const { meshRoot } = await buildMesh();
  // Seed: one user-origin transcript (SID), one newer worker-origin transcript (WORKER_SID).
  // listSessions returns both; worker row first (newest), user row second.
  const sessionIndex = {
    listSessions: async () => [
      { id: WORKER_SID, originSource: 'worker:digest' },
      { id: SID,        originSource: 'cli' }
    ],
    resolveTranscript: async (_root, sid) => {
      if (sid === SID || sid === WORKER_SID) return '/tmp/fake.jsonl';
      const e = new Error('not_found'); e.code = 'not_found'; throw e;
    }
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex });
  const getJson = (p) => get(srv, port, cookie, p).then((r) => r.json());
  const getStatus = (p) => get(srv, port, cookie, p).then((r) => r.status);
  try {
    // exact id → resume that specific session
    const r1 = await getJson(`/api/agent/${AGENT_NAME}/session/resume-command?id=${SID}`);
    assert.ok(r1.ok, `expected ok, got ${JSON.stringify(r1)}`);
    assert.match(r1.command, new RegExp(`--resume ${SID}`));
    assert.ok(r1.cwd.length > 0);

    // latest → user-origin wins (SID), not the newer worker session (WORKER_SID)
    const r2 = await getJson(`/api/agent/${AGENT_NAME}/session/resume-command?id=latest`);
    assert.ok(r2.ok, `expected ok for latest, got ${JSON.stringify(r2)}`);
    assert.match(r2.command, new RegExp(`--resume ${SID}`));

    // new → bare claude (no --resume or --session-id)
    const r3 = await getJson(`/api/agent/${AGENT_NAME}/session/resume-command?id=new`);
    assert.ok(r3.ok, `expected ok for new, got ${JSON.stringify(r3)}`);
    assert.match(r3.command, /claude$/);

    // unknown uuid → 404
    const bad = await getStatus(`/api/agent/${AGENT_NAME}/session/resume-command?id=99999999-9999-4999-8999-999999999999`);
    assert.equal(bad, 404);
  } finally { await srv.close(); }
});
