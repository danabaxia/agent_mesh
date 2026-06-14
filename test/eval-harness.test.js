// test/eval-harness.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMesh, readRuns, gitClean, cleanupMesh, plant } from '../eval/harness.mjs';
import { readManagedRegistry } from '../src/a2a/registry.js';

test('plant produces unique non-dictionary tokens', () => {
  const a = plant('FACT'); const b = plant('FACT');
  assert.match(a, /^FACT-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
});

test('buildMesh: marker-valid registries, manifest, git-clean seeded agents', async () => {
  const mesh = await buildMesh({
    agents: {
      A: { peers: ['B'] },
      B: { agentMd: 'Library agent. Capabilities: lookup.', files: { 'data/fact.md': 'X' } }
    },
    claude: '/bin/true'
  });
  try {
    const reg = await readManagedRegistry(mesh.agents.A.root);
    assert.equal(reg.ok, true);
    assert.deepEqual(Object.keys(reg.registry.peers), ['B']);
    const peerB = reg.registry.peers.B;
    assert.equal(peerB.root, mesh.agents.B.root);
    assert.equal(peerB.env.AGENT_MESH_MESH_CEILING, mesh.meshRoot);
    assert.equal(peerB.env.AGENT_MESH_LOG_DIR, mesh.agents.B.logDir);
    const manifest = JSON.parse(await readFile(join(mesh.meshRoot, 'mesh.json'), 'utf8'));
    assert.deepEqual(manifest.agents.map((a) => a.name).sort(), ['A', 'B']);
    assert.equal(await gitClean(mesh.agents.B), true);   // seeded files committed
    await writeFile(join(mesh.agents.B.root, 'data/fact.md'), 'tampered');
    assert.equal(await gitClean(mesh.agents.B), false);  // detects change
  } finally { await cleanupMesh(mesh); }
});

test('readRuns: parses, dedupes by id (last wins), keeps done only, sorted', async () => {
  const mesh = await buildMesh({ agents: { A: {} }, claude: '/bin/true' });
  try {
    const dir = mesh.agents.A.logDir;
    await mkdir(dir, { recursive: true });
    const lines = [
      { id: 'r1', state: 'started', started_at: '2026-06-10T01:00:00Z' },
      { id: 'r1', state: 'done', status: 'done', started_at: '2026-06-10T01:00:00Z', parent_run_id: 'p0' },
      { id: 'r2', state: 'done', status: 'error', started_at: '2026-06-10T02:00:00Z' }
    ].map((r) => JSON.stringify(r)).join('\n');
    await writeFile(join(dir, 'delegate-2026-06-10.jsonl'), lines + '\n');
    const runs = await readRuns(mesh.agents.A);
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((r) => r.id), ['r1', 'r2']);   // sorted by started_at
    assert.equal(runs[0].parent_run_id, 'p0');               // final record won
  } finally { await cleanupMesh(mesh); }
});

import { probe, sessionArg } from '../eval/probes.mjs';

