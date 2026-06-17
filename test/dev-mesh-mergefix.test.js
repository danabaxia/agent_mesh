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

test('mergefix: Drive Coder skipped on push (claude-code-action does not support push event)', () => {
  // Anchor the guard to the Drive Coder step's own condition (appended after the existing
  // BUDGET_EXHAUSTED clause), not just "anywhere in the file" — a guard on the wrong step
  // (e.g. the Find-PR step) would silently change behaviour yet pass a loose match. This also
  // verifies the original clauses weren't dropped when the line was edited.
  assert.match(
    wf,
    /BUDGET_EXHAUSTED\s*!=\s*'true'\s*&&\s*github\.event_name\s*!=\s*'push'/,
    "Drive Coder if: must append `&& github.event_name != 'push'` to its existing conditions",
  );
  // The schedule backstop is the resolution path for push-discovered conflicts — it must NOT
  // be guarded out by an over-wide expression.
  assert.doesNotMatch(
    wf,
    /event_name\s*!=\s*'schedule'/,
    'schedule backstop must not be blocked — it is how push-discovered conflicts get resolved',
  );
  // …and workflow_dispatch (on-demand resolution) must stay un-guarded too.
  assert.doesNotMatch(
    wf,
    /event_name\s*!=\s*'workflow_dispatch'/,
    'workflow_dispatch must not be blocked — it is the on-demand conflict-resolution trigger',
  );
  // C3: Merge step must ALSO carry the push guard (not just Drive Coder). Count occurrences
  // so a future edit that removes it from the Merge step while Drive Coder keeps it fails here
  // rather than silently passing (that would leave the Merge step running on push events).
  assert.ok(
    (wf.match(/github\.event_name\s*!=\s*'push'/g) || []).length >= 2,
    "Merge step if: must also carry github.event_name != 'push' (not just Drive Coder)",
  );
});

test('mergefix: CONFLICTS_FOUND branches, Drive Coder gate, and Push step coverage', () => {
  // R2(1): both the no-conflict and conflict branches must exist in the merge step.
  assert.match(wf, /CONFLICTS_FOUND=false/, 'success-path must set CONFLICTS_FOUND=false');
  assert.match(wf, /CONFLICTS_FOUND=true/, 'conflict-path must set CONFLICTS_FOUND=true');
  // R2(2): Drive Coder if: must gate on CONFLICTS_FOUND == 'true' so a refactor that drops
  // this condition cannot silently invoke the agent when there is nothing to resolve.
  assert.match(
    wf,
    /env\.CONFLICTS_FOUND\s*==\s*'true'/,
    "Drive Coder if: must include env.CONFLICTS_FOUND == 'true'",
  );
  // R2(3): Push step must exist and guard on steps.claude.outcome == 'success' so a failed
  // agent run cannot push partial/broken conflict resolutions.
  assert.match(wf, /Push resolved merge/, 'Push resolved merge step must exist');
  assert.match(
    wf,
    /steps\.claude\.outcome\s*==\s*['"]success['"]/,
    "Push step if: must check steps.claude.outcome == 'success'",
  );
  // R1 regression: non-zero git merge exit must be inspected with git ls-files -u so hard
  // git errors (exit 128+) don't silently set CONFLICTS_FOUND=true.
  assert.match(wf, /git ls-files -u/, 'non-zero merge exit must be verified via git ls-files -u');
});

test('mergefix: bounded + safe — never force-push, never merge, same-repo only', () => {
  assert.match(wf, /\[mergefix\]/, 'commits are tagged [mergefix] for the budget count');
  assert.doesNotMatch(wf, /--force\b/, 'must never force-push');
  assert.doesNotMatch(wf, /gh pr merge|merge_pull_request|--auto\b/i, 'must never merge the PR');
  assert.doesNotMatch(wf, /pull_request_target/, 'no pwn-request trigger');
  assert.match(wf, /isCrossRepository\s*==\s*false/, 'same-repo only (no fork branches)');
});
