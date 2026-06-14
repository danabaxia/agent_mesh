import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { spawnFile } from './process.js';

// The framework's own bookkeeping dir (run logs, hook denial logs) is never
// "agent work" — exclude it from change detection so writing a run log (now a
// START log + a FINAL log) can never appear in files_changed or flip
// preexisting_dirty. Matches the AGENT_MESH_LOG_DIR convention (`.agent-mesh/…`).
const FRAMEWORK_DIR = '.agent-mesh';
function isFrameworkPath(p) {
  return p === FRAMEWORK_DIR || p.startsWith(FRAMEWORK_DIR + '/');
}

export async function captureChangeState(root) {
  const git = await gitStatus(root);
  if (git.ok) {
    const files = git.files.filter((file) => !isFrameworkPath(file.path));
    return {
      kind: 'git',
      porcelain: new Map(files.map((file) => [file.path, file.status])),
      hashes: await hashGitVisibleFiles(root, files)
    };
  }
  return { kind: 'none' };
}

export async function computeFilesChanged(root, before) {
  if (before.kind !== 'git') {
    return {
      files_changed: null,
      note: 'untracked (not a git repo)'
    };
  }

  const afterStatus = await gitStatus(root);
  if (!afterStatus.ok) {
    return {
      files_changed: null,
      best_effort: true
    };
  }

  const afterFiles = afterStatus.files.filter((file) => !isFrameworkPath(file.path));
  const afterHashes = await hashGitVisibleFiles(root, afterFiles);
  const changed = new Set();

  // Porcelain DELTA, not the union: a file is changed if it is new or its
  // git status differs from the pre-run snapshot. A file that was already
  // dirty before the run and is untouched (same status, same content) is
  // preexisting_dirty — NOT a delta — so it must not appear in
  // files_changed. (PROJECT.md pins "porcelain delta ∪ digest-changed".)
  for (const file of afterFiles) {
    if (before.porcelain.get(file.path) !== file.status) changed.add(file.path);
  }

  // Content-digest change catches re-modifying an already-dirty file (and a
  // run that reverts a dirty file back to HEAD) where the status is unchanged.
  const allHashed = new Set([...before.hashes.keys(), ...afterHashes.keys()]);
  for (const file of allHashed) {
    if (before.hashes.get(file) !== afterHashes.get(file)) changed.add(file);
  }

  return {
    files_changed: [...changed].sort(),
    preexisting_dirty: before.porcelain.size > 0 || undefined
  };
}

async function gitStatus(root) {
  const result = await spawnFile('git', ['status', '--porcelain=v1', '-z'], {
    cwd: root,
    timeoutMs: 10_000
  });
  if (result.code !== 0) return { ok: false, files: [] };

  return { ok: true, files: parsePorcelainZ(result.stdout) };
}

// `git status --porcelain=v1 -z` is NUL-terminated, and a rename/copy (status
// starting with R or C) is encoded as TWO NUL-separated fields: the new path,
// then the original path (`R  new\0old\0`) — there is no ` -> ` marker in -z
// mode. We must consume that second field, tracking the rename's destination as
// the changed path and its source as a separate deletion so files_changed stays
// accurate.
function parsePorcelainZ(stdout) {
  const fields = stdout.split('\0');
  // Trailing '' after the last NUL terminator is not an entry.
  if (fields.length && fields[fields.length - 1] === '') fields.pop();

  const files = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if (status[0] === 'R' || status[0] === 'C') {
      // The next field is the rename/copy source path.
      const from = fields[++i];
      files.push({ status, path });
      if (from && status[0] === 'R') files.push({ status: ' D', path: from });
    } else {
      files.push({ status, path });
    }
  }
  return files;
}

async function hashGitVisibleFiles(root, statusFiles) {
  const tracked = await spawnFile('git', ['ls-files', '-z'], {
    cwd: root,
    timeoutMs: 10_000
  });
  if (tracked.code !== 0) return new Map();

  const files = new Set(tracked.stdout.split('\0').filter(Boolean).filter((p) => !isFrameworkPath(p)));
  for (const file of statusFiles) files.add(file.path);

  const hashes = new Map();
  for (const file of files) {
    const abs = join(root, file);
    try {
      const fileStat = await stat(abs);
      if (!fileStat.isFile()) continue;
      const content = await readFile(abs);
      hashes.set(file, createHash('sha256').update(content).digest('hex'));
    } catch {
      hashes.set(file, null);
    }
  }
  return hashes;
}

export async function listFilesRecursive(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      if (entry.isFile()) out.push(relative(root, abs));
    }
  }
  await walk(root);
  return out.sort();
}
