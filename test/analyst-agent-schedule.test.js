import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../src/builder/doctor.js';
import { readManagedRegistry } from '../src/a2a/registry.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const devMesh = join(repoRoot, 'dev-mesh');

test('mesh.json analyst has webTools:true and peers includes tester', async () => {
  const m = JSON.parse(await readFile(join(devMesh, 'mesh.json'), 'utf8'));
  const analyst = m.agents.find((a) => a.name === 'analyst');
  assert.equal(analyst.webTools, true);
  assert.ok(analyst.peers.includes('tester'));
});

test('analyst schedule.json declares the daily builtin job', async () => {
  const s = JSON.parse(await readFile(join(devMesh, 'analyst', '.agent', 'schedule.json'), 'utf8'));
  const job = s.jobs.find((j) => j.id === 'analyst-daily-review');
  assert.equal(job.kind, 'builtin');
  assert.equal(job.builtin, 'analyst-daily-review');
  assert.equal(job.cadence.kind, 'daily');
  assert.equal(job.enabled, true);
});

test('after doctor on a temp dev-mesh copy, analyst registry includes tester', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'devmesh-'));
  const tmpMesh = join(tmp, 'dev-mesh');
  await cp(devMesh, tmpMesh, { recursive: true });
  await doctor(tmpMesh, { apply: true, managedOnly: true });
  const reg = await readManagedRegistry(join(tmpMesh, 'analyst'));
  const peerNames = Object.keys(reg?.registry?.peers || {});
  assert.ok(peerNames.includes('tester'), `expected tester in analyst registry, saw ${peerNames}`);
});
