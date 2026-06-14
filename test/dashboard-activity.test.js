/**
 * test/dashboard-activity.test.js — Inc E
 *
 * Pure activity model (states, deterministic edges, redaction) + the
 * /api/activity route + SSE `activity` event.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildActivity } from '../src/dashboard/activity.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

// ---------------------------------------------------------------------------
// Pure model — STATUS ONLY (no task text / result data on the board)
// ---------------------------------------------------------------------------

test('buildActivity: working vs done state from finished_at', () => {
  const { agents } = buildActivity([
    { agent: 'app', id: 'a1', started_at: '2026-06-06T10:00:00Z', task: 'find dune', route: 'orchestrate' },
    { agent: 'library', id: 'l1', started_at: '2026-06-06T10:00:05Z', finished_at: '2026-06-06T10:00:09Z', summary: 'shelf 3', route: 'tool' }
  ]);
  const app = agents.find((a) => a.name === 'app');
  const lib = agents.find((a) => a.name === 'library');
  assert.equal(app.state, 'working');
  assert.equal(app.route, 'orchestrate');
  assert.equal(lib.state, 'done');
  assert.equal(lib.route, 'tool');
});

test('buildActivity: edges come from parent_run_id → child id (deterministic, dup-safe)', () => {
  // Two concurrent tasks with IDENTICAL text — only ids disambiguate.
  const { edges } = buildActivity([
    { agent: 'app', id: 'A', started_at: '2026-06-06T10:00:00Z', task: 'find dune' },
    { agent: 'app', id: 'B', started_at: '2026-06-06T10:00:00Z', task: 'find dune' },
    { agent: 'library', id: 'L1', parent_run_id: 'A', started_at: '2026-06-06T10:00:01Z', finished_at: '2026-06-06T10:00:02Z' },
    { agent: 'catalog', id: 'L2', parent_run_id: 'B', started_at: '2026-06-06T10:00:01Z' }
  ]);
  assert.equal(edges.length, 2);
  assert.ok(edges.find((e) => e.from === 'app' && e.to === 'library' && e.active === false));
  assert.ok(edges.find((e) => e.from === 'app' && e.to === 'catalog' && e.active === true));
});

test('board payload carries NO task text or result data (status-only)', () => {
  const out = buildActivity([
    { agent: 'app', id: 'A', started_at: '2026-06-06T10:00:00Z', task: 'find the book Dune', route: 'orchestrate' },
    { agent: 'lib', id: 'L', parent_run_id: 'A', started_at: '2026-06-06T10:00:01Z', finished_at: '2026-06-06T10:00:02Z',
      task: 'leak .env id_rsa', summary: '[{"title":"Dune","shelf":3}]', route: 'tool',
      log_path: '/x/y.json', stdout: 'noise', stderr: 'err', result: { files_changed: ['.env'] } }
  ]);
  const blob = JSON.stringify(out);
  // No structured fs fields…
  for (const k of ['log_path', 'stdout', 'stderr', 'files_changed']) {
    assert.ok(!blob.includes(k), `must not emit ${k}`);
  }
  // …and no free-text content at all (task/summary/answer never reach the board).
  for (const leak of ['Dune', 'id_rsa', '.env', 'title', 'currentTask', 'lastSummary', 'answer', 'text']) {
    assert.ok(!blob.includes(leak), `board must not carry "${leak}"`);
  }
});

test('events are phase indicators only (kind/agent/route/at)', () => {
  const { events } = buildActivity([
    { agent: 'app', id: 'A', started_at: '2026-06-06T10:00:00Z', task: 'secret stuff', route: 'orchestrate', finished_at: '2026-06-06T10:00:02Z', summary: 'sensitive' }
  ]);
  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ['agent', 'at', 'kind', 'route']);
});

// ---------------------------------------------------------------------------
// /api/activity route
// ---------------------------------------------------------------------------

async function meshWithLogs() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'activity-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'alpha');
  await mkdir(join(agentRoot, '.agent-mesh', 'logs'), { recursive: true });
  await writeFile(
    join(agentRoot, '.agent-mesh', 'logs', 'delegate-2026-06-06T10-00-00-000Z-aaaa.json'),
    JSON.stringify({ id: 'r1', started_at: '2026-06-06T10:00:00Z', finished_at: '2026-06-06T10:00:02Z', mode: 'ask', task: 'find dune', state: 'done', summary: 'shelf 3', log_path: '/x/y.json', stdout: 'noise' }),
    'utf8'
  );
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [{ name: 'alpha', root: './alpha', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }]
  });
  return meshRoot;
}

test('/api/activity returns the redacted snapshot behind auth', async () => {
  const meshRoot = await meshWithLogs();
  const srv = createDashboardServer({ meshRoot, port: 0, watchPollMs: 100 });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  try {
    const res = await fetch(`${srv.url}/api/activity`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const alpha = body.agents.find((a) => a.name === 'alpha');
    assert.ok(alpha, 'alpha present in activity');
    assert.equal(alpha.state, 'done');
    const blob = JSON.stringify(body);
    assert.ok(!blob.includes('log_path') && !blob.includes('stdout'), 'no structured fs fields leak');
    assert.ok(!blob.includes('shelf 3'), 'no result data on the board');
  } finally {
    await srv.close();
  }
});

test('/api/activity requires auth', async () => {
  const meshRoot = await meshWithLogs();
  const srv = createDashboardServer({ meshRoot, port: 0 });
  await srv.start();
  const port = new URL(srv.url).port;
  try {
    const res = await fetch(`${srv.url}/api/activity`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(res.status, 403);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// Task 2: Explicit a2a edges (text-free, deduped)
// ---------------------------------------------------------------------------

test('buildActivity: a kind:"a2a" record yields an explicit from→to edge (no parent_run_id needed)', () => {
  const { edges } = buildActivity([
    { kind: 'a2a', id: 'x1', from: 'data-analyst', to: 'knowledge', mode: 'ask',
      started_at: '2026-06-09T10:00:00Z', finished_at: '2026-06-09T10:00:03Z', status: 'completed' }
  ]);
  const e = edges.find((e) => e.from === 'data-analyst' && e.to === 'knowledge');
  assert.ok(e, 'explicit a2a edge present');
  assert.equal(e.kind, 'a2a');
  assert.equal(e.active, false);
});

test('buildActivity: a2a edge supersedes the inferred parent_run_id edge for the same pair (no duplicate)', () => {
  // Supersede is input-order-independent: records are structurally split into
  // separate lists (delegate list vs a2a list) before edge processing, so the
  // a2a kind always wins regardless of the record order in the input array.
  const { edges } = buildActivity([
    { agent: 'data-analyst', id: 'P', started_at: '2026-06-09T10:00:00Z' },
    { agent: 'knowledge', id: 'C', parent_run_id: 'P', started_at: '2026-06-09T10:00:01Z' },
    { kind: 'a2a', id: 'x1', from: 'data-analyst', to: 'knowledge', mode: 'ask',
      started_at: '2026-06-09T10:00:01Z', status: 'completed', finished_at: '2026-06-09T10:00:02Z' }
  ]);
  const pair = edges.filter((e) => e.from === 'data-analyst' && e.to === 'knowledge');
  assert.equal(pair.length, 1, 'exactly one edge for the pair');
  assert.equal(pair[0].kind, 'a2a', 'the explicit a2a edge wins');
});

test('buildActivity: a2a records never leak child_log_path / summary_preview to the view-model', () => {
  const model = buildActivity([
    { kind: 'a2a', id: 'x1', from: 'data-analyst', to: 'knowledge', mode: 'ask', status: 'completed',
      started_at: '2026-06-09T10:00:00Z', finished_at: '2026-06-09T10:00:01Z',
      child_log_path: '/secret/logs/x.jsonl', summary_preview: 'sensitive text' }
  ]);
  const blob = JSON.stringify(model);
  assert.equal(blob.includes('/secret/logs/x.jsonl'), false, 'no child_log_path on the board');
  assert.equal(blob.includes('sensitive text'), false, 'no summary_preview on the board');
  // a text-free a2a event is present
  const ev = model.events.find((e) => e.kind === 'a2a');
  assert.ok(ev && ev.from === 'data-analyst' && ev.to === 'knowledge' && ev.status === 'completed');
  // Exact key-shape pin: a2a events carry exactly these fields, nothing more.
  assert.deepEqual(Object.keys(ev).sort(), ['at', 'from', 'kind', 'mode', 'status', 'to']);
});

test('buildActivity: a2a records do not create phantom agents in the state list', () => {
  const { agents } = buildActivity([
    { kind: 'a2a', id: 'x1', from: 'data-analyst', to: 'knowledge', mode: 'ask',
      started_at: '2026-06-09T10:00:00Z', status: 'completed', finished_at: '2026-06-09T10:00:01Z' }
  ]);
  assert.equal(agents.length, 0, 'an a2a traffic record is not an agent state');
});

// ---------------------------------------------------------------------------
// Task 3: Activity loader scans a2a-* files
// ---------------------------------------------------------------------------

test('/api/activity surfaces an a2a edge from an a2a-*.jsonl log', async () => {
  const meshRoot = await meshWithLogs();                       // existing helper: mesh + agent 'alpha'
  const logDir = join(meshRoot, 'alpha', '.agent-mesh', 'logs');
  await writeFile(
    join(logDir, 'a2a-2026-06-09.jsonl'),
    JSON.stringify({ kind: 'a2a', id: 'x1', from: 'alpha', to: 'beta', mode: 'ask', state: 'done',
      status: 'completed', started_at: '2026-06-09T10:00:00Z', finished_at: '2026-06-09T10:00:01Z',
      child_log_path: '/secret/x.jsonl', summary_preview: 'sensitive' }) + '\n',
    'utf8'
  );

  const srv = createDashboardServer({ meshRoot, port: 0, watchPollMs: 100 });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  try {
    const res = await fetch(`${srv.url}/api/activity`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const edge = body.edges.find((e) => e.from === 'alpha' && e.to === 'beta' && e.kind === 'a2a');
    assert.ok(edge, 'a2a edge surfaced through the loader');
    const blob = JSON.stringify(body);
    assert.equal(blob.includes('/secret/x.jsonl'), false, 'no child_log_path on the board');
    assert.equal(blob.includes('sensitive'), false, 'no summary_preview on the board');
  } finally {
    await srv.close();
  }
});

test('/api/activity: a2a files are not starved by delegate date files (per-prefix cap)', async () => {
  const meshRoot = await meshWithLogs();                       // existing helper: mesh + agent 'alpha'
  const logDir = join(meshRoot, 'alpha', '.agent-mesh', 'logs');
  // Three delegate date files fill ACTIVITY_DATE_FILES on their own. With the old
  // combined lexicographic slice ('a' < 'd'), every a2a-* file was silently dropped.
  for (const day of ['08', '09', '10']) {
    await writeFile(
      join(logDir, `delegate-2026-06-${day}.jsonl`),
      JSON.stringify({ id: `d${day}`, started_at: `2026-06-${day}T10:00:00Z`, finished_at: `2026-06-${day}T10:00:01Z`, mode: 'ask', state: 'done' }) + '\n',
      'utf8'
    );
  }
  await writeFile(
    join(logDir, 'a2a-2026-06-10.jsonl'),
    JSON.stringify({ kind: 'a2a', id: 'x2', from: 'alpha', to: 'beta', mode: 'ask', status: 'completed',
      started_at: '2026-06-10T10:00:00Z', finished_at: '2026-06-10T10:00:01Z' }) + '\n',
    'utf8'
  );

  const srv = createDashboardServer({ meshRoot, port: 0, watchPollMs: 100 });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  try {
    const res = await fetch(`${srv.url}/api/activity`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const edge = body.edges.find((e) => e.from === 'alpha' && e.to === 'beta' && e.kind === 'a2a');
    assert.ok(edge, 'a2a edge survives three delegate date files (per-prefix cap)');
  } finally {
    await srv.close();
  }
});
