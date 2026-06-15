// test/dev-mesh-review-respond.test.js — lint for the autonomous review-feedback loop.
// The mesh reads review comments and fixes them on a SCHEDULE (not via a human/session
// relay). Guards the same invariants as the other do-workers + the injection hardening.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const p = fileURLToPath(new URL('../.github/workflows/dev-mesh-review-respond.yml', import.meta.url));
const wf = existsSync(p) ? readFileSync(p, 'utf8') : '';

test('review-respond: scheduled reader (not a human/session relay), drives claude-code-action', () => {
  assert.ok(wf, 'dev-mesh-review-respond.yml missing');
  assert.match(wf, /^name:\s*dev-mesh-review-respond/m);
  assert.match(wf, /schedule:/);
  assert.match(wf, /workflow_dispatch:/);
  assert.match(wf, /anthropics\/claude-code-action@v1/);
});

test('review-respond: targets CHANGES_REQUESTED same-repo PRs', () => {
  assert.match(wf, /reviewDecision=="CHANGES_REQUESTED"/, 'acts on requested-changes PRs');
  assert.match(wf, /isCrossRepository==false/, 'same-repo only (no fork)');
});

test('review-respond: subscription auth (sanitized + fail-fast), model via repo var', () => {
  assert.match(wf, /tr -d '\[:space:\]'/);
  assert.match(wf, /::add-mask::/);
  assert.match(wf, /if \[ -z "\$CLEAN" \]/, 'fail-fast on empty token');
  assert.match(wf, /vars\.DEV_MESH_MODEL/);
  assert.match(wf, /'sonnet'/);
  assert.doesNotMatch(wf, /claude-opus-4-8/);
});

test('review-respond: do-worker tools, honesty gate, treats comments as DATA', () => {
  for (const t of [/Bash\(git:\*\)/, /Bash\(gh:\*\)/, /Bash\(npm:\*\)/, /Bash\(node:\*\)/]) assert.match(wf, t);
  assert.doesNotMatch(wf, /Bash\((?:git|gh|npm|node)\)/, 'use Bash(cmd:*), not bare');
  assert.match(wf, /id:\s*claude/);
  assert.match(wf, /assert-run-healthy\.mjs/);
  assert.match(wf, /as DATA/, 'review text must be framed as DATA, not instructions');
});

test('review-respond: bounded, injection-safe, never force-push or self-merge', () => {
  assert.match(wf, /\[review-fix\]/, 'commits tagged for the budget count');
  assert.match(wf, /origin\/main\.\.origin\/\$HEAD_REF/, 'budget scoped to the branch via env var');
  assert.match(wf, /HEAD:"?\$PR_BRANCH/, 'push uses the $PR_BRANCH env var (not interpolated)');
  assert.doesNotMatch(wf, /origin\/\$\{\{ steps\.pick\.outputs\.head/, 'no template-interpolated ref in shell');
  assert.doesNotMatch(wf, /--force\b/, 'never force-push');
  assert.doesNotMatch(wf, /gh pr merge|merge_pull_request|--auto\b/i, 'never self-merge');
  assert.doesNotMatch(wf, /pull_request_target/);
});
