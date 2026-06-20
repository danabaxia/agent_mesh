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

test('overlay: merges remediation state onto report items by checkpoint:ref', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { readMergeSweepApi } = await import('../src/dashboard/merge-sweep-api.js');
  const mesh = mkdtempSync(join(tmpdir(), 'mesh-')); const d = join(mesh, 'mesh', 'reports'); mkdirSync(d, { recursive: true });
  const now = new Date('2026-06-20T12:00:00Z');
  writeFileSync(join(d, 'merge-sweep.json'), JSON.stringify({ ranAt: now.toISOString(), cadenceMinutes: 15, summary: {}, checkpoints: [{ name: 'automerge', status: 'flagged', items: [{ ref: 'PR#1', number: 1, state: 'blocked', detail: 'x' }] }] }));
  writeFileSync(join(d, 'merge-sweep-remediation.json'), JSON.stringify({ 'automerge:PR#1': { state: 'escalated', issueNumber: 77 } }));
  const out = readMergeSweepApi(mesh, now);
  assert.equal(out.checkpoints[0].items[0].remediation.state, 'escalated');
  assert.equal(out.checkpoints[0].items[0].remediation.issueNumber, 77);
});
