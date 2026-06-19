// test/workflow-injection-guard.test.js — guards two workflow holes the mesh's own
// sweeps detected: (#145) shell injection via inline ${{ }} in dogfood's run:, and
// (#148) the repair-loop Coder being told to use $PR_BRANCH, which the simple_expansion
// hook rejects — silently breaking the loop. The injection-safe fix keeps the
// author-controlled ref ONLY in workflow run: steps (quoted "$PR_BRANCH"), never in the
// agent's shell or prompt (a literal ref could carry backticks/$()).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const wf = (n) => readFileSync(fileURLToPath(new URL('../.github/workflows/' + n, import.meta.url)), 'utf8');

test('#145: dogfood passes workflow_dispatch input + repo var via env, never inline in run:', () => {
  const d = wf('dev-mesh-dogfood.yml');
  assert.match(d, /TASK_INPUT:\s*\$\{\{\s*inputs\.task/, 'task input is bound in env:');
  assert.match(d, /TASK="\$TASK_INPUT"/, 'run: reads it from the env var');
  assert.match(d, /--model "\$DEV_MESH_MODEL"/, 'model read from env var, quoted');
  assert.doesNotMatch(d, /TASK="\$\{\{/, 'must NOT inline ${{ }} into the shell assignment (CWE-78)');
  assert.doesNotMatch(d, /--model \$\{\{/, 'must NOT inline ${{ vars }} into the shell command');
});

test('#148: the author-controlled PR ref never reaches the Coder shell or prompt', () => {
  const rr = wf('dev-mesh-review-respond.yml');
  const af = wf('dev-mesh-autofix.yml');
  // review-respond: workflow checks out the branch; Coder pushes plain HEAD.
  assert.match(rr, /git checkout "\$PR_BRANCH"/, 'review-respond: workflow does the checkout (safe quoted env var)');
  assert.match(rr, /git push origin HEAD\b/, 'review-respond: Coder pushes HEAD, not a named ref');
  // autofix: detached head_sha; workflow pushes HEAD:$PR_BRANCH after the Coder commits.
  assert.match(af, /git push origin "HEAD:\$PR_BRANCH"/, 'autofix: workflow pushes via the quoted env var');
  // Neither may put the literal ref into the agent prompt (backtick/$() injection vector).
  for (const [name, f] of [['review-respond', rr], ['autofix', af]]) {
    assert.doesNotMatch(f, /git (checkout|push)[^\n]*\$\{\{[^\n]*head/, `${name}: no literal head ref in a git command`);
  }
});
