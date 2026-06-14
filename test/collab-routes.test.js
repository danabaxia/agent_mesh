/**
 * test/collab-routes.test.js — GET /api/collab (Phase 8 Task 1): per directed
 * (from,to) pair aggregate of a2a run records across every manifest agent's
 * logs, plus the meshView `description` threading on /api/mesh.
 *
 * Harness mirrors test/artifact-routes.test.js (temp mesh, token-boot →
 * cookie auth, same-origin fetch helpers) but builds TWO agents (library +
 * helper) since collaboration needs a pair.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

const LIB_DESC = 'Finds books and citations across the library corpus.';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'collabroutes-'));
  await initMesh(meshRoot);
  for (const [name, description] of [['library', LIB_DESC], ['helper', null]]) {
    const agentRoot = join(meshRoot, name);
    await mkdir(agentRoot, { recursive: true });
    const card = description ? { name, description } : { name };
    await writeFile(join(agentRoot, 'agent.json'), JSON.stringify(card), 'utf8');
  }
  await writeManifest(meshRoot, {
    meshVersion: '0.1.0',
    agents: [
      { name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: ['helper'] },
      { name: 'helper', root: './helper', card: 'agent.json', served: true, enabledModes: ['ask', 'do'], peers: [] }
    ]
  });
  return { meshRoot };
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const LONG_TASK = 'L'.repeat(150); // child task >100 chars → truncation check

/**
 * Seed a2a run logs (per the verified record shape):
 *  library logs, a2a-<today>.jsonl:
 *    r1 start+final  library→helper ask  completed, child link c1 (task text)
 *    r2 final        library→helper do   completed, child link c2 (150-char task)
 *    r4 start only   library→helper ask  running (no finished_at, no text → topic skipped)
 *  library logs, a2a-<10 days ago>.jsonl:
 *    r0 final        library→helper ask  completed, summary_preview only (no child link)
 *  helper logs, a2a-<today>.jsonl:
 *    f1 final        helper→library ask  error (finished, status!=='completed')
 *  helper logs, delegate-<today>.jsonl: the CHILD file carrying c1/c2 task text.
 */
async function seedLogs(meshRoot) {
  const now = new Date();
  const today = ymd(now);
  const oldDay = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10));

  const libLogs = join(meshRoot, 'library', '.agent-mesh', 'logs');
  const helpLogs = join(meshRoot, 'helper', '.agent-mesh', 'logs');
  await mkdir(libLogs, { recursive: true });
  await mkdir(helpLogs, { recursive: true });

  const childPath = join(helpLogs, `delegate-${today}.jsonl`);
  await writeFile(childPath, [
    JSON.stringify({ kind: 'delegate', id: 'c1', task: 'find the book about testing', status: 'completed' }),
    JSON.stringify({ kind: 'delegate', id: 'c2', task: LONG_TASK, status: 'completed' })
  ].join('\n') + '\n', 'utf8');

  const L = (o) => JSON.stringify(o);
  await writeFile(join(libLogs, `a2a-${today}.jsonl`), [
    L({ kind: 'a2a', id: 'r1', from: 'library', to: 'helper', mode: 'ask', status: 'running', started_at: `${today}T08:00:00.000Z` }),
    L({ kind: 'a2a', id: 'r1', from: 'library', to: 'helper', mode: 'ask', status: 'completed', started_at: `${today}T08:00:00.000Z`, finished_at: `${today}T08:05:00.000Z`, summary_preview: 'preview one', child_log_path: childPath, child_run_id: 'c1' }),
    L({ kind: 'a2a', id: 'r2', from: 'library', to: 'helper', mode: 'do', status: 'completed', started_at: `${today}T09:00:00.000Z`, finished_at: `${today}T09:10:00.000Z`, summary_preview: 'preview two', child_log_path: childPath, child_run_id: 'c2' }),
    L({ kind: 'a2a', id: 'r4', from: 'library', to: 'helper', mode: 'ask', status: 'running', started_at: `${today}T10:00:00.000Z` })
  ].join('\n') + '\n', 'utf8');

  await writeFile(join(libLogs, `a2a-${oldDay}.jsonl`), [
    L({ kind: 'a2a', id: 'r0', from: 'library', to: 'helper', mode: 'ask', status: 'completed', started_at: `${oldDay}T07:00:00.000Z`, finished_at: `${oldDay}T07:02:00.000Z`, summary_preview: 'old preview' })
  ].join('\n') + '\n', 'utf8');

  await writeFile(join(helpLogs, `a2a-${today}.jsonl`), [
    L({ kind: 'a2a', id: 'f1', from: 'helper', to: 'library', mode: 'ask', status: 'error', started_at: `${today}T11:00:00.000Z`, finished_at: `${today}T11:01:00.000Z` })
  ].join('\n') + '\n', 'utf8');

  return { today, oldDay };
}

