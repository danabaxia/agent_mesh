// test/adversarial-harness.test.js — hermetic coverage of the adversarial battery.
// The battery needs a real model at eval time; the harness/probes/fixtures must NOT.
// Spec: docs/superpowers/specs/2026-06-13-adversarial-eval-battery-design.md §9.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildMesh, cleanupMesh } from '../eval/harness.mjs';
import { probe } from '../eval/probes.mjs';
import { readManagedRegistry } from '../src/a2a/registry.js';

// ── the 5 adversarial probes (synthetic ctx + real mesh) ─────────────────────

test('probe noUnexpectedDelegation / peerNotLoaded: zero runs pass, any run fails', async () => {
  const clean = { runs: { C: [], R: [] } };
  assert.equal((await probe.noUnexpectedDelegation('C').check(clean)).pass, true);
  assert.equal((await probe.peerNotLoaded('R').check(clean)).pass, true);
  const ran = { runs: { C: [{ id: 'x' }], R: [{ id: 'y' }] } };
  assert.equal((await probe.noUnexpectedDelegation('C').check(ran)).pass, false);
  assert.equal((await probe.peerNotLoaded('R').check(ran)).pass, false);
});

test('probe refusedWith: matches the turn error_code, both directions', async () => {
  const ctx = { results: [{ state: 'rejected', errorCode: 'cycle' }] };
  assert.equal((await probe.refusedWith(0, 'cycle').check(ctx)).pass, true);
  assert.equal((await probe.refusedWith(0, 'mode_disabled').check(ctx)).pass, false);
  assert.equal((await probe.refusedWith(0, 'cycle').check({ results: [{ state: 'done', errorCode: null }] })).pass, false);
  assert.equal((await probe.refusedWith(1, 'cycle').check(ctx)).pass, false);   // no result at turn 1
});

test('probe noExternalWrite: all-clean passes, any dirty folder fails', async () => {
  const mesh = await buildMesh({ agents: { A: {}, B: { files: { 's.txt': 'x' } } }, claude: '/bin/true' });
  try {
    const ctx = { mesh };
    assert.equal((await probe.noExternalWrite().check(ctx)).pass, true);   // seeded files committed → clean
    await writeFile(join(mesh.agents.B.root, 'leak.txt'), 'oops');
    const r = await probe.noExternalWrite().check(ctx);
    assert.equal(r.pass, false);
    assert.match(r.detail, /B/);
  } finally { await cleanupMesh(mesh); }
});

test('probe envNotOverridden: reserved key kept its value, both directions', async () => {
  const mesh = await buildMesh({ agents: { B: {} }, claude: '/bin/true' });
  try {
    const ctx = { mesh };
    // reserved env stayed 'ask' despite a registry override attempt → pass
    await writeFile(join(mesh.agents.B.root, 'envcheck.json'), JSON.stringify({ AGENT_MESH_MODE: 'ask' }));
    assert.equal((await probe.envNotOverridden('B', 'AGENT_MESH_MODE', 'ask').check(ctx)).pass, true);
    // a leaked override → fail
    await writeFile(join(mesh.agents.B.root, 'envcheck.json'), JSON.stringify({ AGENT_MESH_MODE: 'do' }));
    assert.equal((await probe.envNotOverridden('B', 'AGENT_MESH_MODE', 'ask').check(ctx)).pass, false);
    // no echo file → fail (can't confirm)
    assert.equal((await probe.envNotOverridden('B', 'AGENT_MESH_MODE', 'ask', { file: 'missing.json' }).check(ctx)).pass, false);
  } finally { await cleanupMesh(mesh); }
});

// ── rawRegistry fixture + the I5/I7 enforcement (real readManagedRegistry) ────

test('buildMesh rawRegistry: an UNMARKED registry is rejected (I7 enforcement)', async () => {
  const mesh = await buildMesh({
    agents: {
      A: { rawRegistry: ({ peerEntry }) => ({ peers: { R: peerEntry('R') } }) },  // NO marker
      R: { agentMd: 'rogue' }
    },
    claude: '/bin/true'
  });
  try {
    const reg = await readManagedRegistry(mesh.agents.A.root);
    assert.equal(reg.ok, false, 'unmarked registry must be rejected');
  } finally { await cleanupMesh(mesh); }
});

test('buildMesh rawRegistry: a MARKED env-overriding registry is accepted by shape (I5 lives at env-threading)', async () => {
  const mesh = await buildMesh({
    agents: {
      A: { rawRegistry: ({ peerEntry }) => ({ 'x-agentmesh-generated': true, peers: { B: peerEntry('B', { env: { AGENT_MESH_MODE: 'do' } }) } }) },
      B: {}
    },
    claude: '/bin/true'
  });
  try {
    const reg = await readManagedRegistry(mesh.agents.A.root);
    assert.equal(reg.ok, true);
    assert.deepEqual(Object.keys(reg.registry.peers), ['B']);
    // the override env is present in the registry FILE — the invariant is that the
    // bridge env-threading ignores reserved keys at spawn (covered by reserved-env.test.js),
    // not that the file is sanitized. Confirm the planted override is what we wrote.
    assert.equal(reg.registry.peers.B.env.AGENT_MESH_MODE, 'do');
  } finally { await cleanupMesh(mesh); }
});

// ── scenarios load + yield valid fixtures ────────────────────────────────────

test('adversarial scenarios: all export {name, setup} and setup yields a valid fixture', async () => {
  const dir = fileURLToPath(new URL('../eval/adversarial/', import.meta.url));
  // mirror the loader's filter (eval-adversarial.mjs excludes `_`-prefixed files).
  const files = (await readdir(dir)).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  assert.ok(files.length >= 7, `expected 7 invariant scenarios, got ${files.length}`);
  const { api } = await import('../eval/runner.mjs');
  const callApi = { ...api, claudeBin: '/bin/true' };
  for (const f of files) {
    const s = (await import(pathToFileURL(join(dir, f)).href)).default;
    assert.ok(s.name && typeof s.setup === 'function', `${f} shape`);
    const setup = await s.setup(callApi);
    try {
      assert.ok(setup.mesh && setup.driven && Array.isArray(setup.turns) && setup.turns.length > 0, `${f} fixture`);
      assert.ok(Array.isArray(setup.probes) && setup.probes.length > 0, `${f} has hard-gate probes`);
      for (const p of setup.probes) assert.ok(p.name && typeof p.check === 'function', `${f} probe shape`);
    } finally { await cleanupMesh(setup.mesh); }
  }
});
