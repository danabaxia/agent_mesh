// test/migrate-quick-memory.test.js — learned.md → quick.json migration (spec §5
// Decision 2). Pure transform + temp-dir wrapper. No spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLearned, migrateLearnedToQuick, migrateAgentLearned } from '../src/migrate-quick-memory.js';
import { isLive, coreMemory, MAX_CORE_ENTRIES } from '../src/quick-memory.js';

test('parseLearned: extracts list items, ignores headers/blank/non-bullets', () => {
  const md = '# Learned\n\n- prefers tabs over spaces\n- deploys via the billing pipeline\n\nsome prose\n  - nested still counts\n';
  assert.deepEqual(parseLearned(md), ['prefers tabs over spaces', 'deploys via the billing pipeline', 'nested still counts']);
  assert.deepEqual(parseLearned(''), []);
});

test('migrateLearnedToQuick: empty store → entries marked core (preserve eager inject), live, full body in l1+value', () => {
  const { quick, migrated } = migrateLearnedToQuick({}, '- alpha fact\n- beta fact');
  assert.equal(migrated, 2);
  assert.ok(isLive(quick['learned-1']) && isLive(quick['learned-2']));
  assert.equal(quick['learned-1'].core, true, 'migrated entry stays eagerly injected (core)');
  assert.equal(quick['learned-1'].l1, 'alpha fact');
  assert.equal(quick['learned-1'].value, 'alpha fact');
  assert.equal(quick['learned-1'].provenance.source, 'learned.md');
  // core block renders these (no silent prompt loss after the §5 cutover)
  assert.deepEqual(Object.keys(coreMemory(quick)).sort(), ['learned-1', 'learned-2']);
});

test('migrateLearnedToQuick: never clobbers a non-empty (authoritative) store', () => {
  const existing = { 'k': { l0: 'x', status: 'active', valid_to: null } };
  const { quick, migrated, skipped } = migrateLearnedToQuick(existing, '- new fact');
  assert.equal(migrated, 0);
  assert.equal(skipped, 'quick-not-empty');
  assert.deepEqual(quick, existing);
});

test('migrateLearnedToQuick: core flag respects MAX_CORE_ENTRIES; overflow stays non-core but live', () => {
  const items = Array.from({ length: MAX_CORE_ENTRIES + 3 }, (_, i) => `- fact number ${i}`).join('\n');
  const { quick, migrated } = migrateLearnedToQuick({}, items);
  assert.equal(migrated, MAX_CORE_ENTRIES + 3);
  const coreCount = Object.values(quick).filter((e) => e.core).length;
  assert.equal(coreCount, MAX_CORE_ENTRIES);
});

test('migrateAgentLearned: writes quick.json once, then idempotent (already-migrated)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'migrate-'));
  await mkdir(join(root, 'memory'), { recursive: true });
  await writeFile(join(root, 'memory', 'learned.md'), '# Learned\n\n- one\n- two\n', 'utf8');

  const first = await migrateAgentLearned(root);
  assert.equal(first.migrated, 2);
  const quick = JSON.parse(await readFile(join(root, 'memory', 'quick.json'), 'utf8'));
  assert.equal(Object.keys(quick).length, 2);

  const second = await migrateAgentLearned(root);
  assert.equal(second.migrated, 0);
  assert.equal(second.skipped, 'already-migrated');

  // learned.md is preserved (read-only back-compat)
  assert.match(await readFile(join(root, 'memory', 'learned.md'), 'utf8'), /one/);
});

test('migrateAgentLearned: no learned.md → skipped, nothing written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'migrate-none-'));
  const res = await migrateAgentLearned(root);
  assert.equal(res.migrated, 0);
  assert.equal(res.skipped, 'no-learned');
});