test('probes: each fires correctly in both directions on synthetic artifacts', async () => {
  const ctx = {
    results: [{ answer: 'The code is FACT-aa11bb22.', runId: 'rA' }],
    runs: {
      B: [{ id: 'rB', parent_run_id: 'rA', argv: ['-p', 'x', '--session-id', 's-1'], started_at: '1' }],
      C: []
    },
    mesh: null, planted: {}
  };
  assert.equal((await probe.peerRan('B').check(ctx)).pass, true);
  assert.equal((await probe.peerRan('C').check(ctx)).pass, false);
  assert.equal((await probe.noPeerRan(['C']).check(ctx)).pass, true);
  assert.equal((await probe.noPeerRan(['B']).check(ctx)).pass, false);
  assert.equal((await probe.answerContains(0, 'FACT-aa11bb22').check(ctx)).pass, true);
  assert.equal((await probe.answerContains(0, 'FACT-zz').check(ctx)).pass, false);
  assert.equal((await probe.answerNotContains(0, 'FACT-zz').check(ctx)).pass, true);
  assert.deepEqual(sessionArg(ctx.runs.B[0]), { flag: '--session-id', id: 's-1' });
  assert.equal(sessionArg({ argv: ['-p', 'x'] }), null);
  // peerRanUnder: C parented by B
  const ctx2 = { ...ctx, runs: { B: ctx.runs.B, C: [{ id: 'rC', parent_run_id: 'rB', started_at: '2' }] } };
  assert.equal((await probe.peerRanUnder('C', 'B').check(ctx2)).pass, true);
  assert.equal((await probe.peerRanUnder('C', 'B').check(ctx)).pass, false);
  // inverse direction of answerNotContains
  assert.equal((await probe.answerNotContains(0, 'FACT-aa11bb22').check(ctx)).pass, false);
  // peerRanUnder false on WRONG parent (not just empty)
  const ctx3 = { ...ctx, runs: { B: ctx.runs.B, C: [{ id: 'rC', parent_run_id: 'WRONG', started_at: '2' }] } };
  assert.equal((await probe.peerRanUnder('C', 'B').check(ctx3)).pass, false);
  // sessionArg: flag with no following value → null, not {id: undefined}
  assert.equal(sessionArg({ argv: ['-p', 'x', '--resume'] }), null);
  // peersClean: unknown agent fails as data, never throws
  const unknown = await probe.peersClean(['nope']).check({ mesh: { agents: {} } });
  assert.equal(unknown.pass, false);
  assert.match(unknown.detail, /unknown agent/);
  // peerRan: turn suffix in name + precise out-of-bounds detail
  assert.equal(probe.peerRan('B', { turn: 1 }).name, 'peerRan(B,t1)');
  const oob = await probe.peerRan('B', { turn: 5 }).check(ctx);
  assert.equal(oob.pass, false);
  assert.match(oob.detail, /no result at turn 5 \(results length 1\)/);
});

test('probes: peersClean and fileAbsent inspect the real mesh', async () => {
  const mesh = await buildMesh({ agents: { B: { files: { 'a.txt': 'x' } } }, claude: '/bin/true' });
  try {
    const ctx = { results: [], runs: {}, mesh, planted: {} };
    assert.equal((await probe.peersClean(['B']).check(ctx)).pass, true);
    assert.equal((await probe.fileAbsent('DONE.txt').check(ctx)).pass, true);
    await writeFile(join(mesh.agents.B.root, 'DONE.txt'), 'oops');
    assert.equal((await probe.peersClean(['B']).check(ctx)).pass, false);
    assert.equal((await probe.fileAbsent('DONE.txt').check(ctx)).pass, false);
  } finally { await cleanupMesh(mesh); }
});

import { aggregate, renderMarkdown, exitCode } from '../eval/scorecard.mjs';
import { mkdtemp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runScenario } from '../eval/runner.mjs';

test('scorecard: aggregation, markdown, threshold exit code', () => {
  const report = aggregate([
    { name: 's1', trials: [
      { trial: 0, pass: true, probes: [], durationMs: 100 },
      { trial: 1, pass: false, probes: [{ name: 'p', pass: false, detail: 'd' }], durationMs: 120 }
    ] },
    { name: 's4', compare: { roster: { delegationRate: 1 }, noRoster: { delegationRate: 0.33 } } }
  ]);
  assert.equal(report.scenarios[0].passRate, 0.5);
  assert.equal(report.aggregate.passRate, 0.5);          // compare entries excluded
  assert.equal(report.aggregate.trials, 2);
  const md = renderMarkdown(report);
  assert.match(md, /s1.*50%/s);
  assert.match(md, /s4/);
  assert.equal(exitCode(report, undefined), 0);          // no threshold → always 0
  assert.equal(exitCode(report, 0.4), 0);
  assert.equal(exitCode(report, 0.9), 1);
});

