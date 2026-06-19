/**
 * test/do-lock.test.js
 *
 * Unit tests for src/a2a/do-lock.js — cross-process advisory file lock.
 * Hermetic: no real peer spawns. Tests cover acquisition, release, stale
 * detection, and timeout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireDoLock } from '../src/a2a/do-lock.js';

const SHORT_TIMEOUT = { AGENT_MESH_TIMEOUT_MS: '100' };

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'do-lock-'));
}

// ---------------------------------------------------------------------------
// basic acquire + release
// ---------------------------------------------------------------------------

test('acquireDoLock: acquires the lock and release deletes the lock file', async () => {
  const root = await tempRoot();
  const r = await acquireDoLock(root, {});
  assert.equal(r.acquired, true);
  assert.equal(typeof r.release, 'function');

  // lock file exists while held
  const lockPath = join(root, '.agent-mesh', 'do.lock');
  const pidText = await readFile(lockPath, 'utf8');
  assert.equal(parseInt(pidText.trim(), 10), process.pid);

  await r.release();
  // lock file gone after release
  await assert.rejects(() => readFile(lockPath, 'utf8'), { code: 'ENOENT' });
});

test('acquireDoLock: second acquisition while lock is held → does not acquire (times out)', async () => {
  const root = await tempRoot();
  const first = await acquireDoLock(root, SHORT_TIMEOUT, { pollMs: 20 });
  assert.equal(first.acquired, true);

  // second attempt times out immediately (100 ms timeout, 20 ms poll)
  const second = await acquireDoLock(root, SHORT_TIMEOUT, { pollMs: 20 });
  assert.equal(second.acquired, false, 'second acquisition must fail while first holds the lock');

  await first.release();
});

// ---------------------------------------------------------------------------
// stale lock detection
// ---------------------------------------------------------------------------

test('acquireDoLock: stale lock (dead PID) is broken and re-acquired', async () => {
  const root = await tempRoot();
  await mkdir(join(root, '.agent-mesh'), { recursive: true });
  const lockPath = join(root, '.agent-mesh', 'do.lock');

  // Write a lock file with a PID that is certainly dead (PID 0 is invalid)
  await writeFile(lockPath, '0\n', 'utf8');

  const r = await acquireDoLock(root, {}, { pollMs: 10 });
  assert.equal(r.acquired, true, 'stale lock must be broken and acquisition must succeed');
  await r.release();
});

test('acquireDoLock: lock file with non-numeric content is treated as stale', async () => {
  const root = await tempRoot();
  await mkdir(join(root, '.agent-mesh'), { recursive: true });
  const lockPath = join(root, '.agent-mesh', 'do.lock');
  await writeFile(lockPath, 'not-a-pid\n', 'utf8');

  const r = await acquireDoLock(root, {}, { pollMs: 10 });
  assert.equal(r.acquired, true, 'corrupt lock must be treated as stale');
  await r.release();
});

// ---------------------------------------------------------------------------
// timeout path
// ---------------------------------------------------------------------------

test('acquireDoLock: returns acquired:false after timeout when lock is held by this PID', async () => {
  const root = await tempRoot();
  await mkdir(join(root, '.agent-mesh'), { recursive: true });
  const lockPath = join(root, '.agent-mesh', 'do.lock');
  // Write lock with our own PID (live process → not stale)
  await writeFile(lockPath, `${process.pid}\n`, 'utf8');

  const start = Date.now();
  const r = await acquireDoLock(root, SHORT_TIMEOUT, { pollMs: 20 });
  const elapsed = Date.now() - start;

  assert.equal(r.acquired, false);
  // elapsed must be >= the timeout (100 ms), not immediately
  assert.ok(elapsed >= 90, `should have waited ~100ms but only waited ${elapsed}ms`);

  // clean up manually
  await import('node:fs/promises').then(({ unlink }) => unlink(lockPath).catch(() => {}));
});

// ---------------------------------------------------------------------------
// idempotent release
// ---------------------------------------------------------------------------

test('acquireDoLock: release is idempotent (double-release does not throw)', async () => {
  const root = await tempRoot();
  const r = await acquireDoLock(root, {});
  assert.equal(r.acquired, true);
  await r.release();
  await r.release(); // second call must not throw
});
