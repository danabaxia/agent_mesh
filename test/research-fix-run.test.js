import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResearchFix } from '../src/dev-society/research-fix-run.js';

const BOT = 'mesh-bot';
const ISSUE = (n, prN) => ({ number: n, title: `t${n}`, body: `<!-- needs-human:automerge:PR#${prN} -->` });

function makeGh({ issues = [], comments = {}, failUser = false, record } = {}) {
  return async (args) => {
    record?.push(args.join(' '));
    const a = args.join(' ');
    if (a.includes('api user')) { if (failUser) throw new Error('no user'); return `${BOT}\n`; }
    if (a.includes('issue list') && a.includes('needs-human')) return JSON.stringify(issues);
    if (a.includes('issue view')) { const n = Number(args[args.indexOf('view') + 1]); return JSON.stringify({ comments: comments[n] || [] }); }
    if (a.includes('issue comment')) return '';
    return '[]';
  };
}
const diag = (extra = []) => [{ body: 'x <!-- research-escalation -->', author: { login: BOT } }, ...extra];
const okBuild = async () => ({ opened: true, prNumber: 321, status: 'opened' });

test('opens a draft fix → marker comment; read-only gh allowlist (build owns pr/git)', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1)], comments: { 10: diag() }, record });
  const res = await runResearchFix({ gh, runBuild: okBuild, buildLockHeld: () => false, repo: 'o/r', cfg: { capPerRun: 1 } });
  assert.equal(res.status, 'ok');
  const comments = record.filter((r) => r.includes('issue comment'));
  assert.equal(comments.length, 1);
  assert.ok(comments[0].includes('<!-- research-fix -->') && comments[0].includes('321'));
  assert.ok(!record.some((r) => /issue create|issue close|issue edit|pr create|pr merge|\bgit\b/.test(r)));
  assert.ok(record.filter((r) => r.includes(' api ')).every((r) => r.includes('api user')));
});

test('no diagnosis → not picked (no build, no comment)', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1)], comments: { 10: [] }, record });
  let built = 0;
  const res = await runResearchFix({ gh, runBuild: async () => { built++; return okBuild(); }, buildLockHeld: () => false, repo: 'o/r' });
  assert.equal(built, 0);
  assert.equal(record.filter((r) => r.includes('issue comment')).length, 0);
  assert.match(res.output, /no diagnosed/);
});

test('already attempted (bot FIX marker) → deduped, not rebuilt', async () => {
  const gh = makeGh({ issues: [ISSUE(10, 1)], comments: { 10: diag([{ body: 'y <!-- research-fix -->', author: { login: BOT } }]) } });
  let built = 0;
  await runResearchFix({ gh, runBuild: async () => { built++; return okBuild(); }, buildLockHeld: () => false, repo: 'o/r' });
  assert.equal(built, 0);
});

test('a non-bot research-fix marker does NOT dedup (spoof guard)', async () => {
  const gh = makeGh({ issues: [ISSUE(10, 1)], comments: { 10: diag([{ body: 'y <!-- research-fix -->', author: { login: 'rando' } }]) } });
  let built = 0;
  await runResearchFix({ gh, runBuild: async () => { built++; return okBuild(); }, buildLockHeld: () => false, repo: 'o/r' });
  assert.equal(built, 1);
});

test('clean not-opened (tests red / no change) → attempt marker comment, no second build', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1)], comments: { 10: diag() }, record });
  const res = await runResearchFix({ gh, runBuild: async () => ({ opened: false, status: 'tests-red', summary: 'boom' }), buildLockHeld: () => false, repo: 'o/r' });
  const comments = record.filter((r) => r.includes('issue comment'));
  assert.equal(comments.length, 1);
  assert.ok(comments[0].includes('<!-- research-fix -->'));
  assert.equal(res.status, 'ok');
});

test('runBuild throws (infra) → NO marker comment (retry)', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1)], comments: { 10: diag() }, record });
  const res = await runResearchFix({ gh, runBuild: async () => { throw new Error('coder infra failure'); }, buildLockHeld: () => false, repo: 'o/r' });
  assert.equal(record.filter((r) => r.includes('issue comment')).length, 0);
  assert.equal(res.status, 'ok');
});

test('build-lock held → yield, no build', async () => {
  let built = 0;
  const gh = makeGh({ issues: [ISSUE(10, 1)], comments: { 10: diag() } });
  const res = await runResearchFix({ gh, runBuild: async () => { built++; return okBuild(); }, buildLockHeld: () => true, repo: 'o/r' });
  assert.equal(built, 0);
  assert.match(res.output, /yield/);
});

test('botLogin unresolved → fail closed', async () => {
  const record = [];
  const gh = makeGh({ issues: [ISSUE(10, 1)], failUser: true, record });
  const res = await runResearchFix({ gh, runBuild: okBuild, buildLockHeld: () => false, repo: 'o/r' });
  assert.equal(res.status, 'fail');
  assert.equal(record.filter((r) => r.includes('issue comment')).length, 0);
});

test('cap honored (1 build even with 2 eligible)', async () => {
  let built = 0;
  const gh = makeGh({ issues: [ISSUE(10, 1), ISSUE(20, 2)], comments: { 10: diag(), 20: diag() } });
  await runResearchFix({ gh, runBuild: async () => { built++; return okBuild(); }, buildLockHeld: () => false, repo: 'o/r', cfg: { capPerRun: 1 } });
  assert.equal(built, 1);
});
