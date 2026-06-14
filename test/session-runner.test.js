/**
 * test/session-runner.test.js — end-to-end smoke of the ask-only dashboard turn
 * through the REAL session-exec wrapper + lease + store, with a fake `claude`
 * that emits canned stream-json.
 *
 * The runner no longer fans live turn events (those surface via the
 * session-mirror / transcript tail). Its contract is now: spawn the turn, run it
 * to completion, persist the canonical session id, record create/select
 * provenance, resume the stored id, and enforce the single-active lease +
 * active_changed guards. These tests assert that surviving contract.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRunner } from '../src/dashboard/session-runner.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';
import { readSessionId, writeSessionId } from '../src/dashboard/session-store.js';
import { readEvents } from '../src/dashboard/session-index.js';

async function fakeClaude(dir) {
  const p = join(dir, 'fake-claude.mjs');
  await writeFile(p, `#!/usr/bin/env node
const a = process.argv.slice(2);
const sid = (a[a.indexOf('--session-id')+1]) || (a[a.indexOf('--resume')+1]) || 'NEW';
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:sid,model:'fake',cwd:process.cwd()})+"\\n");
process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'hello'}]}})+"\\n");
process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'ok',is_error:false})+"\\n");
`, 'utf8');
  await chmod(p, 0o755);
  return p;
}

async function fakeClaudeRecordingArgs(dir, argLogPath) {
  const p = join(dir, 'fake-claude-args.mjs');
  await writeFile(p, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
writeFileSync(${JSON.stringify(argLogPath)}, JSON.stringify(a), 'utf8');
const sessionIdIndex = a.indexOf('--session-id');
const resumeIndex = a.indexOf('--resume');
const sid = sessionIdIndex >= 0 ? a[sessionIdIndex + 1] : (resumeIndex >= 0 ? a[resumeIndex + 1] : 'NEW');
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:sid,model:'fake',cwd:process.cwd()})+"\\n");
process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'hello'}]}})+"\\n");
process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'ok',is_error:false})+"\\n");
`, 'utf8');
  await chmod(p, 0o755);
  return p;
}

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'sr-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'alpha');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'alpha' }), 'utf8');
  await writeFile(join(agentRoot, 'registry.json'), JSON.stringify({ 'x-agentmesh-generated': true, peers: {} }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'alpha', root: './alpha', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  // The runner keys the session store by the realpath-canonical agent root
  // (resolveAgent → realpath); tmpdir is a symlink on macOS, so canonicalize here
  // to read the same store entry the runner writes.
  return { meshRoot, agentRoot: await realpath(agentRoot) };
}

test('runTurn runs to done, persists the canonical id, and resumes it on the next turn', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const claudeBin = await fakeClaude(meshRoot);
  const runner = createSessionRunner({ meshRoot, claudeBin });

  // No id persisted yet → brand-new session.
  assert.equal(await readSessionId(meshRoot, agentRoot), null);

  const { done } = await runner.runTurn({ agentName: 'alpha', text: 'hi' });
  const r1 = await done;
  assert.equal(r1.ok, true);

  // The init event's confirmed session id is persisted as the canonical id.
  const sid = await readSessionId(meshRoot, agentRoot);
  assert.ok(sid && sid.length, 'canonical session id must be persisted after a new-session turn');

  // A `create` provenance event was recorded for the brand-new session.
  const events = await readEvents(meshRoot);
  const create = events.find((e) => e.kind === 'create' && e.sessionId === sid);
  assert.ok(create, 'a create provenance event must be recorded for the new session');
  assert.equal(create.source, 'dashboard');

  // Second turn must resume the SAME persisted id (no new create).
  const before = (await readEvents(meshRoot)).filter((e) => e.kind === 'create').length;
  const { done: done2 } = await runner.runTurn({ agentName: 'alpha', text: 'again' });
  await done2;
  assert.equal(await readSessionId(meshRoot, agentRoot), sid, 'resume must keep the same canonical id');
  const after = (await readEvents(meshRoot)).filter((e) => e.kind === 'create').length;
  assert.equal(after, before, 'resuming an existing session must not record another create');
});

test('runTurn uses a reserved canonical id as --session-id until its transcript exists', async () => {
  const { meshRoot, agentRoot } = await buildMesh();
  const sid = '22222222-2222-2222-2222-222222222222';
  await writeSessionId(meshRoot, agentRoot, sid);
  const argLogPath = join(meshRoot, 'claude-args.json');
  const claudeBin = await fakeClaudeRecordingArgs(meshRoot, argLogPath);
  const runner = createSessionRunner({ meshRoot, claudeBin });

  const { done } = await runner.runTurn({ agentName: 'alpha', text: 'hi' });
  const result = await done;
  assert.equal(result.ok, true);

  const args = JSON.parse(await readFile(argLogPath, 'utf8'));
  assert.equal(args.includes('--resume'), false);
  const sessionIdIndex = args.indexOf('--session-id');
  assert.notEqual(sessionIdIndex, -1, 'reserved ids without transcripts must be launched with --session-id');
  assert.equal(args[sessionIdIndex + 1], sid);
  assert.equal(await readSessionId(meshRoot, agentRoot), sid);
});

test('a live in-flight turn → session_busy without starting a second turn', async () => {
  const { meshRoot } = await buildMesh();
  const claudeBin = await fakeClaude(meshRoot);
  const runner = createSessionRunner({ meshRoot, claudeBin });

  const { done } = await runner.runTurn({ agentName: 'alpha', text: 'first' });
  await assert.rejects(
    () => runner.runTurn({ agentName: 'alpha', text: 'second' }),
    (e) => e.code === 'session_busy'
  );
  await done;
});

// --------------------------------------------------------------------------
// Task 5 helpers: a separate mesh with a `library` agent
// --------------------------------------------------------------------------

async function buildMeshLibrary() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'sr-lib-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
  await writeFile(join(agentRoot, 'registry.json'), JSON.stringify({ 'x-agentmesh-generated': true, peers: {} }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot, agentRoot: await realpath(agentRoot) };
}

test('setActiveSession records select + bumps rev; runTurn rejects active_changed before spawning', async () => {
  const { meshRoot, agentRoot } = await buildMeshLibrary();
  const claudeBin = await fakeClaude(meshRoot);
  const runner = createSessionRunner({ meshRoot, claudeBin });

  const a = await runner.setActiveSession('library', '33333333-3333-3333-3333-333333333333');
  assert.ok(a.rev >= 1);
  assert.equal(a.activeId, '33333333-3333-3333-3333-333333333333');

  // select wrote the canonical id + recorded a `select` provenance event.
  assert.equal(await readSessionId(meshRoot, agentRoot), '33333333-3333-3333-3333-333333333333');
  const sel = (await readEvents(meshRoot)).find((e) => e.kind === 'select' && e.sessionId === '33333333-3333-3333-3333-333333333333');
  assert.ok(sel, 'setActiveSession must record a select provenance event');
  assert.equal(sel.source, 'dashboard');

  // A stale expectedActiveId is rejected BEFORE acquiring the lease / spawning.
  await assert.rejects(
    () => runner.runTurn({ agentName: 'library', text: 'hi', expectedActiveId: 'deadbeef-0000-0000-0000-000000000000' }),
    (e) => e.code === 'active_changed'
  );
  // The store was not disturbed by the rejected turn.
  assert.equal(await readSessionId(meshRoot, agentRoot), '33333333-3333-3333-3333-333333333333');

  // setActiveSession rejects a non-UUID id (no garbage into the store).
  await assert.rejects(() => runner.setActiveSession('library', 'not-a-uuid'), (e) => e.code === 'bad_id');
});

test('runTurn with matching expectedActiveId proceeds; create recorded for brand-new session', async () => {
  const { meshRoot, agentRoot } = await buildMeshLibrary();
  const claudeBin = await fakeClaude(meshRoot);
  const runner = createSessionRunner({ meshRoot, claudeBin });
  // No active session yet (fresh mesh): runTurn with expectedActiveId=null proceeds.
  const { done } = await runner.runTurn({ agentName: 'library', text: 'hello', expectedActiveId: null });
  const r = await done;
  assert.equal(r.ok, true);
  const sid = await readSessionId(meshRoot, agentRoot);
  assert.ok(sid && sid.length);
  const create = (await readEvents(meshRoot)).find((e) => e.kind === 'create' && e.sessionId === sid);
  assert.ok(create, 'a create provenance event must be recorded for the brand-new session');
});

test('setActiveSession then runTurn with correct expectedActiveId resumes the selected id', async () => {
  const { meshRoot, agentRoot } = await buildMeshLibrary();
  const claudeBin = await fakeClaude(meshRoot);
  const runner = createSessionRunner({ meshRoot, claudeBin });
  const sid = '44444444-4444-4444-4444-444444444444';
  await runner.setActiveSession('library', sid);
  // correct expectedActiveId → proceeds (no rejection).
  const { done } = await runner.runTurn({ agentName: 'library', text: 'hi', expectedActiveId: sid });
  const r = await done;
  assert.equal(r.ok, true);
  // Resuming the selected id keeps it canonical and records no `create`.
  assert.equal(await readSessionId(meshRoot, agentRoot), sid);
  const createCount = (await readEvents(meshRoot)).filter((e) => e.kind === 'create').length;
  assert.equal(createCount, 0, 'resuming a selected session must not record a create');
});

test('runMaintenance holds the agent lease: concurrent runTurn gets session_busy; release on throw', async (t) => {
  const { meshRoot } = await buildMesh();
  const agentName = 'alpha';
  const claudeBin = await fakeClaude(meshRoot);
  const runner = createSessionRunner({ meshRoot, claudeBin });
  let release, acquired;
  const gate = new Promise((res) => { release = res; });
  const leaseHeld = new Promise((res) => { acquired = res; });
  const inside = runner.runMaintenance(agentName, async ({ agentRoot }) => {
    assert.ok(agentRoot.length > 0);
    // fn runs only AFTER runMaintenance set inFlight + acquired the lease, so
    // this is a happens-before signal — deterministic on slow runners (the
    // prior fixed 50ms sleep lost the race to Windows process probes in CI).
    acquired();
    await gate;
    return 'done';
  });
  await leaseHeld;
  await assert.rejects(() => runner.runTurn({ agentName, text: 'hi' }), (e) => e.code === 'session_busy');
  release();
  assert.equal(await inside, 'done');
  // lease released → a throwing maintenance also releases:
  await assert.rejects(() => runner.runMaintenance(agentName, async () => { throw new Error('boom'); }), /boom/);
  const again = await runner.runMaintenance(agentName, async () => 'ok-after-throw');
  assert.equal(again, 'ok-after-throw');
});
