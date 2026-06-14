/**
 * test/orchestrator-e2e.test.js — Inc D
 *
 * End-to-end through a REAL orchestrator, with NO claude: the test plays the
 * console, sends "find book Dune" to an orchestrator agent (app); app routes by
 * RULES to library's deterministic primaryTool fast-path, which calls a fake MCP
 * server. Proves route-then-execute + fast-path + parent_run_id correlation with
 * zero LLM turns. Hermetic (only node processes).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createA2AClient } from '../src/a2a/stdio-client.js';
import { readRunLogRecords } from '../src/log.js';

const BIN = fileURLToPath(new URL('../bin/agent-mesh.js', import.meta.url));

const FAKE_MCP = `#!/usr/bin/env node
let buf='';process.stdin.setEncoding('utf8');
process.stdin.on('data',c=>{buf+=c;let nl;while((nl=buf.indexOf('\\n'))!==-1){const line=buf.slice(0,nl).trim();buf=buf.slice(nl+1);if(!line)continue;const m=JSON.parse(line);
if(m.method==='initialize')send(m.id,{protocolVersion:'2024-11-05',capabilities:{}});
else if(m.method==='tools/call')send(m.id,{content:[{type:'text',text:'Dune by Frank Herbert — shelf 3 (query='+(m.params?.arguments?.query??'')+')'}]});
else send(m.id,{});}});
function send(id,result){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');}
`;

async function buildMesh() {
  const mesh = await mkdtemp(join(tmpdir(), 'orch-e2e-'));

  // library — deterministic primaryTool agent
  const lib = join(mesh, 'library');
  await mkdir(join(lib, 'tools'), { recursive: true });
  await writeFile(join(lib, 'tools', 'demo.mjs'), FAKE_MCP, 'utf8');
  await chmod(join(lib, 'tools', 'demo.mjs'), 0o755);
  await writeFile(join(lib, 'agent.json'), JSON.stringify({
    name: 'library',
    'x-agentmesh': { modes: ['ask'], primaryTool: { server: 'demo', tool: 'lookup', intents: ['find book', 'look up'], argsSchema: { query: 'string' } } }
  }), 'utf8');
  await writeFile(join(lib, '.mcp.json'), JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['tools/demo.mjs'], 'x-agentmesh': { readOnly: true } } } }), 'utf8');
  await writeFile(join(lib, 'registry.json'), JSON.stringify({ 'x-agentmesh-generated': true, peers: {} }), 'utf8');

  // app — orchestrator with library as a peer
  const app = join(mesh, 'app');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'agent.json'), JSON.stringify({ name: 'app', 'x-agentmesh': { modes: ['ask'], role: 'orchestrator' } }), 'utf8');
  await writeFile(join(app, 'registry.json'), JSON.stringify({
    'x-agentmesh-generated': true,
    peers: { library: { root: lib, command: 'node', args: [BIN, 'serve-a2a', lib], cwd: lib, env: { AGENT_MESH_ENABLED_MODES: 'ask' } } }
  }), 'utf8');

  return { mesh, app, lib };
}

test('orchestrator rule-routes "find book Dune" to library fast-path (no claude)', async () => {
  const { app, lib } = await buildMesh();

  const client = await createA2AClient(
    { peers: { app: { root: app, command: 'node', args: [BIN, 'serve-a2a', app], cwd: app, env: { AGENT_MESH_ENABLED_MODES: 'ask' } } } },
    { env: { ...process.env }, requestTimeoutMs: 60_000 }
  );

  try {
    const task = await client.send('app', {
      messageId: 'console-1',
      role: 'ROLE_USER',
      parts: [{ text: 'find book Dune' }],
      metadata: { 'agentmesh/mode': 'ask' }
    });

    assert.equal(task.status.state, 'TASK_STATE_COMPLETED', `expected completed, got ${task.status.state}`);
    const summary = (task.artifacts ?? []).flatMap((a) => a.parts || []).map((p) => p.text).join('\n');
    assert.match(summary, /shelf 3/);
    assert.match(summary, /query=Dune/, 'rule extraction passed query="Dune" to the tool');

    // library produced a fast-path (route:"tool") log, linked to the orchestrator run.
    const libLogs = join(lib, '.agent-mesh', 'logs');
    const files = (await readdir(libLogs)).filter((f) => f.endsWith('.jsonl'));
    const logs = (await Promise.all(files.map((f) => readRunLogRecords(join(libLogs, f))))).flat();
    const toolLog = logs.find((l) => l.route === 'tool' && l.state === 'done');
    assert.ok(toolLog, 'library must have a route:"tool" fast-path log');
    assert.ok(toolLog.parent_run_id, 'fast-path log links back to the orchestrator run');
  } finally {
    await client.close().catch(() => {});
  }
});
