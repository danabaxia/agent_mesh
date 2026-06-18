import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sh = promisify(execFile);

export const DEFAULT_IGNORE_PREFIXES = ['.dev-society/'];

export function parsePorcelainZ(output = '') {
  const parts = String(output).split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!/^[ MARC DU?!]{2} /.test(entry)) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status[0] === 'R' || status[0] === 'C') i += 1;
  }
  return paths;
}

export function filterDirtyPaths(paths = [], ignorePrefixes = DEFAULT_IGNORE_PREFIXES) {
  return paths
    .map((p) => String(p).replace(/\\/g, '/'))
    .filter((p) => p && !ignorePrefixes.some((prefix) => p === prefix || p.startsWith(prefix)));
}

export function parseAheadBehind(output = '') {
  const [ahead = 0, behind = 0] = String(output).trim().split(/\s+/).map((n) => Number(n));
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
}

export function planRepoSync({ upstream, dirtyPaths = [], ahead = 0, behind = 0 } = {}) {
  if (!upstream) return { action: 'skip_no_upstream' };
  if (dirtyPaths.length) return { action: 'skip_dirty', dirtyPaths };
  if (ahead > 0 && behind > 0) return { action: 'skip_diverged', ahead, behind };
  if (ahead > 0) return { action: 'skip_ahead', ahead };
  if (behind > 0) return { action: 'fast_forward', behind };
  return { action: 'up_to_date' };
}

export async function runGit(repoPath, args) {
  const { stdout } = await sh('git', args, { cwd: repoPath, maxBuffer: 1 << 24 });
  return stdout;
}

export async function runRepoSyncOnce({
  repoPath,
  git = runGit,
  log = () => {},
  now = () => new Date(),
  ignorePrefixes = DEFAULT_IGNORE_PREFIXES,
} = {}) {
  if (!repoPath) throw new Error('repoPath is required');

  try {
    await git(repoPath, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    // Not a git worktree — return a structured record (failure-is-data) for
    // consistency with skip_detached / skip_no_upstream, instead of throwing.
    const rec = { ts: now().toISOString(), action: 'skip_not_git', repoPath };
    log(rec);
    return rec;
  }
  let branch;
  try {
    branch = (await git(repoPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
  } catch {
    branch = '';
  }
  if (!branch) {
    const rec = { ts: now().toISOString(), action: 'skip_detached', repoPath };
    log(rec);
    return rec;
  }

  let upstream = '';
  try {
    upstream = (await git(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  } catch {
    const rec = { ts: now().toISOString(), action: 'skip_no_upstream', repoPath, branch };
    log(rec);
    return rec;
  }

  const remote = (await git(repoPath, ['config', `branch.${branch}.remote`])).trim() || 'origin';
  await git(repoPath, ['fetch', '--prune', remote, '-q']);

  const rawDirty = parsePorcelainZ(await git(repoPath, ['status', '--porcelain=v1', '-z']));
  const dirtyPaths = filterDirtyPaths(rawDirty, ignorePrefixes);
  const { ahead, behind } = parseAheadBehind(await git(repoPath, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]));
  const plan = planRepoSync({ upstream, dirtyPaths, ahead, behind });
  const rec = { ts: now().toISOString(), repoPath, branch, upstream, ahead, behind, ...plan };

  if (plan.action === 'fast_forward') {
    await git(repoPath, ['merge', '--ff-only', upstream]);
    rec.action = 'fast_forwarded';
  }

  log(rec);
  return rec;
}
