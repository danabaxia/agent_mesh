import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAnalystDailyReview } from '../scripts/analyst-review-run.mjs';

const fenced = (arr) => '```json\n' + JSON.stringify(arr) + '\n```';

async function repoWithMir(dateName) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'analyst-repo-'));
  const mirDir = join(repoRoot, '.dev-society', 'mir');
  await mkdir(mirDir, { recursive: true });
  if (dateName) await writeFile(join(mirDir, dateName), '{}');
  return { repoRoot, mirDir };
}

// Write both required digest files (today by default) and return paths.
async function writeDigests(repoRoot, { mtime } = {}) {
  const dir = join(repoRoot, '.dev-society');
  await mkdir(dir, { recursive: true });
  const daily = join(dir, 'daily-report.json');
  const ghAct = join(dir, 'gh-activity.json');
  await writeFile(daily, JSON.stringify({ generatedAt: new Date().toISOString() }));
  await writeFile(ghAct, JSON.stringify([]));
  if (mtime !== undefined) {
    // backdate both files to simulate a stale run from a prior day
    await utimes(daily, mtime, mtime);
    await utimes(ghAct, mtime, mtime);
  }
  return { daily, ghAct };
}

const noopGh = async (args) => (args[1] === 'list' ? '[]' : '');
const noopDelegate = async () => ({ status: 'done', summary: '[]' });

// ---------------------------------------------------------------------------
// Freshness / heartbeat guard (issue #195)
// ---------------------------------------------------------------------------

test('inputs_unavailable when both digest artifacts are missing', async () => {
  const { repoRoot } = await repoWithMir(null);
  // .dev-society/ doesn't exist → both files missing
  const delegateCalls = [];
  const delegate = async (opts) => { delegateCalls.push(opts); return { status: 'done', summary: '[]' }; };
  const res = await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh: noopGh, now: () => new Date() });
  assert.equal(res.status, 'inputs_unavailable');
  assert.match(res.output, /daily-report\.json.*missing/i);
  assert.match(res.output, /gh-activity\.json.*missing/i);
  assert.equal(delegateCalls.length, 0, 'agent must NOT be called when artifacts missing');
});

test('inputs_unavailable when daily-report.json is missing (gh-activity.json present)', async () => {
  const { repoRoot } = await repoWithMir(null);
  const dir = join(repoRoot, '.dev-society');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'gh-activity.json'), JSON.stringify([]));
  // daily-report.json still absent
  const res = await runAnalystDailyReview({ repoRoot, dryRun: true, delegate: noopDelegate, gh: noopGh, now: () => new Date() });
  assert.equal(res.status, 'inputs_unavailable');
  assert.match(res.output, /daily-report\.json.*missing/i);
});

test('inputs_unavailable when digest files are stale (yesterday)', async () => {
  const { repoRoot } = await repoWithMir(null);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await writeDigests(repoRoot, { mtime: yesterday });
  const delegateCalls = [];
  const delegate = async (opts) => { delegateCalls.push(opts); return { status: 'done', summary: '[]' }; };
  const today = new Date();
  const res = await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh: noopGh, now: () => today });
  assert.equal(res.status, 'inputs_unavailable');
  assert.match(res.output, /last modified/i);
  assert.equal(delegateCalls.length, 0, 'agent must NOT be called when artifacts are stale');
});

test('fresh digest artifacts → proceeds to delegate', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json');
  await writeDigests(repoRoot); // today's mtime
  let delegateCalled = false;
  const delegate = async () => { delegateCalled = true; return { status: 'done', summary: '[]' }; };
  const res = await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh: noopGh, now: () => new Date() });
  assert.equal(res.status, 'ok', 'should succeed when digests are fresh');
  assert.ok(delegateCalled, 'delegate must be called when digests are fresh');
});

// ---------------------------------------------------------------------------
// Existing behaviour (now requires fresh digests)
// ---------------------------------------------------------------------------

test('dry-run plans issues and performs NO gh mutation', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json');
  await writeDigests(repoRoot);
  const ghCalls = [];
  const gh = async (args) => {
    ghCalls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([]); // no open markers
    throw new Error('unexpected gh call in dry-run: ' + args.join(' '));
  };
  const delegate = async () => ({ status: 'done', summary: fenced([
    { title: 'Idea one', body: 'b1', dedupeKey: 'k1' },
    { title: 'Idea two', body: 'b2', dedupeKey: 'k2' },
  ]) });
  const res = await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh });
  assert.equal(res.status, 'ok');
  // Only the issue-list read happened; no `issue create`.
  assert.ok(!ghCalls.some((a) => a[0] === 'issue' && a[1] === 'create'));
  assert.match(res.output, /2 planned/);
});

