// src/dashboard/public/board2-model.js
/**
 * PURE view-model transforms for the redesigned board (spec 2026-06-10).
 * No DOM, no fetch — unit-tested in node. Inputs are the verbatim payloads
 * of /api/mesh, /api/resources, /api/activity.
 */

/** Stable per-agent color: deterministic hue from the name (spec §2.6). */
export function agentColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h}, 62%, 36%)`;
}

export function buildKpis(mesh, resources, activity) {
  const agents = mesh?.agents ?? [];
  const groups = resources?.groups ?? [];
  const meshGroup = groups.find((g) => g.id === 'mesh');
  const events = activity?.events ?? [];
  const a2aEvents = events.filter((e) => e.kind === 'a2a');
  return {
    agents: { total: agents.length, served: agents.filter((a) => a.served).length },
    skills: resources?.totals?.skills ?? 0,
    mcps: { total: resources?.totals?.mcps ?? 0, mesh: meshGroup?.counts?.mcps ?? 0 },
    a2a: { total: a2aEvents.length },
    sessions: events.length - a2aEvents.length
  };
}

export function buildCards(mesh, resources, activity) {
  const groups = new Map((resources?.groups ?? []).map((g) => [g.id, g]));
  const live = new Map((activity?.agents ?? []).map((a) => [a.name, a]));

  // EFFECTIVE MCP grants, not just agent-local declarations: mesh/mcp.json
  // servers marked x-agentmesh.readOnly are granted to EVERY agent in ask
  // mode (the mode-gate), so each card shows local + mesh-granted servers.
  // Unmarked mesh servers are declared-only (discovery) and are not counted.
  const meshGranted = (groups.get('mesh')?.mcps ?? [])
    .filter((m) => m?.config?.readOnly === true || m?.config?.['x-agentmesh']?.readOnly === true)
    .map((m) => ({ ...m, grant: 'mesh' }));

  return (mesh?.agents ?? []).map((a) => {
    const g = groups.get(a.name);
    const act = live.get(a.name);
    const mcps = [...(g?.mcps ?? []), ...meshGranted];
    return {
      name: a.name,
      color: agentColor(a.name),
      modes: a.modes ?? [],
      description: a.description ?? '',
      peers: a.peers ?? [],
      served: a.served,
      state: act ? (act.state === 'working' ? 'working' : 'live') : 'idle',
      route: act?.route ?? null,
      since: act?.since ?? null,
      skillCount: g?.counts?.skills ?? 0,
      mcpCount: mcps.length,
      skills: g?.skills ?? [],
      mcps
    };
  });
}

export function buildLane(activity) {
  const edges = (activity?.edges ?? []).map((e) => ({
    ...e,
    label: `${e.from} ${e.active ? '⇄→' : '→'} ${e.to}`
  }));
  return edges.sort((a, b) => (b.active === true) - (a.active === true));
}

export function buildTimeline(activity) {
  return (activity?.events ?? [])
    .slice()
    .sort((a, b) => Date.parse(b.at ?? 0) - Date.parse(a.at ?? 0))
    .map((e) => e.kind === 'a2a'
      ? { kind: 'a2a', at: e.at, names: [e.from, e.to],
          text: `${e.from} → ${e.to} (${e.mode ?? '?'})${e.status ? ` — ${e.status}` : ''}` }
      : { kind: e.kind, at: e.at, names: [e.agent],
          text: `${e.agent} · ${e.kind}${e.route ? ` — ${e.route}` : ''}` });
}
