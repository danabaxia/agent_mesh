import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskBoard, TASK_COLUMNS, relAge } from '../src/dashboard/public/tasks-model.js';

const NOW = Date.parse('2026-06-22T12:00:00Z');
const mk = (id, state, at) => ({ id, from: 'analyst', to: 'tester', title: `T-${id}`, state,
  created_at: at, history: [{ state, at, by: 'analyst' }], result: state === 'done' ? 'ok' : null });

test('TASK_COLUMNS is the canonical order', () => {
  assert.deepEqual(TASK_COLUMNS.map((c) => c.state), ['assigned', 'acknowledged', 'in-progress', 'done']);
});

test('groups by state, counts in summary, newest-first within a column', () => {
  const b = buildTaskBoard([
    mk('1', 'assigned', '2026-06-22T10:00:00Z'),
    mk('2', 'assigned', '2026-06-22T11:00:00Z'),
    mk('3', 'in-progress', '2026-06-22T09:00:00Z'),
    mk('4', 'done', '2026-06-21T12:00:00Z'),
  ], { now: NOW });
  const col = (s) => b.columns.find((c) => c.state === s);
  assert.deepEqual(col('assigned').cards.map((c) => c.id), ['2', '1']);   // newest first
  assert.equal(col('in-progress').cards[0].ageMs, 3 * 3600 * 1000);
  assert.equal(col('done').cards[0].hasResult, true);
  assert.equal(b.summary.total, 4);
  assert.equal(b.summary.assigned, 2);
  assert.equal(b.summary['in-progress'], 1);
});

test('tolerates missing fields + unknown state gets a trailing column', () => {
  const b = buildTaskBoard([{ id: 'x', state: 'weird' }, {}], { now: NOW });
  assert.ok(b.columns.find((c) => c.state === 'weird'), 'unknown state column appended');
  assert.equal(b.summary.total, 2);
  // the four canonical columns are always present
  for (const s of ['assigned', 'acknowledged', 'in-progress', 'done']) assert.ok(b.columns.find((c) => c.state === s));
});

test('relAge is compact', () => {
  assert.equal(relAge(30 * 1000), 'just now');
  assert.equal(relAge(5 * 60 * 1000), '5m');
  assert.equal(relAge(3 * 3600 * 1000), '3h');
  assert.equal(relAge(2 * 86400 * 1000), '2d');
});
