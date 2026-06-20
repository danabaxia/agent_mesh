// src/dev-society/deploy-sync.js — pure planner for the deploy-worktree sync. No I/O.
// reset:  the worktree is not at origin/main → hard-reset it.
// restart: the daemon has not been restarted onto this target yet (keyed off a
//          persisted lastRestartedTarget) → restart it. Independent of reset so a
//          failed restart is retried on a later tick even when the tree is current.
// buildBusy: a coder build is in flight (see build-lock.js). Restarting the daemon
// mid-build (`launchctl kickstart -k`) kills it and orphans the issue (in-progress,
// no PR — the build finished but never got committed/pushed). So the restart is
// DEFERRED while busy; the reset still proceeds (harmless to the already-loaded
// daemon), and the next tick restarts once the build clears the lock. A STALE lock
// reads as not-busy (build-lock.js), so a hung build can never wedge sync forever.
export function planDeploySync({ head, target, lastRestartedTarget, buildBusy = false } = {}) {
  const t = typeof target === 'string' ? target : '';
  const h = typeof head === 'string' ? head : '';
  const last = typeof lastRestartedTarget === 'string' ? lastRestartedTarget : '';
  const wantRestart = !!t && t !== last;
  return {
    reset: !!t && h !== t,
    restart: wantRestart && !buildBusy,
    deferredRestart: wantRestart && !!buildBusy,
  };
}