test('live run files create calls with --limit 500 on the list', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json');
  await writeDigests(repoRoot);
  const ghCalls = [];
  const gh = async (args) => {
    ghCalls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify([]);
    return ''; // create returns nothing of interest
  };
  const delegate = async () => ({ status: 'done', summary: fenced([{ title: 'X', body: 'b', dedupeKey: 'k1' }]) });
  const res = await runAnalystDailyReview({ repoRoot, dryRun: false, delegate, gh });
  assert.equal(res.status, 'ok');
  const listCall = ghCalls.find((a) => a[0] === 'issue' && a[1] === 'list');
  assert.ok(listCall.includes('--limit') && listCall[listCall.indexOf('--limit') + 1] === '500');
  assert.ok(ghCalls.some((a) => a[0] === 'issue' && a[1] === 'create'));
  // Self-heal: ensureLabels must `gh label create` each plan label BEFORE the first
  // issue create, so a new label (e.g. generated:analyst) can't 422 the run (#182).
  const order = ghCalls.map((a) => a.slice(0, 2).join(' '));
  const firstLabel = order.indexOf('label create');
  const firstCreate = order.indexOf('issue create');
  assert.ok(firstLabel !== -1, 'expected ensureLabels to call `gh label create`');
  assert.ok(firstLabel < firstCreate, 'labels must be ensured before the first issue create');
  const labeled = ghCalls.filter((a) => a[0] === 'label' && a[1] === 'create').map((a) => a[2]);
  assert.ok(labeled.includes('idea') && labeled.includes('generated:analyst'), `ensured: ${labeled}`);
});

test('MIR content is embedded directly in the delegate prompt', async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), 'analyst-repo-'));
  const mirDir = join(repoRoot, '.dev-society', 'mir');
  await mkdir(mirDir, { recursive: true });
  await writeFile(join(mirDir, 'mir-2026-06-20.json'), '{"signal":"mir-unique-marker"}');
  await writeDigests(repoRoot);
  let seenTask = '';
  const delegate = async ({ input }) => { seenTask = input.task; return { status: 'done', summary: '[]' }; };
  const gh = async (args) => (args[1] === 'list' ? '[]' : '');
  await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh });
  assert.ok(seenTask.includes('mir-unique-marker'), 'MIR content must be embedded in prompt');
  assert.ok(!seenTask.includes(join(mirDir, 'mir-2026-06-20.json')), 'MIR path must NOT appear in prompt');
});

test('no MIR present → prompt omits the pointer, still succeeds', async () => {
  const { repoRoot } = await repoWithMir(null);
  await writeDigests(repoRoot);
  let seenTask = '';
  const delegate = async ({ input }) => { seenTask = input.task; return { status: 'done', summary: '[]' }; };
  const gh = async (args) => (args[1] === 'list' ? '[]' : '');
  const res = await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh });
  assert.equal(res.status, 'ok');
  assert.ok(/no MIR available/i.test(seenTask));
});

test('digest contents are embedded in the delegate prompt when digests exist', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json');
  const devSocietyDir = join(repoRoot, '.dev-society');
  await writeFile(join(devSocietyDir, 'daily-report.json'), '{"report":"daily-unique-marker"}');
  await writeFile(join(devSocietyDir, 'gh-activity.json'), '{"activity":"gh-unique-marker"}');
  let seenTask = '';
  const delegate = async ({ input }) => { seenTask = input.task; return { status: 'done', summary: '[]' }; };
  const gh = async (args) => (args[1] === 'list' ? '[]' : '');
  await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh });
  assert.ok(seenTask.includes('daily-unique-marker'), 'daily-report content must be embedded in prompt');
  assert.ok(seenTask.includes('gh-unique-marker'), 'gh-activity content must be embedded in prompt');
  const expectedReport = join(repoRoot, '.dev-society', 'daily-report.json');
  const expectedActivity = join(repoRoot, '.dev-society', 'gh-activity.json');
  assert.ok(!seenTask.includes(expectedReport), 'daily-report path must NOT appear in prompt');
  assert.ok(!seenTask.includes(expectedActivity), 'gh-activity path must NOT appear in prompt');
});

test('absent digests: returns inputs_unavailable (loudly refuses to proceed)', async () => {
  const { repoRoot } = await repoWithMir(null);
  const delegateCalls = [];
  const delegate = async (opts) => { delegateCalls.push(opts); return { status: 'done', summary: '[]' }; };
  const gh = async (args) => (args[1] === 'list' ? '[]' : '');
  const res = await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh });
  assert.equal(res.status, 'inputs_unavailable', 'absent digests must fail loudly, not silently degrade');
  assert.equal(delegateCalls.length, 0, 'agent must NOT be called when digests are absent');
});

test('a non-done delegate result fails cleanly without gh create', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json');
  await writeDigests(repoRoot);
  const ghCalls = [];
  const gh = async (args) => { ghCalls.push(args); return '[]'; };
  const delegate = async () => ({ status: 'timeout', summary: 'partial' });
  const res = await runAnalystDailyReview({ repoRoot, dryRun: false, delegate, gh });
  assert.equal(res.status, 'fail');
  assert.ok(!ghCalls.some((a) => a[1] === 'create'));
});
