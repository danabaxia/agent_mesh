// net-graph-layout.js — PURE, deterministic geometry/sizing math for the mesh
// network graph (board2 network view). Extracted from net-graph.js so the
// data-derivation math can be unit-tested without a DOM or the force-physics
// animation (the x/y sim in net-graph.js is non-deterministic and stays there).
//
// These functions take plain data and return plain data — no DOM, no Math.random,
// no time, no fetch.

// Agent-node radius. Mirrors net-graph.js update():
//   const maxVol = Math.max(1, ...d.agents.map((a) => a.volume));
//   const r = 13 + 15 * Math.sqrt(a.volume / maxVol);
// maxVol is guarded to >= 1; a missing volume is treated as 0.
export function nodeRadius(volume, maxVol) {
  const v = Number.isFinite(volume) ? volume : 0;
  const m = Math.max(1, Number.isFinite(maxVol) ? maxVol : 1);
  return 13 + 15 * Math.sqrt(v / m);
}

// Derive agent nodes from the agents array. Pure: one node per agent, in input
// order, sized by collaboration volume relative to the busiest agent.
export function buildNodes(agents) {
  const list = Array.isArray(agents) ? agents : [];
  const maxVol = Math.max(1, ...list.map((a) => (Number.isFinite(a?.volume) ? a.volume : 0)));
  return list.map((a) => ({
    id: a.name,
    label: a.name,
    color: a.color,
    r: nodeRadius(a.volume, maxVol),
  }));
}

// Dedup undirected peer edges. Mirrors net-graph.js rebuildLinks():
//   const key = [l.a, l.b].sort().join('|');
//   if (seen.has(key)) continue;  // first-seen wins
// (net-graph also drops edges whose endpoints aren't live nodes; that node-set
// guard is a rendering concern and stays in net-graph.js.)
export function buildEdges(links) {
  const list = Array.isArray(links) ? links : [];
  const seen = new Set();
  const out = [];
  for (const l of list) {
    const key = [l.a, l.b].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ a: l.a, b: l.b, w: l.w, active: l.active });
  }
  return out;
}
