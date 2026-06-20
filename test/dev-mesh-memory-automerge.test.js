// test/dev-mesh-memory-automerge.test.js — lint for the one sanctioned auto-merge.
// A scheduled sweep merges memory:promote PRs (Curator's distilled lessons) after a
// light validateQuickMemory check, skipping heavy CI. Guards that the auto-merge is
// tightly scoped: memory-data only, same-repo, validated — it can NEVER merge code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

test('memory-automerge: label-scoped, same-repo before any merge', () => {
  assert.match(wf, /--label memory:promote/, 'only memory:promote PRs');
  assert.match(wf, /isCrossRepository==false/, 'same-repo only (no fork auto-merge)');
});

test('memory-automerge: guard accepts only memory quick.json / *.md, rejects code & deep nesting', () => {
  // Extract the actual ERE used by `grep -vqE '...'` and exercise it as a RegExp, so a
  // mutation (e.g. [^/]+ → .+, dropping the anchor) is caught by BEHAVIOUR, not substring
  // presence. The guard is the security boundary (Reviewer #21): only inert memory DATA
  // (quick.json or a flat/one-subdir *.md doc) may auto-merge — never executable files.
  const m = wf.match(/grep -vqE '([^']+)'/);
  assert.ok(m, 'guard must use grep -vqE with a quoted ERE');
  const re = new RegExp(m[1]); // this ERE is JS-RegExp compatible
  const ok = (p) => assert.ok(re.test(p), `guard should ACCEPT ${p}`);
  const no = (p) => assert.ok(!re.test(p), `guard should REJECT ${p}`);
  ok('dev-mesh/curator/memory/quick.json');
  ok('dev-mesh/curator/memory/lesson.md');           // flat doc
  ok('dev-mesh/curator/memory/workflows/cycle.md');  // one subdir
  no('dev-mesh/curator/memory/a/b/c/deep.md');        // arbitrary nesting
  no('dev-mesh/curator/memory/evil.js');              // executable
  no('dev-mesh/curator/memory/workflows/evil.js');    // named subdir, non-.md extension
  no('dev-mesh/curator/memory/quick.json.js');        // not a real quick.json
  no('dev-mesh/curator/evil.md');                     // outside memory/
  no('dev-mesh/curator/memory/sub/evil.json');        // a second .json that escapes validation
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

test('memory-automerge: resolves quick.json/md conflicts in-line via union, defers code', () => {
  // The fix for the conflict-pileup: on conflict, run the deterministic union resolver and
  // push the resolved merge so the squash-merge sees a clean PR. The resolver exits 3 for any
  // non-memory conflict, so code is never auto-resolved — the else branch still defers.
  const resolver = fileURLToPath(new URL('../scripts/union-quick-memory.mjs', import.meta.url));
  assert.ok(existsSync(resolver), 'scripts/union-quick-memory.mjs must exist');
  assert.match(wf, /node scripts\/union-quick-memory\.mjs/, 'conflict path must invoke the union resolver');
  assert.match(wf, /git push origin "HEAD:\$branch"/, 'resolved merge must be pushed to the PR branch for the squash-merge');
  assert.match(wf, /git merge --abort/, 'non-resolvable (code) conflict must still abort and defer to mergefix');
});

test('validate-quick-memory.mjs exits 1 with no args (script-level fail-closed)', () => {
  // Script property: called with no paths it errors rather than vacuously passing. (The
  // workflow now never reaches this — it handles the no-quick.json case explicitly, below —
  // but the script staying fail-closed is still the right default.)
  const r = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.strictEqual(r.status, 1, 'no-args must exit 1');
});

test('memory-automerge: the empty (no quick.json) case comments + needs-a-human, never a silent skip', () => {
  // The glob can match nothing (e.g. an .md-only PR before any role has a quick.json). That
  // branch must leave author feedback, not silently re-skip every sweep (#67 review finding).
  assert.match(wf, /\[\[ ! -e "\$\{qjs\[0\]\}" \]\]/, 'must detect the empty-glob case');
  assert.match(wf, /no quick\.json found in the merged tree — needs a human/, 'empty case must post a needs-a-human comment');
});

test('validate-quick-memory.mjs exits 1 for an over-cap l0 entry (CI gate fails closed)', () => {
  // The task-critical path: a real over-cap l0 must make the validator exit non-zero so the
  // ci.yml validate-memory step (and the auto-merge gate) register it as a failure — #41/#59.
  const dir = mkdtempSync(join(tmpdir(), 'qm-overcap-'));
  const file = join(dir, 'quick.json');
  writeFileSync(file, JSON.stringify({ k: { status: 'active', valid_to: null, l0: 'x'.repeat(121) } }));
  try {
    const r = spawnSync(process.execPath, [scriptPath, file], { encoding: 'utf8' });
    assert.strictEqual(r.status, 1, 'over-cap l0 (121 > 120) must exit 1');
    assert.match(r.stderr, /exceeds 120 chars/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ci.yml skips the heavy matrix for memory-only PRs, but still runs validate-memory', () => {
  // Mechanism (#41): a label-based if-condition on the matrix job (NOT paths-ignore), so the
  // validate-memory job still runs for memory:promote PRs even though the heavy matrix skips.
  // paths-ignore would have suppressed validate-memory too.
  assert.match(ci, /memory:promote/, 'matrix job must gate-skip on the memory:promote label');
  assert.match(ci, /needs\.matrix\.result\s*==\s*['"]success['"]/, 'test job must skip when matrix is skipped');
  assert.match(ci, /validate-memory:/, 'a validate-memory job must exist');
  assert.match(ci, /validate-quick-memory\.mjs/, 'validate-memory must run the validator');
  assert.doesNotMatch(ci, /paths-ignore:/, 'paths-ignore is replaced by the label gate (it would skip validate-memory)');
});
