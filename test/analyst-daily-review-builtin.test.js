import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAnalystDailyReview } from '../scripts/analyst-review-run.mjs';

const fenced = (arr) => '```json\n' + JSON.stringify(arr) + '\n```';

// Write the two required daily digests so the #195 freshness guard passes by
// default (a fresh mtime). Tests that exercise the guard pass { digests: false }
// or backdate `now` to simulate a stale/missing input.
async function writeFreshDigests(repoRoot) {
  const devSocietyDir = join(repoRoot, '.dev-society');
  await writeFile(join(devSocietyDir, 'daily-report.json'), '{"report":"ok"}');
  await writeFile(join(devSocietyDir, 'gh-activity.json'), '[]');
}

async function repoWithMir(dateName, { digests = true } = {}) {
  const repoRoot = await mkdtemp(join(tmpdir(), 'analyst-repo-'));
  const mirDir = join(repoRoot, '.dev-society', 'mir');
  await mkdir(mirDir, { recursive: true });
  if (dateName) await writeFile(join(mirDir, dateName), '{}');
  if (digests) await writeFreshDigests(repoRoot);
  return { repoRoot, mirDir };
}

test('dry-run plans issues and performs NO gh mutation', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json');
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
  await writeFreshDigests(repoRoot);
  let seenTask = '';
  const delegate = async ({ input }) => { seenTask = input.task; return { status: 'done', summary: '[]' }; };
  const gh = async (args) => (args[1] === 'list' ? '[]' : '');
  await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh });
  assert.ok(seenTask.includes('mir-unique-marker'), 'MIR content must be embedded in prompt');
  assert.ok(!seenTask.includes(join(mirDir, 'mir-2026-06-20.json')), 'MIR path must NOT appear in prompt');
});

test('no MIR present → prompt omits the pointer, still succeeds', async () => {
  const { repoRoot } = await repoWithMir(null);
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

// Freshness/heartbeat guard (#195): a missing required digest must fail LOUDLY
// with a single 'inputs unavailable' alert, and must NOT delegate (no fabricated
// degraded review) nor touch gh.
test('missing digest → inputs-unavailable fail, no delegate or gh', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json', { digests: false });
  let delegated = false;
  const ghCalls = [];
  const delegate = async () => { delegated = true; return { status: 'done', summary: '[]' }; };
  const gh = async (args) => { ghCalls.push(args); return '[]'; };
  const res = await runAnalystDailyReview({ repoRoot, dryRun: false, delegate, gh });
  assert.equal(res.status, 'fail');
  assert.match(res.output, /inputs unavailable/i);
  assert.match(res.output, /daily-report\.json missing/);
  assert.match(res.output, /gh-activity\.json missing/);
  assert.ok(!delegated, 'must not delegate a review when inputs are unavailable');
  assert.equal(ghCalls.length, 0, 'must not call gh when inputs are unavailable');
});

// A present-but-STALE digest (mtime older than the max age) is also an unusable
// input and must fail loudly rather than feeding the Analyst yesterday's data.
test('stale digest → inputs-unavailable fail', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json'); // fresh digests written now
  let delegated = false;
  const delegate = async () => { delegated = true; return { status: 'done', summary: '[]' }; };
  const gh = async (args) => (args[1] === 'list' ? '[]' : '');
  // Pretend "now" is 48h after the digests were written → both are stale (>26h).
  const now = () => new Date(Date.now() + 48 * 60 * 60 * 1000);
  const res = await runAnalystDailyReview({ repoRoot, dryRun: false, delegate, gh, now });
  assert.equal(res.status, 'fail');
  assert.match(res.output, /inputs unavailable/i);
  assert.match(res.output, /stale/);
  assert.ok(!delegated, 'must not delegate a review on stale inputs');
});

test('a non-done delegate result fails cleanly without gh create', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json');
  const ghCalls = [];
  const gh = async (args) => { ghCalls.push(args); return '[]'; };
  const delegate = async () => ({ status: 'timeout', summary: 'partial' });
  const res = await runAnalystDailyReview({ repoRoot, dryRun: false, delegate, gh });
  assert.equal(res.status, 'fail');
  assert.ok(!ghCalls.some((a) => a[1] === 'create'));
});
