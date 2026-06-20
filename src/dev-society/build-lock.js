// src/dev-society/build-lock.js — a tiny cross-process lock the dev-society daemon
// holds while a coder build is in flight (runOneTask). deploy-sync reads it and
// DEFERS the daemon restart until the build finishes: a `launchctl kickstart -k`
// mid-build kills the daemon and orphans the issue (in-progress, no PR — the build
// completed but never got committed/pushed). The reset is harmless (the running
// daemon is already loaded in memory), so only the restart is deferred.
//
// File: <deployRoot>/.dev-society/build.lock  → { issue, pid, ts }. It goes STALE
// after staleMs (the A2A build timeout + margin) so a hung/crashed build can never
// wedge sync forever — once stale, deploy-sync proceeds and restarts.
import { writeFileSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_STALE_MS = 12 * 60 * 1000; // > AGENT_MESH/A2A build timeout (10m) + margin

export function buildLockPath(root) {
  return join(root, '.dev-society', 'build.lock');
}

export function acquireBuildLock(root, { issue, pid, now = () => Date.now() } = {}) {
  const p = buildLockPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ issue: issue ?? null, pid: pid ?? process.pid, ts: now() }));
  return p;
}

export function releaseBuildLock(root) {
  rmSync(buildLockPath(root), { force: true });
}

// Pure decision: is a build in flight? false on absent/stale/corrupt lock content.
export function isBuildBusy(lockContent, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  if (!lockContent) return false;
  let rec;
  try { rec = JSON.parse(lockContent); } catch { return false; }
  const ts = Number(rec?.ts);
  if (!Number.isFinite(ts)) return false;
  return (now - ts) < staleMs;
}

// I/O wrapper: read the lock file and decide. Missing/unreadable → not busy.
export function readBuildBusy(root, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  let content = null;
  try { content = readFileSync(buildLockPath(root), 'utf8'); } catch { return false; }
  return isBuildBusy(content, { now, staleMs });
}
