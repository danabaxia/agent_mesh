// Single-instance dashboard: reap a prior dashboard on the same port (via a
// port-scoped pidfile) before launching a new one. All process/fs I/O is
// injectable so the reap logic is hermetically testable with a fake process table.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync, rmSync as fsRmSync } from 'node:fs';

export function pidfilePath(port, dir = tmpdir()) {
  return join(dir, `agent-mesh-dashboard-${port}.pid`);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// process.kill(pid, 0): throws ESRCH if dead, EPERM if alive-but-not-ours.
export function isAlive(pid, signalKill = process.kill) {
  try { signalKill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * Reap the prior dashboard recorded in the pidfile. Graceful (SIGTERM) → grace
 * poll → forceful (SIGKILL). Fail-open for launch (signal errors swallowed)
 * EXCEPT the --no-replace refusal, which throws.
 * @returns {Promise<{action:'none'|'stale'|'reaped', pid?:number}>}
 */
export async function reapExisting({ pidfile, replace = true, signalKill = process.kill, sleep = defaultSleep, readFileSync = fsReadFileSync, log = () => {}, graceMs = 3000, pollMs = 100 }) {
  let pid;
  try { pid = JSON.parse(readFileSync(pidfile, 'utf8')).pid; } catch { return { action: 'none' }; }
  if (typeof pid !== 'number' || pid <= 0 || pid === process.pid) return { action: 'none' };
  if (!isAlive(pid, signalKill)) return { action: 'stale', pid };
  if (!replace) { const e = new Error(`a dashboard is already running (pid ${pid}); stop it or use a different --port`); e.code = 'DASHBOARD_RUNNING'; throw e; }
  log(`single-instance: reaping prior dashboard pid ${pid}…`);
  try { signalKill(pid, 'SIGTERM'); } catch { /* already gone */ }
  let waited = 0;
  while (waited < graceMs) {
    await sleep(pollMs); waited += pollMs;
    if (!isAlive(pid, signalKill)) return { action: 'reaped', pid };
  }
  try { signalKill(pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(pollMs);
  return { action: 'reaped', pid };
}

export function writePidfile(pidfile, { pid, port, now }, { writeFileSync = fsWriteFileSync } = {}) {
  try { writeFileSync(pidfile, JSON.stringify({ pid, port, startedAt: now })); } catch { /* best-effort */ }
}

export function removePidfile(pidfile, { rmSync = fsRmSync } = {}) {
  try { rmSync(pidfile, { force: true }); } catch { /* best-effort */ }
}
