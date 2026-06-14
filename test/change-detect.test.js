import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { captureChangeState, computeFilesChanged } from '../src/change-detect.js';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync('git', args, { cwd });
}

async function createGitRepo() {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-cd-'));
  await git(root, ['init']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  return root;
}

async function commit(root, file, content) {
  await writeFile(join(root, file), content);
  await git(root, ['add', file]);
  await git(root, ['commit', '-m', `add ${file}`]);
}

test('a file dirty before the run and left untouched is preexisting_dirty, NOT a delta', async () => {
  const root = await createGitRepo();
  await writeFile(join(root, 'dirty.txt'), 'v1'); // untracked, dirty before the run

  const before = await captureChangeState(root);
  // ...run touches nothing...
  const changed = await computeFilesChanged(root, before);

  assert.deepEqual(changed.files_changed, [], 'untouched preexisting-dirty file must not appear');
  assert.equal(changed.preexisting_dirty, true);
});

test('re-touching an already-dirty file with unchanged git status is caught by the content digest', async () => {
  const root = await createGitRepo();
  await writeFile(join(root, 'dirty.txt'), 'v1'); // untracked (status ??) before the run

  const before = await captureChangeState(root);
  await writeFile(join(root, 'dirty.txt'), 'v2'); // still untracked (status stays ??)
  const changed = await computeFilesChanged(root, before);

  assert.deepEqual(changed.files_changed, ['dirty.txt']);
});

test('reverting a dirty tracked file back to HEAD is still reported as changed', async () => {
  const root = await createGitRepo();
  await commit(root, 'tracked.txt', 'orig');
  await writeFile(join(root, 'tracked.txt'), 'changed'); // dirty before the run

  const before = await captureChangeState(root);
  await writeFile(join(root, 'tracked.txt'), 'orig'); // run reverts it — status becomes clean
  const changed = await computeFilesChanged(root, before);

  assert.deepEqual(changed.files_changed, ['tracked.txt']);
});

test('a clean file untouched across the run is not reported', async () => {
  const root = await createGitRepo();
  await commit(root, 'tracked.txt', 'orig');

  const before = await captureChangeState(root);
  const changed = await computeFilesChanged(root, before);

  assert.deepEqual(changed.files_changed, []);
});

test('porcelain -z rename is parsed without garbage paths (new + old, not "xt")', async () => {
  const root = await createGitRepo();
  await commit(root, 'a.txt', 'hello');

  const before = await captureChangeState(root);
  await git(root, ['mv', 'a.txt', 'b.txt']); // staged rename -> porcelain "R  b.txt\0a.txt\0"
  const changed = await computeFilesChanged(root, before);

  assert.deepEqual(changed.files_changed, ['a.txt', 'b.txt']);
  assert.ok(!changed.files_changed.includes('xt'), 'must not produce a mis-sliced "xt" path');
});

test('post-run git failure degrades to best_effort with null files_changed', async () => {
  const root = await createGitRepo();
  await commit(root, 'tracked.txt', 'orig');

  const before = await captureChangeState(root);
  await rm(join(root, '.git'), { recursive: true, force: true }); // git status now fails
  const changed = await computeFilesChanged(root, before);

  assert.equal(changed.files_changed, null);
  assert.equal(changed.best_effort, true);
});
