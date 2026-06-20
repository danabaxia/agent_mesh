// scripts/dev-society-deploy-sync.mjs — sync the deploy worktree to origin/main and
// restart the daemon on advance. Reset-to-main is correct for a deploy-only tree
// (self-healing, works on a detached HEAD). Restart is retryable via persisted state.
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planDeploySync } from '../src/dev-society/deploy-sync.js';
import { readBuildBusy } from '../src/dev-society/build-lock.js';

const sh = promisify(execFile);

export async function runGitCap(deployPath, args) {
  const { stdout } = await sh('git', args, { cwd: deployPath, maxBuffer: 1 << 24 });
  return stdout.trim();
}

export function makeFileState(statePath) {
  return {
    readState() {
      try { return JSON.parse(readFileSync(statePath, 'utf8')).lastRestartedTarget || ''; }
      catch { return ''; }
    },
    writeState(targetSha) {
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ lastRestartedTarget: targetSha }));
      renameSync(tmp, statePath);   // atomic replace
    },
  };
}

export function makeLaunchctlRestart(label) {
  return async () => {
    await sh('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { maxBuffer: 1 << 20 });
  };
}

export async function runDeploySyncOnce({
  deployPath, git = runGitCap, restart, readState, writeState,
  buildBusy = () => readBuildBusy(deployPath), now = () => new Date(), log = () => {},
}) {
  const ts = now().toISOString();
  try {
    const head = await git(deployPath, ['rev-parse', 'HEAD']);
    await git(deployPath, ['fetch', 'origin', '--prune', '-q']);   // throws → caught
    const target = await git(deployPath, ['rev-parse', 'origin/main']);
    const lastRestartedTarget = readState();
    // Defer the restart if a coder build is in flight (build.lock fresh) — a restart
    // mid-build orphans the issue (in-progress, no PR). The reset still runs.
    const busy = !!buildBusy();
    const { reset, restart: needRestart, deferredRestart } = planDeploySync({ head, target, lastRestartedTarget, buildBusy: busy });
    if (reset) await git(deployPath, ['reset', '--hard', 'origin/main']);
    let restarted = false;
    if (needRestart) {
      await restart();          // throws → caught below; writeState NOT reached
      writeState(target);       // persist only after a successful restart
      restarted = true;
    }
    const rec = { ts, action: reset ? 'advanced' : 'up_to_date', head, target, reset, restarted, deferredRestart: !!deferredRestart };
    log(rec);
    return rec;
  } catch (error) {
    const rec = { ts, action: 'error', error: error?.message || String(error) };
    log(rec);
    return rec;
  }
}

// CLI: node scripts/dev-society-deploy-sync.mjs  (run from inside the deploy worktree)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deployPath = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const label = process.env.DEV_SOCIETY_DAEMON_LABEL || 'com.danabaxia.agent-mesh.dev-society';
  const statePath = join(deployPath, '.dev-society', 'deploy-sync-state.json');
  const logPath = join(deployPath, '.dev-society', 'deploy-sync.log');
  const { readState, writeState } = makeFileState(statePath);
  const rec = await runDeploySyncOnce({
    deployPath, restart: makeLaunchctlRestart(label), readState, writeState,
    log: (r) => {
      try { mkdirSync(dirname(logPath), { recursive: true });
            writeFileSync(logPath, JSON.stringify(r) + '\n', { flag: 'a' }); } catch { /* best effort */ }
      console.log(r.ts, r.action, r.target || '', r.restarted ? 'restarted' : (r.deferredRestart ? 'restart-deferred(build-busy)' : ''));
    },
  });
  process.exitCode = rec.action === 'error' ? 1 : 0;
}
