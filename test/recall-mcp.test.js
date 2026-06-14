// test/recall-mcp.test.js — the framework recall MCP server + its assembly wiring.
// The F1-critical assertion: the recall server is a framework-owned server granted
// in BOTH ask and do (it must NOT use the ask-only marker path that `do` drops).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools, RECALL_SERVER_NAME } from '../src/recall-mcp.js';
import { RESERVED_PREFIX } from '../src/a2a/peer-bridge.js';   // test-only import (no runtime cycle)
import { assembleMcpServers, generateRecallServerEntry } from '../src/mesh-mcp.js';
import { writeQuickMemory } from '../src/quick-memory.js';
import { BIN_PATH } from '../src/delegate-invocation.js';

const liveEntry = (o = {}) => ({ l0: 'L0', l1: 'L1', value: 'V', core: false, valid_from: '2026-06-13T00:00:00Z', valid_to: null, provenance: {}, status: 'active', ...o });

test('buildTools: the three read-only recall verbs with schemas', () => {
  const tools = buildTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['load_session', 'load_workflow', 'recall']);
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');
  assert.deepEqual(buildTools().find((t) => t.name === 'recall').inputSchema.required, ['key']);
  assert.equal(RECALL_SERVER_NAME, 'agentmesh_recall');
});

test('RECALL_SERVER_NAME stays in the reserved framework namespace (drift guard)', () => {
  // RECALL_SERVER_NAME is hardcoded (to dodge a runtime import cycle), so guard the
  // invariant the hardcoding silently dropped: it MUST live under the reserved
  // agentmesh_* prefix, or readEligibleServers would stop dropping an author
  // .mcp.json server of that name and let it shadow the framework recall server.
  // Mirrors test/peer-bridge.test.js's BRIDGE_SERVER_NAME assertion.
  assert.ok(RECALL_SERVER_NAME.startsWith('agentmesh_'));
  assert.ok(RECALL_SERVER_NAME.startsWith(RESERVED_PREFIX), 'must match peer-bridge RESERVED_PREFIX');
});

test('generateRecallServerEntry: spawns the hidden serve-recall verb', () => {
  const e = generateRecallServerEntry('/agents/A', BIN_PATH);
  assert.equal(e.command, 'node');
  assert.deepEqual(e.args, [BIN_PATH, 'serve-recall', '/agents/A']);
});

test('assembleMcpServers: recall server present in BOTH ask AND do when quick.json exists (F1)', async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), 'recall-asm-'));
  await writeQuickMemory(agentRoot, { fact: liveEntry() });
  for (const mode of ['ask', 'do']) {
    const servers = await assembleMcpServers({ agentRoot, meshRoot: null, mode, binPath: BIN_PATH });
    assert.ok(servers[RECALL_SERVER_NAME], `recall server must be granted in ${mode} mode`);
    assert.deepEqual(servers[RECALL_SERVER_NAME].args, [BIN_PATH, 'serve-recall', agentRoot]);
  }
});

test('assembleMcpServers: NO recall server when the agent has no quick.json', async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), 'recall-none-'));
  await mkdir(agentRoot, { recursive: true });
  const servers = await assembleMcpServers({ agentRoot, meshRoot: null, mode: 'ask', binPath: BIN_PATH });
  assert.equal(servers[RECALL_SERVER_NAME], undefined);
});
