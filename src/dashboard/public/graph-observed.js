// src/dashboard/public/graph-observed.js
// PURE set-diff for the observed-traffic layer of the delegation graph.
// Given the keys of currently-rendered observed edges and the new edge list
// (already filtered to known nodes by the caller), returns the minimal DOM
// change: which edges to add, which to update (.active resync), which to remove.
// No DOM, no fetch — unit-testable in node, importable in the browser.
//
// Edge key = `${from}|${to}` (matches src/dashboard/activity.js keying, so
// directionality is preserved: a|b is distinct from b|a).

/**
 * @param {string[]} prevKeys           keys of edges currently in the DOM
 * @param {Array<{from:string,to:string,active?:any}>} edges  new edges to show
 * @returns {{add:Array<{from,to,active:boolean}>, update:Array<{key:string,active:boolean}>, remove:string[]}}
 */
export function reconcileObserved(prevKeys, edges) {
  const prev = new Set(prevKeys || []);
  const next = new Set();
  const add = [];
  const update = [];
  for (const e of edges || []) {
    const key = `${e.from}|${e.to}`;
    if (next.has(key)) continue;        // de-dupe defensively
    next.add(key);
    const active = !!e.active;
    if (prev.has(key)) update.push({ key, active });
    else add.push({ from: e.from, to: e.to, active });
  }
  const remove = [...prev].filter((k) => !next.has(k));
  return { add, update, remove };
}
