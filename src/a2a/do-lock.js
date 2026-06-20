/**
 * src/a2a/do-lock.js
 *
 * Cross-process advisory file lock for do-mode peer delegation.
 *
 * Lock path: <root>/.agent-mesh/do.lock
 *
 * Acquisition is atomic via O_CREAT|O_EXCL (`open('wx')`).  A stale lock
 * (holder PID no longer alive) is detected via `process.kill(pid, 0)` and
 * broken automatically.  On Windows the same code path works because Node
 * maps signal-0 to a process-existence check (throws ESRCH when absent).
 */

import { open, unlink, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_TIMEOUT_MS, readPositiveInt } from '../config.js';

const LOCK_POLL_MS = 200;

/**
 * Acquire the do-mode advisory lock for `root`.
 *
 * @param {string} root  agent folder (lock lives at <root>/.agent-mesh/do.lock)
 * @param {object} env   process env (reads AGENT_MESH_TIMEOUT_MS)
 * @param {object} [opts]
 *   @param {number} [opts.pollMs]  poll interval while waiting (default 200 ms)
 * @returns {Promise<{ acquired: true, release: Function } | { acquired: false }>}
 */
export async function acquireDoLock(root, env, { pollMs = LOCK_POLL_MS } = {}) {
  const timeoutMs = readPositiveInt(env?.AGENT_MESH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const lockPath = join(root, '.agent-mesh', 'do.lock');
  await mkdir(join(root, '.agent-mesh'), { recursive: true });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // O_CREAT|O_EXCL — atomic; throws EEXIST if another process holds the lock.
      const fh = await open(lockPath, 'wx');
      await fh.write(`${process.pid}\n`);
      await fh.close();
      return {
        acquired: true,
        release: () => unlink(lockPath).catch(() => {})
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (await isLockStale(lockPath)) {
        try { await unlink(lockPath); } catch { /* another process may have raced */ }
        continue; // retry acquisition without sleeping
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { acquired: false };
}

async function isLockStale(lockPath) {
  try {
    const pid = parseInt((await readFile(lockPath, 'utf8')).trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0); // signal 0: existence check only, no actual signal sent
      return false;          // process alive
    } catch (killErr) {
      return killErr.code === 'ESRCH'; // no such process → stale; EPERM → alive
    }
  } catch {
    return true; // unreadable lock file → treat as stale
  }
}
