// test/ui/net-graph.component.test.js — COMPONENT tier (jsdom + axe).
// Takes the REAL pure layout/derivation math (src/dashboard/public/
// net-graph-layout.js → buildNodes/buildEdges and graph-view-model.js KPI
// helpers), renders the derived data into a DOM fragment the way the live graph
// view does (one labelled node per agent + KPI readouts), and asserts the
// rendered structure via role/label/text + data-testid, then runs axe for the
// jsdom-meaningful categories (accessible names, ARIA, structure — NOT
// contrast/focus, see _jsdom-axe.js).
//
// Deterministic: buildNodes/buildEdges and the KPI helpers are pure (no DOM, no
// Math.random, no time). We feed a fixed fixture, so node radii / KPI totals are
// reproducible. The non-deterministic force-physics x/y simulation lives in
// net-graph.js and is intentionally NOT exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNodes, buildEdges } from '../../src/dashboard/public/net-graph-layout.js';
import { issuesLabel, tokenTotal } from '../../src/dashboard/public/graph-view-model.js';
import { mount, inMain, runAxe, assertNoAxeViolations } from './_jsdom-axe.js';

const AGENTS = [
  { name: 'app', color: '#3b82f6', volume: 9 },
  { name: 'library', color: '#10b981', volume: 4 },
  { name: 'docs', color: '#f59e0b', volume: 1 },
];
const LINKS = [
  { a: 'app', b: 'library', w: 3, active: true },
  { a: 'library', b: 'app', w: 1, active: false }, // duplicate undirected edge → deduped
  { a: 'app', b: 'docs', w: 2, active: false },
];

// Render the derived graph the way the live view does: an SVG list of labelled
// circles + a KPI strip. Each node gets an aria-label so it has an accessible
// name in the a11y tree (graph nodes are images of agents).
function renderGraph(agents, links, kpis) {
  const nodes = buildNodes(agents); // REAL layout math under test
  const edges = buildEdges(links);
  const circles = nodes
    .map((n) => `<g role="img" aria-label="agent ${n.label}" data-testid="node-${n.id}"><circle r="${n.r.toFixed(2)}"></circle><text>${n.label}</text></g>`)
    .join('');
  const edgeEls = edges.map((e) => `<line data-edge="${e.a}-${e.b}"></line>`).join('');
  const kpiStrip = `
    <dl data-testid="graph-kpis">
      <dt>Open issues</dt><dd data-testid="kpi-issues">${issuesLabel(kpis.issues)}</dd>
      <dt>Tokens</dt><dd data-testid="kpi-tokens">${tokenTotal(kpis.tokens)}</dd>
    </dl>`;
  return inMain(
    `<svg role="group" aria-label="mesh network graph">${edgeEls}${circles}</svg>${kpiStrip}`,
    'Mesh graph',
  );
}

test('component: graph renders one accessible node per agent (deduped edges)', async () => {
  const kpis = { issues: { openNow: 7 }, tokens: { series: [{ value: 100 }, { value: 250 }, { value: 50 }] } };
  const { document, byTestId } = mount(renderGraph(AGENTS, LINKS, kpis));

  // One node per agent, each with an accessible name.
  const nodes = [...document.querySelectorAll('[role="img"]')];
  assert.equal(nodes.length, 3, 'one node per agent');
  assert.deepEqual(
    nodes.map((n) => n.getAttribute('aria-label')),
    ['agent app', 'agent library', 'agent docs'],
    'every node has an accessible name',
  );
  assert.ok(byTestId('node-app') && byTestId('node-library') && byTestId('node-docs'), 'all nodes addressable by testid');

  // The duplicate undirected app↔library edge is deduped → 2 edges, not 3.
  assert.equal(document.querySelectorAll('line[data-edge]').length, 2, 'duplicate undirected edge deduped');

  // KPI readouts come from the pure view-model (deterministic).
  assert.equal(byTestId('kpi-issues').textContent, '7 open total');
  assert.equal(byTestId('kpi-tokens').textContent, '400', 'token total summed deterministically');

  const results = await runAxe(document);
  assertNoAxeViolations(results, assert);
});

test('component: empty mesh renders a valid (empty) accessible graph + zeroed KPIs', async () => {
  const { document, byTestId } = mount(renderGraph([], [], { issues: {}, tokens: {} }));
  assert.equal(document.querySelectorAll('[role="img"]').length, 0, 'no nodes');
  assert.equal(byTestId('kpi-issues').textContent, '0 open total');
  assert.equal(byTestId('kpi-tokens').textContent, '0');

  const results = await runAxe(document);
  assertNoAxeViolations(results, assert);
});
