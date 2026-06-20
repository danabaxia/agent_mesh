import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRemediation } from '../src/merge-sweep/remediation-run.js';

function recGh(map) { const calls = []; return { calls, gh: async (a) => { calls.push(a.join(' ')); return map(a) ?? ''; } }; }
const CFG = { escalateAfter: 4, hysteresisK: 3, capPerRun: 5, backoffBaseMs: 1_800_000 };
const reportWith = (items) => ({ available: true, checkpoints: [{ name: 'automerge', status: 'flagged', items }] });

test('report unavailable → no create/close, state preserved, status fail', async () => {
  const { calls, gh } = recGh(() => '[]');
  const r = await runRemediation({ gh, repo: 'o/r', meshRoot: '/m', readReport: () => ({ available: false }), readState: () => ({ x: 1 }), writeState: () => {}, now: new Date('2026-06-20T12:00:00Z'), cfg: CFG });
  assert.equal(r.status, 'fail');
  assert.ok(!calls.some((c) => /issue (create|close)/.test(c)), 'no create/close on unavailable report');
});

test('files one deduped needs-human issue for an aged stuck PR; read-only otherwise', async () => {
  const { calls, gh } = recGh((a) => {
    const s = a.join(' ');
    if (s.includes('issue list') && s.includes('needs-human')) return '[]';
    if (s.includes('issue list') && s.includes('needs-triage')) return '[]';
    if (s.includes('pr view 1')) return JSON.stringify({ number: 1, state: 'OPEN' });
    if (s.includes('issue create')) return 'https://github.com/o/r/issues/77';
    return '[]';
  });
  let state = null;
  const r = await runRemediation({ gh, repo: 'o/r', meshRoot: '/m', readReport: () => reportWith([{ ref: 'PR#1', number: 1, state: 'blocked', detail: 'not-clean:DIRTY', ageRuns: 9 }]), readState: () => ({}), writeState: (_p, s2) => { state = s2; }, now: new Date('2026-06-20T12:00:00Z'), cfg: CFG });
  const forbidden = calls.filter((c) => /pr merge|pr edit|pr comment| api |git (push|commit|merge|checkout)/.test(c));
  assert.deepEqual(forbidden, [], 'no mutating commands');
  assert.ok(calls.some((c) => /issue create .*needs-human/.test(c)), 'filed a needs-human issue');
  assert.equal(state['automerge:PR#1'].state, 'escalated');
  assert.equal(state['automerge:PR#1'].issueNumber, 77);
  assert.equal(r.status, 'ok');
});

test('a failing issue create leaves the item in prior state (not escalated)', async () => {
  const { gh } = recGh((a) => {
    const s = a.join(' ');
    if (s.includes('issue list')) return '[]';
    if (s.includes('pr view')) return JSON.stringify({ state: 'OPEN' });
    if (s.includes('issue create')) throw new Error('rate limited');
    return '[]';
  });
  let state = null;
  await runRemediation({ gh, repo: 'o/r', meshRoot: '/m', readReport: () => reportWith([{ ref: 'PR#1', number: 1, state: 'blocked', detail: 'not-clean:DIRTY', ageRuns: 9 }]), readState: () => ({}), writeState: (_p, s2) => { state = s2; }, now: new Date('2026-06-20T12:00:00Z'), cfg: CFG });
  assert.notEqual(state['automerge:PR#1']?.state, 'escalated');
});

test('closed own marker issue (human-ack) for a still-stuck item → acked, no create', async () => {
  const { calls, gh } = recGh((a) => {
    const s = a.join(' ');
    if (s.includes('issue list') && s.includes('needs-human')) return JSON.stringify([{ number: 80, state: 'CLOSED', body: '<!-- needs-human:automerge:PR#1 -->', labels: [] }]);
    if (s.includes('issue list')) return '[]';
    if (s.includes('pr view')) return JSON.stringify({ state: 'OPEN' });
    return '[]';
  });
  let state = null;
  await runRemediation({ gh, repo: 'o/r', meshRoot: '/m', readReport: () => reportWith([{ ref: 'PR#1', number: 1, state: 'blocked', detail: 'not-clean:DIRTY', ageRuns: 9 }]), readState: () => ({ 'automerge:PR#1': { state: 'escalated', issueNumber: 80 } }), writeState: (_p, s2) => { state = s2; }, now: new Date('2026-06-20T12:00:00Z'), cfg: CFG });
  assert.ok(!calls.some((c) => /issue create/.test(c)), 'no re-file of an acked item');
  assert.equal(state['automerge:PR#1'].state, 'acked');
});
