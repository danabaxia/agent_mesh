/**
 * test/dashboard-data.test.js
 *
 * Unit tests for src/dashboard/data.js — PURE, no I/O.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  meshView,
  treeView,
  resourcesView,
  skillsView,
  mcpsView,
  isSensitivePath
} from '../src/dashboard/data.js';

// ---------------------------------------------------------------------------
// isSensitivePath
// ---------------------------------------------------------------------------

test('isSensitivePath: .git directory component', () => {
  assert.equal(isSensitivePath('.git/config'), true);
  assert.equal(isSensitivePath('.git/HEAD'), true);
});

test('isSensitivePath: .env files', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('.env.local'), true);
  assert.equal(isSensitivePath('.env.production'), true);
});

test('isSensitivePath: private keys', () => {
  assert.equal(isSensitivePath('cert.pem'), true);
  assert.equal(isSensitivePath('server.key'), true);
  assert.equal(isSensitivePath('id_rsa'), true);
  assert.equal(isSensitivePath('id_rsa.pub'), true);
});

test('isSensitivePath: secret/credential patterns', () => {
  assert.equal(isSensitivePath('my-secret.json'), true);
  assert.equal(isSensitivePath('credentials.json'), true);
  assert.equal(isSensitivePath('AWS_SECRET_KEY'), true);
});

test('isSensitivePath: build directories', () => {
  assert.equal(isSensitivePath('dist/bundle.js'), true);
  assert.equal(isSensitivePath('build/output.js'), true);
  assert.equal(isSensitivePath('out/main.js'), true);
  assert.equal(isSensitivePath('node_modules/lodash/index.js'), true);
});

test('isSensitivePath: .DS_Store', () => {
  assert.equal(isSensitivePath('.DS_Store'), true);
  assert.equal(isSensitivePath('some/dir/.DS_Store'), true);
});

test('isSensitivePath: safe paths are NOT flagged', () => {
  assert.equal(isSensitivePath('agent.json'), false);
  assert.equal(isSensitivePath('prompts/system.md'), false);
  assert.equal(isSensitivePath('README.md'), false);
  assert.equal(isSensitivePath('src/index.js'), false);
  assert.equal(isSensitivePath('mesh.json'), false);
});

// ---------------------------------------------------------------------------
// meshView — directed edges and node status/topology
// ---------------------------------------------------------------------------

function makeManifest(agents) {
  return { meshVersion: '0.1.0', agents };
}

test('meshView: one-way directed edge (A→B)', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'A', root: './A', served: true, enabledModes: ['ask'], peers: ['B'] },
      { name: 'B', root: './B', served: true, enabledModes: ['ask'], peers: [] }
    ])
  };
  const view = meshView(snapshot);
  const edges = view.graph.edges;
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], { from: 'A', to: 'B', kind: 'ok' });
});

test('meshView: reciprocal peers → two directed edges', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'A', root: './A', served: true, enabledModes: ['ask'], peers: ['B'] },
      { name: 'B', root: './B', served: true, enabledModes: ['ask'], peers: ['A'] }
    ])
  };
  const view = meshView(snapshot);
  const edges = view.graph.edges;
  assert.equal(edges.length, 2);
  const fromA = edges.find(e => e.from === 'A');
  const fromB = edges.find(e => e.from === 'B');
  assert.ok(fromA, 'edge from A must exist');
  assert.ok(fromB, 'edge from B must exist');
  assert.equal(fromA.kind, 'ok');
  assert.equal(fromB.kind, 'ok');
});

test('meshView: dangling edge to served:false agent', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'A', root: './A', served: true, enabledModes: ['ask'], peers: ['B'] },
      { name: 'B', root: './B', served: false, enabledModes: [], peers: [] }
    ])
  };
  const view = meshView(snapshot);
  const edge = view.graph.edges.find(e => e.from === 'A' && e.to === 'B');
  assert.ok(edge, 'edge A→B must exist');
  assert.equal(edge.kind, 'dangling');
});

test('meshView: served agent with empty peers → isolated:true but status served', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'Solo', root: './Solo', served: true, enabledModes: ['ask'], peers: [] }
    ])
  };
  const view = meshView(snapshot);
  const node = view.graph.nodes.find(n => n.id === 'Solo');
  assert.ok(node, 'Solo node must exist');
  assert.equal(node.status, 'served', 'status must be served (not standalone/disabled)');
  assert.equal(node.isolated, true, 'isolated must be true when no edges');

  const agent = view.agents.find(a => a.name === 'Solo');
  assert.ok(agent);
  assert.equal(agent.status, 'served');
  assert.equal(agent.isolated, true);
});

test('meshView: served:false agent → status disabled', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'Inactive', root: './Inactive', served: false, enabledModes: [], peers: [] }
    ])
  };
  const view = meshView(snapshot);
  const node = view.graph.nodes.find(n => n.id === 'Inactive');
  assert.equal(node.status, 'disabled');
  assert.equal(node.isolated, true);
});

test('meshView: node that has incoming but no outgoing is not isolated', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'A', root: './A', served: true, enabledModes: ['ask'], peers: ['B'] },
      { name: 'B', root: './B', served: true, enabledModes: ['ask'], peers: [] }
    ])
  };
  const view = meshView(snapshot);
  const nodeB = view.graph.nodes.find(n => n.id === 'B');
  assert.equal(nodeB.isolated, false, 'B has incoming from A, so not isolated');
  const nodeA = view.graph.nodes.find(n => n.id === 'A');
  assert.equal(nodeA.isolated, false, 'A has outgoing to B, so not isolated');
});

test('meshView: three agents, only two wired — third is isolated', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'A', root: './A', served: true, enabledModes: ['ask'], peers: ['B'] },
      { name: 'B', root: './B', served: true, enabledModes: ['ask'], peers: [] },
      { name: 'C', root: './C', served: true, enabledModes: ['ask'], peers: [] }
    ])
  };
  const view = meshView(snapshot);
  const nodeC = view.graph.nodes.find(n => n.id === 'C');
  assert.equal(nodeC.isolated, true);
  assert.equal(nodeC.status, 'served');
});

test('meshView: drift status takes precedence', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'DriftAgent', root: './da', served: true, enabledModes: ['ask'], peers: [] }
    ]),
    conformanceByAgent: new Map([['DriftAgent', 'drift']])
  };
  const view = meshView(snapshot);
  const node = view.graph.nodes.find(n => n.id === 'DriftAgent');
  assert.equal(node.status, 'drift');
});

test('meshView: agents carry description from snapshot descriptionsByAgent; missing → empty string', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'A', root: './A', served: true, enabledModes: ['ask'], peers: [] },
      { name: 'B', root: './B', served: true, enabledModes: ['ask'], peers: [] }
    ]),
    descriptionsByAgent: new Map([['A', 'Finds books.']])
  };
  const view = meshView(snapshot);
  assert.equal(view.agents.find((a) => a.name === 'A').description, 'Finds books.');
  assert.equal(view.agents.find((a) => a.name === 'B').description, '', 'missing entry → empty string');
});

test('meshView: no descriptionsByAgent map at all → description defaults to empty string', () => {
  const view = meshView({
    manifest: makeManifest([
      { name: 'A', root: './A', served: true, enabledModes: ['ask'], peers: [] }
    ])
  });
  assert.equal(view.agents[0].description, '');
});

test('meshView: empty manifest → empty view', () => {
  const view = meshView({ manifest: makeManifest([]) });
  assert.deepEqual(view.agents, []);
  assert.deepEqual(view.graph.nodes, []);
  assert.deepEqual(view.graph.edges, []);
});

test('meshView: null/missing manifest → empty view', () => {
  const view = meshView({});
  assert.deepEqual(view.agents, []);
});

// ---------------------------------------------------------------------------
// treeView — sensitive paths omitted
// ---------------------------------------------------------------------------

test('treeView: omits .env and .git entries', () => {
  const snapshot = {
    meshFiles: ['mesh.json', '.env', '.git/HEAD', 'README.md'],
    filesByAgent: new Map()
  };
  const tree = treeView(snapshot, 'mesh');
  const paths = tree.map(e => e.path);
  assert.ok(paths.includes('mesh.json'), 'mesh.json should be present');
  assert.ok(paths.includes('README.md'), 'README.md should be present');
  assert.ok(!paths.includes('.env'), '.env should be omitted');
  assert.ok(!paths.includes('.git/HEAD'), '.git/HEAD should be omitted');
});

test('treeView: per-agent scope uses filesByAgent', () => {
  const snapshot = {
    meshFiles: ['mesh.json'],
    filesByAgent: new Map([
      ['agent-a', ['agent.json', 'prompts/system.md', '.env', 'node_modules/x/y.js']]
    ])
  };
  const tree = treeView(snapshot, 'agent-a');
  const paths = tree.map(e => e.path);
  assert.ok(paths.includes('agent.json'));
  assert.ok(paths.includes('prompts/system.md'));
  assert.ok(!paths.includes('.env'));
  assert.ok(!paths.includes('node_modules/x/y.js'));
});

test('treeView: unknown scope returns empty', () => {
  const snapshot = {
    meshFiles: ['mesh.json'],
    filesByAgent: new Map()
  };
  const tree = treeView(snapshot, 'nonexistent-agent');
  assert.deepEqual(tree, []);
});

test('treeView: no scope defaults to mesh', () => {
  const snapshot = {
    meshFiles: ['README.md'],
    filesByAgent: new Map()
  };
  const tree = treeView(snapshot);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].path, 'README.md');
});

// ---------------------------------------------------------------------------
// skillsView — source labels
// ---------------------------------------------------------------------------

test('skillsView: global skills labeled mesh', () => {
  const snapshot = {
    globalSkills: [
      { name: 'citation-format', summary: 'Format citations.' }
    ],
    agentSkills: new Map()
  };
  const skills = skillsView(snapshot);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].source, 'mesh');
  assert.equal(skills[0].name, 'citation-format');
});

test('skillsView: per-agent skills labeled with agent name', () => {
  const snapshot = {
    globalSkills: [],
    agentSkills: new Map([
      ['agent-a', [{ name: 'my-skill', summary: 'Does stuff.' }]]
    ])
  };
  const skills = skillsView(snapshot);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].source, 'agent-a');
  assert.equal(skills[0].name, 'my-skill');
});

test('skillsView: mixed global and per-agent', () => {
  const snapshot = {
    globalSkills: [{ name: 'global-skill', summary: 'Global.' }],
    agentSkills: new Map([
      ['agent-a', [{ name: 'local-skill', summary: 'Local.' }]]
    ])
  };
  const skills = skillsView(snapshot);
  assert.equal(skills.length, 2);
  const global = skills.find(s => s.source === 'mesh');
  const local = skills.find(s => s.source === 'agent-a');
  assert.ok(global);
  assert.ok(local);
});

// ---------------------------------------------------------------------------
// mcpsView — source + grant labels
// ---------------------------------------------------------------------------

test('mcpsView: global MCP labeled declared-only', () => {
  const snapshot = {
    globalMcps: [{ name: 'my-tool', config: { args: ['server.mjs'] } }],
    agentMcps: new Map()
  };
  const mcps = mcpsView(snapshot);
  assert.equal(mcps.length, 1);
  assert.equal(mcps[0].source, 'mesh');
  assert.equal(mcps[0].grant, 'declared-only');
});

test('mcpsView: per-agent MCP with readOnly:true → grant readOnly', () => {
  const snapshot = {
    globalMcps: [],
    agentMcps: new Map([
      ['agent-a', [{ name: 'readonly-tool', config: { readOnly: true, args: ['s.mjs'] } }]]
    ])
  };
  const mcps = mcpsView(snapshot);
  assert.equal(mcps.length, 1);
  assert.equal(mcps[0].grant, 'readOnly');
  assert.equal(mcps[0].source, 'agent-a');
});

test('mcpsView: per-agent MCP without readOnly → grant granted', () => {
  const snapshot = {
    globalMcps: [],
    agentMcps: new Map([
      ['agent-a', [{ name: 'normal-tool', config: { args: ['s.mjs'] } }]]
    ])
  };
  const mcps = mcpsView(snapshot);
  assert.equal(mcps.length, 1);
  assert.equal(mcps[0].grant, 'granted');
});

test('mcpsView: does not conflate global declared-only with per-agent granted', () => {
  const snapshot = {
    globalMcps: [{ name: 'shared-tool', config: {} }],
    agentMcps: new Map([
      ['agent-b', [{ name: 'shared-tool', config: { readOnly: false } }]]
    ])
  };
  const mcps = mcpsView(snapshot);
  const global = mcps.find(m => m.source === 'mesh');
  const agentEntry = mcps.find(m => m.source === 'agent-b');
  assert.equal(global.grant, 'declared-only');
  assert.equal(agentEntry.grant, 'granted');
});

// ---------------------------------------------------------------------------
// resourcesView — grouped mesh + per-agent resource summary
// ---------------------------------------------------------------------------

test('resourcesView: groups global and per-agent skills/MCP with counts', () => {
  const snapshot = {
    manifest: makeManifest([
      { name: 'library', root: './library', served: true, enabledModes: ['ask'], peers: [] },
      { name: 'coding-agent', root: './coding-agent', served: true, enabledModes: ['ask', 'do'], peers: [] }
    ]),
    globalSkills: [{ name: 'citation-format', summary: 'Format references.' }],
    globalMcps: [{ name: 'citation-policy', config: { command: 'node', args: ['mesh/tools/citation/server.mjs'] } }],
    agentSkills: new Map([
      ['library', [{ name: 'shelf-answer', summary: 'Answer shelf-location queries.' }]],
      ['coding-agent', [
        { name: 'code-review', summary: 'Review scoped code changes.' },
        { name: 'test-strategy', summary: 'Recommend focused verification.' }
      ]]
    ]),
    agentMcps: new Map([
      ['library', [
        {
          name: 'book-search',
          config: {
            command: 'node',
            args: ['tools/book-search/server.mjs'],
            'x-agentmesh': { readOnly: true }
          }
        }
      ]]
    ])
  };

  const view = resourcesView(snapshot);

  assert.deepEqual(view.totals, { skills: 4, mcps: 2 });

  const meshGroup = view.groups.find(g => g.id === 'mesh');
  assert.ok(meshGroup);
  assert.equal(meshGroup.label, 'Mesh');
  assert.equal(meshGroup.kind, 'mesh');
  assert.equal(meshGroup.counts.skills, 1);
  assert.equal(meshGroup.counts.mcps, 1);
  assert.equal(meshGroup.skills[0].source, 'mesh');
  assert.equal(meshGroup.mcps[0].grant, 'declared-only');

  const libraryGroup = view.groups.find(g => g.id === 'library');
  assert.ok(libraryGroup);
  assert.equal(libraryGroup.kind, 'agent');
  assert.deepEqual(libraryGroup.counts, { skills: 1, mcps: 1 });
  assert.equal(libraryGroup.skills[0].summary, 'Answer shelf-location queries.');
  assert.equal(libraryGroup.mcps[0].grant, 'readOnly');

  const codingGroup = view.groups.find(g => g.id === 'coding-agent');
  assert.ok(codingGroup);
  assert.deepEqual(codingGroup.counts, { skills: 2, mcps: 0 });
  assert.deepEqual(codingGroup.mcps, []);
});
