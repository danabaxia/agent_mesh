// test/board2-model.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentColor, buildKpis, buildCards, buildLane, buildTimeline }
  from '../src/dashboard/public/board2-model.js';

const MESH = {
  agents: [
    { name: 'knowledge', status: 'served', modes: ['ask', 'do'], peers: ['data-analyst'], served: true,
      description: 'Knowledge curator — ingests sources into the team wiki' },
    { name: 'fracas', status: 'served', modes: ['ask', 'do'], peers: [], served: true }
  ],
  graph: { nodes: [], edges: [{ from: 'knowledge', to: 'data-analyst', kind: 'ok' }] },
  shellEnabled: true, sessionLogEnabled: true, chatEnabled: false
};
const RESOURCES = {
  totals: { skills: 7, mcps: 6 },
  groups: [
    { id: 'mesh', label: 'Mesh', kind: 'mesh', counts: { skills: 1, mcps: 5 },
      skills: [{ name: 'shared-skill', summary: 'A mesh skill', source: 'mesh' }],
      mcps: [
        // readOnly-marked mesh server = GRANTED to every agent in ask mode
        { name: 'internal-files', source: 'mesh', grant: 'declared-only', config: { 'x-agentmesh': { readOnly: true } } },
        // unmarked mesh server = declared only, NOT granted — must not count
        { name: 'declared-not-granted', source: 'mesh', grant: 'declared-only', config: {} }
      ] },
    { id: 'knowledge', label: 'knowledge', kind: 'agent', counts: { skills: 6, mcps: 1 },
      skills: [{ name: 'wiki-absorb', summary: 'Ingest a source into the wiki', source: 'knowledge' }],
      mcps: [{ name: 'local-mcp', source: 'knowledge', grant: 'readOnly', config: {} }] }
  ]
};
const ACTIVITY = {
  agents: [{ name: 'knowledge', state: 'working', route: 'ask', since: '2026-06-11T01:00:00Z' }],
  edges: [{ from: 'knowledge', to: 'data-analyst', active: true, kind: 'a2a' }],
  events: [
    { kind: 'a2a', from: 'knowledge', to: 'data-analyst', mode: 'ask', status: null, at: '2026-06-11T01:00:00Z' },
    { kind: 'done', agent: 'fracas', route: 'cli', at: '2026-06-11T00:50:00Z' }
  ]
};

test('agentColor is stable and distinct for distinct names', () => {
  assert.equal(agentColor('knowledge'), agentColor('knowledge'));
  assert.notEqual(agentColor('knowledge'), agentColor('coder'));
  assert.match(agentColor('anything'), /^hsl\(\d+, /);
});

test('buildKpis counts agents/skills/mcps and a2a outcomes', () => {
  const k = buildKpis(MESH, RESOURCES, ACTIVITY);
  assert.equal(k.agents.total, 2);
  assert.equal(k.agents.served, 2);
  assert.equal(k.skills, 7);
  assert.equal(k.mcps.total, 6);
  assert.equal(k.mcps.mesh, 5);
  assert.equal(k.a2a.total, 1);          // only kind:'a2a' events count
  assert.equal(k.sessions, 1);           // non-a2a events = session/delegate turns
});

test('buildCards merges mesh + resources + activity per agent', () => {
  const cards = buildCards(MESH, RESOURCES, ACTIVITY);
  assert.equal(cards.length, 2);
  const k = cards.find((c) => c.name === 'knowledge');
  assert.equal(k.state, 'working');            // from activity
  assert.equal(k.skillCount, 6);               // from resources counts
  // EFFECTIVE MCP grants = agent-local + mesh readOnly-granted servers
  // (regression: data-analyst showed 0 while querying through mesh-granted
  // an external MCP — agent-local-only counting misrepresents reality).
  assert.equal(k.mcpCount, 2);                 // 1 local + 1 mesh-granted
  assert.deepEqual(k.mcps.map((m) => m.name), ['local-mcp', 'internal-files']);
  assert.equal(k.mcps[1].grant, 'mesh', 'merged mesh rows tagged as mesh grants');
  assert.ok(!k.mcps.some((m) => m.name === 'declared-not-granted'), 'unmarked mesh servers not counted');
  assert.equal(k.skills[0].summary, 'Ingest a source into the wiki');
  assert.deepEqual(k.modes, ['ask', 'do']);
  // Identity panel data: description + peers ride along from /api/mesh
  assert.equal(k.description, 'Knowledge curator — ingests sources into the team wiki');
  assert.deepEqual(k.peers, ['data-analyst']);
  const f = cards.find((c) => c.name === 'fracas');
  assert.equal(f.state, 'idle');               // no activity record → idle
  assert.equal(f.skillCount, 0);               // no resources group → 0
  assert.equal(f.mcpCount, 1, 'agent without a resources group still gets mesh grants');
  assert.equal(f.description, '', 'missing description → empty string, never undefined');
  assert.deepEqual(f.peers, []);
});

test('buildLane returns active edges first with labels', () => {
  const lane = buildLane(ACTIVITY);
  assert.equal(lane[0].from, 'knowledge');
  assert.equal(lane[0].active, true);
  assert.equal(lane[0].kind, 'a2a');
});

test('buildTimeline is newest-first with per-event agent names for coloring', () => {
  const t = buildTimeline(ACTIVITY);
  assert.equal(t.length, 2);
  assert.ok(Date.parse(t[0].at) >= Date.parse(t[1].at), 'newest first');
  assert.deepEqual(t[0].names, ['knowledge', 'data-analyst']);  // a2a → both ends
  assert.deepEqual(t[1].names, ['fracas']);
  assert.equal(typeof t[0].text, 'string');
});
