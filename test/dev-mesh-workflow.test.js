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
    assert.match(wf[n], /secrets\.CLAUDE_CODE_OAUTH_TOKEN/, `${n}: must wire subscription auth (CLAUDE_CODE_OAUTH_TOKEN) from secrets`);
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

test('MODEL: every workflow uses the DEV_MESH_MODEL repo variable (Sonnet fallback), never forces Opus', () => {
  // The action otherwise forces Opus 4.8, which the deploy key can't access (instant
  // is_error/$0 — the loop silently no-ops). The model is a repo variable so it can be
  // changed without a PR; the fallback is a model an API key reliably has. (dogfood
  // checked separately.) This guard keeps it from regressing back to a forced Opus.
  for (const n of NAMES) {
    assert.match(wf[n], /vars\.DEV_MESH_MODEL/, `${n}: model must come from the DEV_MESH_MODEL repo variable`);
    assert.match(wf[n], /'sonnet'/, `${n}: fallback must be the 'sonnet' alias (resolves to a model the key has)`);
    assert.doesNotMatch(wf[n], /claude-opus-4-8/, `${n}: must not force Opus (key has no access)`);
  }
});

test('HONESTY GATE: every agent workflow fails on an errored/no-op model run', () => {
  // green job != healthy run — each workflow must verify its agent actually worked
  // (claude-code-action reports success even when the model errored instantly).
  for (const n of NAMES) {
    assert.match(wf[n], /id:\s*claude/, `${n}: action step needs id: claude for the gate`);
    assert.match(wf[n], /assert-run-healthy\.mjs/, `${n}: must run the per-run honesty gate`);
  }
});

test('AUTH HARDENING: every workflow sanitizes the OAuth token (strip stray newline)', () => {
  // A trailing newline in the secret makes the auth header invalid ("Header has
  // invalid value"). Every workflow must strip whitespace before use.
  for (const n of NAMES) {
    assert.match(wf[n], /tr -d '\[:space:\]'/, `${n}: must sanitize the OAuth token`);
    assert.match(wf[n], /::add-mask::/, `${n}: must re-mask the cleaned token`);
  }
  assert.match(dogfood, /tr -d '\[:space:\]'/, 'dogfood must sanitize the OAuth token');
});

test('TOOL GRANTS: least privilege — only do-workers can push/build; all can comment', () => {
  // claude-code-action's default denies push/gh/test, so each agent must be granted
  // the tools its role needs — but no more. do-workers (backlog, curate) push code &
  // run tests; ask/analyst roles read + comment only (lower surface on agents that
  // ingest untrusted PR/issue content).
  const DO_WORKERS = new Set(['backlog', 'curate']);
  for (const n of NAMES) {
    assert.match(wf[n], /--allowedTools/, `${n}: must declare an explicit tool allowlist`);
    // ":*" = any-args; Bash(gh) (exact) would deny `gh pr create …` (the 2026-06-15 bug).
    // NB: Bash(gh:*) also permits `gh pr close/merge` at the TOOL layer — the per-workflow
    // github_token is the real fence (ask-roles are contents:read, so merge/push fail at
    // the API). Claude Code's grammar can't scope sub-commands, so gh:* is unavoidable.
    assert.match(wf[n], /Bash\(gh:\*\)/, `${n}: needs gh (any args) for comments/labels/PRs`);
    assert.doesNotMatch(wf[n], /Bash\((?:git|gh|npm|node)\)/, `${n}: bare Bash(cmd) denies args — use Bash(cmd:*)`);
    if (DO_WORKERS.has(n)) {
      assert.match(wf[n], /Bash\(git:\*\)/, `${n}: do-worker needs git (any args) to push`);
      assert.match(wf[n], /Bash\(npm:\*\)|Bash\(node:\*\)/, `${n}: do-worker runs the suite`);
    } else {
      assert.doesNotMatch(wf[n], /Bash\(git:/, `${n}: ask/analyst role must not push code`);
      assert.doesNotMatch(wf[n], /Bash\(npm:|Bash\(node:/, `${n}: ask/analyst role doesn't run builds`);
    }
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

// --- the health monitor ---
const health = (() => {
  const p = `${dir}dev-mesh-health.yml`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
})();

test('health monitor: scheduled, judges the result envelope (not just the green job)', () => {
  assert.ok(health, 'dev-mesh-health.yml missing');
  assert.match(health, /schedule:/);
  assert.match(health, /workflow_dispatch:/);
  // It must run the health probe script (which classifies is_error/cost/turns) and
  // the conformance check — not infer health from a job conclusion.
  assert.match(health, /scripts\/dev-mesh-health\.mjs/, 'must run the health probe script');
  assert.match(health, /dev-mesh-dogfood/, 'reads the dogfood canary');
  // Least privilege: it observes + escalates, never writes repo contents.
  assert.doesNotMatch(health, /contents:\s*write/, 'health monitor must not write repo contents');
  assert.match(health, /if:\s*failure\(\)/, 'escalates only on real unhealth');
});

test('dogfood: real-claude, materializes the real mesh, read-only & non-merging', () => {
  assert.match(dogfood, /npm i -g @anthropic-ai\/claude-code/, 'installs the real claude');
  assert.match(dogfood, /if \[ -z "\$CLEAN" \]/, 'fail-fast secret preflight (on the sanitized token)');
  assert.match(dogfood, /doctor dev-mesh --apply/, 'materializes the real Dev-mesh (Phase 1)');
  assert.match(dogfood, /vars\.DEV_MESH_MODEL/, 'dogfood uses the DEV_MESH_MODEL repo variable');
  assert.doesNotMatch(dogfood, /claude-opus-4-8/, 'dogfood must not force Opus (key has no access)');
  // Observational: read-only repo, artifacts logs, never merges.
  assert.match(dogfood, /contents:\s*read/, 'dogfood must be read-only (no pushes)');
  assert.match(dogfood, /upload-artifact/, 'dogfood artifacts its run logs');
  assert.doesNotMatch(dogfood, /gh pr merge|merge_pull_request|--auto\b/i, 'dogfood never merges');
});
