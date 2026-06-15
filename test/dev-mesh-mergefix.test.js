// test/dev-mesh-mergefix.test.js — hermetic lint of the conflict-resolution workflow.
// Standalone file (no shared edits) so it can't itself cause the merge conflicts it
// exists to fix. Asserts the same security/behavior invariants as the other do-workers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const p = fileURLToPath(new URL('../.github/workflows/dev-mesh-mergefix.yml', import.meta.url));
const wf = existsSync(p) ? readFileSync(p, 'utf8') : '';

test('mergefix: exists, runs on main push + schedule, drives claude-code-action', () => {
  assert.ok(wf, 'dev-mesh-mergefix.yml missing');
  assert.match(wf, /^name:\s*dev-mesh-mergefix/m);
  assert.match(wf, /push:/);
  assert.match(wf, /branches:\s*\[main\]/);
  assert.match(wf, /schedule:/);
  assert.match(wf, /anthropics\/claude-code-action@v1/);
});

test('mergefix: subscription auth, sanitized + masked, model via repo var', () => {
  assert.match(wf, /secrets\.CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(wf, /tr -d '\[:space:\]'/, 'must sanitize the OAuth token');
  assert.match(wf, /::add-mask::/, 'must re-mask the cleaned token');
  assert.match(wf, /vars\.DEV_MESH_MODEL/);
  assert.match(wf, /'sonnet'/);
  assert.doesNotMatch(wf, /claude-opus-4-8/);
});

test('mergefix: do-worker tools (any-args), honesty gate present', () => {
  for (const t of [/Bash\(git:\*\)/, /Bash\(gh:\*\)/, /Bash\(npm:\*\)/, /Bash\(node:\*\)/]) {
    assert.match(wf, t, `needs ${t}`);
  }
  assert.doesNotMatch(wf, /Bash\((?:git|gh|npm|node)\)/, 'bare Bash(cmd) denies args — use Bash(cmd:*)');
  assert.match(wf, /id:\s*claude/, 'action step needs id: claude');
  assert.match(wf, /assert-run-healthy\.mjs/, 'must run the per-run honesty gate');
});

test('mergefix: branch ref via env (no shell/prompt injection) + fail-fast on empty token', () => {
  // Reviewer #16: ${{ steps.pick.outputs.head }} interpolated into run:/prompt is a
  // shell/prompt injection vector. It must arrive via env (HEAD_REF) and be used as
  // $HEAD_REF / $PR_BRANCH only.
  assert.match(wf, /HEAD_REF:\s*\$\{\{ steps\.pick\.outputs\.head \}\}/, 'ref captured via env block');
  assert.match(wf, /origin\/main\.\.origin\/\$HEAD_REF/, 'budget range uses the $HEAD_REF var, not interpolation');
  assert.match(wf, /HEAD:"?\$PR_BRANCH/, 'push uses $PR_BRANCH');
  assert.doesNotMatch(wf, /origin\/\$\{\{ steps\.pick\.outputs\.head/, 'no template-interpolated ref in shell');
  // Reviewer #22 R2: the shell-path pin alone wouldn't catch the ref being re-added to the
  // prompt (e.g. "branch `${{ steps.pick.outputs.head }}`" — the exact form being fixed).
  // steps.pick.outputs.head is safe ONLY in the env: capture — assert it appears exactly
  // once, so any reappearance in the prompt/run blocks fails here.
  assert.equal((wf.match(/steps\.pick\.outputs\.head/g) || []).length, 1,
    'steps.pick.outputs.head must appear exactly once (the env: capture) — never in prompt/run');
  assert.match(wf, /if \[ -z "\$CLEAN" \]/, 'fail-fast when the OAuth token is empty');
});

test('mergefix: bounded + safe — never force-push, never merge, same-repo only', () => {
  assert.match(wf, /\[mergefix\]/, 'commits are tagged [mergefix] for the budget count');
  assert.doesNotMatch(wf, /--force\b/, 'must never force-push');
  assert.doesNotMatch(wf, /gh pr merge|merge_pull_request|--auto\b/i, 'must never merge the PR');
  assert.doesNotMatch(wf, /pull_request_target/, 'no pwn-request trigger');
  assert.match(wf, /isCrossRepository\s*==\s*false/, 'same-repo only (no fork branches)');
});
