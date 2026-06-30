import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInspirationDigest } from '../src/dev-society/inspiration-digest-run.js';

const readers = (now) => ({
  mir: async () => ({ asOf: now, data: { regressions: 1 } }),
  gaps: async () => ({ asOf: now, data: { stale: ['#1'] } }),
  captures: async () => ({ asOf: now, data: [{ text: 'idea' }] }),
  activity: async () => ({ asOf: now, data: {} }),
});

test('writes a digest with seeds + generatedAt on a successful analyst dispatch', async () => {
  const writes = [];
  const r = await runInspirationDigest({
    readers: readers(100),
    dispatchAnalyst: async () => ({ done: true, text: JSON.stringify({ seeds: [{ theme: 't', spark: 's', why: 'w', sources: [], relatedCaptures: [] }] }) }),
    writeFile: async (path, content) => writes.push({ path, content }),
    file: '/tmp/insp.json', now: 100, maxSeeds: 7, staleMs: 1000,
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.seeds.length, 1);
  const written = JSON.parse(writes[0].content);
  assert.equal(written.generatedAt, new Date(100).toISOString());
  assert.equal(written.seeds[0].spark, 's');
});

test('analyst not done → keeps last good file (no write)', async () => {
  const writes = [];
  const r = await runInspirationDigest({
    readers: readers(100),
    dispatchAnalyst: async () => ({ done: false, text: '' }),
    writeFile: async (p, c) => writes.push({ p, c }),
    file: '/tmp/insp.json', now: 100,
  });
  assert.equal(r.status, 'skip');
  assert.equal(writes.length, 0);
});

// Guard (after a LIVE run wiped a good digest, 2026-06-29): zero parseable seeds → SKIP,
// never overwrite the last-good inspiration.json.
test('analyst returns text but 0 parseable seeds → skip, no write', async () => {
  const writes = [];
  const r = await runInspirationDigest({
    readers: readers(100),
    dispatchAnalyst: async () => ({ done: true, text: '**Regressions only** | # | ID |\n|---|---|\n| 1 | p-001 |' }),
    writeFile: async (p, c) => writes.push({ p, c }),
    file: '/tmp/insp.json', now: 100,
  });
  assert.equal(r.status, 'skip');
  assert.equal(writes.length, 0);
});
