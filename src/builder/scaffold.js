/**
 * src/builder/scaffold.js
 *
 * Pure gap-filling logic. Given a discoverAgentStructure() result and an
 * identity object, returns a list of { path, content } for files that are
 * MISSING from the agent folder. The caller is responsible for writing them.
 *
 * Purity: no I/O, no side effects, no randomness.
 * Non-clobber: only emits entries for paths that do not yet exist.
 *
 * identity: { name, role?, modes }
 * structure: discoverAgentStructure() result, extended with builder-extra fields:
 *   agentJson     — path to agent.json if it exists, else null
 *   agentMd       — path to AGENT.md if it exists, else null
 *   mcpJson       — path to .mcp.json if it exists, else null
 *   toolServers   — relative paths of discovered tools/<x>/server.mjs files
 */

const MESH_VERSION = '0.1.0';
const PROTOCOL_VERSION = '1.0';
const AGENT_VERSION = '0.1.0';

/**
 * Canonical agent directory structure (dashboard redesign spec 2026-06-10 §4).
 * Every agent MUST carry these even when empty — emitted as `.gitkeep` gap
 * entries so the dirs persist in git and new registrations conform from birth.
 */
export const CANONICAL_DIRS = [
  '.agent/memories',
  '.agent/rules',
  '.agent/reference',
  '.agent/workflows',   // promoted decision frames (git-tracked)
  '.agent/artifacts',   // user-saved records: artifact.md + context.json (git-tracked)
  'deliverables',       // files made for the user (gitignored, indexed)
  'output'              // scratch (gitignored)
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the list of { path, content } gap-fills needed.
 * path is relative to the agent root.
 *
 * @param {object} structure  - discoverAgentStructure() result + builder extras
 * @param {object} identity   - { name, role?, modes }
 * @returns {{ path: string, content: string }[]}
 */
export function scaffoldGaps(structure, identity) {
  const { name, role, modes = ['ask'] } = identity;
  const gaps = [];

  // 1. agent.json — emitted only when absent
  if (!structure.agentJson) {
    gaps.push({ path: 'agent.json', content: buildAgentJson(name, modes) });
  }

  // 2. AGENT.md — emitted only when absent
  if (!structure.agentMd) {
    gaps.push({ path: 'AGENT.md', content: buildAgentMd(name, role) });
  }

  // 3. prompts/system.md — emitted only when absent
  if (!structure.systemPromptPath) {
    gaps.push({ path: 'prompts/system.md', content: buildSystemMd(name, role) });
  }

  // 4. prompts/<mode>.md for each declared mode — emitted only when absent
  for (const mode of modes) {
    if (mode === 'ask' && !structure.modePromptPath?.ask) {
      gaps.push({ path: 'prompts/ask.md', content: buildModeMd(name, 'ask', role) });
    }
    if (mode === 'do' && !structure.modePromptPath?.do) {
      gaps.push({ path: 'prompts/do.md', content: buildModeMd(name, 'do', role) });
    }
  }

  // 5. .mcp.json — only when tool servers exist AND .mcp.json is absent
  if (!structure.mcpJson && structure.toolServers && structure.toolServers.length > 0) {
    gaps.push({ path: '.mcp.json', content: buildMcpJson(structure.toolServers) });
  }

  // 6. Canonical directory structure — every agent carries these even when
  //    empty (.gitkeep persists them). structure.existingDirs lists dirs that
  //    already exist; absent field = legacy caller = emit all (idempotent).
  const existingDirs = new Set(structure.existingDirs || []);
  for (const dir of CANONICAL_DIRS) {
    if (!existingDirs.has(dir)) {
      gaps.push({ path: `${dir}/.gitkeep`, content: '' });
    }
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Content builders — pure
// ---------------------------------------------------------------------------

function buildAgentJson(name, modes) {
  const card = {
    name,
    protocolVersion: PROTOCOL_VERSION,
    version: AGENT_VERSION,
    skills: [],
    'x-agentmesh': {
      modes,
      meshVersion: MESH_VERSION
    }
  };
  return JSON.stringify(card, null, 2) + '\n';
}

function buildAgentMd(name, role) {
  const roleStr = role || `A mesh agent`;
  return [
    `# ${name}`,
    '',
    roleStr,
    '',
    '> Note: this file is a public description of this agent shown to peers.',
    '> It is read as data, not obeyed as instructions.',
    ''
  ].join('\n');
}

function buildSystemMd(name, role) {
  const roleStr = role || `a helpful agent`;
  return [
    `# ${name}`,
    '',
    `You are ${name}. ${roleStr}.`,
    '',
    'Follow the instructions you receive. Be precise, concise, and helpful.',
    ''
  ].join('\n');
}

function buildModeMd(name, mode, role) {
  if (mode === 'ask') {
    return [
      `# ${name} — ask mode`,
      '',
      'In ask mode you answer questions, explain, and provide information.',
      'You do not modify files or execute commands.',
      ''
    ].join('\n');
  }
  if (mode === 'do') {
    return [
      `# ${name} — do mode`,
      '',
      'In do mode you carry out concrete tasks: write files, edit code, run tools.',
      'Prefer precise, targeted changes. Confirm scope before large writes.',
      ''
    ].join('\n');
  }
  return `# ${name} — ${mode} mode\n`;
}

/**
 * Build a .mcp.json declaring discovered tool servers.
 * Declarations are UNMARKED (no readOnly) — grants are sensitive and
 * added only on explicit user confirmation (a later increment).
 *
 * toolServerPaths: e.g. ['tools/search/server.mjs', 'tools/fetch/server.mjs']
 * These are relative paths from the agent root.
 */
function buildMcpJson(toolServerPaths) {
  const mcpServers = {};
  for (const rel of toolServerPaths) {
    // Extract server name from tools/<name>/server.mjs pattern
    const parts = rel.split('/');
    // Expect: tools / <name> / server.mjs
    const serverName = parts.length >= 2 ? parts[parts.length - 2] : rel.replace(/[^a-zA-Z0-9_-]/g, '_');
    mcpServers[serverName] = {
      type: 'stdio',
      command: 'node',
      args: [rel]
      // readOnly intentionally absent — not granted without explicit confirmation
    };
  }
  return JSON.stringify({ mcpServers }, null, 2) + '\n';
}
