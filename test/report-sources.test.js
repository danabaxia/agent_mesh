// test/report-sources.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLocalLogs, fetchGhActivity, fetchCiUsage } from '../src/report/sources.js';

test('readLocalLogs reads + dedupes the date-grouped delegate log', async () => {
  const calls = [];
  const recs = await readLocalLogs({
    logDir: '/x/.agent-mesh/logs',
    date: '2026-06-18',
    readRecords: async (p) => { calls.push(p); return [
      { id: 'a', route: 'coder', usage: { input_tokens: 1 } },
      { id: 'a', route: 'coder', usage: { input_tokens: 5 } }, // final wins
    ]; },
  });
  assert.equal(calls[0], '/x/.agent-mesh/logs/delegate-2026-06-18.jsonl');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].usage.input_tokens, 5);
});

test('fetchGhActivity shells gh for prs/issues and parses JSON', async () => {
  const seen = [];
  const gh = async (args) => {
    seen.push(args.join(' '));
    if (args[0] === 'pr' && args.includes('--state') && args[args.indexOf('--state') + 1] === 'open')
      return JSON.stringify([{ number: 9 }]);
    if (args[0] === 'pr') return JSON.stringify([{ number: 1, title: 't', author: { login: 'me' }, url: 'u', createdAt: 'x', mergedAt: null, closedAt: null }]);
    if (args[0] === 'issue' && args.includes('--state') && args[args.indexOf('--state') + 1] === 'open')
      return JSON.stringify([{ number: 7, labels: [{ name: 'blocked' }] }]);
    return JSON.stringify([{ number: 5, title: 'i', labels: [{ name: 'approved' }], url: 'iu', createdAt: 'x', closedAt: null }]);
  };
  const a = await fetchGhActivity({ gh, repo: 'o/r' });
  assert.equal(a.prs[0].author, 'me');        // author.login flattened
  assert.deepEqual(a.openPrs, [{ number: 9 }]);
  assert.deepEqual(a.issues[0].labels, ['approved']); // label objects flattened to names
  assert.deepEqual(a.openIssues[0].labels, ['blocked']);
});

test('fetchCiUsage lists in-window runs, downloads usage, marks missing as uncaptured', async () => {
  const gh = async (args) => {
    if (args[0] === 'run' && args[1] === 'list')
      return JSON.stringify([
        { databaseId: 1, workflowName: 'dev-mesh-review', createdAt: '2026-06-18T09:00:00Z' },
        { databaseId: 2, workflowName: 'dev-mesh-triage', createdAt: '2026-06-18T10:00:00Z' },
        { databaseId: 3, workflowName: 'old', createdAt: '2026-06-10T00:00:00Z' }, // out of window
      ]);
    if (args[0] === 'run' && args[1] === 'download') {
      const id = args[args.indexOf('--name') + 1];
      if (id === 'mesh-usage-1') return ''; // download writes files; success
      throw new Error('no artifact'); // run 2 has no usage artifact
    }
    return '[]';
  };
  const reads = { 'mesh-usage-1': { ts: '2026-06-18T09:00:00Z', workflow: 'dev-mesh-review', runId: '1', usage: { input_tokens: 5 } } };
  const recs = await fetchCiUsage({
    gh, repo: 'o/r', date: '2026-06-18',
    download: async (name) => reads[name] || (() => { throw new Error('missing'); })(),
  });
  const review = recs.find((r) => r.workflow === 'dev-mesh-review');
  assert.equal(review.usage.input_tokens, 5);
  const triage = recs.find((r) => r.runId === '2');
  assert.equal(triage.uncaptured, true);
  assert.ok(!recs.some((r) => r.workflow === 'old')); // out-of-window dropped
});
