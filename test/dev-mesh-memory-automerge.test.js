// test/dev-mesh-memory-automerge.test.js — lint for the one sanctioned auto-merge.
// Memory:promote PRs (Curator's distilled lessons) skip heavy CI + merge automatically
// after a light validateQuickMemory check. This guards that the auto-merge is tightly
// scoped: memory-data only, same-repo, validated — it can NEVER merge code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wfPath = fileURLToPath(new URL('../.github/workflows/dev-mesh-memory-automerge.yml', import.meta.url));
const ciPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const wf = existsSync(wfPath) ? readFileSync(wfPath, 'utf8') : '';
const ci = readFileSync(ciPath, 'utf8');

test('memory-automerge: triggers on PRs, scoped to memory:promote + same-repo', () => {
  assert.ok(wf, 'dev-mesh-memory-automerge.yml missing');
  assert.match(wf, /^name:\s*dev-mesh-memory-automerge/m);
  assert.match(wf, /pull_request:/);
  assert.match(wf, /contains\(github\.event\.pull_request\.labels\.\*\.name,\s*'memory:promote'\)/, 'must gate on the memory:promote label');
  assert.match(wf, /head\.repo\.full_name == github\.repository/, 'same-repo only (no fork auto-merge)');
});

test('memory-automerge: memory-only guard + validation before any merge', () => {
  // The guard rejects any changed file outside dev-mesh/<role>/memory/ so code can't be merged.
  assert.match(wf, /grep -vqE '\^dev-mesh\/\[\^\/\]\+\/memory\//, 'must reject non-memory changed files');
  assert.match(wf, /validateQuickMemory/, 'must validate quick.json caps/shape before merging');
  // merge step is gated on the guard passing.
  assert.match(wf, /steps\.guard\.outputs\.ok == 'true'/);
});

test('memory-automerge: it is the ONLY workflow allowed to run gh pr merge', () => {
  assert.match(wf, /gh pr merge .* --squash/, 'memory data merges via squash');
});

test('ci.yml skips the heavy matrix for memory-only PRs', () => {
  assert.match(ci, /paths-ignore:/);
  assert.match(ci, /dev-mesh\/\*\/memory\/\*\*/, 'ci.yml must paths-ignore memory dirs');
});
