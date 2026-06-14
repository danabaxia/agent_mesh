import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpServer } from '../src/mcp.js';

test('MCP server lists the two pinned tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-mcp-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns tests.');
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    text += chunk;
  });

  const server = await createMcpServer({ root, env: {} });
  const running = server.start(input, output);
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.end();
  await running;

  // MCP stdio is newline-delimited JSON. Assert the real wire format a
  // genuine MCP client sees — NOT self-stripped LSP Content-Length framing
  // (that masked a handshake bug the real-claude E2E caught).
  assert.ok(!text.includes('Content-Length:'), 'must not use LSP Content-Length framing');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const response = JSON.parse(lines.at(-1));
  assert.deepEqual(response.result.tools.map((tool) => tool.name), ['describe_self', 'delegate_task']);
});
