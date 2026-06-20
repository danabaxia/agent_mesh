// test/release-workflow.test.js — hermetic lint of the Release workflow. The repo
// is zero-dependency (no YAML parser), so this asserts the invariants that matter
// against the raw workflow text — trigger gating, concurrency, permissions, and the
// publish steps — catching drift in the L0 suite even though the workflow only runs
// on GitHub. Spec: docs/superpowers/specs/2026-06-20-cd-release-workflow-design.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const wfPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const ciPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const wf = await readFile(wfPath, 'utf8');

test('release workflow: triggers only on CI completion, gated to a green push on main', () => {
  assert.match(wf, /^on:/m);
  assert.match(wf, /workflow_run:/);
  assert.match(wf, /workflows:\s*\["CI"\]/);
  assert.match(wf, /types:\s*\[completed\]/);
  // all three guard clauses are load-bearing
  assert.match(wf, /conclusion == 'success'/);
  assert.match(wf, /head_branch == 'main'/);
  assert.match(wf, /event == 'push'/);
  // release only via workflow_run — never per-PR or direct push
  assert.doesNotMatch(wf, /^\s*pull_request:/m, 'release must not trigger on pull_request');
  assert.doesNotMatch(wf, /^\s*push:/m, 'release must not trigger on push directly');
});

test('release workflow: serialized, scoped, bounded', () => {
  assert.match(wf, /concurrency:/);
  assert.match(wf, /cancel-in-progress:\s*false/);   // never interrupt a versioned create
  assert.match(wf, /permissions:[\s\S]*contents:\s*write/);
  assert.match(wf, /timeout-minutes:/);
  assert.match(wf, /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/);
});

test('release workflow: packs to a stable name and publishes edge + versioned', () => {
  assert.match(wf, /npm pack --ignore-scripts \| tail -1/);
  assert.match(wf, /cp "\$TARBALL" agent-mesh\.tgz/);
  // rolling edge: delete-then-create; tag is edge, never main
  assert.match(wf, /gh release delete edge --yes --cleanup-tag/);
  assert.match(wf, /gh release create edge --prerelease/);
  assert.doesNotMatch(wf, /gh release (create|delete|view|upload) main\b/, 'rolling tag must be edge, not main');
  // versioned: guarded create (skip if exists)
  assert.match(wf, /gh release view "v\$VERSION"/);
  assert.match(wf, /gh release create "v\$VERSION"/);
});

test('release workflow: CI name-coupling guard — ci.yml still named "CI"', async () => {
  const ci = await readFile(ciPath, 'utf8');
  assert.match(ci, /^name:\s*CI\s*$/m, 'release.yml workflow_run is keyed to CI by name; keep ci.yml name: CI');
});
