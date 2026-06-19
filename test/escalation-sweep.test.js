// test/escalation-sweep.test.js — the injected escalation sweep: opens a needs-triage
// issue for each stale-stuck PR (dedup'd) and closes its own escalations once the PR
// recovers. gh is injected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runEscalation } from '../src/automerge/escalation-sweep.js';

const NOW = 2_000_000_000_000;
const STALE = 3 * 3600_000;
const oldTs = new Date(NOW - 4 * 3600_000).toISOString();

function fakeGh({ prs = [], triage = [] }) {
  const calls = { create: [], close: [] };
  const gh = async (args) => {
    const a = args.join(' ');
    if (a.includes('pr list')) return JSON.stringify(prs);
    if (a.includes('issue list')) return JSON.stringify(triage);
    if (a.includes('issue create')) { calls.create.push(args[args.indexOf('--title') + 1]); return ''; }
    if (a.startsWith('issue close') || (a.includes('issue close'))) { calls.close.push(args[args.indexOf('close') + 1]); return ''; }
    return '';
  };
  return { gh, calls };
}
const pr = (n, over = {}) => ({ number: n, title: `t${n}`, url: `u/${n}`, isDraft: false, isCrossRepository: false, labels: [], updatedAt: oldTs, ...over });
const run = (opts) => runEscalation({ repo: 'o/r', enabled: true, now: NOW, staleMs: STALE, ...opts });

test('disabled → no-op', async () => {
  const { gh, calls } = fakeGh({ prs: [pr(1, { mergeStateStatus: 'DIRTY' })] });
  const r = await runEscalation({ gh, repo: 'o/r', enabled: false, now: NOW, staleMs: STALE });
  assert.equal(r.disabled, true);
  assert.equal(calls.create.length + calls.close.length, 0);
});

test('opens a needs-triage issue for a stale-stuck PR', async () => {
  const { gh, calls } = fakeGh({ prs: [pr(10, { mergeStateStatus: 'DIRTY' })], triage: [] });
  const r = await run({ gh });
  assert.deepEqual(r.opened, [10]);
  assert.equal(calls.create.length, 1);
  assert.match(calls.create[0], /PR #10 stuck/);
});

test('dedups — does not re-open when an escalation issue already exists', async () => {
  const { gh, calls } = fakeGh({
    prs: [pr(11, { mergeStateStatus: 'CHANGES_REQUESTED', reviewDecision: 'CHANGES_REQUESTED' })],
    triage: [{ number: 500, title: 'needs-triage: PR #11 stuck (DIRTY)' }],
  });
  const r = await run({ gh });
  assert.deepEqual(r.opened, []);
  assert.equal(calls.create.length, 0);
});

test('self-cleans — closes its own escalation when the PR is no longer stuck', async () => {
  const { gh, calls } = fakeGh({
    prs: [pr(12, { mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' })], // healthy now
    triage: [{ number: 501, title: 'needs-triage: PR #12 stuck (DIRTY)' }],
  });
  const r = await run({ gh });
  assert.deepEqual(r.closed, ['501']);
  assert.equal(calls.close.length, 1);
});

test('does NOT close janitor-style needs-triage issues (only its own "stuck (…)" titles)', async () => {
  const { gh, calls } = fakeGh({
    prs: [pr(13, { mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' })],
    triage: [{ number: 502, title: 'needs-triage: PR #13 unlabelled and stuck' }], // janitor's
  });
  const r = await run({ gh });
  assert.deepEqual(r.closed, []);
  assert.equal(calls.close.length, 0);
});

test('dryRun → decides but performs no create/close', async () => {
  const { gh, calls } = fakeGh({
    prs: [pr(14, { mergeStateStatus: 'DIRTY' })],
    triage: [{ number: 503, title: 'needs-triage: PR #99 stuck (DIRTY)' }], // PR 99 not in list → would close
  });
  const r = await run({ gh, dryRun: true });
  assert.deepEqual(r.opened, [14]);
  assert.deepEqual(r.closed, ['503']);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.close.length, 0);
});
