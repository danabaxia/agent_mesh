import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireBuildLock, releaseBuildLock, buildLockPath, isBuildBusy, readBuildBusy, DEFAULT_STALE_MS,
} from '../src/dev-society/build-lock.js';

test('acquire writes a lock with issue/pid/ts; release removes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bl-'));
  acquireBuildLock(root, { issue: 175, pid: 42, now: () => 1000 });
  const p = buildLockPath(root);
  assert.ok(existsSync(p));
  const rec = JSON.parse(await readFile(p, 'utf8'));
  assert.deepEqual(rec, { issue: 175, pid: 42, ts: 1000 });
  releaseBuildLock(root);
  assert.ok(!existsSync(p));
});

test('release is idempotent (no throw when absent)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bl-'));
  assert.doesNotThrow(() => releaseBuildLock(root));
});

test('isBuildBusy: fresh → true, stale → false, absent/corrupt → false', () => {
  const fresh = JSON.stringify({ issue: 1, ts: 1_000_000 });
  assert.equal(isBuildBusy(fresh, { now: 1_000_000 + 60_000, staleMs: DEFAULT_STALE_MS }), true);
  assert.equal(isBuildBusy(fresh, { now: 1_000_000 + DEFAULT_STALE_MS + 1, staleMs: DEFAULT_STALE_MS }), false);
  assert.equal(isBuildBusy(null), false);
  assert.equal(isBuildBusy(''), false);
  assert.equal(isBuildBusy('{not json'), false);
  assert.equal(isBuildBusy(JSON.stringify({ issue: 1 })), false); // no ts
});

test('readBuildBusy: missing file → false; fresh lock → true; stale → false', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bl-'));
  assert.equal(readBuildBusy(root), false);                         // no lock
  acquireBuildLock(root, { issue: 9, now: () => 5_000_000 });
  assert.equal(readBuildBusy(root, { now: 5_000_000 + 1000 }), true);
  assert.equal(readBuildBusy(root, { now: 5_000_000 + DEFAULT_STALE_MS + 1 }), false);
});
