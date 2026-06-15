// src/board/identity.js — resolve the mesh root and THIS agent's mesh-unique
// name. Mirrors peer-bridge.resolveCallerName but is usable from a hook that
// only knows its cwd (env is consulted first, exactly like serve-mesh-health).
import { realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { readManifest } from '../builder/manifest.js';

export function resolveMeshRoot(env = {}) {
  if (env.AGENT_MESH_MESH_CEILING) return env.AGENT_MESH_MESH_CEILING;
  if (env.AGENT_MESH_MESH_ROOT) return dirname(env.AGENT_MESH_MESH_ROOT);
  return null;
}

// Match the manifest agent whose root realpaths to `root`. Returns the name, or
// null when unresolvable (no mesh, unreadable manifest, no match) — callers must
// treat null as "cannot act" rather than guessing a non-unique basename.
export async function resolveSelfName({ root, env = {} }) {
  const meshRoot = resolveMeshRoot(env);
  if (!meshRoot) return null;
  try {
    const self = await realpath(root);
    const manifest = await readManifest(meshRoot);
    for (const a of (manifest.agents || [])) {
      if (typeof a?.name !== 'string' || typeof a?.root !== 'string') continue;
      const aReal = await realpath(resolve(join(meshRoot, a.root))).catch(() => null);
      if (aReal && aReal === self) return a.name;
    }
  } catch { /* unreadable manifest / missing mesh.json → unresolvable */ }
  return null;
}
