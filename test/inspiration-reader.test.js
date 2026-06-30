import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readInspiration } from '../src/brains/inspiration-reader.js';

const okFetch = (body) => async () => ({ ok: true, json: async () => body });
const failFetch = () => async () => { throw new Error('offline'); };

test('fetches and returns seeds, refreshing the cache', async () => {
  let cached = null;
  const r = await readInspiration({
    fetchImpl: okFetch({ seeds: [{ theme: 't', spark: 's' }], generatedAt: 'z' }),
    url: 'http://mac/inspiration', token: 'READ',
    readCache: async () => cached, writeCache: async (v) => { cached = v; },
    ttlMs: 0, now: 1,
  });
  assert.equal(r.seeds[0].spark, 's');
  assert.deepEqual(cached.seeds, r.seeds);
});

test('offline → serves the cached digest', async () => {
  const r = await readInspiration({
    fetchImpl: failFetch(), url: 'http://mac/inspiration', token: 'READ',
    readCache: async () => ({ seeds: [{ theme: 'c', spark: 'cached' }], generatedAt: 'old' }),
    writeCache: async () => {}, ttlMs: 0, now: 1,
  });
  assert.equal(r.seeds[0].spark, 'cached');
});

test('offline + no cache → {seeds:[]}, never throws', async () => {
  const r = await readInspiration({ fetchImpl: failFetch(), url: 'http://mac/inspiration', token: 'READ', readCache: async () => null, writeCache: async () => {}, ttlMs: 0, now: 1 });
  assert.deepEqual(r.seeds, []);
});

test('fresh cache (within ttlMs) → served without hitting the network', async () => {
  let fetchCalls = 0;
  const neverFetch = async () => { fetchCalls++; throw new Error('should not be called'); };
  const r = await readInspiration({
    fetchImpl: neverFetch,
    url: 'http://mac/inspiration', token: 'READ',
    readCache: async () => ({ seeds: [{ theme: 't', spark: 'fresh' }], fetchedAt: 100, generatedAt: 'g1', degraded: [] }),
    writeCache: async () => {},
    ttlMs: 1000, now: 150,
  });
  assert.equal(fetchCalls, 0, 'fetchImpl must not be invoked for a fresh cache hit');
  assert.equal(r.seeds[0].spark, 'fresh');
  assert.equal(r.generatedAt, 'g1');
});
