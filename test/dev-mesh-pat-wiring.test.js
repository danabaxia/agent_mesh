// test/dev-mesh-pat-wiring.test.js — pins the DEV_MESH_PAT wiring + CODEOWNERS guard.
//
// The Actions GITHUB_TOKEN is barred by GitHub from modifying .github/workflows/** files,
// so the do-workers that push code (backlog/autofix/mergefix/review-respond) push with a
// DEV_MESH_PAT (a PAT with `workflows` scope), falling back to GITHUB_TOKEN when the secret
// is absent (non-breaking). curate stays on GITHUB_TOKEN so its memory:promote PRs keep the
// recursion guard (the auto-merge design depends on bot PRs NOT firing pull_request). A
// CODEOWNERS rule keeps the human merge gate explicit for any workflow-file change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const read = (n) => {
  const p = `${dir}dev-mesh-${n}.yml`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

// The PAT fallback expression, written without whitespace assumptions.
const PAT_FALLBACK = /secrets\.DEV_MESH_PAT\s*\|\|\s*secrets\.GITHUB_TOKEN/;

test('do-workers push via DEV_MESH_PAT (fallback to GITHUB_TOKEN) on checkout + action', () => {
  for (const n of ['backlog', 'autofix', 'mergefix', 'review-respond']) {
    const wf = read(n);
    assert.ok(wf, `dev-mesh-${n}.yml missing`);
    // checkout must set the push token to the PAT fallback
    assert.match(wf, /actions\/checkout@v4[\s\S]*?token:\s*\$\{\{\s*secrets\.DEV_MESH_PAT/,
      `${n}: checkout must push with DEV_MESH_PAT (so it can land .github/workflows/** fixes)`);
    // and the action's github_token must use the same fallback
    assert.match(wf, new RegExp(`github_token:\\s*\\$\\{\\{\\s*${PAT_FALLBACK.source}`),
      `${n}: claude-code-action github_token must use the DEV_MESH_PAT fallback`);
  }
});

test('curate stays on GITHUB_TOKEN (preserves the recursion guard for memory:promote PRs)', () => {
  const wf = read('curate');
  assert.ok(wf, 'dev-mesh-curate.yml missing');
  assert.doesNotMatch(wf, /secrets\.DEV_MESH_PAT/,
    'curate must NOT use the PAT — its bot memory PRs rely on GITHUB_TOKEN not firing pull_request');
});

test('CODEOWNERS requires owner review on workflow files', () => {
  const p = fileURLToPath(new URL('../.github/CODEOWNERS', import.meta.url));
  assert.ok(existsSync(p), '.github/CODEOWNERS must exist');
  const co = readFileSync(p, 'utf8');
  assert.match(co, /\.github\/workflows\/\s+@/, 'CODEOWNERS must assign an owner to .github/workflows/');
});
