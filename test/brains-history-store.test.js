import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHistory, appendTurn } from '../src/brains/history-store.js';

const dir = () => mkdtemp(join(tmpdir(), 'hist-'));

test('persists and reloads turns oldest-first (restart-safe)', async () => {
  const root = await dir();
  await appendTurn(root, 'ctx-a', { role: 'user', text: 'hi', ts: 1000 });
  await appendTurn(root, 'ctx-a', { role: 'assistant', text: 'hello', ts: 1001 });
  const hist = await loadHistory(root, 'ctx-a', { now: 2000 });
  assert.deepEqual(hist.map((t) => t.text), ['hi', 'hello']);
});

test('separate contextIds do not bleed', async () => {
  const root = await dir();
  await appendTurn(root, 'ctx-a', { role: 'user', text: 'A', ts: 1 });
  await appendTurn(root, 'ctx-b', { role: 'user', text: 'B', ts: 1 });
  assert.deepEqual((await loadHistory(root, 'ctx-a', { now: 2 })).map((t) => t.text), ['A']);
});

test('enforces maxTurns cap (keeps most recent)', async () => {
  const root = await dir();
  for (let i = 0; i < 10; i++) await appendTurn(root, 'c', { role: 'user', text: `t${i}`, ts: i }, { maxTurns: 3 });
  const hist = await loadHistory(root, 'c', { maxTurns: 3, now: 99 });
  assert.deepEqual(hist.map((t) => t.text), ['t7', 't8', 't9']);
});

test('drops TTL-expired turns', async () => {
  const root = await dir();
  await appendTurn(root, 'c', { role: 'user', text: 'old', ts: 0 });
  await appendTurn(root, 'c', { role: 'user', text: 'new', ts: 100_000 });
  const hist = await loadHistory(root, 'c', { ttlMs: 50_000, now: 120_000 });
  assert.deepEqual(hist.map((t) => t.text), ['new']);
});

test('corrupt store reads as empty (never throws)', async () => {
  const root = await dir();
  assert.deepEqual(await loadHistory(root, 'never-written', { now: 1 }), []);
});

test('clamps oversized turn text', async () => {
  const root = await dir();
  await appendTurn(root, 'c', { role: 'user', text: 'x'.repeat(9999), ts: 1 });
  const [t] = await loadHistory(root, 'c', { now: 2 });
  assert.equal(t.text.length, 4000);
});
