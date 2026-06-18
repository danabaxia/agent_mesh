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
const NAMES = ['research', 'intake', 'backlog', 'triage', 'review', 'curate', 'autofix'];
const wf = Object.fromEntries(NAMES.map((n) => {
  const p = `${dir}dev-mesh-${n}.yml`;
  return [n, existsSync(p) ? readFileSync(p, 'utf8') : ''];
}));

test('all Dev-mesh agent workflows exist and are well-formed', () => {
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
  assert.match(wf.autofix, /check_run:/);           // autofix owns the CI-failure event
  assert.match(wf.triage, /schedule:/);             // triage is the hourly sweep…
  assert.doesNotMatch(wf.triage, /check_run:/);     // …not the event path (no double-run)
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
  // autofix uses a different (valid) fence: check_run.pull_requests[] is empty for fork
  // PRs, so its `if` accessing [0] naturally skips forks. Assert the mechanism is present.
  assert.match(
    wf.autofix,
    /pull_requests\[0\]/,
    'autofix: if must reference pull_requests[0] (empty for fork check runs = no write-creds leak)',
  );
});

test('SECURITY: ask-roles run least-privilege (review never writes repo contents)', () => {
  // The reviewer is ask-only: it comments on PRs, never pushes. contents stays read.
  assert.match(wf.review, /permissions:/);
  assert.match(wf.review, /contents:\s*read/, 'review must keep contents: read (no pushes)');
  assert.doesNotMatch(wf.review, /contents:\s*write/, 'review must not grant contents: write');
});

test('REVIEW VERDICT: reviewer emits an explicit approve/request-changes (the all-clear signal)', () => {
  // Root-cause fix for the sticky-CHANGES_REQUESTED bug: without an approve path the
  // first request-changes never clears, so a PR shows red forever while CI is green.
  // The reviewer must submit ONE verdict per commit and approve when no blocking items
  // remain — green CI + that approval = merge-ready.
  assert.match(wf.review, /--approve/, 'reviewer must be able to approve (clears sticky CHANGES_REQUESTED)');
  assert.match(wf.review, /--request-changes/, 'reviewer must request changes on a blocking finding');
  assert.match(wf.review, /BLOCKING/, 'reviewer must classify findings as blocking vs non-blocking');
  // Still ask-only: an approval is not a merge. The NO-AUTO-MERGE test guards `gh pr merge`.
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
  // NB: for ask-roles (review/triage) this is also STRUCTURAL — contents:read makes
  // `gh pr merge` fail at the API. For do-workers (backlog/curate/autofix) it's
  // behavioural: Bash(gh:*) permits merge at the tool layer, so the prompt must also
  // forbid it (autofix carries an explicit "FORBIDDEN: never run gh pr merge").
  for (const n of NAMES) {
    assert.doesNotMatch(
      wf[n],
      /enable_pr_auto_merge|enable-auto-merge|--auto\b|gh pr merge|merge_pull_request/i,
      `${n}: auto-merge is forbidden (human holds the merge gate)`,
    );
  }
  // autofix is a do-worker acting autonomously on PR branches → assert the explicit fence.
  assert.match(wf.autofix, /FORBIDDEN: never merge or close the PR/, 'autofix must explicitly forbid self-merging');
});

test('autofix budget is scoped to the PR commits (base..HEAD), not all history', () => {
  // Reviewer #15 blocker: an unbounded `git log --grep` counts [autofix] commits merged
  // into main and locks every future PR out. The count must be range-bounded.
  assert.match(wf.autofix, /base\.\.HEAD/, 'autofix budget must count [autofix] within base..HEAD');
  assert.doesNotMatch(wf.autofix, /git log --oneline --grep='\\\[autofix\\\]'\s*\|/, 'no unbounded git log for the budget');
});

