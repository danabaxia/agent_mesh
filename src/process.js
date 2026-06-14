import { spawn, execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, isAbsolute, extname, dirname } from 'node:path';

/**
 * Resolve a command to a directly-spawnable target for the current platform,
 * WITHOUT a shell — so the large `-p <prompt>` / `--mcp-config <path>` args never
 * face cmd.exe quoting. Handles:
 *   - *.js / *.mjs / *.cjs  → run via the current node (process.execPath). This
 *     covers the test fake-claude and any node-script bin on every platform.
 *   - win32 bare `claude`   → modern Node refuses to spawn a `.cmd`/`.bat` without
 *     a shell (CVE-2024-27980), and the real binary lives in a nested npm dir not
 *     on PATH. We find the npm `.cmd` shim on PATH and follow it to the wrapped
 *     `.exe` (or `.js`), which IS directly spawnable.
 * Returns { cmd, args, shell }.
 */
export function resolveSpawnTarget(command, args) {
  if (/\.(c|m)?js$/i.test(command)) {
    return { cmd: process.execPath, args: [command, ...args], shell: false };
  }
  if (process.platform !== 'win32') return { cmd: command, args, shell: false };
  // A concrete path or an explicit extension → spawn it (or node it) directly.
  if (isAbsolute(command) || command.includes('\\') || command.includes('/') || extname(command)) {
    return resolveConcreteWin(command, args);
  }
  // Bare command: search PATH. Prefer a real .exe, else follow a .cmd shim.
  const dirs = (process.env.PATH || process.env.Path || '').split(';').filter(Boolean);
  for (const d of dirs) {
    const exe = join(d, command + '.exe');
    if (existsSync(exe)) return { cmd: exe, args, shell: false };
  }
  for (const d of dirs) {
    const cmdShim = join(d, command + '.cmd');
    if (existsSync(cmdShim)) {
      const target = parseNpmCmdShim(cmdShim);
      if (target) return resolveConcreteWin(target, args);
      // Rare last resort: the npm .cmd shim can't be parsed. shell:true means
      // cmd.exe on win32 (EDR-visible), accepted only because the alternative is
      // a hard spawn failure. The marker exempts the lone vetted exception.
      return { cmd: cmdShim, args, shell: true }; // cmd-exe-allow: vetted shim fallback
    }
  }
  return { cmd: command, args, shell: false };
}

function resolveConcreteWin(target, args) {
  if (/\.(c|m)?js$/i.test(target)) {
    return { cmd: process.execPath, args: [target, ...args], shell: false };
  }
  // A concrete `.cmd`/`.bat` path (e.g. AGENT_MESH_CLAUDE=C:\...\claude.cmd) can't
  // be spawned without a shell on modern Node (CVE-2024-27980) → `spawn EINVAL`.
  // Follow the npm shim to its wrapped `.exe`/`.js` (directly spawnable); fall
  // back to shell:true only if the shim can't be parsed.
  if (/\.(cmd|bat)$/i.test(target)) {
    const wrapped = parseNpmCmdShim(target);
    if (wrapped) return resolveConcreteWin(wrapped, args);
    // Rare last resort: a concrete .cmd/.bat that can't be parsed (see above).
    return { cmd: target, args, shell: true }; // cmd-exe-allow: vetted shim fallback
  }
  return { cmd: target, args, shell: false };
}

// npm `.cmd` shims invoke e.g.  "%dp0%\node_modules\...\bin\claude.exe"  %*
// (or `node "%dp0%\..\cli.js"`). Extract that wrapped .exe/.js path, resolving
// %dp0% / %~dp0 to the shim's own directory.
function parseNpmCmdShim(cmdPath) {
  let text;
  try { text = readFileSync(cmdPath, 'utf8'); } catch { return null; }
  const dir = dirname(cmdPath);
  const m = text.match(/"%~?dp0%\\?([^"]+\.(?:exe|c?js|mjs))"/i);
  if (m) return join(dir, m[1]);
  return null;
}

