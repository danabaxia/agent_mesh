import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMergeSweepApi } from '../src/dashboard/merge-sweep-api.js';

function seed(report) {
  const mesh = mkdtempSync(join(tmpdir(), 'mesh-'));
  if (report) { const d = join(mesh, 'mesh', 'reports'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'merge-sweep.json'), JSON.stringify(report)); }
  return mesh;
}

test('absent report → {available:false}', () => {
  assert.deepEqual(readMergeSweepApi(seed(null), new Date()), { available: false });
});
test('present + fresh → report with stale:false', () => {
  const now = new Date('2026-06-20T12:00:00Z');
  const rep = { ranAt: now.toISOString(), cadenceMinutes: 15, checkpoints: [], summary: { ok: 0, flagged: 0, errors: 0 } };
  const out = readMergeSweepApi(seed(rep), now);
  assert.equal(out.available, true); assert.equal(out.stale, false);
});
test('present + old → stale:true (> 2*cadence)', () => {
  const ran = new Date('2026-06-20T12:00:00Z');
  const rep = { ranAt: ran.toISOString(), cadenceMinutes: 15, checkpoints: [], summary: {} };
  const out = readMergeSweepApi(seed(rep), new Date('2026-06-20T12:31:00Z'));
  assert.equal(out.stale, true);
});
