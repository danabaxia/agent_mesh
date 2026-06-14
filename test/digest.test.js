import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDigestOutput, runDigest } from '../src/digest.js';
import { encodeProjectDir } from '../src/session-transcripts.js';
import { MAX_MEMORY_FILE_CHARS } from '../src/config.js';

const SID = 'cccccccc-dddd-4eee-8fff-000000000000';
const GOOD = {
  learned: ['User prefers tabs', 'Repo uses node:test only'],
  decisions: ['2026-06-12 — adopted headroom rotation'],
  proposals: [{ type: 'skill', name: 'cite-sources', summary: 'how to cite', draft: '# SKILL\nbody' }]
};
const summaryFor = (obj) => 'Here you go:\n```json\n' + JSON.stringify(obj) + '\n```';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dg-'));
  // realpath AFTER mkdir so the fixture encodes the SAME canonical root the
  // product looks up: resolveTranscript canonicalizes agentRoot before encoding,
  // so on Windows (os.tmpdir() returns an 8.3 SHORT path that realpath expands to
  // the LONG form) a raw-mkdtemp encoding would diverge and every lookup would
  // miss. On Linux this is a no-op.
  await mkdir(join(base, 'agent'));
  const agentRoot = await realpath(join(base, 'agent'));
  const projectsDir = join(base, 'projects');
  const enc = encodeProjectDir(agentRoot, 'linux', { projectsDir });
  await mkdir(join(projectsDir, enc), { recursive: true });
  await writeFile(join(projectsDir, enc, `${SID}.jsonl`),
    JSON.stringify({ type: 'user', message: { content: 'remember: tabs' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'noted' }] } }) + '\n');
  return { agentRoot, io: { projectsDir, platform: 'linux' } };
}

test('validateDigestOutput: GOOD passes; bad shapes and unsafe names fail closed', () => {
  assert.equal(validateDigestOutput(GOOD).ok, true);
  assert.equal(validateDigestOutput(null).ok, false);
  assert.equal(validateDigestOutput({ ...GOOD, learned: 'not-an-array' }).ok, false);
  assert.equal(validateDigestOutput({ ...GOOD, proposals: [{ type: 'skill', name: '../prompts/x', summary: 's', draft: 'd' }] }).ok, false);
  assert.equal(validateDigestOutput({ ...GOOD, proposals: [{ type: 'weird', name: 'ok-name', summary: 's', draft: 'd' }] }).ok, false);
});

test('runDigest happy path: extract written, worker called with digest timeout, files applied', async () => {
  const { agentRoot, io } = await fixture();
  const calls = [];
  const delegate = async (args) => { calls.push(args); return { status: 'done', summary: summaryFor(GOOD), log_path: '/log' }; };
  const r = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate, now: () => new Date('2026-06-12T10:00:00Z') });
  assert.equal(r.status, 'done');
  assert.equal(calls[0].input.mode, 'ask');
  assert.equal(calls[0].route, 'digest');
  assert.equal(calls[0].env.AGENT_MESH_TIMEOUT_MS, '180000');
  assert.match(calls[0].input.task, /\.agent-mesh[\\/]digest[\\/]/);
  const learned = await readFile(join(agentRoot, 'memory', 'learned.md'), 'utf8');
  assert.match(learned, /User prefers tabs/);
  assert.ok(learned.length <= MAX_MEMORY_FILE_CHARS);
  const decisions = await readFile(join(agentRoot, 'memory', 'decisions.md'), 'utf8');
  assert.match(decisions, /2026-06-12 — adopted headroom rotation/);
  const day = join(agentRoot, 'deliverables', 'digests', '2026-06-12', SID.slice(0, 8));
  const files = await readdir(day);
  assert.deepEqual(files, ['skill-cite-sources.md']);
  assert.deepEqual(r.applied, { learned: 2, decisions: 1, proposals: ['deliverables/digests/2026-06-12/' + SID.slice(0, 8) + '/skill-cite-sources.md'] });
});

test('oversized learned content is truncated to the memory cap', async () => {
  const { agentRoot, io } = await fixture();
  const big = { learned: Array.from({ length: 20 }, (_, i) => `fact ${i} ` + 'x'.repeat(180)), decisions: [], proposals: [] };
  const delegate = async () => ({ status: 'done', summary: summaryFor(big) });
  const r = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate });
  assert.equal(r.status, 'done');
  const learned = await readFile(join(agentRoot, 'memory', 'learned.md'), 'utf8');
  assert.ok(learned.length <= MAX_MEMORY_FILE_CHARS);
});

test('invalid contract → status error and ZERO writes', async () => {
  const { agentRoot, io } = await fixture();
  const delegate = async () => ({ status: 'done', summary: 'not json at all' });
  const r = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'digest_contract_invalid');
  await assert.rejects(() => access(join(agentRoot, 'memory', 'learned.md')));
});

test('proposals-only digest applies with zero memory writes', async () => {
  const { agentRoot, io } = await fixture();
  const only = { learned: [], decisions: [], proposals: [{ type: 'workflow', name: 'triage', summary: 'how to triage', draft: 'steps' }] };
  const delegate = async () => ({ status: 'done', summary: summaryFor(only) });
  const r = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate, now: () => new Date('2026-06-12T10:00:00Z') });
  assert.equal(r.status, 'done');
  assert.deepEqual(r.applied.proposals, ['deliverables/digests/2026-06-12/' + SID.slice(0, 8) + '/workflow-triage.md']);
  assert.equal(r.applied.learned, 0);
  assert.equal(r.applied.decisions, 0);
  await assert.rejects(() => access(join(agentRoot, 'memory', 'learned.md'))); // no memory writes
});

test('worker failure → status error, zero writes; empty learned never erases memory', async () => {
  const { agentRoot, io } = await fixture();
  await mkdir(join(agentRoot, 'memory'), { recursive: true });
  await writeFile(join(agentRoot, 'memory', 'learned.md'), 'precious');
  const fail = async () => ({ status: 'timeout', error: { message: 'killed' } });
  const r1 = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate: fail });
  assert.equal(r1.status, 'error');
  assert.equal(r1.error.code, 'digest_worker_failed');
  const empty = async () => ({ status: 'done', summary: summaryFor({ learned: [], decisions: [], proposals: [] }) });
  const r2 = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate: empty });
  assert.equal(r2.status, 'done');
  assert.equal(await readFile(join(agentRoot, 'memory', 'learned.md'), 'utf8'), 'precious');
});
