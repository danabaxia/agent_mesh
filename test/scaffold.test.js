/**
 * test/scaffold.test.js
 *
 * Tests for src/builder/scaffold.js — pure gap-filling logic.
 * All tests are hermetic (no I/O).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldGaps, CANONICAL_DIRS } from '../src/builder/scaffold.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyStructure(overrides = {}) {
  return {
    root: '/some/agent',
    systemPromptPath: null,
    modePromptPath: { ask: null, do: null },
    memoryFiles: [],
    workflowFiles: { default: null, ask: null, do: null },
    globalSkills: [],
    localSkills: [],
    // builder extra fields for tool discovery
    toolServers: [],
    agentJson: null,
    agentMd: null,
    mcpJson: null,
    ...overrides
  };
}

function identity(overrides = {}) {
  return { name: 'myagent', role: 'A helpful test agent', modes: ['ask'], ...overrides };
}

function findFile(gaps, relPath) {
  return gaps.find(g => g.path === relPath);
}

// ---------------------------------------------------------------------------
// agent.json scaffolded when absent
// ---------------------------------------------------------------------------

test('scaffold: emits agent.json when absent', () => {
  const gaps = scaffoldGaps(emptyStructure(), identity());
  const entry = findFile(gaps, 'agent.json');
  assert.ok(entry, 'agent.json must be in gaps');

  const parsed = JSON.parse(entry.content);
  assert.equal(parsed.name, 'myagent');
  assert.equal(parsed.protocolVersion, '1.0');
  assert.equal(parsed.version, '0.1.0');
  assert.ok(Array.isArray(parsed.skills));
  assert.ok(parsed['x-agentmesh'], 'must have x-agentmesh block');
  assert.deepEqual(parsed['x-agentmesh'].modes, ['ask']);
  assert.equal(parsed['x-agentmesh'].meshVersion, '0.1.0');
});

test('scaffold: agent.json has meshVersion in x-agentmesh', () => {
  const gaps = scaffoldGaps(emptyStructure(), identity({ modes: ['ask', 'do'] }));
  const entry = findFile(gaps, 'agent.json');
  assert.ok(entry);
  const parsed = JSON.parse(entry.content);
  assert.equal(parsed['x-agentmesh'].meshVersion, '0.1.0');
  assert.deepEqual(parsed['x-agentmesh'].modes, ['ask', 'do']);
});

test('scaffold: does NOT emit agent.json when it already exists', () => {
  const structure = emptyStructure({ agentJson: '/some/agent/agent.json' });
  const gaps = scaffoldGaps(structure, identity());
  const entry = findFile(gaps, 'agent.json');
  assert.equal(entry, undefined, 'agent.json must not be emitted when it exists');
});

// ---------------------------------------------------------------------------
// AGENT.md scaffolded when absent
// ---------------------------------------------------------------------------

test('scaffold: emits AGENT.md when absent', () => {
  const gaps = scaffoldGaps(emptyStructure(), identity({ role: 'Handles data ingestion' }));
  const entry = findFile(gaps, 'AGENT.md');
  assert.ok(entry, 'AGENT.md must be in gaps');
  assert.ok(entry.content.includes('myagent'), 'AGENT.md must mention name');
  assert.ok(entry.content.includes('Handles data ingestion'), 'AGENT.md must mention role');
});

test('scaffold: does NOT emit AGENT.md when it already exists', () => {
  const structure = emptyStructure({ agentMd: '/some/agent/AGENT.md' });
  const gaps = scaffoldGaps(structure, identity());
  assert.equal(findFile(gaps, 'AGENT.md'), undefined);
});

// ---------------------------------------------------------------------------
// prompts/ scaffolded when absent
// ---------------------------------------------------------------------------

test('scaffold: emits prompts/system.md when absent', () => {
  const gaps = scaffoldGaps(emptyStructure(), identity({ role: 'Process images' }));
  const entry = findFile(gaps, 'prompts/system.md');
  assert.ok(entry, 'prompts/system.md must be in gaps');
  assert.ok(entry.content.includes('myagent'), 'system.md must mention name');
});

test('scaffold: does NOT emit prompts/system.md when it already exists', () => {
  const structure = emptyStructure({ systemPromptPath: '/some/agent/prompts/system.md' });
  const gaps = scaffoldGaps(structure, identity());
  assert.equal(findFile(gaps, 'prompts/system.md'), undefined);
});

test('scaffold: emits prompts/ask.md for ask mode when absent', () => {
  const gaps = scaffoldGaps(emptyStructure(), identity({ modes: ['ask'] }));
  assert.ok(findFile(gaps, 'prompts/ask.md'), 'prompts/ask.md must be in gaps');
});

test('scaffold: emits prompts/do.md for do mode when absent', () => {
  const gaps = scaffoldGaps(emptyStructure(), identity({ modes: ['do'] }));
  assert.ok(findFile(gaps, 'prompts/do.md'), 'prompts/do.md must be in gaps');
});

test('scaffold: emits both ask.md and do.md for ask+do modes', () => {
  const gaps = scaffoldGaps(emptyStructure(), identity({ modes: ['ask', 'do'] }));
  assert.ok(findFile(gaps, 'prompts/ask.md'));
  assert.ok(findFile(gaps, 'prompts/do.md'));
});

test('scaffold: does NOT emit prompts/ask.md when it already exists', () => {
  const structure = emptyStructure({ modePromptPath: { ask: '/some/agent/prompts/ask.md', do: null } });
  const gaps = scaffoldGaps(structure, identity({ modes: ['ask'] }));
  assert.equal(findFile(gaps, 'prompts/ask.md'), undefined);
});

test('scaffold: does not emit prompts/ask.md for do-only agent', () => {
  const gaps = scaffoldGaps(emptyStructure(), identity({ modes: ['do'] }));
  assert.equal(findFile(gaps, 'prompts/ask.md'), undefined);
});

// ---------------------------------------------------------------------------
// .mcp.json from discovered tool servers (UNMARKED)
// ---------------------------------------------------------------------------

test('scaffold: emits .mcp.json when tool servers found and .mcp.json absent', () => {
  const structure = emptyStructure({
    toolServers: ['tools/search/server.mjs', 'tools/fetch/server.mjs'],
    mcpJson: null
  });
  const gaps = scaffoldGaps(structure, identity());
  const entry = findFile(gaps, '.mcp.json');
  assert.ok(entry, '.mcp.json must be in gaps when tool servers are found');

  const parsed = JSON.parse(entry.content);
  assert.ok(parsed.mcpServers, 'must have mcpServers');
  assert.ok(parsed.mcpServers.search, 'must declare search server');
  assert.ok(parsed.mcpServers.fetch, 'must declare fetch server');
});

test('scaffold: inferred .mcp.json tool declarations are UNMARKED (no readOnly)', () => {
  const structure = emptyStructure({
    toolServers: ['tools/mytool/server.mjs'],
    mcpJson: null
  });
  const gaps = scaffoldGaps(structure, identity());
  const entry = findFile(gaps, '.mcp.json');
  assert.ok(entry);
  const parsed = JSON.parse(entry.content);
  // readOnly must NOT be present (or must be absent/false) — grant is sensitive
  const server = parsed.mcpServers.mytool;
  assert.ok(server, 'server entry must exist');
  assert.ok(!('readOnly' in server), 'readOnly must be absent from inferred declarations');
});

test('scaffold: does NOT emit .mcp.json when mcpJson already exists', () => {
  const structure = emptyStructure({
    toolServers: ['tools/search/server.mjs'],
    mcpJson: '/some/agent/.mcp.json'
  });
  const gaps = scaffoldGaps(structure, identity());
  assert.equal(findFile(gaps, '.mcp.json'), undefined);
});

test('scaffold: does NOT emit .mcp.json when no tool servers found', () => {
  const structure = emptyStructure({ toolServers: [], mcpJson: null });
  const gaps = scaffoldGaps(structure, identity());
  assert.equal(findFile(gaps, '.mcp.json'), undefined);
});

// ---------------------------------------------------------------------------
// Idempotence — no gaps re-emitted when everything exists
// ---------------------------------------------------------------------------

test('scaffold: emits nothing when all files already exist', () => {
  const structure = emptyStructure({
    agentJson: '/some/agent/agent.json',
    agentMd: '/some/agent/AGENT.md',
    systemPromptPath: '/some/agent/prompts/system.md',
    modePromptPath: { ask: '/some/agent/prompts/ask.md', do: '/some/agent/prompts/do.md' },
    toolServers: ['tools/x/server.mjs'],
    mcpJson: '/some/agent/.mcp.json',
    existingDirs: [...CANONICAL_DIRS]
  });
  const gaps = scaffoldGaps(structure, identity({ modes: ['ask', 'do'] }));
  assert.equal(gaps.length, 0, 'no gaps when everything exists');
});

// ---------------------------------------------------------------------------
// No memory/workflows/skills created
// ---------------------------------------------------------------------------

test('scaffold: never emits memory/, workflows/, or skills/ entries', () => {
  const gaps = scaffoldGaps(emptyStructure(), identity());
  const forbidden = gaps.filter(
    g => g.path.startsWith('memory/') || g.path.startsWith('workflows/') || g.path.startsWith('skills/')
  );
  assert.equal(forbidden.length, 0, `scaffold must not create memory/workflows/skills: ${JSON.stringify(forbidden)}`);
});

// ---------------------------------------------------------------------------
// placeholder role
// ---------------------------------------------------------------------------

test('scaffold: uses placeholder when role is absent', () => {
  const gaps = scaffoldGaps(emptyStructure(), { name: 'myagent', modes: ['ask'] });
  const system = findFile(gaps, 'prompts/system.md');
  assert.ok(system, 'prompts/system.md must exist even with no role');
  // Just check it doesn't throw and has some content
  assert.ok(system.content.length > 0);
});
