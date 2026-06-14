import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '../src/atomic-write.js';
import { persistEpoch, readEpoch } from '../src/a2a/session-id.js';

test('atomicWriteFile creates parents, writes, and leaves no tmp residue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-'));
  const target = join(dir, 'nested', 'deep', 'file.md');
  await atomicWriteFile(target, 'hello');
  assert.equal(await readFile(target, 'utf8'), 'hello');
  await atomicWriteFile(target, 'replaced');
  assert.equal(await readFile(target, 'utf8'), 'replaced');
  const names = await readdir(join(dir, 'nested', 'deep'));
  assert.deepEqual(names, ['file.md']); // no .tmp left behind
});

test('persistEpoch still round-trips through the shared util', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-epoch-'));
  await persistEpoch(root, 'B', 3);
  assert.equal(await readEpoch(root, 'B'), 3);
});
