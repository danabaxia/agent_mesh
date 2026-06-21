// test/mir-sync-artifacts.test.js — local daemon staging of CI eval scorecards so
// a locally-run MIR isn't blind to behavior/adversarial/perf metrics (issue #337).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { EVAL_ARTIFACTS, syncEvalArtifacts } from '../src/mesh-improvement/sync-artifacts.js';

const REPO = '/repo';

// gh stub that yields newest-first integration run ids.
const ghRuns = (...ids) => async (args) => {
  assert.equal(args[0], 'run');
  assert.equal(args[1], 'list');
  assert.ok(args.includes('integration.yml'), 'lists the nightly integration workflow');
  return ids.join('\n') + '\n';
};

test('maps each CI eval artifact to the repo-root dir collect.js scans', () => {
  const byDir = Object.fromEntries(EVAL_ARTIFACTS.map((a) => [a.dir, a.artifact]));
  assert.equal(byDir['eval-results'], 'l2-behavior-scorecard');
  assert.equal(byDir['adversarial-results'], 'l3-adversarial-results');
  assert.equal(byDir['perf-results'], 'l4-perf-scorecard');
});

test('downloads each artifact from the newest run that has it, into its dir', async () => {
  const calls = [];
  const download = async (runId, artifact, dest) => {
    calls.push({ runId, artifact, dest });
    return true; // newest run has every artifact
  };
  const synced = await syncEvalArtifacts({ repoRoot: REPO, gh: ghRuns('300', '299'), download, isCI: false });
  assert.deepEqual(synced, ['l2-behavior-scorecard', 'l3-adversarial-results', 'l4-perf-scorecard']);
  // first run hit wins → only the newest run id is used, and dest is repoRoot/<dir>.
  assert.deepEqual(calls.map((c) => c.runId), ['300', '300', '300']);
  assert.equal(calls[0].dest, join(REPO, 'eval-results'));
  assert.equal(calls[2].dest, join(REPO, 'perf-results'));
});

test('falls back to an older run when the newest lacks an artifact', async () => {
  // run 300 only has perf; run 299 has behavior + adversarial.
  const has = { '300': new Set(['l4-perf-scorecard']),
                '299': new Set(['l2-behavior-scorecard', 'l3-adversarial-results']) };
  const tried = [];
  const download = async (runId, artifact) => {
    tried.push(`${runId}:${artifact}`);
    return has[runId].has(artifact);
  };
  const synced = await syncEvalArtifacts({ repoRoot: REPO, gh: ghRuns('300', '299'), download, isCI: false });
  assert.deepEqual(synced.sort(), ['l2-behavior-scorecard', 'l3-adversarial-results', 'l4-perf-scorecard']);
  // behavior: 300 miss then 299 hit.
  assert.ok(tried.includes('300:l2-behavior-scorecard') && tried.includes('299:l2-behavior-scorecard'));
});

test('no-op on CI — the workflow stages this run\'s own fresh artifacts', async () => {
  let downloads = 0, ghCalls = 0;
  const synced = await syncEvalArtifacts({
    repoRoot: REPO, isCI: true,
    gh: async () => { ghCalls++; return ''; },
    download: async () => { downloads++; return true; },
  });
  assert.deepEqual(synced, []);
  assert.equal(ghCalls, 0, 'never lists runs on CI');
  assert.equal(downloads, 0, 'never downloads on CI');
});

test('degrades to [] (null metrics) when no integration runs exist', async () => {
  const synced = await syncEvalArtifacts({
    repoRoot: REPO, isCI: false,
    gh: async () => '', // no run ids
    download: async () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(synced, []);
});

test('a failing gh list never throws — degrades to []', async () => {
  const synced = await syncEvalArtifacts({
    repoRoot: REPO, isCI: false,
    gh: async () => { throw new Error('gh not installed'); },
    download: async () => true,
  });
  assert.deepEqual(synced, []);
});

test('a throwing download for one artifact never aborts the others', async () => {
  const download = async (_runId, artifact) => {
    if (artifact === 'l3-adversarial-results') throw new Error('expired artifact');
    return true;
  };
  const synced = await syncEvalArtifacts({ repoRoot: REPO, gh: ghRuns('300'), download, isCI: false });
  assert.deepEqual(synced.sort(), ['l2-behavior-scorecard', 'l4-perf-scorecard']);
});
