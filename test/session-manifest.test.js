// test/session-manifest.test.js — per-agent session manifest (spec §7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyManifest, readManifest, writeManifest, normalizeEntry,
  upsertSession, backfill, archiveSession, activeSessionIndex
} from '../src/session-manifest.js';

test('normalizeEntry: defaults + status coercion', () => {
  const e = normalizeEntry({ id: 's1' });
  assert.equal(e.id, 's1');
  assert.equal(e.task_label, null);
  assert.equal(e.status, 'active');
  assert.equal(e.origin, 'cli');
  assert.deepEqual(e.produced_memory_keys, []);
  assert.deepEqual(e.produced_workflows, []);
  assert.equal(normalizeEntry({ id: 's2', status: 'bogus' }).status, 'active');   // coerced
  assert.equal(normalizeEntry({ id: 's3', status: 'archived' }).status, 'archived');
});

test('upsertSession: insert then merge by id', () => {
  let m = emptyManifest();
  m = upsertSession(m, { id: 's1', origin: 'worker:digest' });
  assert.equal(m.sessions.length, 1);
  m = upsertSession(m, { id: 's1', task_label: 'fix-auth', l0: 'fixed auth' });
  assert.equal(m.sessions.length, 1);                       // merged, not duplicated
  assert.equal(m.sessions[0].task_label, 'fix-auth');
  assert.equal(m.sessions[0].origin, 'worker:digest');      // prior field preserved
});

test('backfill: adds unknown sessions (archived) without clobbering existing', () => {
  let m = upsertSession(emptyManifest(), { id: 's1', task_label: 'kept', status: 'active' });
  m = backfill(m, [{ id: 's1', task_label: 'SHOULD-NOT-WIN' }, { id: 's2' }, { id: 's3' }]);
  assert.equal(m.sessions.length, 3);
  assert.equal(m.sessions.find((s) => s.id === 's1').task_label, 'kept');   // existing wins
  assert.equal(m.sessions.find((s) => s.id === 's1').status, 'active');
  assert.equal(m.sessions.find((s) => s.id === 's2').status, 'archived');   // discovered → archived
  assert.equal(m.sessions.find((s) => s.id === 's2').task_label, null);
});

test('archiveSession + activeSessionIndex', () => {
  let m = emptyManifest();
  m = upsertSession(m, { id: 's1', l0: 'A', status: 'active' });
  m = upsertSession(m, { id: 's2', l0: 'B', status: 'active' });
  assert.equal(activeSessionIndex(m).length, 2);
  m = archiveSession(m, 's1');
  const idx = activeSessionIndex(m);
  assert.deepEqual(idx.map((s) => s.id), ['s2']);
  assert.equal(idx[0].l0, 'B');
});

test('write/read round-trip; absent → empty manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sm-'));
  assert.deepEqual(await readManifest(root), emptyManifest());      // absent
  const m = upsertSession(emptyManifest(), { id: 's1', l0: 'hi', run_ids: ['r1', 'r2'] });
  const p = await writeManifest(root, m);
  assert.match(p, /\.agent-mesh[/\\]sessions[/\\]index\.json$/);
  const back = await readManifest(root);
  assert.equal(back.sessions.length, 1);
  assert.deepEqual(back.sessions[0].run_ids, ['r1', 'r2']);
});
