// src/dev-society/deploy-sync.js — pure planner for the deploy-worktree sync. No I/O.
// reset:  the worktree is not at origin/main → hard-reset it.
// restart: the daemon has not been restarted onto this target yet (keyed off a
//          persisted lastRestartedTarget) → restart it. Independent of reset so a
//          failed restart is retried on a later tick even when the tree is current.
export function planDeploySync({ head, target, lastRestartedTarget } = {}) {
  const t = typeof target === 'string' ? target : '';
  const h = typeof head === 'string' ? head : '';
  const last = typeof lastRestartedTarget === 'string' ? lastRestartedTarget : '';
  return { reset: !!t && h !== t, restart: !!t && t !== last };
}
