#!/usr/bin/env node
// SessionStart hook: surface this agent's inbound assignments and outbound
// completions from the mesh task board. Read-only to the model; it injects
// context, never instructions. Flips seen_by_from for surfaced completions so
// the assigner is notified exactly once. Fails OPEN (no context) on any error —
// a board problem must never block an interactive session.
import { realpath, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveMeshRoot, resolveSelfName } from '../src/board/identity.js';
import { listTasks, markSeenByFrom } from '../src/board/store.js';
import { selectNotices, renderBoardNotice } from '../src/board/notify.js';

function emit(context) {
  if (context) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context }
    }));
  }
  process.exit(0);
}

// Walk up from the agent root to the first dir containing mesh.json.
async function findMeshCeiling(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    try { await access(join(dir, 'mesh.json')); return dir; } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

try {
  let payload = {};
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    payload = JSON.parse(text || '{}');
  } catch { /* no/!JSON stdin → use cwd */ }

  const cwd = payload?.cwd || process.cwd();
  const root = await realpath(cwd).catch(() => cwd);
  const env = process.env;

  // Mesh root: env first, else walk up from the agent root.
  const meshRoot = resolveMeshRoot(env) || (await findMeshCeiling(root));
  if (!meshRoot) emit('');

  const name = await resolveSelfName({ root, env: { ...env, AGENT_MESH_MESH_CEILING: meshRoot } });
  if (!name) emit('');

  const tasks = await listTasks(meshRoot);
  const notices = selectNotices(tasks, name);
  for (const t of notices.outboundDone) await markSeenByFrom(meshRoot, t.id);
  emit(renderBoardNotice(notices));
} catch {
  emit(''); // fail open
}
