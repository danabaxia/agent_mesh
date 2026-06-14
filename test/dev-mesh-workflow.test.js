// test/dev-mesh-workflow.test.js — hermetic lint of the six Phase-0 Dev-mesh
// workflows. The repo is zero-dependency (no YAML parser), so — like
// integration-workflow.test.js — this asserts the security/behavior invariants
// against the raw workflow text. These are the properties that, if they drift,
// turn the self-hosting society into a liability: secrets leaking to fork PRs
// (the pwn-request class), a lost claim lock, a bypassed approval gate, or a
// silent auto-merge. Spec: docs/superpowers/specs/2026-06-14-self-hosting-dev-mesh-design.md §6/§9/§15
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const NAMES = ['research', 'intake', 'backlog', 'triage', 'review', 'curate'];
const wf = Object.fromEntries(NAMES.map((n) => {
  const p = `${dir}dev-mesh-${n}.yml`;
  return [n, existsSync(p) ? readFileSync(p, 'utf8') : ''];
}));

test('all six Dev-mesh workflows exist and are well-formed', () => {
  for (const n of NAMES) {
    assert.ok(wf[n], `dev-mesh-${n}.yml missing`);
    assert.match(wf[n], /^name:/m, `${n}: needs a name`);
    assert.match(wf[n], /^on:/m, `${n}: needs triggers`);
    assert.match(wf[n], /anthropics\/claude-code-action@v1/, `${n}: must drive claude-code-action@v1`);
    assert.match(wf[n], /secrets\.ANTHROPIC_API_KEY/, `${n}: must wire the API key from secrets`);
  }
});

test('triggers match the §6 table', () => {
  assert.match(wf.research, /workflow_dispatch:/);
  assert.match(wf.research, /schedule:/);
  assert.match(wf.intake, /^\s*issues:/m);
  assert.match(wf.backlog, /schedule:/);
  assert.match(wf.backlog, /^\s*issues:/m);
  assert.match(wf.triage, /check_run:/);
  assert.match(wf.review, /^\s*pull_request:/m);
  assert.match(wf.curate, /^\s*pull_request:/m);
  assert.match(wf.curate, /types:\s*\[?\s*closed/, 'curate fires on PR closed');
});

test('SECURITY F4: no secrets to fork PRs (no pull_request_target anywhere)', () => {
  // pull_request_target runs untrusted fork code with the base repo's secrets —
  // the "pwn request" class. None of these workflows may use it.
  for (const n of NAMES) {
    assert.doesNotMatch(wf[n], /pull_request_target/, `${n}: pull_request_target is forbidden`);
  }
  // The PR-triggered workflows must gate on same-repo (forks get no secrets).
  for (const n of ['review', 'curate']) {
    assert.match(
      wf[n],
      /head\.repo\.full_name\s*==\s*github\.repository/,
      `${n}: must gate on same-repo head so fork PRs don't get secrets`,
    );
  }
});

test('SECURITY: ask-roles run least-privilege (review never writes repo contents)', () => {
  // The reviewer is ask-only: it comments on PRs, never pushes. contents stays read.
  assert.match(wf.review, /permissions:/);
  assert.match(wf.review, /contents:\s*read/, 'review must keep contents: read (no pushes)');
  assert.doesNotMatch(wf.review, /contents:\s*write/, 'review must not grant contents: write');
});

test('CLAIM LOCK: backlog & triage serialize via concurrency (no double-claim)', () => {
  for (const n of ['backlog', 'triage']) {
    assert.match(wf[n], /concurrency:/, `${n}: needs a concurrency group (the claim lock)`);
    assert.match(wf[n], /cancel-in-progress:\s*false/, `${n}: in-flight work must not be cancelled`);
  }
});

test('APPROVAL GATE: backlog only builds approved work; intake never builds code', () => {
  // §5.3 — no do-mode/code work happens before a human approves.
  assert.match(wf.backlog, /approved/, 'backlog must gate on the approved state');
  // intake (Analyst) handles discuss/spec/labels only — it must not push code to a
  // branch. It may open a spec PR (pull-requests: write) but not write repo contents.
  assert.doesNotMatch(wf.intake, /contents:\s*write/, 'intake must not push code (approval gate)');
});

test('NO AUTO-MERGE: the loop drives to review, a human merges', () => {
  for (const n of NAMES) {
    assert.doesNotMatch(
      wf[n],
      /enable_pr_auto_merge|enable-auto-merge|--auto\b|gh pr merge|merge_pull_request/i,
      `${n}: auto-merge is forbidden (human holds the merge gate)`,
    );
  }
});

test('each workflow drives its own role via dev-mesh/<role>', () => {
  const role = { research: 'analyst', intake: 'analyst', backlog: 'maintainer', triage: 'triager', review: 'reviewer', curate: 'curator' };
  for (const n of NAMES) {
    assert.match(wf[n], new RegExp(`dev-mesh/${role[n]}`), `${n}: should reference dev-mesh/${role[n]}`);
  }
});

// --- Task 9: the nightly dogfood (Phase-1 mesh-native, non-gating) ---
const dogfood = (() => {
  const p = `${dir}dev-mesh-dogfood.yml`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
})();

test('dogfood: scheduled + manual, NEVER per-PR (non-gating)', () => {
  assert.ok(dogfood, 'dev-mesh-dogfood.yml missing');
  assert.match(dogfood, /schedule:/);
  assert.match(dogfood, /workflow_dispatch:/);
  // A push/pull_request trigger here would run a real claude on every change and
  // could become a de-facto gate — forbidden.
  assert.doesNotMatch(dogfood, /^\s*push:/m, 'dogfood must not run on push');
  assert.doesNotMatch(dogfood, /^\s*pull_request:/m, 'dogfood must not run on pull_request');
  assert.match(dogfood, /cancel-in-progress:\s*false/, 'a half-finished end-to-end run must not be cancelled');
});

test('dogfood: real-claude, materializes the real mesh, read-only & non-merging', () => {
  assert.match(dogfood, /npm i -g @anthropic-ai\/claude-code/, 'installs the real claude');
  assert.match(dogfood, /if \[ -z "\$ANTHROPIC_API_KEY" \]/, 'fail-fast secret preflight');
  assert.match(dogfood, /doctor dev-mesh --apply/, 'materializes the real Dev-mesh (Phase 1)');
  // Observational: read-only repo, artifacts logs, never merges.
  assert.match(dogfood, /contents:\s*read/, 'dogfood must be read-only (no pushes)');
  assert.match(dogfood, /upload-artifact/, 'dogfood artifacts its run logs');
  assert.doesNotMatch(dogfood, /gh pr merge|merge_pull_request|--auto\b/i, 'dogfood never merges');
});