test('autofix: author-controlled branch ref enters via env, never interpolated into prompt/push', () => {
  // Reviewer #15: ${{ head.ref }} in the prompt/push is a prompt/shell injection vector.
  // It must be captured into $PR_BRANCH via an env: block and used as a shell var only.
  assert.match(wf.autofix, /PR_BRANCH=/, 'must capture the ref into $PR_BRANCH');
  assert.match(wf.autofix, /HEAD:\$PR_BRANCH/, 'push must use the $PR_BRANCH env var');
  assert.doesNotMatch(wf.autofix, /push origin HEAD:\$\{\{/, 'push must not template-interpolate the ref');
  // Reviewer #22 R1: the push pin alone wouldn't catch the ref being re-added to the
  // prompt for "context". head.ref is safe ONLY in the env: capture step — assert it
  // appears exactly once in the whole file (that one env: line), so any reappearance in
  // the prompt/run blocks fails here.
  assert.equal((wf.autofix.match(/head\.ref/g) || []).length, 1,
    'head.ref must appear exactly once (the env: capture) — never in the prompt/run blocks');
  // fork fence must be in the job if: && chain (not just anywhere in the file).
  assert.match(wf.autofix, /pull_requests\[0\] &&/, 'fork guard must be in the job if: && chain');
  // Reviewer #22 R3: fail-fast on an empty OAuth token (parity with mergefix/dogfood).
  assert.match(wf.autofix, /if \[ -z "\$CLEAN" \]/, 'autofix must fail-fast on a missing OAuth token');
});

test('MODEL: every workflow uses the DEV_MESH_MODEL repo variable (Sonnet fallback), never forces Opus', () => {
  // The action otherwise forces Opus 4.8, which the deploy key can't access (instant
  // is_error/$0 — the loop silently no-ops). The model is a repo variable so it can be
  // changed without a PR; the fallback is a broadly available model alias. (dogfood
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
  const DO_WORKERS = new Set(['backlog', 'curate', 'autofix']);
  for (const n of NAMES) {
    assert.match(wf[n], /--allowedTools/, `${n}: must declare an explicit tool allowlist`);
    // ":*" = any-args; Bash(gh) (exact) would deny `gh pr create …` (the 2026-06-15 bug).
    // NB: Bash(gh:*) also permits `gh pr close/merge` at the TOOL layer — the per-workflow
    // github_token is the real fence (ask-roles are contents:read, so merge/push fail at
    // the API). Claude Code's grammar can't scope sub-commands, so gh:* is unavoidable.
    assert.match(wf[n], /Bash\(gh:\*\)/, `${n}: needs gh (any args) for comments/labels/PRs`);
    assert.doesNotMatch(wf[n], /Bash\((?:git|gh|npm|node)\)/, `${n}: bare Bash(cmd) denies args — use Bash(cmd:*)`);
    // NB: Bash(npm:*) also permits `npm install <arbitrary-pkg>` and Bash(node:*)
    // arbitrary JS — same caveat as gh:*. Mitigation: ephemeral runner (no persistent
    // side effects) + the github_token's contents scope bounds any repo-side change.
    if (DO_WORKERS.has(n)) {
      assert.match(wf[n], /Bash\(git:\*\)/, `${n}: do-worker needs git (any args) to push`);
      assert.match(wf[n], /Bash\(npm:\*\)|Bash\(node:\*\)/, `${n}: do-worker runs the suite`);
    } else {
      assert.doesNotMatch(wf[n], /Bash\(git:/, `${n}: ask/analyst role must not push code`);
      assert.doesNotMatch(wf[n], /Bash\(npm:|Bash\(node:/, `${n}: ask/analyst role doesn't run builds`);
    }
  }
});

test('CURATOR GATE: curate validates quick.json caps (belt-and-suspenders backstop after claude-code-action)', () => {
  // memory-cap-validate-at-write (quick.json): over-cap l0s deadlock the pipeline.
  // The primary gate is the promote-to-memory SKILL.md step 2b (validate before push
  // inside Claude's execution). This workflow step is the belt-and-suspenders backstop:
  // it runs after claude-code-action exits (and after git push / gh pr create have
  // already happened inside the action), not before the push. It fails the curate run
  // if the gate was skipped, but the memory:promote PR is already open at that point.
  // Ordering: must appear after `id: claude` (so it reads the committed file) and
  // before assert-run-healthy (so a cap violation shows up before the honesty gate).
  assert.match(wf.curate, /validate-quick-memory\.mjs.*quick\.json/,
    'curate: must call validate-quick-memory.mjs on the curator quick.json');
  const ls = wf.curate.split('\n');
  const clIdx = ls.findIndex((l) => /id:\s*claude/.test(l));
  const vaIdx = ls.findIndex((l) => /validate-quick-memory\.mjs/.test(l));
  const hhIdx = ls.findIndex((l) => /assert-run-healthy\.mjs/.test(l));
  assert.ok(clIdx < vaIdx, 'validate step must come after id: claude');
  assert.ok(vaIdx < hhIdx, 'validate step must come before assert-run-healthy');
});

test('each workflow drives its own role via dev-mesh/<role>', () => {
  // autofix is the one exception: it's a combined Triager+Coder CI-fix role described
  // INLINE in the prompt (it deliberately does NOT read the no-shell Coder AGENT.md).
  const role = { research: 'analyst', intake: 'analyst', backlog: 'maintainer', triage: 'triager', review: 'reviewer', curate: 'curator' };
  for (const n of Object.keys(role)) {
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

// --- PR janitor (elevated-permission scheduled sweep) ---
const janitor = (() => {
  const p = `${dir}dev-mesh-pr-janitor.yml`;
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
})();

test('janitor: scheduled + manual only, never per-PR (fork-PR / pwn-request safety)', () => {
  assert.ok(janitor, 'dev-mesh-pr-janitor.yml missing');
  assert.match(janitor, /schedule:/);
  assert.match(janitor, /workflow_dispatch:/);
  // §F4: no secrets must flow to fork PRs — push/pull_request/pull_request_target are forbidden.
  assert.doesNotMatch(janitor, /^\s*push:/m, 'janitor must not run on push');
  assert.doesNotMatch(janitor, /^\s*pull_request:/m, 'janitor must not run on pull_request');
  assert.doesNotMatch(janitor, /pull_request_target/, 'janitor: pull_request_target is forbidden');
});

test('janitor: serialized runs (cancel-in-progress: false)', () => {
  assert.match(janitor, /concurrency:/);
  assert.match(janitor, /cancel-in-progress:\s*false/, 'in-flight janitor run must not be cancelled');
});

test('janitor: NO auto-merge (NEVER merges, human holds the gate)', () => {
  assert.doesNotMatch(
    janitor,
    /enable_pr_auto_merge|enable-auto-merge|--auto\b|gh pr merge|merge_pull_request/i,
    'janitor must not auto-merge (contents:write + schedule = elevated risk)',
  );
});

test('janitor: every PR query filters out cross-repository (fork) PRs (§F4 runtime guard)', () => {
  // The complementary defense to the trigger guard: the janitor pushes commits to
  // PR head branches, so it must never act on a fork PR. Both jq filters (UNKNOWN
  // nudge + unlabelled escalate) must carry isCrossRepository==false.
  // All three `gh pr list` steps (1 closes PRs, 2 pushes to branches, 3 opens issues)
  // must carry the guard; >= 3 so dropping it from the highest-stakes Step 1 (PR close) fails.
  const count = (janitor.match(/isCrossRepository==false/g) || []).length;
  assert.ok(count >= 3, `expected isCrossRepository==false in every PR query (3), found ${count}`);
});
