// test/escalate-workflow.test.js — lint the escalation sweep workflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = (p) => readFileSync(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8');
const wf = repo('.github/workflows/dev-mesh-escalate.yml');

test('escalate workflow: scheduled + dispatchable, gated by AUTOMERGE_ENABLED', () => {
  assert.match(wf, /^name:\s*dev-mesh-escalate/m);
  assert.match(wf, /schedule:/);
  assert.match(wf, /cron:\s*'12,42 \* \* \* \*'/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /AUTOMERGE_ENABLED:\s*\$\{\{\s*vars\.AUTOMERGE_ENABLED\s*\}\}/);
});

test('escalate workflow: ensures needs-triage label, runs the sweep, least-privilege', () => {
  assert.match(wf, /gh label create needs-triage/);
  assert.match(wf, /node scripts\/escalation-sweep\.mjs/);
  assert.ok(existsSync(fileURLToPath(new URL('../scripts/escalation-sweep.mjs', import.meta.url))));
  assert.match(wf, /issues:\s*write/);
  assert.match(wf, /pull-requests:\s*read/);
  assert.doesNotMatch(wf, /contents:\s*write/, 'never writes repo contents — only issues');
});