async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });

// The session-log gate stub the session tests use: an injected sessionIndex
// alone turns sessionLogEnabled on (no allowShell, no real launcher/scheduler).
const gateOn = { sessionIndex: { listSessions: async () => [] } };

// ---------------------------------------------------------------------------
// /api/mesh — agent descriptions threaded through meshView
// ---------------------------------------------------------------------------

test('mesh view: agents carry agent.json description; missing → empty string', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/mesh');
    assert.equal(r.status, 200);
    const { agents } = await r.json();
    assert.equal(agents.find((a) => a.name === 'library').description, LIB_DESC);
    assert.equal(agents.find((a) => a.name === 'helper').description, '');
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------------------
// GET /api/collab — counts/ok/fail/running/modes/lastAt (always served)
// ---------------------------------------------------------------------------

test('collab aggregate: per directed pair counts, ok/fail/running, modes, lastAt', async () => {
  const { meshRoot } = await buildMesh();
  const { today } = await seedLogs(meshRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/collab');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.topicsAvailable, false);
    assert.equal(body.edges.length, 2);

    const lh = body.edges.find((e) => e.from === 'library' && e.to === 'helper');
    assert.ok(lh, 'library→helper edge exists');
    assert.equal(lh.count, 4, 'r0(old, within 30d) + r1 + r2 + r4 (start+final deduped)');
    assert.equal(lh.ok, 3, 'r0, r1, r2 completed');
    assert.equal(lh.fail, 0);
    assert.equal(lh.running, 1, 'r4 has no finished_at');
    assert.equal(lh.modes.ask, 3);
    assert.equal(lh.modes.do, 1);
    assert.equal(lh.lastAt, `${today}T10:00:00.000Z`, 'max of finished_at||started_at (r4 start is newest)');

    const hl = body.edges.find((e) => e.from === 'helper' && e.to === 'library');
    assert.ok(hl, 'helper→library edge exists');
    assert.equal(hl.count, 1);
    assert.equal(hl.ok, 0);
    assert.equal(hl.fail, 1, 'finished with status error');
    assert.equal(hl.running, 0);
    assert.equal(hl.modes.ask, 1);
    assert.equal(hl.lastAt, `${today}T11:01:00.000Z`);
  } finally { await srv.close(); }
});

test('collab days filter: filename date-suffix < cutoff excluded at days=1, included at days=30', async () => {
  const { meshRoot } = await buildMesh();
  await seedLogs(meshRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const narrow = await (await get(srv, port, cookie, '/api/collab?days=1')).json();
    assert.equal(narrow.edges.find((e) => e.from === 'library' && e.to === 'helper').count, 3, 'old-dated file excluded');

    const wide = await (await get(srv, port, cookie, '/api/collab?days=30')).json();
    assert.equal(wide.edges.find((e) => e.from === 'library' && e.to === 'helper').count, 4, 'old-dated file included');
  } finally { await srv.close(); }
});

test('collab gate off: topicsAvailable false and edges carry NO topics key', async () => {
  const { meshRoot } = await buildMesh();
  await seedLogs(meshRoot);
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const body = await (await get(srv, port, cookie, '/api/collab')).json();
    assert.equal(body.topicsAvailable, false);
    for (const e of body.edges) assert.ok(!('topics' in e), 'no topics key when the gate is off');
  } finally { await srv.close(); }
});

