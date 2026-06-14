// test/recall.test.js — read-side confinement + resolver behind the recall verbs
// (spec §6). The security-critical assertions: every target is realpath-confined
// under AGENT_MESH_ROOT; out-of-root is refused as data; load_session is restricted
// to the agent's own manifest (never an arbitrary UUID).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confinePath, recall, loadWorkflow, loadSession, recallVerb } from '../src/recall.js';
import { writeQuickMemory } from '../src/quick-memory.js';
import { writeManifest, emptyManifest, upsertSession } from '../src/session-manifest.js';

const liveEntry = (o = {}) => ({ l0: 'L0', l1: 'L1', value: 'V', core: false, valid_from: '2026-06-13T00:00:00Z', valid_to: null, provenance: { run_id: 'r1' }, status: 'active', ...o });

async function makeAgent() {
  const root = await mkdtemp(join(tmpdir(), 'recall-'));
  await writeQuickMemory(root, { fact: liveEntry({ value: 'SECRET-42' }), gone: liveEntry({ status: 'retired' }) });
  await mkdir(join(root, 'workflows'), { recursive: true });
  await writeFile(join(root, 'workflows', 'deploy.md'), '# deploy steps\n');
  await writeManifest(root, upsertSession(emptyManifest(), { id: 'sess-mine', l0: 'my task' }));
  return root;
}

test('confinePath: in-root resolves; ../ and absolute escapes refused; symlink escape refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'confine-'));
  await mkdir(join(root, 'workflows'), { recursive: true });
  assert.ok(await confinePath(root, 'workflows/x.md'));            // in root
  assert.equal(await confinePath(root, '../escape.txt'), null);    // parent traversal
  assert.equal(await confinePath(root, '/etc/passwd'), null);      // absolute outside
  // symlink that points outside the root must not widen confinement. Creating a
  // dir symlink can need privileges on Windows — skip that sub-assertion if so.
  const outside = await mkdtemp(join(tmpdir(), 'outside-'));
  await writeFile(join(outside, 'secret.txt'), 'x');
  let symlinked = true;
  try { await symlink(outside, join(root, 'link')); } catch { symlinked = false; }
  if (symlinked) assert.equal(await confinePath(root, 'link/secret.txt'), null);  // resolves outside → refused
});

test('recall: live entry returns value+provenance; retired/missing/bad refused', async () => {
  const root = await makeAgent();
  const hit = await recall(root, 'fact');
  assert.equal(hit.ok, true);
  assert.equal(hit.value.value, 'SECRET-42');
  assert.equal((await recall(root, 'gone')).refused, 'not_found');   // retired → not recallable
  assert.equal((await recall(root, 'nope')).refused, 'not_found');
  assert.equal((await recall(root, '')).refused, 'bad_input');
});

test('load_workflow: bare slug reads; traversal/escape refused; absent → not_found', async () => {
  const root = await makeAgent();
  const w = await loadWorkflow(root, 'deploy');
  assert.equal(w.ok, true);
  assert.match(w.value.content, /deploy steps/);
  assert.equal((await loadWorkflow(root, '../../etc/passwd')).refused, 'bad_input');  // not a bare slug
  assert.equal((await loadWorkflow(root, 'a/b')).refused, 'bad_input');
  assert.equal((await loadWorkflow(root, 'missing')).refused, 'not_found');
});

test('load_session: only the agent OWN manifest ids — never an arbitrary UUID', async () => {
  const root = await makeAgent();
  assert.equal((await loadSession(root, 'sess-mine')).ok, true);
  // an arbitrary/other-agent UUID is NOT loadable even though it could exist on disk
  assert.equal((await loadSession(root, '11111111-2222-4333-8444-555555555555')).refused, 'not_found');
  assert.equal((await loadSession(root, '../x')).refused, 'bad_input');
});

test('recallVerb: dispatches by kind; unknown kind refused', async () => {
  const root = await makeAgent();
  assert.equal((await recallVerb(root, 'recall', { key: 'fact' })).ok, true);
  assert.equal((await recallVerb(root, 'load_workflow', { name: 'deploy' })).ok, true);
  assert.equal((await recallVerb(root, 'load_session', { id: 'sess-mine' })).ok, true);
  assert.equal((await recallVerb(root, 'evil', {})).refused, 'bad_input');
});