async function fakeClaude(body) {
  const dir = await mkdtemp(join(tmpdir(), 'eval-fc-'));
  const p = join(dir, 'fake-claude.mjs');
  await writeFile(p, `#!/usr/bin/env node\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

test('runner: full hermetic loop — build, drive over real serve-a2a, probe, score', { timeout: 60_000 }, async () => {
  // fake worker: echoes the planted fact it finds in its own folder.
  const fc = await fakeClaude(`
    const fs = await import('node:fs/promises');
    let fact = 'none';
    try { fact = (await fs.readFile('notes.md', 'utf8')).trim(); } catch {}
    console.log('The answer is ' + fact);`);
  const fact = plant('FACT');
  const scenario = {
    name: 'hermetic-smoke',
    async setup(h) {
      const mesh = await h.buildMesh({
        agents: { A: { files: { 'notes.md': fact }, peers: ['B'] }, B: {} },
        claude: fc
      });
      return {
        mesh, driven: 'A',
        turns: [{ task: 'What does your notes file say?' }],
        probes: [h.probe.answerContains(0, fact), h.probe.noPeerRan(['B'])]
      };
    }
  };
  const rep = await runScenario(scenario, { trials: 2, claude: fc, timeoutMs: 30_000, outDir: await mkdtemp(join(tmpdir(), 'eval-out-')) });
  assert.equal(rep.trials.length, 2);
  assert.equal(rep.trials.every((t) => t.pass), true, JSON.stringify(rep.trials, null, 2));
});

test('harness guards: claude required, unknown peer named error, cleanupMesh removes temp dirs', async () => {
  await assert.rejects(() => buildMesh({ agents: { A: {} } }), /claude binary path is required/);
  await assert.rejects(
    () => buildMesh({ agents: { A: { peers: ['ghost'] } }, claude: '/bin/true' }),
    /unknown peer "ghost"/
  );
  const mesh = await buildMesh({ agents: { A: {} }, claude: '/bin/true' });
  await cleanupMesh(mesh);
  const { access } = await import('node:fs/promises');
  await assert.rejects(() => access(mesh.meshRoot), undefined, 'meshRoot removed');
  await assert.rejects(() => access(mesh.logsBase), undefined, 'logsBase removed');
});

test('runner: failing probe preserves artifacts; setup throw scored not crashed', { timeout: 60_000 }, async () => {
  const fc = await fakeClaude(`console.log('nothing useful');`);
  const outDir = await mkdtemp(join(tmpdir(), 'eval-out-'));
  const failing = {
    name: 'hermetic-fail',
    async setup(h) {
      const mesh = await h.buildMesh({ agents: { A: {} }, claude: fc });
      return { mesh, driven: 'A', turns: [{ task: 'say nothing' }], probes: [h.probe.answerContains(0, 'WILL-NOT-APPEAR')] };
    }
  };
  const rep = await runScenario(failing, { trials: 1, claude: fc, timeoutMs: 30_000, outDir });
  assert.equal(rep.trials[0].pass, false);
  const { access, readFile } = await import('node:fs/promises');
  const ansPath = join(outDir, 'failures', 'hermetic-fail-t0', 'answers.json');
  await access(ansPath);
  const answers = JSON.parse(await readFile(ansPath, 'utf8'));
  assert.equal(answers.length, 1);
  assert.ok('task' in answers[0] && 'state' in answers[0]);

  const thrower = { name: 'hermetic-throw', async setup() { throw new Error('fixture exploded'); } };
  const rep2 = await runScenario(thrower, { trials: 1, claude: fc, timeoutMs: 30_000, outDir });
  assert.equal(rep2.trials[0].pass, false);
  assert.match(rep2.trials[0].probes[0].detail, /fixture exploded/);
});

test('scenario 04 exports a custom run() producing a compare entry', async () => {
  // Import via the file:// URL directly. The previous form took
  // `new URL(...).pathname` (which on Windows is `/D:/…/04-roster-ab.mjs` — a URL
  // path, NOT a filesystem path) and fed it to pathToFileURL, which treated it as
  // relative and produced a doubled-drive `D:\D:\…` module specifier → "Cannot
  // find module". A file:// URL is already a valid ESM specifier on every platform.
  const url = new URL('../eval/scenarios/04-roster-ab.mjs', import.meta.url).href;
  const s = (await import(url)).default;
  assert.equal(s.name, '04-roster-ab');
  assert.equal(typeof s.run, 'function');
});

test('scenario modules: all export {name, setup|run} and setup() yields a valid fixture', async () => {
  const { readdir } = await import('node:fs/promises');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  // fileURLToPath, not `.pathname`: on Windows `.pathname` is `/D:/…/scenarios/`
  // (leading-slash URL path), which readdir resolves to a doubled-drive
  // `D:\D:\…` and ENOENTs. fileURLToPath yields the real `D:\…\scenarios\` path.
  const dir = fileURLToPath(new URL('../eval/scenarios/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort();
  assert.ok(files.length >= 4, `expected scenario files, got ${files.length}`);
  const { api } = await import('../eval/runner.mjs');
  api.claudeBin = '/bin/true';   // scenarios reference h.claudeBin; tests never spawn it
  for (const f of files) {
    const s = (await import(pathToFileURL(join(dir, f)).href)).default;
    assert.ok(s.name, `${f} has a name`);
    if (typeof s.run === 'function') continue;            // custom-run (04)
    const setup = await s.setup(api);
    try {
      assert.ok(setup.mesh && setup.driven && Array.isArray(setup.turns) && setup.turns.length > 0, `${f} fixture complete`);
      assert.ok(Array.isArray(setup.probes) && setup.probes.length > 0, `${f} has probes`);
      for (const p of setup.probes) assert.ok(p.name && typeof p.check === 'function', `${f} probe shape`);
    } finally { await cleanupMesh(setup.mesh); }
  }
});

test('gitClean ignores the claude CLI .claude state dir but flags real output', async () => {
  const mesh = await buildMesh({ agents: { B: { files: { 'a.txt': 'x' } } }, claude: '/bin/true' });
  try {
    await mkdir(join(mesh.agents.B.root, '.claude'), { recursive: true });
    await writeFile(join(mesh.agents.B.root, '.claude', 'settings.local.json'), '{}');
    await mkdir(join(mesh.agents.B.root, '.agent-mesh', 'peer-epochs'), { recursive: true });
    await writeFile(join(mesh.agents.B.root, '.agent-mesh', 'peer-epochs', 'abc123'), '1');
    assert.equal(await gitClean(mesh.agents.B), true, '.claude/.agent-mesh residue tolerated');
    await writeFile(join(mesh.agents.B.root, 'task-output.txt'), 'oops');
    assert.equal(await gitClean(mesh.agents.B), false, 'real output still flagged');
  } finally { await cleanupMesh(mesh); }
});

// ── do-mode behavior evals (spec 2026-06-13-do-mode-behavior-evals) ──────────

test('do-mode probes: fileHasContent / onlyAgentChanged / guardDenied / filesChangedReports', async () => {
  const mesh = await buildMesh({ agents: { A: {}, B: {} }, claude: '/bin/true' });
  try {
    const ctx = { results: [{ runId: 'rA' }], runs: {}, mesh, planted: {} };
    // fileHasContent: present-with-substring / present-without / absent / unknown agent
    await mkdir(join(mesh.agents.A.root, 'notes'), { recursive: true });
    await writeFile(join(mesh.agents.A.root, 'notes', 'out.txt'), 'has TOKEN-1 here');
    assert.equal((await probe.fileHasContent('A', 'notes/out.txt', 'TOKEN-1').check(ctx)).pass, true);
    assert.equal((await probe.fileHasContent('A', 'notes/out.txt', 'NOPE').check(ctx)).pass, false);
    assert.equal((await probe.fileHasContent('A', 'missing.txt', 'x').check(ctx)).pass, false);
    assert.equal((await probe.fileHasContent('ghost', 'x', 'y').check(ctx)).pass, false);
    // onlyAgentChanged: A dirty + B clean → pass; B (unchanged) → fail
    assert.equal((await probe.onlyAgentChanged('A').check(ctx)).pass, true);
    assert.equal((await probe.onlyAgentChanged('B').check(ctx)).pass, false, 'clean target fails');
    await writeFile(join(mesh.agents.B.root, 'leak.txt'), 'x');   // now B dirty too
    assert.equal((await probe.onlyAgentChanged('A').check(ctx)).pass, false, 'other folder changed → fail');
    // guardDenied: no log → fail; a denial entry → pass
    assert.equal((await probe.guardDenied('A').check(ctx)).pass, false);
    await mkdir(mesh.agents.A.logDir, { recursive: true });
    await writeFile(join(mesh.agents.A.logDir, 'path-guard-denials.jsonl'), JSON.stringify({ path: '/x' }) + '\n');
    assert.equal((await probe.guardDenied('A').check(ctx)).pass, true);
    // filesChangedReports: run matched by turn runId; array hit / miss / null
    const ctxFC = { results: [{ runId: 'r1' }], runs: { A: [{ id: 'r1', result: { files_changed: ['notes/out.txt'] } }] }, mesh };
    assert.equal((await probe.filesChangedReports('A', 'notes/out.txt').check(ctxFC)).pass, true);
    assert.equal((await probe.filesChangedReports('A', 'other.txt').check(ctxFC)).pass, false);
    // git collapses a new untracked dir to "notes/" → still covers notes/out.txt
    const ctxDir = { results: [{ runId: 'r1' }], runs: { A: [{ id: 'r1', result: { files_changed: ['notes/'] } }] }, mesh };
    assert.equal((await probe.filesChangedReports('A', 'notes/out.txt').check(ctxDir)).pass, true);
    const ctxNull = { results: [{ runId: 'r1' }], runs: { A: [{ id: 'r1', result: { files_changed: null } }] }, mesh };
    assert.equal((await probe.filesChangedReports('A', 'x').check(ctxNull)).pass, false);
  } finally { await cleanupMesh(mesh); }
});

test('runner: do-mode write lands in-root, only there, files_changed reports it', { timeout: 60_000 }, async () => {
  // Writer fake: writes notes/out.txt ONLY when the worker is spawned in do mode
  // (proving agentEnv enabled do + the turn's mode:do reached delegate). The
  // path-guard's real enforcement (out-of-root denial) needs real claude tool
  // calls, so scenarios 11/12 prove that at eval time; this is the happy path.
  const fc = await fakeClaude(`
    const fs = await import('node:fs/promises');
    if (process.env.AGENT_MESH_MODE === 'do') {
      await fs.mkdir('notes', { recursive: true });
      await fs.writeFile('notes/out.txt', 'WROTE-HERMETIC');
    }
    console.log('done');`);
  const scenario = {
    name: 'do-write-hermetic',
    async setup(h) {
      const mesh = await h.buildMesh({ agents: { A: {}, B: {} }, claude: fc });
      return {
        mesh, driven: 'A',
        // enable do on the served agent; pin platform so the do-mode managed-policy
        // preflight passes on a Windows dev host too (matches delegate.test.js).
        agentEnv: { AGENT_MESH_ENABLED_MODES: 'ask,do', AGENT_MESH_TEST_PLATFORM: 'linux' },
        turns: [{ metadata: { 'agentmesh/mode': 'do' }, task: 'write notes/out.txt in your folder' }],
        probes: [
          h.probe.fileHasContent('A', 'notes/out.txt', 'WROTE-HERMETIC'),
          h.probe.onlyAgentChanged('A'),
          h.probe.filesChangedReports('A', 'notes/out.txt')
        ]
      };
    }
  };
  const rep = await runScenario(scenario, { trials: 1, claude: fc, timeoutMs: 30_000, outDir: await mkdtemp(join(tmpdir(), 'eval-out-')) });
  assert.equal(rep.trials[0].pass, true, JSON.stringify(rep.trials, null, 2));
});
