/**
 * src/dashboard/session-exec.js — the per-turn lease owner.
 *
 * argv contract (after `session-exec`):
 *   <lockPath> <token> <claudeBin> -- <claude args...>
 *
 * As its FIRST action it self-registers the `running` lease with its OWN pid
 * (before spawning claude), then spawns `claude` in its own process group,
 * records the child identity into the lease, pipes the child's stdout straight
 * through to our stdout (which the dashboard runner reads), and on child exit
 * token-checked-releases the lease. Driving the lease from the process whose
 * lifetime == the turn closes the crash/TOCTOU window (spec §6).
 */
import { spawn } from 'node:child_process';
import { registerRunning, releaseLease, probePid } from './session-lease.js';
import { resolveSpawnTarget } from '../process.js';

export async function runSessionExec(argv) {
  const sep = argv.indexOf('--');
  const [lockPath, token, claudeBin] = argv.slice(0, 3);
  const claudeArgs = argv.slice(sep + 1);
  const selfProbe = probePid(process.pid);

  // Spawn claude as a normal child INSIDE this wrapper's process group (the
  // runner spawns the wrapper `detached`, so the wrapper is the group leader and
  // its pid IS the group id). One `kill(-wrapperPid)` then reaps wrapper+claude
  // together — used by takeover and stop. stdout/stderr inherit our streams so
  // claude's stream-json flows straight to the runner.
  const t = resolveSpawnTarget(claudeBin, claudeArgs);
  const child = spawn(t.cmd, t.args, { stdio: ['ignore', 'inherit', 'inherit'], shell: t.shell, windowsHide: true });

  // Record child identity into the lease BEFORE anything else. childPgid is the
  // wrapper's own pid (the group leader), so a group-kill reaps claude even if
  // the wrapper has already exited.
  await registerRunning(lockPath, {
    token,
    pid: process.pid, procStartedAt: selfProbe.procStartedAt,
    childPid: child.pid, childProcStartedAt: probePid(child.pid).procStartedAt, childPgid: process.pid,
    now: Date.now()
  });

  const code = await new Promise((res) => {
    child.on('exit', (c) => res(c ?? 0));
    child.on('error', () => res(1));
  });
  await releaseLease(lockPath, token);
  process.exitCode = code;
}
