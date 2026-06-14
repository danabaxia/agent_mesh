/**
 * src/dashboard/activity.js
 *
 * PURE transform: parsed run-log records → live board activity. The board shows
 * only STATUS / PHASE INDICATORS (working/done, route, which agent is talking to
 * which) — **never task text or result data**. The actual conversation/output
 * lives in the Desk chat window (the console's Task response), not on the board,
 * so the dashboard stays uncluttered.
 *
 * Because no free text is emitted here, there is nothing to leak: the payload is
 * structurally incapable of carrying a path, a secret, or model output (a
 * stronger guarantee than the earlier scrub-and-cap).
 *
 * Records are stamped by the runtime start-log: { agent, id, parent_run_id?,
 * route?, started_at, finished_at? }.
 */

const MAX_EVENTS = 40;

/**
 * @param {Array<object>} records  parsed run-log records (each with `agent`)
 * @returns {{ agents: object[], edges: object[], events: object[] }}
 *   agents: { name, state:'working'|'done', route, since }
 *   edges:  { from, to, active }              (deterministic parent_run_id links)
 *   events: { kind:'start'|'done', agent, route, at }   (phase indicators only)
 */
export function buildActivity(records) {
  const all = Array.isArray(records) ? records : [];
  const a2a = all.filter((r) => r && r.kind === 'a2a' && r.from && r.to);
  const list = all.filter((r) => r && r.kind !== 'a2a' && r.agent);

  // Latest record per agent → state (status only, no text). a2a records excluded.
  const byAgent = new Map();
  for (const r of list) {
    const t = ts(r.started_at);
    const prev = byAgent.get(r.agent);
    if (!prev || t >= prev._t) byAgent.set(r.agent, { ...r, _t: t });
  }
  const agents = [...byAgent.values()].map((r) => ({
    name: r.agent,
    state: r.finished_at ? 'done' : 'working',
    route: r.route || null,
    since: r.started_at || null
  }));

  // Edges, keyed by `from|to` ('|' is structurally collision-safe vs space).
  // Explicit a2a edges are authoritative and SUPERSEDE an inferred parent_run_id
  // edge for the same ordered pair (they work without AGENT_MESH_RUN_ID and carry
  // kind). active = OR across contributing edges.
  const edgeMap = new Map();
  const addEdge = (from, to, active, kind) => {
    if (from === to) return;
    const key = `${from}|${to}`;
    const prev = edgeMap.get(key);
    if (!prev) { edgeMap.set(key, { from, to, active, kind }); return; }
    prev.active = prev.active || active;
    if (kind === 'a2a') prev.kind = 'a2a';        // explicit wins
  };
  const byId = new Map(list.filter((r) => r.id).map((r) => [r.id, r]));
  for (const r of list) {
    if (!r.parent_run_id) continue;
    const parent = byId.get(r.parent_run_id);
    if (!parent || parent.agent === r.agent) continue;
    addEdge(parent.agent, r.agent, !r.finished_at, 'delegate');
  }
  for (const r of a2a) addEdge(r.from, r.to, !r.finished_at, 'a2a');
  const edges = [...edgeMap.values()];

  // Bounded, time-ordered phase feed. delegate → {kind:start|done, agent, route};
  // a2a → text-free {kind:'a2a', from, to, mode, status}. No text content.
  const events = [...list, ...a2a]
    .sort((a, b) => ts(a.started_at) - ts(b.started_at))
    .slice(-MAX_EVENTS)
    .map((r) => r.kind === 'a2a'
      ? { kind: 'a2a', from: r.from, to: r.to, mode: r.mode || null, status: r.status || null, at: r.finished_at || r.started_at || null }
      : { kind: r.finished_at ? 'done' : 'start', agent: r.agent, route: r.route || null, at: r.finished_at || r.started_at || null });

  return { agents, edges, events };
}

function ts(s) {
  const t = Date.parse(s || '');
  return Number.isFinite(t) ? t : 0;
}
