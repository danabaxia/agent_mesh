/**
 * src/dashboard/data.js
 *
 * PURE — no I/O. Transforms a snapshot (loaded by server.js) into
 * view-model JSON for the dashboard frontend.
 *
 * Exported:
 *   meshView(snapshot)           → { agents, graph }
 *   treeView(snapshot, scope)    → file tree array
 *   skillsView(snapshot)         → skills array with source labels
 *   mcpsView(snapshot)           → mcps array with source + grant labels
 *   isSensitivePath(relPath)     → boolean
 */

// ---------------------------------------------------------------------------
// isSensitivePath — shared predicate
// ---------------------------------------------------------------------------

/**
 * Returns true when `relPath` matches a pattern that should be redacted
 * from tree listings and denied for file reads.
 *
 * Patterns:
 *   .git/            — git internals
 *   .env*            — environment variable files
 *   *.pem, *.key     — certificates and private keys
 *   id_rsa*          — SSH private keys
 *   *secret*         — generic secrets
 *   *credential*     — credentials
 *   node_modules/    — dependency tree
 *   dist/, build/, out/ — build output directories
 *   .DS_Store        — macOS metadata
 *
 * @param {string} relPath  path relative to root (may use / or OS sep)
 * @returns {boolean}
 */
export function isSensitivePath(relPath) {
  if (typeof relPath !== 'string') return false;
  // Normalise to forward-slash, strip leading ./
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');

  // Segment-based checks first (directory names at any position)
  const segments = p.split('/');

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;

    // Directory-only patterns: only match when not the last segment (i.e., it IS a directory component)
    if (seg === '.git' && !isLast) return true;
    if (seg === 'node_modules') return true;
    if (seg === 'dist' && !isLast) return true;
    if (seg === 'build' && !isLast) return true;
    if (seg === 'out' && !isLast) return true;

    // File-name patterns (apply to basename = last segment)
    if (isLast) {
      if (seg === '.DS_Store') return true;
      if (seg.startsWith('.env')) return true;
      if (seg.endsWith('.pem')) return true;
      if (seg.endsWith('.key')) return true;
      if (seg.startsWith('id_rsa')) return true;
      if (seg.toLowerCase().includes('secret')) return true;
      if (seg.toLowerCase().includes('credential')) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// meshView — graph + agent list
// ---------------------------------------------------------------------------

/**
 * Build the mesh view-model from a snapshot.
 *
 * @param {object} snapshot
 *   {
 *     manifest: { agents: Array<{ name, root, served, enabledModes, peers, card }> },
 *     conformanceByAgent?: Map<string, string>,  // name → 'ok' | 'drift' | ...
 *     descriptionsByAgent?: Map<string, string>  // name → agent.json description ('' when absent)
 *   }
 * @returns {{ agents: object[], graph: { nodes: object[], edges: object[] } }}
 */
export function meshView(snapshot) {
  const manifest = snapshot?.manifest;
  const agents = Array.isArray(manifest?.agents) ? manifest.agents : [];
  const conformanceByAgent = snapshot?.conformanceByAgent ?? new Map();
  const descriptionsByAgent = snapshot?.descriptionsByAgent ?? new Map();

  // Build a set of known agent names for dangling-edge detection
  const agentByName = new Map();
  for (const a of agents) {
    agentByName.set(a.name, a);
  }

  // Build node and agent list
  const nodeList = [];
  const agentList = [];

  for (const a of agents) {
    const served = a.served === true;
    const conformance = conformanceByAgent.get(a.name) ?? 'unknown';

    // Node status: served → 'served'; served:false → 'disabled'; drift → 'drift'
    let status;
    if (conformance === 'drift') {
      status = 'drift';
    } else if (served) {
      status = 'served';
    } else {
      status = 'disabled';
    }

    // Topology: isolated = no outgoing peers AND no incoming peers
    // We compute incoming after the loop; mark outgoing now
    const outgoing = Array.isArray(a.peers) ? a.peers : [];

    agentList.push({
      name: a.name,
      description: descriptionsByAgent.get(a.name) ?? '',
      status,
      modes: Array.isArray(a.enabledModes) ? a.enabledModes : [],
      peers: outgoing,
      served,
      conformance
    });

    nodeList.push({
      id: a.name,
      status,
      served,
      _outgoing: outgoing  // temporary, removed below
    });
  }

  // Compute incoming edges map
  const incomingCount = new Map();
  for (const a of agents) {
    if (!incomingCount.has(a.name)) incomingCount.set(a.name, 0);
    for (const peer of (Array.isArray(a.peers) ? a.peers : [])) {
      incomingCount.set(peer, (incomingCount.get(peer) ?? 0) + 1);
    }
  }

  // Finalize nodes (add isolated flag, remove temp field)
  const nodes = nodeList.map((n) => {
    const hasOutgoing = n._outgoing.length > 0;
    const hasIncoming = (incomingCount.get(n.id) ?? 0) > 0;
    const isolated = !hasOutgoing && !hasIncoming;
    return { id: n.id, status: n.status, isolated };
  });

  // Finalize agent list (add isolated flag)
  for (let i = 0; i < agentList.length; i++) {
    const a = agentList[i];
    const hasOutgoing = a.peers.length > 0;
    const hasIncoming = (incomingCount.get(a.name) ?? 0) > 0;
    agentList[i] = { ...a, isolated: !hasOutgoing && !hasIncoming };
  }

  // Build directed edges
  const edges = [];
  for (const a of agents) {
    const from = a.name;
    for (const peerName of (Array.isArray(a.peers) ? a.peers : [])) {
      const target = agentByName.get(peerName);
      const kind = (target && target.served === true) ? 'ok' : 'dangling';
      edges.push({ from, to: peerName, kind });
    }
  }

  return {
    agents: agentList,
    graph: { nodes, edges }
  };
}

// ---------------------------------------------------------------------------
// treeView — file tree (sensitive omitted)
// ---------------------------------------------------------------------------

/**
 * Build a file tree view from the snapshot.
 *
 * @param {object} snapshot   { filesByAgent: Map<string, string[]>, meshFiles: string[] }
 *   filesByAgent: agent-name → array of relative paths under that agent's root
 *   meshFiles:    array of relative paths under the mesh root
 * @param {string} scope  'mesh' (whole) | agent-name
 * @returns {object[]}  array of { path: string, kind: 'file'|'dir' } entries, sensitive omitted
 */
export function treeView(snapshot, scope) {
  if (scope === 'mesh' || !scope) {
    return filterTree(snapshot?.meshFiles ?? []);
  }
  // Per-agent scope
  const files = snapshot?.filesByAgent?.get?.(scope) ?? [];
  return filterTree(files);
}

/**
 * Filter an array of relative paths, omitting sensitive ones.
 * Returns objects { path, kind }.
 *
 * @param {string[]} paths
 * @returns {{ path: string, kind: 'file'|'dir' }[]}
 */
function filterTree(paths) {
  const result = [];
  for (const p of paths) {
    if (isSensitivePath(p)) continue;
    // Determine kind from trailing slash convention or assume file
    const kind = p.endsWith('/') ? 'dir' : 'file';
    result.push({ path: p, kind });
  }
  return result;
}

// ---------------------------------------------------------------------------
// skillsView — skills across the mesh with source labels
// ---------------------------------------------------------------------------

/**
 * Build skills view-model from snapshot.
 *
 * @param {object} snapshot
 *   { globalSkills: Array<{ name, summary }>, agentSkills: Map<string, Array<{ name, summary }>> }
 * @returns {Array<{ name, summary, source: 'mesh'|string }>}
 */
export function skillsView(snapshot) {
  const result = [];

  // Global (mesh-level) skills
  for (const s of (snapshot?.globalSkills ?? [])) {
    result.push({ name: s.name, summary: s.summary ?? '', source: 'mesh' });
  }

  // Per-agent skills
  const agentSkills = snapshot?.agentSkills;
  if (agentSkills) {
    for (const [agentName, skills] of agentSkills) {
      for (const s of skills) {
        result.push({ name: s.name, summary: s.summary ?? '', source: agentName });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// resourcesView — grouped mesh + per-agent resources
// ---------------------------------------------------------------------------

/**
 * Build grouped resource view-model for the dashboard resource board.
 *
 * @param {object} snapshot
 *   {
 *     manifest: { agents: Array<{ name }> },
 *     globalSkills: Array<{ name, summary }>,
 *     globalMcps: Array<{ name, config }>,
 *     agentSkills: Map<string, Array<{ name, summary }>>,
 *     agentMcps: Map<string, Array<{ name, config }>>
 *   }
 * @returns {{ totals: { skills:number, mcps:number }, groups: Array<object> }}
 */
export function resourcesView(snapshot) {
  const globalSkills = skillsForSource(snapshot?.globalSkills ?? [], 'mesh');
  const globalMcps = mcpsForSource(snapshot?.globalMcps ?? [], 'mesh');
  const agents = Array.isArray(snapshot?.manifest?.agents) ? snapshot.manifest.agents : [];

  const groups = [
    buildResourceGroup({
      id: 'mesh',
      label: 'Mesh',
      kind: 'mesh',
      skills: globalSkills,
      mcps: globalMcps
    })
  ];

  for (const agent of agents) {
    const name = agent.name;
    const skills = skillsForSource(snapshot?.agentSkills?.get?.(name) ?? [], name);
    const mcps = mcpsForSource(snapshot?.agentMcps?.get?.(name) ?? [], name);
    groups.push(buildResourceGroup({
      id: name,
      label: name,
      kind: 'agent',
      skills,
      mcps
    }));
  }

  return {
    totals: {
      skills: groups.reduce((sum, group) => sum + group.counts.skills, 0),
      mcps: groups.reduce((sum, group) => sum + group.counts.mcps, 0)
    },
    groups
  };
}

function buildResourceGroup({ id, label, kind, skills, mcps }) {
  return {
    id,
    label,
    kind,
    counts: { skills: skills.length, mcps: mcps.length },
    skills,
    mcps
  };
}

function skillsForSource(skills, source) {
  return skills.map((s) => ({
    name: s.name,
    summary: s.summary ?? '',
    source
  }));
}

function mcpsForSource(mcps, source) {
  const grant = source === 'mesh' ? 'declared-only' : null;
  return mcps.map((m) => ({
    name: m.name,
    source,
    grant: grant ?? grantForMcpConfig(m.config),
    config: m.config ?? {}
  }));
}

function grantForMcpConfig(config = {}) {
  return config.readOnly === true || config?.['x-agentmesh']?.readOnly === true
    ? 'readOnly'
    : 'granted';
}

// ---------------------------------------------------------------------------
// mcpsView — MCP servers across the mesh with source + grant labels
// ---------------------------------------------------------------------------

/**
 * Build MCP view-model from snapshot.
 *
 * Grant semantics (spec §3):
 *   - Global mesh/mcp.json entries → grant: 'declared-only' (discovery only, not granted)
 *   - Per-agent .mcp.json entries → grant: 'readOnly' if cfg.readOnly === true, else 'granted'
 *
 * @param {object} snapshot
 *   {
 *     globalMcps: Array<{ name, config }>,
 *     agentMcps:  Map<string, Array<{ name, config }>>
 *   }
 * @returns {Array<{ name, source: 'mesh'|string, grant: 'declared-only'|'readOnly'|'granted', config? }>}
 */
export function mcpsView(snapshot) {
  const result = [];

  // Global (mesh-level) MCP — declared-only
  for (const m of (snapshot?.globalMcps ?? [])) {
    result.push({
      name: m.name,
      source: 'mesh',
      grant: 'declared-only',
      config: m.config ?? {}
    });
  }

  // Per-agent MCP
  const agentMcps = snapshot?.agentMcps;
  if (agentMcps) {
    for (const [agentName, mcps] of agentMcps) {
      for (const m of mcps) {
        result.push({
          name: m.name,
          source: agentName,
          grant: grantForMcpConfig(m.config),
          config: m.config ?? {}
        });
      }
    }
  }

  return result;
}
