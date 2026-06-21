// src/builder/discover.js — read-only local-agent discovery.
//
// Recognizes candidate agent folders in a local checkout so a one-click deploy
// can wire them into a mesh, instead of requiring a hand-authored `add` per
// folder (PROJECT.md: "recognize local agents, join them by project need").
// PURE DISCOVERY — it only reads the filesystem; it never copies, registers, or
// mutates anything. The operator (or a future `deploy` wrapper) decides what to
// `add`. Mirrors how the rest of the builder treats mesh.json as the authoring
// source of truth: discovery proposes, the operator disposes.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';

// Dirs that never contain a first-class agent: dependency trees, VCS/tool state,
// and the mesh's own substrate. Pruned so a scan of a real checkout stays fast
// and doesn't surface vendored or generated folders as "agents".
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.claude', '.hg', '.svn', 'dist', 'build', 'coverage',
  '.agent-mesh', '.dev-society', 'mesh', '.goal-metrics', '.next', 'vendor',
]);

// A folder is an agent candidate when it carries any of these markers. agent.json
// is the conformance-required card (strongest signal); prompts/system.md is the
// runtime prompt (medium); AGENT.md alone is a human description (weak but worth
// surfacing so an operator can promote it).
async function markersFor(dir) {
  const [agentJson, agentMd, promptsSystem] = await Promise.all([
    exists(join(dir, 'agent.json')),
    exists(join(dir, 'AGENT.md')),
    exists(join(dir, 'prompts', 'system.md')),
  ]);
  return { agentJson, agentMd, promptsSystem };
}

const confidenceOf = (m) => (m.agentJson ? 'high' : m.promptsSystem ? 'medium' : 'low');

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// Absolute roots of agents already registered in <meshRoot>/mesh.json, for the
// alreadyInMesh annotation. Best-effort: a missing/invalid manifest yields an
// empty set (discovery still works, just unannotated).
async function inMeshRoots(meshRoot) {
  try {
    const manifest = JSON.parse(await readFile(join(meshRoot, 'mesh.json'), 'utf8'));
    const roots = new Set();
    for (const a of manifest.agents ?? []) {
      if (typeof a?.root === 'string') roots.add(resolve(meshRoot, a.root));
    }
    return roots;
  } catch { return null; }
}

/**
 * Walk `scanRoot` (bounded depth) and return the candidate agent folders found.
 * Does NOT descend into a folder once it is itself a candidate — an agent's own
 * prompts/ or subfolders are part of that agent, not separate agents.
 *
 * @param {string} scanRoot                 directory to scan.
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=4]        how many levels below scanRoot to walk.
 * @param {string} [opts.meshRoot]          if given, annotate each candidate with
 *                                          `alreadyInMesh` against its mesh.json.
 * @returns {Promise<Array<{path,name,markers,confidence,alreadyInMesh?}>>}
 *          name-sorted; absolute `path`. Never throws — a missing/empty root → [].
 */
export async function discoverAgentCandidates(scanRoot, { maxDepth = 4, meshRoot } = {}) {
  const root = resolve(scanRoot);
  const meshSet = meshRoot != null ? await inMeshRoots(resolve(meshRoot)) : undefined;
  const out = [];

  async function walk(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

    const markers = await markersFor(dir);
    if ((markers.agentJson || markers.agentMd || markers.promptsSystem) && dir !== root) {
      const candidate = {
        path: dir, name: basename(dir), markers, confidence: confidenceOf(markers),
      };
      if (meshSet) candidate.alreadyInMesh = meshSet.has(dir);
      out.push(candidate);
      return; // a candidate is a leaf — do not descend into its internals
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }

  await walk(root, 0);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
