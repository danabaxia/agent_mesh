// test/usage-routes.test.js — GET /api/usage: per-agent skill/MCP invocation
// counts from recent transcripts (sizes the force-graph dots). Privileged:
// without the session backends it returns {available:false}.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'usage-'));
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
const get = (srv, port, cookie, p) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });

// transcript lines as Claude writes them (tool_use content blocks)
const LINE = (name, extra = '') =>
  `{"type":"assistant","timestamp":"2026-06-11T10:00:00.000Z","message":{"content":[{"type":"tool_use","id":"t1","name":"${name}"${extra}}]}}`;

test('usage: counts Skill invocations by skill name and MCP calls by server; non-MCP plain tools ignored', async () => {
  const { meshRoot } = await buildMesh();
  const transcript = join(meshRoot, 'fixture-transcript.jsonl');
  await writeFile(transcript, [
    LINE('Skill', ',"input":{"skill":"cpk-analysis","args":""}'),
    LINE('Skill', ',"input":{"skill":"cpk-analysis"}'),
    LINE('Skill', ',"input":{"skill":"fpy-summary"}'),
    LINE('mcp__external-db__sql_query', ',"input":{}'),
    LINE('mcp__external-db__export_query', ',"input":{}'),
    LINE('mcp__data-viz__plot_bar', ',"input":{}'),
    LINE('Read', ',"input":{}'),
    LINE('Bash', ',"input":{}')
  ].join('\n') + '\n', 'utf8');

  const sessionIndex = {
    listSessions: async () => [{ id: 'a'.repeat(36), transcriptPath: transcript, turns: 3 }],
    recordEvent: async () => {}
  };
  const { srv, port, cookie } = await authed(meshRoot, { sessionIndex });
  try {
    const r = await get(srv, port, cookie, '/api/usage');
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.available, true);
    assert.deepEqual(body.agents.library.skills, { 'cpk-analysis': 2, 'fpy-summary': 1 });
    assert.deepEqual(body.agents.library.mcps, { 'external-db': 2, 'data-viz': 1 });
  } finally { await srv.close(); }
});

test('usage: without session backends → available:false (no transcript access)', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const body = await (await get(srv, port, cookie, '/api/usage')).json();
    assert.deepEqual(body, { available: false, agents: {} });
  } finally { await srv.close(); }
});
