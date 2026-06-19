import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordActivity, readActivity, pruneActivity } from '../src/activity-log/log.js';

const tmp = () => mkdtemp(join(tmpdir(), 'activity-'));

test('recordActivity appends a parseable line to the dated file', async () => {
  const dir = await tmp();
  const now = () => new Date('2026-06-19T12:00:00Z');
  recordActivity({ source: 'daemon', type: 'issue.picked', summary: 'took #98', ref: '#98' }, { dir, now });
  const txt = await readFile(join(dir, 'activity-2026-06-19.jsonl'), 'utf8');
  const ev = JSON.parse(txt.trim());
  assert.equal(ev.type, 'issue.picked');
  assert.equal(ev.ref, '#98');
  assert.equal(ev.ts, '2026-06-19T12:00:00.000Z');
});

test('recordActivity is fail-safe (un-writable dir → no throw)', async () => {
  // A FILE: a dir path *under* it is ENOTDIR on every OS — an instant, deterministic
  // un-writable target (unlike /proc, whose procfs writes can BLOCK on Linux → hang).
  const f = join(await tmp(), 'afile');
  await writeFile(f, 'x');
  assert.doesNotThrow(() => recordActivity({ summary: 'x' }, { dir: join(f, 'sub'), now: () => new Date('2026-06-19T00:00:00Z') }));
});

test('readActivity reads recent files newest-first, since-windowed, capped, skips malformed', async () => {
  const dir = await tmp();
  await writeFile(join(dir, 'activity-2026-06-18.jsonl'), JSON.stringify({ ts: '2026-06-18T10:00:00Z', type: 'a' }) + '\nGARBAGE\n', 'utf8');
  await writeFile(join(dir, 'activity-2026-06-19.jsonl'), JSON.stringify({ ts: '2026-06-19T10:00:00Z', type: 'b' }) + '\n' + JSON.stringify({ ts: '2026-06-19T11:00:00Z', type: 'c' }) + '\n', 'utf8');
  const all = readActivity({ dir });
  assert.deepEqual(all.map((e) => e.type), ['c', 'b', 'a']);     // newest first, malformed skipped
  const recent = readActivity({ dir, since: '2026-06-19T00:00:00Z' });
  assert.deepEqual(recent.map((e) => e.type), ['c', 'b']);        // since-windowed
  assert.equal(readActivity({ dir, limit: 1 }).length, 1);        // capped
  assert.deepEqual(readActivity({ dir: join(dir, 'missing') }), []); // tolerant
});

test('pruneActivity removes only files older than keepDays', async () => {
  const dir = await tmp();
  for (const d of ['2026-05-01', '2026-06-18', '2026-06-19']) await writeFile(join(dir, `activity-${d}.jsonl`), '{}\n', 'utf8');
  const now = () => new Date('2026-06-19T12:00:00Z');
  const { removed } = pruneActivity({ dir, keepDays: 30, now });
  assert.deepEqual(removed, ['activity-2026-05-01.jsonl']);       // >30 days
  const left = (await readdir(dir)).sort();
  assert.deepEqual(left, ['activity-2026-06-18.jsonl', 'activity-2026-06-19.jsonl']);
});
