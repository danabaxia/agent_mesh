import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeRadius, buildNodes, buildEdges } from '../src/dashboard/public/net-graph-layout.js';

test('nodeRadius: mirrors 13 + 15*sqrt(volume/maxVol)', () => {
  // maxVol guarded to >= 1
  assert.equal(nodeRadius(0, 4), 13);                 // sqrt(0)=0 → 13
  assert.equal(nodeRadius(4, 4), 13 + 15);            // sqrt(1)=1 → 28
  assert.equal(nodeRadius(1, 4), 13 + 15 * 0.5);      // sqrt(0.25)=0.5 → 20.5
  assert.equal(nodeRadius(9, 9), 28);                 // sqrt(1)=1 → 28
  // maxVol < 1 is clamped to 1 (so volume is treated as ratio to 1)
  assert.equal(nodeRadius(0, 0), 13);
  assert.equal(nodeRadius(1, 0), 28);                 // maxVol→1, sqrt(1)=1
  // missing volume → treated as 0
  assert.equal(nodeRadius(undefined, 4), 13);
});

test('buildNodes: exact node count + radii from agents data', () => {
  const agents = [
    { name: 'app', color: '#a00', volume: 4 },
    { name: 'lib', color: '#0a0', volume: 1 },
    { name: 'docs', color: '#00a', volume: 0 },
  ];
  const nodes = buildNodes(agents);
  assert.equal(nodes.length, 3);                      // exact count
  assert.deepEqual(nodes.map((n) => n.id), ['app', 'lib', 'docs']);
  assert.deepEqual(nodes.map((n) => n.label), ['app', 'lib', 'docs']);
  // maxVol = 4 → radii computed by hand
  assert.equal(nodes[0].r, 28);                       // 13+15*sqrt(4/4)
  assert.equal(nodes[1].r, 20.5);                     // 13+15*sqrt(1/4)
  assert.equal(nodes[2].r, 13);                       // 13+15*sqrt(0/4)
  // empty agents → no nodes, no throw (maxVol guarded)
  assert.deepEqual(buildNodes([]), []);
});

test('buildEdges: dedups undirected edge keys, mirrors net-graph', () => {
  const links = [
    { a: 'app', b: 'lib', w: 3, active: true },
    { a: 'lib', b: 'app', w: 9, active: false },       // reverse dup of above → dropped
    { a: 'app', b: 'docs', w: 1, active: false },
    { a: 'app', b: 'lib', w: 5, active: false },        // exact dup → dropped
  ];
  const edges = buildEdges(links);
  assert.equal(edges.length, 2);                        // app|lib, app|docs
  // first-seen wins (matches net-graph's seen-set ordering)
  assert.deepEqual(edges, [
    { a: 'app', b: 'lib', w: 3, active: true },
    { a: 'app', b: 'docs', w: 1, active: false },
  ]);
  assert.deepEqual(buildEdges([]), []);
});
