import { refused } from './errors.js';
import { DEFAULT_DEPTH } from './config.js';

export function readCallContext(env, defaultDepth = DEFAULT_DEPTH) {
  const path = typeof env.AGENT_MESH_PATH === 'string' && env.AGENT_MESH_PATH.length > 0
    ? env.AGENT_MESH_PATH.split('\n').filter(Boolean)
    : [];
  const depth = readDepth(env.AGENT_MESH_DEPTH, defaultDepth);
  return { path, depth };
}

export function enterCallContext(root, env, defaultDepth = DEFAULT_DEPTH) {
  const context = readCallContext(env, defaultDepth);
  if (context.path.includes(root)) {
    return {
      ok: false,
      result: refused('cycle', `Refusing delegation cycle into ${root}.`)
    };
  }

  if (context.depth <= 0) {
    return {
      ok: false,
      result: refused('depth_budget', 'Refusing delegation because remaining depth is exhausted.')
    };
  }

  const nextPath = [...context.path, root];
  return {
    ok: true,
    env: {
      AGENT_MESH_PATH: nextPath.join('\n'),
      AGENT_MESH_DEPTH: String(context.depth - 1)
    },
    context: {
      path: nextPath,
      depth: context.depth - 1
    }
  };
}

function readDepth(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
