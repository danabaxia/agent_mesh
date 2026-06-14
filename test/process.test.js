import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnFile, killProcessTree, resolveSpawnTarget } from '../src/process.js';

// A parent script that spawns a grandchild (NOT detached, so it stays in the
// parent's process group) which records its own pid and then lives forever.
// `ignoreSigterm` makes the grandchild trap SIGTERM so only SIGKILL reaps it.
async function writeTreeScript({ ignoreSigterm, parentIgnoreSigterm } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-mesh-tree-'));
  const pidFile = join(dir, 'grandchild.pid');
  const grandchild = join(dir, 'grandchild.mjs');
  const parent = join(dir, 'parent.mjs');
  await writeFile(
    grandchild,
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(process.env.PID_FILE, String(process.pid));\n` +
      (ignoreSigterm ? `process.on('SIGTERM', () => {});\n` : '') +
      `setInterval(() => {}, 1000);\n`,
    'utf8'
  );
  await writeFile(
    parent,
    `import { spawn } from 'node:child_process';\n` +
      (parentIgnoreSigterm ? `process.on('SIGTERM', () => {});\n` : '') +
      `process.stdout.write('parent up\\n');\n` +
      `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore', env: process.env });\n` +
      `setInterval(() => {}, 1000);\n`,
    'utf8'
  );
  await chmod(parent, 0o755);
  return { parent, pidFile };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function readPid(pidFile) {
  try {
    const text = (await readFile(pidFile, 'utf8')).trim();
    return text ? Number(text) : null;
  } catch {
    return null;
  }
}

test('spawnFile timeout kills the whole process tree, not just the direct child', async () => {
  const { parent, pidFile } = await writeTreeScript({ ignoreSigterm: false });

  // Ordering matters: the grandchild must RECORD its pid before the timeout-driven
  // kill reaps the tree, else the pidfile never appears and the assert below is
  // unwinnable. A short (1.2s) timeout raced TWO cold Node starts (parent →
  // grandchild) plus the pid write on loaded Windows CI runners — the tree was
  // killed before the grandchild wrote its pid, so the test flaked (the old 15s
  // pidfile wait only delayed the inevitable failure, since the tree was already
  // dead). Fix: give the tree a generous budget to fully come up, CONFIRM it is
  // up (pidfile present) well WITHIN that budget, and only then await the
  // timeout-driven kill — which is the behavior this test actually verifies.
  const KILL_TIMEOUT_MS = 6000;
  const pending = spawnFile(process.execPath, [parent], {
    env: { ...process.env, PID_FILE: pidFile },
    timeoutMs: KILL_TIMEOUT_MS,
    detached: true
  });

  // The pidfile must appear before the timeout fires; the deadline is < the
  // timeout so a confirmed pid means "tree fully up, kill has not run yet".
  const recorded = await waitFor(async () => (await readPid(pidFile)) !== null, KILL_TIMEOUT_MS - 1000);
  const grandchildPid = await readPid(pidFile);
  assert.equal(recorded, true, 'grandchild should have recorded its pid before the timeout kill');
  assert.ok(grandchildPid, 'grandchild should have recorded its pid');

  const result = await pending;
  assert.equal(result.timedOut, true);

  const died = await waitFor(() => !isAlive(grandchildPid), 5000);
  assert.equal(died, true, `grandchild ${grandchildPid} must be killed with the tree`);
});

test('spawnFile timeout does not resolve until the killed tree is actually dead (lock held until death)', async () => {
  // Parent and grandchild both ignore SIGTERM, so the tree only dies once
  // killProcessTree escalates to SIGKILL (~KILL_ESCALATION_MS after the
  // timeout). If spawnFile resolved at the timeout instant it would return
  // well before that — the lock would release while the worker is still alive.
  const { parent, pidFile } = await writeTreeScript({ ignoreSigterm: true, parentIgnoreSigterm: true });

  const start = Date.now();
  const result = await spawnFile(process.execPath, [parent], {
    env: { ...process.env, PID_FILE: pidFile },
    timeoutMs: 300,
    detached: true
  });
  const elapsed = Date.now() - start;

  assert.equal(result.timedOut, true);
  // The SIGKILL-escalation timing lower-bound is POSIX-specific: it relies on the
  // tree IGNORING SIGTERM so it survives until the SIGKILL escalation. On Windows
  // `process.on('SIGTERM')` is emulated and `taskkill /T` may reap the process
  // immediately, so the tree can die BEFORE the escalation window — making
  // `elapsed >= 1800` an intermittent false failure (it flaked once on CI: green
  // on one branch, red on another for the identical commit). Assert the timing
  // only on POSIX; the cross-platform invariant — spawnFile does not resolve with
  // the tree still dangling — is the `died` check below and holds on both.
  if (process.platform !== 'win32') {
    assert.ok(elapsed >= 1800, `expected to wait for tree death, resolved after only ${elapsed}ms`);
  }

  const grandchildPid = await readPid(pidFile);
  const died = await waitFor(() => !isAlive(grandchildPid), 3000);
  assert.equal(died, true, 'the whole tree must be dead by the time spawnFile resolves');
});

test('resolveSpawnTarget: a concrete .cmd npm shim is followed to its wrapped target (no spawn EINVAL)',
  { skip: process.platform !== 'win32' ? 'win32-only concrete-path spawn semantics' : false }, async () => {
  // Regression: AGENT_MESH_CLAUDE=C:\...\claude.cmd took the concrete-path branch
  // and was spawned as a bare .cmd (shell:false) → `spawn EINVAL` on modern Node.
  // A concrete .cmd must be followed to its wrapped .exe/.js like the bare-name case.
  const dir = await mkdtemp(join(tmpdir(), 'agent-mesh-shim-'));
  const cmdShim = join(dir, 'claude.cmd');
  // Same shape as a real npm cmd shim, but wrapping a .js so we can assert the
  // node+script resolution without needing a real .exe on disk.
  await writeFile(
    cmdShim,
    '@ECHO off\r\n:find_dp0\r\nSET dp0=%~dp0\r\n:start\r\n"%dp0%\\sub\\cli.js"   %*\r\n',
    'utf8'
  );
  const t = resolveSpawnTarget(cmdShim, ['-p', 'hi']);
  assert.equal(t.shell, false, 'a parseable shim must resolve to a directly-spawnable target, not shell-exec the .cmd');
  assert.equal(t.cmd, process.execPath, 'a .js-wrapped shim runs via the current node');
  assert.deepEqual(t.args, [join(dir, 'sub', 'cli.js'), '-p', 'hi']);
});

test('killProcessTree escalates to SIGKILL for a tree that ignores SIGTERM', async () => {
  const { parent, pidFile } = await writeTreeScript({ ignoreSigterm: true });

  const child = spawn(process.execPath, [parent], {
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, PID_FILE: pidFile }
  });

  const ready = await waitFor(async () => (await readPid(pidFile)) !== null, 5000);
  assert.equal(ready, true, 'grandchild should start');
  const grandchildPid = await readPid(pidFile);

  // Short escalation window so the test stays fast.
  killProcessTree(child, 200);

  const died = await waitFor(() => !isAlive(grandchildPid), 5000);
  assert.equal(died, true, `SIGTERM-ignoring grandchild ${grandchildPid} must be SIGKILLed`);
});