export function spawnFile(command, args, options = {}) {
  return new Promise((resolve) => {
    // Test-only seam (auto-update spawn-race coverage). The live race is the npm
    // updater briefly DELETING the real `claude` binary (a concrete `.exe` / bare
    // PATH command) so the spawn fails with a `spawn … ENOENT` error EVENT — the
    // exact signature delegate.js's backoff retry keys on. A `.mjs` fake-claude
    // can't reproduce that: resolveSpawnTarget reroutes it to `node <path>`, and
    // `node` always exists, so a missing `.mjs` yields exit-1/MODULE_NOT_FOUND
    // (no `error`), and the retry never fires. When AGENT_MESH_TEST_SPAWN_ENOENT_WHEN_ABSENT
    // is set, treat an ABSENT command path as the real missing-binary case:
    // synthesize the identical ENOENT error result instead of spawning `node`.
    // Unset in production → zero effect. Gated to a concrete (non-bare) path so
    // it can never mask a real PATH lookup.
    if (
      (options.env?.AGENT_MESH_TEST_SPAWN_ENOENT_WHEN_ABSENT || process.env.AGENT_MESH_TEST_SPAWN_ENOENT_WHEN_ABSENT) &&
      (isAbsolute(command) || command.includes('\\') || command.includes('/')) &&
      !existsSync(command)
    ) {
      const error = new Error(`spawn ${command} ENOENT`);
      error.code = 'ENOENT';
      error.errno = -2;
      error.syscall = `spawn ${command}`;
      error.path = command;
      resolve({ code: null, signal: null, stdout: '', stderr: error.message, error });
      return;
    }
    const t = resolveSpawnTarget(command, args);
    const cmd = t.cmd;
    const cmdArgs = t.args;
    const child = spawn(cmd, cmdArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: Boolean(options.detached),
      shell: t.shell,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let backstop = null;
    let probe = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (backstop) clearTimeout(backstop);
      if (probe) clearInterval(probe);
      resolve(result);
    };

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          timedOut = true;
          killProcessTree(child);
          // Do NOT resolve yet: the serialization lock is released when this
          // promise settles, so we must hold it until the worker TREE is
          // actually dead — otherwise a still-alive (acceptEdits) worker can
          // keep writing the folder while the next `do` task spawns. On POSIX
          // the 'close' handler below resolves once the SIGTERM-ignoring leader
          // dies at SIGKILL escalation. On win32 there is no 'close'-guaranteed
          // tree death, so we ALSO poll the leader pid (`process.kill(pid, 0)`
          // liveness works on win32 in Node) until it is reaped, THEN finish —
          // mirroring the POSIX contract that resolution waits for the tree to
          // actually die. The backstop is a last resort for a truly unkillable
          // process, so we never hang.
          if (child.pid) {
            probe = setInterval(() => {
              let alive = true;
              try { process.kill(child.pid, 0); } catch { alive = false; }
              if (!alive) finish({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut: true });
            }, 100);
            probe.unref?.();
          }
          backstop = setTimeout(() => {
            finish({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut: true });
          }, KILL_ESCALATION_MS + 3_000);
          backstop.unref?.();
        }, options.timeoutMs)
      : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      finish({ code: null, signal: null, stdout, stderr: `${stderr}${error.message}`, error });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut });
    });
  });
}

// Default grace before escalating SIGTERM → SIGKILL on a process tree that
// refuses to exit. Overridable mainly so tests can keep it short.
export const KILL_ESCALATION_MS = 2_000;

export function killProcessTree(child, escalationMs = KILL_ESCALATION_MS) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // On Windows there are no process groups / POSIX signals, so we mirror the
    // POSIX SIGTERM → (grace) → SIGKILL escalation with taskkill: a GRACEFUL
    // `taskkill /T` first (requests termination of the tree), then a FORCEFUL
    // `taskkill /T /F` after escalationMs. A console process that traps/ignores
    // the graceful request (the test's SIGTERM-trapping tree) survives the grace
    // window and only dies at the forceful kill — exactly like the POSIX path,
    // so spawnFile's resolution (gated on the leader actually dying) does not
    // race ahead of tree death. execFile failures (e.g. taskkill missing →
    // ENOENT) arrive as an 'error' EVENT that would crash the process if
    // unhandled; attach a handler that falls back to a direct SIGKILL.
    const graceful = execFile('taskkill', ['/pid', String(child.pid), '/T'], { windowsHide: true });
    graceful.on('error', () => { /* graceful best-effort; forceful kill follows */ });
    const escalate = setTimeout(() => {
      const tk = execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      tk.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
    }, escalationMs);
    escalate.unref?.();
    return;
  }
  signalTree(child, 'SIGTERM');
  // Any group member that traps/ignores SIGTERM — including a grandchild that
  // outlives the group leader — would otherwise survive the timeout and leak.
  // Follow up with an unmaskable SIGKILL to the whole group. We cannot cheaply
  // tell whether stragglers remain, so we always escalate; if the group is
  // already gone the signal is a harmless ESRCH (caught below). unref() so this
  // timer never keeps the event loop (or the test runner) alive on its own.
  const escalate = setTimeout(() => signalTree(child, 'SIGKILL'), escalationMs);
  escalate.unref?.();
}

/**
 * Kill a process tree given only a bare pid (the group leader / wrapper pid),
 * platform-aware — for cross-process takeover where we have a pid from a lease
 * file, not a ChildProcess handle. POSIX: SIGKILL the process group (`-pid`).
 * win32: `taskkill /pid <pid> /T /F` (recursive), with the async-error guard.
 */
export function killTreeByPid(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const tk = execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      tk.on('error', () => { /* taskkill missing → nothing more we can do with a bare pid */ });
    } catch { /* ignore */ }
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
}

function signalTree(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}
