// test/issue-gate-workflow.test.js — lint the issue-gate sweep workflow: scheduled,
// gated by AUTOMERGE_ENABLED, ensures its label exists, and runs the sweep script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = (p) => readFileSync(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8');
const wf = repo('.github/workflows/dev-mesh-issue-gate.yml');

test('issue-gate workflow: scheduled, offset before automerge, dispatchable', () => {
  assert.match(wf, /^name:\s*dev-mesh-issue-gate/m);
  assert.match(wf, /schedule:/);
  assert.match(wf, /cron:\s*'2,32 \* \* \* \*'/, 'runs 5 min before dev-mesh-automerge (7,37)');
  assert.match(wf, /workflow_dispatch:/);
});

test('issue-gate workflow: gated by AUTOMERGE_ENABLED, ensures its label, runs the sweep', () => {
  assert.match(wf, /AUTOMERGE_ENABLED:\s*\$\{\{\s*vars\.AUTOMERGE_ENABLED\s*\}\}/, 'gated by the automerge family flag');
  assert.match(wf, /gh label create blocked-by-issue/, 'creates its dedicated hold label if missing');
  assert.match(wf, /node scripts\/issue-gate-sweep\.mjs/, 'invokes the sweep');
  assert.ok(existsSync(fileURLToPath(new URL('../scripts/issue-gate-sweep.mjs', import.meta.url))), 'sweep script exists');
});

test('issue-gate workflow: least-privilege permissions (no contents:write)', () => {
  assert.match(wf, /pull-requests:\s*write/);
  assert.match(wf, /issues:\s*read/);
  assert.match(wf, /contents:\s*read/);
  assert.doesNotMatch(wf, /contents:\s*write/, 'the gate only edits labels — never writes repo contents');
});
