// test/multi-turn-delegate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { delegateTask } from '../src/delegate.js';
import { createA2AStdioServer } from '../src/a2a/stdio-server.js';
import { createBridge } from '../src/a2a/peer-bridge.js';
import { deriveSessionId } from '../src/a2a/session-id.js';
import { encodeProjectDir } from '../src/session-transcripts.js';
import { BIN_PATH } from '../src/delegate-invocation.js';
import { readLabels } from '../src/dashboard/session-index.js';

async function fakeClaude(body) {
  const dir = await mkdtemp(join(tmpdir(), 'fc-'));
  const p = join(dir, 'fake-claude.mjs');
  await writeFile(p, `#!/usr/bin/env node\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

test('ask delegate threads --session-id (new) / --resume (resume) into the claude argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-'));
  const fc = await fakeClaude(`
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
    console.log('ok');`);
  const env = { AGENT_MESH_CLAUDE: fc, AGENT_MESH_TEST_PLATFORM: 'linux', CAPTURE_PATH: join(root, 'argv.json') };
  const sid = '22222222-2222-4222-8222-222222222222';

  await delegateTask({ root, env, input: { mode: 'ask', task: 't' }, session: { id: sid, resume: false } });
  let argv = JSON.parse(await readFile(join(root, 'argv.json'), 'utf8'));
  assert.ok(argv.includes('--session-id') && argv[argv.indexOf('--session-id') + 1] === sid);

  await delegateTask({ root, env, input: { mode: 'ask', task: 't2' }, session: { id: sid, resume: true } });
  argv = JSON.parse(await readFile(join(root, 'argv.json'), 'utf8'));
  assert.ok(argv.includes('--resume') && argv[argv.indexOf('--resume') + 1] === sid);
});

test('resume-load failure self-heals: re-spawn once with --session-id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-'));
  // fake claude: if invoked with --resume, exit 1 with a resume error; with --session-id, succeed.
  const fc = await fakeClaude(`
    const a = process.argv.slice(2);
    if (a.includes('--resume')) { process.stderr.write('Error: No conversation found to resume'); process.exit(1); }
    console.log('fresh ok');`);
  const env = { AGENT_MESH_CLAUDE: fc, AGENT_MESH_TEST_PLATFORM: 'linux' };
  const r = await delegateTask({ root, env, input: { mode: 'ask', task: 't' },
    session: { id: '33333333-3333-4333-8333-333333333333', resume: true } });
  assert.equal(r.status, 'done');                       // recovered, not error
  assert.match(r.summary, /fresh ok/);
});

// ── Task 4: C derives the per-caller session per turn ────────────────────────

// Drive the in-process A2A server with a single SendMessage and wait for its
// JSON-RPC response (emitted only after the stub claude has exited and captured
// its argv). Each call uses a FRESH server, proving cross-restart durability.
async function sendOnce({ root, env, caller, reset }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => {
    try { lines.push(JSON.parse(l)); } catch { /* partial */ }
  }));
  const server = await createA2AStdioServer({ root, env });
  const done = server.start(input, output);
  const md = { 'agentmesh/mode': 'ask' };
  if (caller) md['agentmesh/caller'] = caller;
  if (reset) md['agentmesh/reset_conversation'] = true;
  input.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'SendMessage',
    params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hi' }], metadata: md } }
  }) + '\n');
  const t0 = Date.now();
  while (lines.length === 0 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 20));
  input.end();
  await done.catch(() => {});
  return lines[0];
}

async function transcriptFixture() {
  const root = await mkdtemp(join(tmpdir(), 'peer-'));
  const projects = await mkdtemp(join(tmpdir(), 'projects-'));
  const fc = await fakeClaude(`console.log('ok');`);
  const platform = process.platform;
  const env = { AGENT_MESH_CLAUDE: fc, AGENT_MESH_TEST_PLATFORM: platform, AGENT_MESH_PROJECTS_DIR: projects };
  const enc = encodeProjectDir(await realpath(root), platform, { projectsDir: projects });
  const idB0 = deriveSessionId('B:0', enc);
  return { root, projects, env, enc, idB0 };
}

test('C derives a stable per-caller session: 1st --session-id, 2nd --resume; reset+restart durable; caller isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'peer-'));
  const projects = await mkdtemp(join(tmpdir(), 'projects-'));
  const capture = join(root, 'argv.json');
  const fc = await fakeClaude(`
    const fs = await import('node:fs/promises');
    const a = process.argv.slice(2);
    const i = a.indexOf('--session-id') >= 0 ? a.indexOf('--session-id') : a.indexOf('--resume');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({ flag: a[i], id: a[i + 1] }));
    console.log('ok');`);
  const platform = process.platform;
  const env = { AGENT_MESH_CLAUDE: fc, AGENT_MESH_TEST_PLATFORM: platform,
    AGENT_MESH_PROJECTS_DIR: projects, CAPTURE_PATH: capture };
  const enc = encodeProjectDir(await realpath(root), platform, { projectsDir: projects });
  const idB0 = deriveSessionId('B:0', enc);
  const idB1 = deriveSessionId('B:1', enc);
  const idD0 = deriveSessionId('D:0', enc);
  const readCap = async () => JSON.parse(await readFile(capture, 'utf8'));

  // turn 1 — B, no transcript yet → start a NEW session
  await sendOnce({ root, env, caller: 'B' });
  let cap = await readCap();
  assert.equal(cap.flag, '--session-id');
  assert.equal(cap.id, idB0);

  // claude "wrote" its transcript → turn 2 must RESUME the same id
  await mkdir(join(projects, enc), { recursive: true });
  await writeFile(join(projects, enc, `${idB0}.jsonl`), '{}\n');

  await sendOnce({ root, env, caller: 'B' });
  cap = await readCap();
  assert.equal(cap.flag, '--resume');
  assert.equal(cap.id, idB0);

  // new_conversation → epoch bumps to 1 (persisted) → a DIFFERENT, fresh id
  await sendOnce({ root, env, caller: 'B', reset: true });
  cap = await readCap();
  assert.equal(cap.flag, '--session-id');
  assert.equal(cap.id, idB1);
  assert.notEqual(idB1, idB0);

  // a FRESH server reads the persisted epoch (1) → same idB1 (durable reset).
  // If the bump had only lived in memory, this would fall back to idB0 (--resume).
  await sendOnce({ root, env, caller: 'B' });
  cap = await readCap();
  assert.equal(cap.id, idB1);
  assert.equal(cap.flag, '--session-id');   // idB1 has no transcript → still new

  // isolation — D lands on its own thread, never B's
  await sendOnce({ root, env, caller: 'D' });
  cap = await readCap();
  assert.equal(cap.id, idD0);
  assert.notEqual(idD0, idB0);
});

// ── Task 5: bridge stamps the authentic caller name + new_conversation ───────

test('bridge stamps the manifest caller name and reset flag; refuses when caller identity is unresolvable', async () => {
  // mini mesh: meshRoot/{mesh.json, B/registry.json}
  const meshRoot = await mkdtemp(join(tmpdir(), 'mesh-'));
  const bRoot = join(meshRoot, 'B');
  await mkdir(bRoot, { recursive: true });
  await writeFile(join(meshRoot, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true, meshVersion: '1',
    agents: [{ name: 'B', root: './B' }, { name: 'C', root: './C' }]
  }));
  await writeFile(join(bRoot, 'registry.json'), JSON.stringify({
    'x-agentmesh-generated': true,
    peers: { C: { root: '/tmp/C', command: 'node', args: [], cwd: '/tmp/C', env: {} } }
  }));

  let captured = null;
  const createClient = async () => ({
    send: async (_p, m) => { captured = m; return { status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [], metadata: {} }; },
    close: async () => {}
  });

  // resolvable: AGENT_MESH_MESH_CEILING points at the mesh root → caller = 'B'
  const bridge = createBridge({ root: bRoot, env: { AGENT_MESH_MESH_CEILING: meshRoot }, createClient });
  const ok = await bridge.delegateToPeer({ peer: 'C', mode: 'ask', task: 'q1', new_conversation: true });
  assert.equal(ok.ok, true);
  assert.equal(captured.metadata['agentmesh/caller'], 'B');
  assert.equal(captured.metadata['agentmesh/reset_conversation'], true);

  // a normal follow-up carries the caller but NO reset flag
  await bridge.delegateToPeer({ peer: 'C', mode: 'ask', task: 'q2' });
  assert.equal(captured.metadata['agentmesh/caller'], 'B');
  assert.equal(captured.metadata['agentmesh/reset_conversation'], undefined);

  // unresolvable: no mesh env → refuse BEFORE any peer spawn
  let spawned = false;
  const bad = createBridge({ root: bRoot, env: {}, createClient: async () => { spawned = true; return { send: async () => ({}), close: async () => {} }; } });
  const r = await bad.delegateToPeer({ peer: 'C', mode: 'ask', task: 'q' });
  assert.equal(r.status, 'rejected');
  assert.equal(r.error_code, 'caller_identity_unresolved');
  assert.equal(spawned, false);
});

// ── Task 6: end-to-end multi-turn over a REAL serve-a2a peer subprocess ───────
//
// The bridge uses the REAL createA2AClient, so each delegate_to_peer spawns a
// fresh `node bin/agent-mesh.js serve-a2a C` and tears it down in finally — the
// exact per-call teardown the design must survive. A stub claude (threaded into
// C via the registry peer.env) records the (--session-id|--resume, id) it was
// invoked with; AGENT_MESH_PROJECTS_DIR keeps transcript-existence hermetic.
test('E2E: B→C multi-turn resumes across real per-call teardown; reset + caller isolation', { timeout: 60000 }, async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'mesh-e2e-'));
  const bRoot = join(meshRoot, 'B');
  const dRoot = join(meshRoot, 'D');
  const cRoot = join(meshRoot, 'C');
  await mkdir(bRoot, { recursive: true });
  await mkdir(dRoot, { recursive: true });
  await mkdir(cRoot, { recursive: true });
  const projects = await mkdtemp(join(tmpdir(), 'projects-e2e-'));
  const capture = join(meshRoot, 'capture.json');
  const platform = process.platform;

  await writeFile(join(meshRoot, 'mesh.json'), JSON.stringify({
    'x-agentmesh-generated': true, meshVersion: '1',
    agents: [{ name: 'B', root: './B' }, { name: 'C', root: './C' }, { name: 'D', root: './D' }]
  }));

  // stub claude: record {flag, id} for the session arg it was spawned with.
  const stub = await fakeClaude(`
    const fs = await import('node:fs/promises');
    const a = process.argv.slice(2);
    const i = a.indexOf('--session-id') >= 0 ? a.indexOf('--session-id') : a.indexOf('--resume');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify({ flag: a[i], id: a[i + 1] }));
    console.log('ok');`);

  const peerC = {
    root: cRoot,
    command: process.execPath,                       // node
    args: [BIN_PATH, 'serve-a2a', cRoot],
    env: {
      AGENT_MESH_ENABLED_MODES: 'ask',
      AGENT_MESH_CLAUDE: stub,
      AGENT_MESH_PROJECTS_DIR: projects,
      AGENT_MESH_TEST_PLATFORM: platform,
      CAPTURE_PATH: capture
    }
  };
  const registry = { 'x-agentmesh-generated': true, peers: { C: peerC } };
  await writeFile(join(bRoot, 'registry.json'), JSON.stringify(registry));
  await writeFile(join(dRoot, 'registry.json'), JSON.stringify(registry));

  const encC = encodeProjectDir(await realpath(cRoot), platform, { projectsDir: projects });
  const idB0 = deriveSessionId('B:0', encC);
  const idB1 = deriveSessionId('B:1', encC);
  const idD0 = deriveSessionId('D:0', encC);
  const readCap = async () => JSON.parse(await readFile(capture, 'utf8'));

  const bridgeB = createBridge({ root: bRoot, env: { ...process.env, AGENT_MESH_MESH_CEILING: meshRoot } });

  // turn 1 — fresh thread → --session-id
  let res = await bridgeB.delegateToPeer({ peer: 'C', mode: 'ask', task: 'q1' });
  assert.equal(res.ok, true, `turn1: ${res.summary}`);
  let cap = await readCap();
  assert.equal(cap.flag, '--session-id');
  assert.equal(cap.id, idB0);

  // claude "wrote" its transcript on C → the NEXT (freshly spawned) C resumes it
  await mkdir(join(projects, encC), { recursive: true });
  await writeFile(join(projects, encC, `${idB0}.jsonl`), '{}\n');

  // turn 2 — resume across a genuine process teardown → --resume (same id)
  res = await bridgeB.delegateToPeer({ peer: 'C', mode: 'ask', task: 'q2' });
  assert.equal(res.ok, true, `turn2: ${res.summary}`);
  cap = await readCap();
  assert.equal(cap.flag, '--resume');
  assert.equal(cap.id, idB0);

  // turn 3 — new_conversation → C durably bumps B's epoch → a fresh id
  res = await bridgeB.delegateToPeer({ peer: 'C', mode: 'ask', task: 'q3', new_conversation: true });
  assert.equal(res.ok, true, `turn3: ${res.summary}`);
  cap = await readCap();
  assert.equal(cap.flag, '--session-id');
  assert.equal(cap.id, idB1);
  assert.notEqual(idB1, idB0);

  // isolation — a different caller D lands on its own thread, never B's
  const bridgeD = createBridge({ root: dRoot, env: { ...process.env, AGENT_MESH_MESH_CEILING: meshRoot } });
  res = await bridgeD.delegateToPeer({ peer: 'C', mode: 'ask', task: 'qd' });
  assert.equal(res.ok, true, `turnD: ${res.summary}`);
  cap = await readCap();
  assert.equal(cap.id, idD0);
  assert.notEqual(idD0, idB0);
});

// ── metrics.turn: thread turn-count stamped on multi-turn ask responses ──────

test('C stamps agentmesh/metrics.turn from the resumed transcript (omitted when absent)', async () => {
  const { root, projects, env, enc, idB0 } = await transcriptFixture();

  // turn 1: no transcript yet → metrics.turn omitted
  let resp = await sendOnce({ root, env, caller: 'B' });
  let metrics = resp.result.task.metadata['agentmesh/metrics'];
  assert.equal(metrics.turn, undefined, 'no transcript → no turn metric');

  // simulate claude having written a 2-user-turn transcript for the thread
  await mkdir(join(projects, enc), { recursive: true });
  const lines = [
    { type: 'user', message: { content: 'q1' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'a1' }] } },
    { type: 'user', message: { content: 'q2' } }
  ].map((l) => JSON.stringify(l)).join('\n') + '\n';
  await writeFile(join(projects, enc, `${idB0}.jsonl`), lines);

  resp = await sendOnce({ root, env, caller: 'B' });
  metrics = resp.result.task.metadata['agentmesh/metrics'];
  assert.equal(metrics.turn, 2, 'turn = count of user_text events in the thread transcript');
});

// ── Task 6: metrics.headroom stamped from thread transcript usage ────────────

test('SendMessage stamps agentmesh/metrics.headroom when the thread transcript carries usage', async () => {
  const { root, projects, env, enc, idB0 } = await transcriptFixture();

  // Pre-seed the transcript with a usage-bearing assistant record (150k of 200k default).
  // usageFromTail scans the LAST assistant line; a later usage-less assistant line would
  // shadow it — there is none here (test/headroom.test.js pins that behaviour).
  // The fake claude (console.log only) does NOT append to the transcript, so the
  // pre-seeded usage line remains the last assistant record when headroom is read.
  await mkdir(join(projects, enc), { recursive: true });
  const usageLine = JSON.stringify({
    type: 'assistant', timestamp: '2026-06-12T00:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }],
      usage: { input_tokens: 150000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  });
  await writeFile(join(projects, enc, `${idB0}.jsonl`), usageLine + '\n');

  const resp = await sendOnce({ root, env, caller: 'B' });
  const metrics = resp.result.task.metadata['agentmesh/metrics'];
  assert.equal(metrics.headroom, 25,
    `expected headroom=25 (150k/200k), got ${JSON.stringify(metrics)}`);
});

test('metrics.headroom is omitted (never an error) when the transcript has no usage', async () => {
  const { root, projects, env, enc, idB0 } = await transcriptFixture();

  // Pre-seed the transcript with an assistant record that carries NO usage field.
  await mkdir(join(projects, enc), { recursive: true });
  const noUsageLine = JSON.stringify({
    type: 'assistant', timestamp: '2026-06-12T00:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] }
  });
  await writeFile(join(projects, enc, `${idB0}.jsonl`), noUsageLine + '\n');

  const resp = await sendOnce({ root, env, caller: 'B' });
  const metrics = resp.result.task.metadata['agentmesh/metrics'];
  assert.equal('headroom' in metrics, false, `headroom must be omitted; got ${JSON.stringify(metrics)}`);
  // Turn still succeeds — the missing headroom never breaks the response shape.
  assert.ok(resp.result.task.status.state, 'task has a state (turn succeeded)');
});

// ── Task 4 (mesh-a2a-visibility): peer-session label keyed by mesh root ───────

test('peer-session label is keyed by mesh root, not agent root (shows as from:<caller>)', async () => {
  // C = a peer agent inside a mesh; bridge env carries AGENT_MESH_MESH_CEILING = meshRoot.
  const meshRoot = await mkdtemp(join(tmpdir(), 'prov-mesh-'));
  const root = join(meshRoot, 'knowledge');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'AGENT.md'), '# Knowledge\n', 'utf8');

  const fc = await fakeClaude(`console.log('ok');`);            // helper already in this file
  const env = { AGENT_MESH_CLAUDE: fc, AGENT_MESH_TEST_PLATFORM: 'linux',
    AGENT_MESH_MESH_CEILING: meshRoot, AGENT_MESH_PROJECTS_DIR: join(meshRoot, '.projects') };

  await sendOnce({ root, env, caller: 'data-analyst' });        // helper already in this file (one ask turn)

  const meshLabels = await readLabels(meshRoot);
  assert.ok(Object.values(meshLabels).includes('from:data-analyst'), 'label under the mesh-root store');
  const agentLabels = await readLabels(root);
  assert.equal(Object.values(agentLabels).includes('from:data-analyst'), false, 'NOT under the agent-root store');
});

test('label store falls back to dirname(AGENT_MESH_MESH_ROOT) — trailing slash tolerated', async () => {
  const meshRoot = await mkdtemp(join(tmpdir(), 'mesh-'));
  const root = join(meshRoot, 'archivist');
  await mkdir(root, { recursive: true });
  const projects = await mkdtemp(join(tmpdir(), 'projects-'));
  const fc = await fakeClaude(`console.log('ok');`);
  // No CEILING — only MESH_ROOT, with a trailing slash (env-override hazard).
  const env = {
    AGENT_MESH_CLAUDE: fc, AGENT_MESH_TEST_PLATFORM: process.platform,
    AGENT_MESH_PROJECTS_DIR: projects,
    AGENT_MESH_MESH_ROOT: join(meshRoot, 'mesh') + '/'
  };
  await sendOnce({ root, env, caller: 'colleague' });
  const meshLabels = await readLabels(meshRoot);
  assert.ok(Object.values(meshLabels).includes('from:colleague'),
    `fallback dirname(MESH_ROOT) must key the mesh store, got ${JSON.stringify(meshLabels)}`);
});
