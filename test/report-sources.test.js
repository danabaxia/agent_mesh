// test/report-sources.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLocalLogs, fetchGhActivity } from '../src/report/sources.js';

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
