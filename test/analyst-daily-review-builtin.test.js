import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

test('the resolved latest MIR path is interpolated into the delegate prompt', async () => {
  const { repoRoot, mirDir } = await repoWithMir('mir-2026-06-20.json');
  let seenTask = '';
  const delegate = async ({ input }) => { seenTask = input.task; return { status: 'done', summary: '[]' }; };
  const gh = async (args) => (args[1] === 'list' ? '[]' : '');
  await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh });
  assert.ok(seenTask.includes(join(mirDir, 'mir-2026-06-20.json')), 'prompt must name the exact MIR path');
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

test('digest paths in the prompt are absolute, resolved from repoRoot', async () => {
  const { repoRoot } = await repoWithMir('mir-2026-06-20.json');
  let seenTask = '';
  const delegate = async ({ input }) => { seenTask = input.task; return { status: 'done', summary: '[]' }; };
  const gh = async (args) => (args[1] === 'list' ? '[]' : '');
  await runAnalystDailyReview({ repoRoot, dryRun: true, delegate, gh });
  const expectedReport = join(repoRoot, '.dev-society', 'daily-report.json');
  const expectedActivity = join(repoRoot, '.dev-society', 'gh-activity.json');
  assert.ok(seenTask.includes(expectedReport), `prompt must name daily-report at absolute path`);
  assert.ok(seenTask.includes(expectedActivity), `prompt must name gh-activity at absolute path`);
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
