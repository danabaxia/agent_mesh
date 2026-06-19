// test/dev-mesh-ci-sweep.test.js — lint for the scheduled failing-CI reader (the polling
// backstop to event-driven autofix). Same do-worker invariants + injection hardening.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const p = fileURLToPath(new URL('../.github/workflows/dev-mesh-ci-sweep.yml', import.meta.url));
const wf = existsSync(p) ? readFileSync(p, 'utf8') : '';

test('ci-sweep: scheduled reader of failing-CI PRs (backstop to event autofix)', () => {
  assert.ok(wf, 'dev-mesh-ci-sweep.yml missing');
  assert.match(wf, /^name:\s*dev-mesh-ci-sweep/m);
  assert.match(wf, /schedule:/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /statusCheckRollup/, 'must read CI status to find failing PRs');
  assert.match(wf, /index\("FAILURE"\)/, 'targets PRs with a FAILURE check');
  assert.match(wf, /isCrossRepository==false/, 'same-repo only');
});

test('ci-sweep: subscription auth (sanitized + fail-fast), model var, do-worker tools + gate', () => {
  assert.match(wf, /tr -d '\[:space:\]'/);
  assert.match(wf, /::add-mask::/);
  assert.match(wf, /if \[ -z "\$CLEAN" \]/);
  assert.match(wf, /vars\.DEV_MESH_MODEL/);
  assert.doesNotMatch(wf, /claude-opus-4-8/);
  for (const t of [/Bash\(git:\*\)/, /Bash\(gh:\*\)/, /Bash\(npm:\*\)/, /Bash\(node:\*\)/]) assert.match(wf, t);
  assert.doesNotMatch(wf, /Bash\((?:git|gh|npm|node)\)/, 'use Bash(cmd:*), not bare');
  assert.match(wf, /id:\s*claude/);
  assert.match(wf, /agent-postrun/);
});

test('ci-sweep: shares the [autofix] budget, injection-safe, never force-push/self-merge', () => {
  assert.match(wf, /\[autofix\]/, 'shares the [autofix] budget tag (no double-spend with autofix)');
  assert.match(wf, /origin\/main\.\.origin\/\$HEAD_REF/, 'budget scoped to the branch via env var');
  assert.match(wf, /HEAD:"?\$PR_BRANCH/, 'push uses the $PR_BRANCH env var');
  assert.doesNotMatch(wf, /origin\/\$\{\{ steps\.pick\.outputs\.head/, 'no template-interpolated ref in shell');
  assert.doesNotMatch(wf, /--force\b/);
  assert.doesNotMatch(wf, /gh pr merge|merge_pull_request|--auto\b/i);
  assert.doesNotMatch(wf, /pull_request_target/);
});
