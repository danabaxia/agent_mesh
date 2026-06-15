// test/dev-mesh-memory-automerge.test.js — lint for the one sanctioned auto-merge.
// A scheduled sweep merges memory:promote PRs (Curator's distilled lessons) after a
// light validateQuickMemory check, skipping heavy CI. Guards that the auto-merge is
// tightly scoped: memory-data only, same-repo, validated — it can NEVER merge code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wfPath = fileURLToPath(new URL('../.github/workflows/dev-mesh-memory-automerge.yml', import.meta.url));
const ciPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/validate-quick-memory.mjs', import.meta.url));
const wf = existsSync(wfPath) ? readFileSync(wfPath, 'utf8') : '';
const ci = readFileSync(ciPath, 'utf8');

test('memory-automerge: scheduled sweep (not pull_request — dodges the GITHUB_TOKEN recursion guard)', () => {
  assert.ok(wf, 'dev-mesh-memory-automerge.yml missing');
  assert.match(wf, /^name:\s*dev-mesh-memory-automerge/m);
  assert.match(wf, /schedule:/);
  assert.match(wf, /workflow_dispatch:/);
  assert.doesNotMatch(wf, /^\s*pull_request:/m, 'must NOT use pull_request (would not fire for GITHUB_TOKEN-opened PRs)');
});

test('memory-automerge: label-scoped, same-repo, memory-DATA-only guard before any merge', () => {
  assert.match(wf, /--label memory:promote/, 'only memory:promote PRs');
  assert.match(wf, /isCrossRepository==false/, 'same-repo only (no fork auto-merge)');
  // The guard accepts ONLY a memory quick.json or a memory *.md doc (inert data) — never a
  // bare "under memory/" (Reviewer #21: that would let dev-mesh/x/memory/evil.js auto-merge).
  // Assert both alternatives are present and the pattern is anchored ($) so code is excluded.
  assert.match(wf, /quick\\\.json\|/, 'guard alternation must include quick.json');
  assert.match(wf, /\\\.md\)\$/, 'guard alternation must include *.md and anchor with $ (no code)');
});

test('memory-automerge: validates the MERGE RESULT (merges main first), then squash-merges', () => {
  // A PR branched before a quick.json fix carries the stale invalid file on HEAD yet merges
  // cleanly; validating HEAD would deadlock it (mergefix only touches DIRTY PRs). Merge main
  // in first and validate the result so such stale-but-clean branches self-heal.
  assert.match(wf, /git merge origin\/main/, 'must merge main before validating (self-heal stale-clean branches)');
  assert.match(wf, /git merge --abort/, 'a real conflict must abort and defer to mergefix');
  assert.match(wf, /validate-quick-memory\.mjs/, 'must run the light validation before merge');
  assert.match(wf, /gh pr merge .* --squash/, 'memory data merges via squash');
  assert.ok(existsSync(scriptPath), 'scripts/validate-quick-memory.mjs must exist');
});

test('ci.yml skips the heavy matrix for memory-only PRs', () => {
  assert.match(ci, /paths-ignore:/);
  assert.match(ci, /dev-mesh\/\*\/memory\/\*\*/, 'ci.yml must paths-ignore memory dirs');
});
