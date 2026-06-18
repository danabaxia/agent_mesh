import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterDirtyPaths,
  parseAheadBehind,
  parsePorcelainZ,
  planRepoSync,
  runRepoSyncOnce,
} from '../src/dev-society/repo-sync.js';

test('parsePorcelainZ extracts dirty paths from git status -z output', () => {
  const paths = parsePorcelainZ(' M src/a.js\0?? docs/new file.md\0R  new.js\0old.js\0');
  assert.deepEqual(paths, ['src/a.js', 'docs/new file.md', 'new.js']);
});

test('filterDirtyPaths ignores local dev-society runtime state only', () => {
  const dirty = filterDirtyPaths([
    '.dev-society/',
    '.dev-society/daemon.log',
    'src/a.js',
    '.github/workflows/dev-mesh-pr-janitor.yml',
  ]);

  assert.deepEqual(dirty, ['src/a.js', '.github/workflows/dev-mesh-pr-janitor.yml']);
});

test('parseAheadBehind reads git rev-list --left-right --count output', () => {
  assert.deepEqual(parseAheadBehind('0\t6\n'), { ahead: 0, behind: 6 });
});

test('planRepoSync fast-forwards only when clean and behind', () => {
  assert.equal(planRepoSync({ upstream: 'origin/main', dirtyPaths: [], ahead: 0, behind: 6 }).action, 'fast_forward');
  assert.equal(planRepoSync({ upstream: 'origin/main', dirtyPaths: ['src/a.js'], ahead: 0, behind: 6 }).action, 'skip_dirty');
  assert.equal(planRepoSync({ upstream: 'origin/main', dirtyPaths: [], ahead: 2, behind: 6 }).action, 'skip_diverged');
  assert.equal(planRepoSync({ upstream: 'origin/main', dirtyPaths: [], ahead: 2, behind: 0 }).action, 'skip_ahead');
  assert.equal(planRepoSync({ upstream: 'origin/main', dirtyPaths: [], ahead: 0, behind: 0 }).action, 'up_to_date');
  assert.equal(planRepoSync({ upstream: '', dirtyPaths: [], ahead: 0, behind: 0 }).action, 'skip_no_upstream');
});

test('runRepoSyncOnce uses old-git-compatible branch detection before fast-forwarding', async () => {
  const calls = [];
  const outputs = new Map([
    ['rev-parse --is-inside-work-tree', 'true\n'],
    ['symbolic-ref --quiet --short HEAD', 'v0.5-development\n'],
    ['rev-parse --abbrev-ref --symbolic-full-name @{u}', 'origin/v0.5-development\n'],
    ['config branch.v0.5-development.remote', 'origin\n'],
    ['fetch --prune origin -q', ''],
    ['status --porcelain=v1 -z', ''],
    ['rev-list --left-right --count HEAD...origin/v0.5-development', '0\t1\n'],
    ['merge --ff-only origin/v0.5-development', ''],
  ]);
  const records = [];
  const rec = await runRepoSyncOnce({
    repoPath: '/repo',
    now: () => new Date('2026-06-17T00:00:00.000Z'),
    log: (r) => records.push(r),
    git: async (_repoPath, args) => {
      const key = args.join(' ');
      calls.push(key);
      if (!outputs.has(key)) throw new Error(`unexpected git call: ${key}`);
      return outputs.get(key);
    },
  });

  assert.equal(rec.action, 'fast_forwarded');
  assert.equal(rec.branch, 'v0.5-development');
  assert.equal(records.length, 1);
  assert.equal(calls.includes('branch --show-current'), false);
  assert.equal(calls.includes('symbolic-ref --quiet --short HEAD'), true);
});
