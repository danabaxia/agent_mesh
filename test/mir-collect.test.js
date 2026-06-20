import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { latestMirPath } from '../src/mesh-improvement/collect.js';

test('latestMirPath returns the newest dated mir file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mir-'));
  await writeFile(join(dir, 'mir-2026-06-18.json'), '{}');
  await writeFile(join(dir, 'mir-2026-06-20.json'), '{}');
  await writeFile(join(dir, 'mir-2026-06-19.json'), '{}');
  assert.equal(await Promise.resolve(latestMirPath(dir)), join(dir, 'mir-2026-06-20.json'));
});

test('latestMirPath returns null for an empty or missing dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mir-empty-'));
  assert.equal(latestMirPath(dir), null);
  assert.equal(latestMirPath(join(dir, 'nope')), null);
});

test('latestMirPath ignores non-mir files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mir-mix-'));
  await writeFile(join(dir, 'mir-2026-06-20.json'), '{}');
  await writeFile(join(dir, 'test-results.json'), '{}');
  await writeFile(join(dir, 'mir-2026-06-20.md'), '#');
  assert.equal(latestMirPath(dir), join(dir, 'mir-2026-06-20.json'));
});
