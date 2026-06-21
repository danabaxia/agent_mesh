import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResearchEscalation } from '../src/dev-society/research-escalation-run.js';

const BOT = 'mesh-bot';

function makeGh({ issues = [], comments = {}, failUser = false, record } = {}) {
  return async (args) => {
    record?.push(args.join(' '));
    const a = args.join(' ');
    if (a.includes('api user')) {
      if (failUser) throw new Error('gh api user failed');
      return `${BOT}\n`;
    }
    if (a.includes('issue list') && a.includes('needs-human')) return JSON.stringify(issues);
    if (a.includes('issue view')) {
      const n = Number(args[args.indexOf('view') + 1]);
      return JSON.stringify({ comments: comments[n] || [] });
    }
    if (a.includes('pr view') && a.includes('comments')) return JSON.stringify({ comments: [] });
    if (a.includes('pr view')) return JSON.stringify({ title: 't', url: 'u', mergeStateStatus: 'DIRTY', statusCheckRollup: [] });
    if (a.includes('pr diff')) return 'diff --git a b';
    if (a.includes('issue comment')) return '';
    return '[]';
  };
}

const ISSUE = (number, prN) => ({ number, body: `<!-- needs-human:automerge:PR#${prN} -->` });
const OK = async () => ({ done: true, text: 'diagnosis text' });

test('posts exactly one marked comment per researched issue; read-only allowlist', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1), ISSUE(20, 2)], record });
  const res = await runResearchEscalation({ gh, dispatchAnalyst: OK, repo: 'o/r', cfg: { capPerRun: 5 } });
  assert.equal(res.status, 'ok');
  const comments = record.filter((r) => r.includes('issue comment'));
  assert.equal(comments.length, 2);
  assert.ok(comments.every((c) => c.includes('o/r')));
  assert.ok(comments.every((c) => c.includes('<!-- research-escalation -->')));
  assert.ok(!record.some((r) => /issue create|issue close|issue edit|pr merge|pr edit|\bgit\b/.test(r)));
  assert.ok(record.filter((r) => r.includes(' api ')).every((r) => r.includes('api user')));
});

test('bot-authored marker dedups; a non-bot marker does NOT', async () => {
  const record = [];
  const gh2 = makeGh({ issues: [ISSUE(10, 1), ISSUE(20, 2)], comments: {
    10: [{ body: 'x <!-- research-escalation -->', author: { login: BOT } }],
    20: [{ body: 'x <!-- research-escalation -->', author: { login: 'random' } }],
  }, record });
  const res = await runResearchEscalation({ gh: gh2, dispatchAnalyst: OK, repo: 'o/r', cfg: { capPerRun: 5 } });
  const comments = record.filter((r) => r.includes('issue comment'));
  assert.equal(comments.length, 1);
  assert.ok(comments[0].includes('20'));
  assert.equal(res.status, 'ok');
});

test('status gate: a not-done result (with text) posts NO comment/marker', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1)], record });
  const notDone = async () => ({ done: false, text: 'partial timeout text' });
  await runResearchEscalation({ gh, dispatchAnalyst: notDone, repo: 'o/r', cfg: { capPerRun: 5 } });
  assert.equal(record.filter((r) => r.includes('issue comment')).length, 0);
});

test('empty text (done) posts nothing', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1)], record });
  const empty = async () => ({ done: true, text: '' });
  await runResearchEscalation({ gh, dispatchAnalyst: empty, repo: 'o/r', cfg: { capPerRun: 5 } });
  assert.equal(record.filter((r) => r.includes('issue comment')).length, 0);
});

test('one dispatch throw is isolated; others still researched', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1), ISSUE(20, 2)], record });
  let calls = 0;
  const flaky = async () => { calls += 1; if (calls === 1) throw new Error('boom'); return { done: true, text: 'ok' }; };
  const res = await runResearchEscalation({ gh, dispatchAnalyst: flaky, repo: 'o/r', cfg: { capPerRun: 5 } });
  assert.equal(res.status, 'ok');
  assert.equal(record.filter((r) => r.includes('issue comment')).length, 1);
});

test('cap honored', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1), ISSUE(20, 2), ISSUE(30, 3)], record });
  await runResearchEscalation({ gh, dispatchAnalyst: OK, repo: 'o/r', cfg: { capPerRun: 2 } });
  assert.equal(record.filter((r) => r.includes('issue comment')).length, 2);
});

test('botLogin unresolved → fail closed, no comments', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1)], failUser: true, record });
  const res = await runResearchEscalation({ gh, dispatchAnalyst: OK, repo: 'o/r', cfg: { capPerRun: 5 } });
  assert.equal(res.status, 'fail');
  assert.equal(record.filter((r) => r.includes('issue comment')).length, 0);
});

test('issue list with explicit oldest-first + limit', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1)], record });
  await runResearchEscalation({ gh, dispatchAnalyst: OK, repo: 'o/r', cfg: { capPerRun: 5 } });
  const list = record.find((r) => r.includes('issue list') && r.includes('needs-human'));
  assert.match(list, /--limit 200/);
  assert.match(list, /sort:created-asc/);
});