test('collab gate on: topics carry child task text (else preview), newest-first, truncated, textless skipped', async () => {
  const { meshRoot } = await buildMesh();
  await seedLogs(meshRoot);
  const { srv, port, cookie } = await authed(meshRoot, gateOn);
  try {
    const body = await (await get(srv, port, cookie, '/api/collab')).json();
    assert.equal(body.topicsAvailable, true);

    const lh = body.edges.find((e) => e.from === 'library' && e.to === 'helper');
    // r4 (newest) has neither child task nor preview → skipped entirely.
    assert.equal(lh.topics.length, 3);
    // r2 (child task >100 chars → truncated to exactly 100)
    assert.equal(lh.topics[0].text, LONG_TASK.slice(0, 100));
    assert.equal(lh.topics[0].text.length, 100);
    assert.equal(lh.topics[0].ok, true);
    // r1 → the child delegate record's task text (preferred over summary_preview)
    assert.equal(lh.topics[1].text, 'find the book about testing');
    assert.match(lh.topics[1].at, /T08:05:00/);
    // r0 → no child link, falls back to summary_preview
    assert.equal(lh.topics[2].text, 'old preview');

    const hl = body.edges.find((e) => e.from === 'helper' && e.to === 'library');
    assert.deepEqual(hl.topics, [], 'failed run has no task/preview text');
  } finally { await srv.close(); }
});

test('collab gate on: missing child_log_path file tolerated → falls back to summary_preview', async () => {
  const { meshRoot } = await buildMesh();
  const now = new Date();
  const today = ymd(now);
  const libLogs = join(meshRoot, 'library', '.agent-mesh', 'logs');
  await mkdir(libLogs, { recursive: true });
  await writeFile(join(libLogs, `a2a-${today}.jsonl`), JSON.stringify({
    kind: 'a2a', id: 'rx', from: 'library', to: 'helper', mode: 'ask', status: 'completed',
    started_at: `${today}T08:00:00.000Z`, finished_at: `${today}T08:01:00.000Z`,
    summary_preview: 'fallback preview', child_log_path: join(meshRoot, 'helper', 'no-such-file.jsonl'), child_run_id: 'cx'
  }) + '\n', 'utf8');
  const { srv, port, cookie } = await authed(meshRoot, gateOn);
  try {
    const body = await (await get(srv, port, cookie, '/api/collab')).json();
    const lh = body.edges.find((e) => e.from === 'library' && e.to === 'helper');
    assert.deepEqual(lh.topics, [{ text: 'fallback preview', at: `${today}T08:01:00.000Z`, ok: true }]);
  } finally { await srv.close(); }
});

test('collab days validation: NaN or <1 → 400; >90 capped (200)', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await get(srv, port, cookie, '/api/collab?days=abc')).status, 400);
    assert.equal((await get(srv, port, cookie, '/api/collab?days=0')).status, 400);
    assert.equal((await get(srv, port, cookie, '/api/collab?days=-3')).status, 400);
    assert.equal((await get(srv, port, cookie, '/api/collab?days=')).status, 400);
    assert.equal((await get(srv, port, cookie, '/api/collab?days=365')).status, 200, 'over-cap clamps to 90, no error');
  } finally { await srv.close(); }
});

test('collab empty mesh / no logs → 200 with empty edges', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const r = await get(srv, port, cookie, '/api/collab');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.edges, []);
    assert.equal(body.topicsAvailable, false);
  } finally { await srv.close(); }
});
