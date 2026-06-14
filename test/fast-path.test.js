/**
 * test/fast-path.test.js
 *
 * Inc B — deterministic primary-tool fast-path: a structured agentmesh/toolCall
 * matching the declared primaryTool runs the MCP tool directly (no worker),
 * inside the run-log + change-detect audit envelope; mismatches/undeclared →
 * mode_disabled; in-root writes by the tool are still audited.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { fastPathExecute } from '../src/fast-path.js';
import { buildAgentCard } from '../src/a2a/protocol.js';
import { readRunLogRecords } from '../src/log.js';

const execFileAsync = promisify(execFile);

// A tiny stdio MCP server: initialize + tools/call("lookup") → "RESULT: <query>".
// If WRITE_FILE is set, it also writes a file in cwd (to exercise the audit path).
const FAKE_MCP = `#!/usr/bin/env node
import fs from 'node:fs';
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.method === 'initialize') send(m.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '0' } });
    else if (m.method === 'tools/call') {
      if (process.env.WRITE_FILE) fs.writeFileSync(process.env.WRITE_FILE, 'side-effect');
      const q = m.params?.arguments?.query ?? '';
      send(m.id, { content: [{ type: 'text', text: 'RESULT: ' + q }] });
    } else send(m.id, {});
  }
});
function send(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
`;

async function agentRoot({ primaryTool = true, readOnly = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fastpath-'));
  await execFileAsync('git', ['init'], { cwd: root });
  await mkdir(join(root, 'tools'), { recursive: true });
  await writeFile(join(root, 'tools', 'demo.mjs'), FAKE_MCP, 'utf8');
  await chmod(join(root, 'tools', 'demo.mjs'), 0o755);

  const xa = { modes: ['ask'] };
  if (primaryTool) {
    xa.primaryTool = { server: 'demo', tool: 'lookup', argsSchema: { query: 'string' }, intents: ['find', 'look up'] };
  }
  await writeFile(join(root, 'agent.json'), JSON.stringify({ name: 'demo-agent', 'x-agentmesh': xa }), 'utf8');
  await writeFile(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { demo: { command: 'node', args: ['tools/demo.mjs'], ...(readOnly ? { 'x-agentmesh': { readOnly: true } } : {}) } } }),
    'utf8'
  );
  return root;
}

async function lastLog(root) {
  const dir = join(root, '.agent-mesh', 'logs');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
  const recs = await readRunLogRecords(join(dir, files.sort().at(-1)));
  return recs.find((r) => r.state === 'done') || recs.at(-1);
}

test('valid toolCall runs the primary tool directly and returns its result', async () => {
  const root = await agentRoot();
  const result = await fastPathExecute({
    root, env: {}, toolCall: { tool: 'lookup', args: { query: 'Dune' } }, task: 'find dune', parentRunId: 'p1'
  });
  assert.equal(result.status, 'done');
  assert.match(result.summary, /RESULT: Dune/);

  const log = await lastLog(root);
  assert.equal(log.route, 'tool');
  assert.equal(log.state, 'done');
  assert.equal(log.parent_run_id, 'p1');
  assert.equal(log.tool, 'lookup');
});

test('toolCall not matching the declared primaryTool → mode_disabled (no run)', async () => {
  const root = await agentRoot();
  const result = await fastPathExecute({ root, env: {}, toolCall: { tool: 'other_tool', args: {} } });
  assert.equal(result.status, 'refused');
  assert.equal(result.error.code, 'mode_disabled');
});

test('no declared primaryTool → mode_disabled', async () => {
  const root = await agentRoot({ primaryTool: false });
  const result = await fastPathExecute({ root, env: {}, toolCall: { tool: 'lookup', args: { query: 'x' } } });
  assert.equal(result.error.code, 'mode_disabled');
});

test('primaryTool server not marked readOnly → mode_disabled (ask-only)', async () => {
  const root = await agentRoot({ readOnly: false });
  const result = await fastPathExecute({ root, env: {}, toolCall: { tool: 'lookup', args: { query: 'x' } } });
  assert.equal(result.error.code, 'mode_disabled');
});

test('args failing the declared schema → bad_input', async () => {
  const root = await agentRoot();
  const result = await fastPathExecute({ root, env: {}, toolCall: { tool: 'lookup', args: { wrong: 1 } } });
  assert.equal(result.error.code, 'bad_input');
});

test('a readOnly tool that writes in-root is still audited (files_changed non-null)', async () => {
  const root = await agentRoot();
  const result = await fastPathExecute({
    root,
    env: { WRITE_FILE: join(root, 'sneaky.txt') },
    toolCall: { tool: 'lookup', args: { query: 'x' } }
  });
  assert.equal(result.status, 'done');
  assert.ok(Array.isArray(result.files_changed), 'files_changed must be an array (audit ran)');
  assert.ok(result.files_changed.includes('sneaky.txt'), 'in-root write by the tool must be caught');
});

test('buildAgentCard exposes a SANITIZED primaryTool (no command/args)', () => {
  const card = buildAgentCard({
    self: { name: 'demo', 'x-agentmesh': { modes: ['ask'], primaryTool: { server: 'demo', tool: 'lookup', argsSchema: { query: 'string' }, intents: ['find'] } } },
    root: '/x', url: 'agent-mesh://demo', modes: ['ask']
  });
  const pt = card['x-agentmesh'].primaryTool;
  assert.equal(pt.server, 'demo');
  assert.equal(pt.tool, 'lookup');
  assert.deepEqual(pt.intents, ['find']);
  assert.equal(pt.command, undefined, 'must not leak command');
  assert.equal(pt.args, undefined, 'must not leak args');
});
