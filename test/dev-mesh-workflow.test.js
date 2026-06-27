// test/dev-mesh-workflow.test.js — hermetic lint of the six Phase-0 Dev-mesh
// workflows. The repo is zero-dependency (no YAML parser), so — like
// integration-workflow.test.js — this asserts the security/behavior invariants
// against the raw workflow text. These are the properties that, if they drift,
// turn the self-hosting society into a liability: secrets leaking to fork PRs
// (the pwn-request class), a lost claim lock, a bypassed approval gate, or a
// silent auto-merge. Spec: docs/superpowers/specs/2026-06-14-self-hosting-dev-mesh-design.md §6/§9/§15
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const NAMES = ['research', 'intake', 'backlog', 'triage', 'review', 'curate', 'autofix', 'security'];
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
  // intake must NOT trigger on `edited` — the Analyst edits issue bodies as it works,
  // which would self-trigger an intake re-run (the self-cancel bug, PR #428).
  assert.doesNotMatch(wf.intake, /types:\s*\[[^\]]*edited/, 'intake: must not trigger on issues:edited (self-trigger)');
  assert.match(wf.backlog, /schedule:/);
  assert.match(wf.backlog, /^\s*issues:/m);
  assert.match(wf.autofix, /check_run:/);           // autofix owns the CI-failure event
  assert.match(wf.triage, /schedule:/);             // triage is the hourly sweep…
  assert.doesNotMatch(wf.triage, /check_run:/);     // …not the event path (no double-run)
  assert.match(wf.security, /schedule:/);            // security is a scheduled scanner…
  assert.match(wf.security, /workflow_dispatch:/);   // …and can be run on demand
  assert.doesNotMatch(wf.security, /^\s*pull_request:/m, 'security must not run on PRs');
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
  assert.match(wf.security, /permissions:/);
  assert.match(wf.security, /contents:\s*read/, 'security must keep contents: read (no pushes)');
  assert.match(wf.security, /issues:\s*write/, 'security may open/update alert issues');
  assert.doesNotMatch(wf.security, /contents:\s*write/, 'security must not grant contents: write');
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
  // intake too: the Analyst relabels the issue as it works, firing a same-group event —
  // cancel-in-progress:true killed the in-flight `claude -p` (self-cancel bug, PR #428).
  assert.match(wf.intake, /cancel-in-progress:\s*false/, 'intake: Analyst relabels mid-run → must not cancel in-flight runs');
});

test('APPROVAL GATE: backlog only builds approved work; intake never builds code', () => {
  // §5.3 — no do-mode/code work happens before a human approves.
  assert.match(wf.backlog, /approved/, 'backlog must gate on the approved state');
  // intake (Analyst) may commit spec documents (docs/superpowers/specs/) and open spec
  // PRs using DEV_MESH_PAT credentials. It must NOT use GITHUB_TOKEN write access —
  // contents stays read so the GITHUB_TOKEN cannot push code, and the Analyst cannot
  // merge its own PRs.
  assert.doesNotMatch(wf.intake, /contents:\s*write/, 'intake must keep contents: read (GITHUB_TOKEN write blocked; use DEV_MESH_PAT for spec branches)');
  // Scope discipline: the Analyst prompt must explicitly limit writes to docs/superpowers/specs/.
  assert.match(wf.intake, /docs\/superpowers\/specs/, 'intake prompt must scope spec commits to docs/superpowers/specs/');
});

test('intake (#248): the Analyst never mutates labels on already-approved issues', () => {
  // #248 deadlock: the approve-label event re-ran the Analyst, which stripped `spec:in-review`
  // off an APPROVED issue ("leave labels matching reality"), severing its only route to the
  // coder (approved-overrides-review). The prompt must fence the Analyst out of post-approval
  // label edits — its role ends at the spec:in-review human gate.
  assert.match(wf.intake, /approved/, 'intake prompt must reference the approved gate');
  assert.match(
    wf.intake,
    /already carries the `approved`|already.{0,40}`approved`|ALREADY.{0,40}approved/i,
    'intake prompt must forbid touching labels once an issue is approved (#248 deadlock)',
  );
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

test('RETRY BACKOFF: every workflow using claude-code-action has the backoff step immediately before it', () => {
  // The mesh-retry-backoff composite action sleeps 3–5 min with jitter when
  // github.run_attempt > 1 — preventing a 529-overloaded re-run from hammering
  // the API before back-off. It MUST precede the claude step so the delay fires
  // before the invocation, not after. Assert both presence and ordering for all
  // 11 workflows that use anthropics/claude-code-action.
  let checked = 0;
  for (const n of ALL_NAMES) {
    const body = allWf[n];
    if (!/anthropics\/claude-code-action/.test(body)) continue;
    checked++;
    assert.match(body, /mesh-retry-backoff/, `dev-mesh-${n}.yml: must include the mesh-retry-backoff step`);
    const lines = body.split('\n');
    const backoffIdx = lines.findIndex((l) => /mesh-retry-backoff/.test(l));
    const claudeIdx = lines.findIndex((l) => /anthropics\/claude-code-action/.test(l));
    assert.ok(backoffIdx < claudeIdx, `dev-mesh-${n}.yml: mesh-retry-backoff must precede anthropics/claude-code-action`);
  }
  assert.equal(checked, 11, `expected exactly 11 workflows with claude-code-action, saw ${checked}`);
});

test('HONESTY GATE: every agent workflow fails on an errored/no-op model run', () => {
  // green job != healthy run — each workflow must verify its agent actually worked
  // (claude-code-action reports success even when the model errored instantly).
  for (const n of NAMES) {
    assert.match(wf[n], /id:\s*claude/, `${n}: action step needs id: claude for the gate`);
    // The honesty gate now runs via the agent-postrun composite action (which invokes
    // scripts/assert-run-healthy.mjs internally and also captures token usage).
    assert.match(wf[n], /agent-postrun/, `${n}: must run the per-run honesty gate (agent-postrun)`);
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
  // intake is a SPEC_WRITER: it may commit spec documents (docs/superpowers/specs/)
  // to a branch and open spec PRs, but it does NOT run builds or modify code.
  // Git access uses DEV_MESH_PAT credentials; GITHUB_TOKEN keeps contents: read.
  const SPEC_WRITERS = new Set(['intake']);
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
    } else if (SPEC_WRITERS.has(n)) {
      // spec-writers can push spec documents to branches (git) but do not run builds.
      assert.match(wf[n], /Bash\(git:\*\)/, `${n}: spec-writer needs git to push spec branches`);
      assert.doesNotMatch(wf[n], /Bash\(npm:|Bash\(node:/, `${n}: spec-writer does not run builds`);
    } else {
      assert.doesNotMatch(wf[n], /Bash\(git:/, `${n}: ask-only role must not push`);
      assert.doesNotMatch(wf[n], /Bash\(npm:|Bash\(node:/, `${n}: ask-only role doesn't run builds`);
    }
  }
});

test('WEB TOOLS (#266): the Analyst research workflows grant WebSearch/WebFetch', () => {
  // research-landscape is a deep-research skill (fan-out search → fetch → verify). The
  // Analyst drives it from both intake (scheduled poll) and research. Without WebSearch
  // and WebFetch in --allowedTools, that path is denied its core tools and accumulates
  // permission denials until the postrun honesty gate fails (#266). Only the Analyst's
  // research-capable workflows need them; do-workers and other ask-roles must NOT.
  const WEB_AGENTS = new Set(['intake', 'research']);
  for (const n of NAMES) {
    if (WEB_AGENTS.has(n)) {
      assert.match(wf[n], /--allowedTools "[^"]*\bWebSearch\b/, `${n}: research path needs WebSearch`);
      assert.match(wf[n], /--allowedTools "[^"]*\bWebFetch\b/, `${n}: research path needs WebFetch`);
    } else {
      assert.doesNotMatch(wf[n], /--allowedTools "[^"]*\bWebSearch\b/, `${n}: must not grant web tools`);
      assert.doesNotMatch(wf[n], /--allowedTools "[^"]*\bWebFetch\b/, `${n}: must not grant web tools`);
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
  // before the honesty gate (so a cap violation shows up before it). The gate now runs
  // via the agent-postrun composite step.
  assert.match(wf.curate, /validate-quick-memory\.mjs.*quick\.json/,
    'curate: must call validate-quick-memory.mjs on the curator quick.json');
  const ls = wf.curate.split('\n');
  const clIdx = ls.findIndex((l) => /id:\s*claude/.test(l));
  const vaIdx = ls.findIndex((l) => /validate-quick-memory\.mjs/.test(l));
  const hhIdx = ls.findIndex((l) => /agent-postrun/.test(l));
  assert.ok(clIdx < vaIdx, 'validate step must come after id: claude');
  assert.ok(vaIdx < hhIdx, 'validate step must come before the honesty gate (agent-postrun)');
});

test('each workflow drives its own role via dev-mesh/<role>', () => {
  // autofix is the one exception: it's a combined Triager+Coder CI-fix role described
  // INLINE in the prompt (it deliberately does NOT read the no-shell Coder AGENT.md).
  const role = { research: 'analyst', intake: 'analyst', backlog: 'maintainer', triage: 'triager', review: 'reviewer', curate: 'curator', security: 'security' };
  for (const n of Object.keys(role)) {
    assert.match(wf[n], new RegExp(`dev-mesh/${role[n]}`), `${n}: should reference dev-mesh/${role[n]}`);
  }
});

test('security scanner covers injection, identity/auth, and token budget controls', () => {
  assert.match(wf.security, /prompt injection|workflow command injection/i, 'security prompt must cover injection attacks');
  assert.match(wf.security, /OAuth-only|CLAUDE_CODE_OAUTH_TOKEN|identity/i, 'security prompt must cover identity/auth');
  assert.match(wf.security, /token budget|\[autofix\]|\[review-fix\]/i, 'security prompt must cover automation token budgets');
  assert.match(wf.security, /dev-mesh\/security\/AGENT\.md/, 'security workflow must drive the security agent');
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

// --- PERMISSIONS FLOOR LINT: auto-discovered (issue #248) ---
// Auto-discover every dev-mesh-*.yml so new workflows are covered without
// editing this file. Asserts the minimum permissions floor: a permissions:
// block must exist, contents must be at least read (required for checkout),
// and any workflow using gh pr list or pull-requests must grant that scope.
const ALL_NAMES = readdirSync(dir)
  .filter((f) => f.startsWith('dev-mesh-') && f.endsWith('.yml'))
  .map((f) => f.replace(/\.yml$/, '').replace(/^dev-mesh-/, ''));

const allWf = Object.fromEntries(ALL_NAMES.map((n) => [n, readFileSync(`${dir}dev-mesh-${n}.yml`, 'utf8')]));

test('PERMISSIONS FLOOR: every dev-mesh-*.yml has a permissions: block', () => {
  for (const n of ALL_NAMES) {
    assert.match(allWf[n], /^permissions:/m, `dev-mesh-${n}.yml: missing top-level permissions: block`);
  }
});

test('PERMISSIONS FLOOR: every dev-mesh-*.yml grants at least contents: read (checkout requirement)', () => {
  // Without contents: read (or write), GitHub sets all unlisted scopes to none
  // and actions/checkout@v4 will 403. contents: write satisfies the floor.
  for (const n of ALL_NAMES) {
    assert.match(
      allWf[n],
      /contents:\s*(read|write)/,
      `dev-mesh-${n}.yml: must grant at least contents: read (required for actions/checkout@v4)`,
    );
  }
});

test('PERMISSIONS FLOOR: workflows using any gh pr subcommand or pull_request trigger must grant pull-requests', () => {
  // Any `gh pr *` call (list, comment, view, checkout, merge, review, create…) needs
  // pull-requests: read at minimum; without it the gh call 403s.  A pull_request trigger
  // also needs the scope to read PR metadata.
  for (const n of ALL_NAMES) {
    const body = allWf[n];
    const needsPR = /\bgh pr\s/.test(body) || /^\s*pull_request:/m.test(body);
    if (needsPR) {
      assert.match(
        body,
        /pull-requests:\s*(read|write)/,
        `dev-mesh-${n}.yml: uses gh pr or pull_request trigger but missing pull-requests: read/write`,
      );
    }
  }
});

test('CIRCUIT BREAKER (#508): intake prompt enforces spec-push attempt cap and needs-human circuit-break', () => {
  // Issue #508 P1b: a runaway re-author loop (no attempt cap) burned credits on 12+ re-authors.
  // The Analyst must count prior "Spec ready attempt N" comments; at N=3 it must add needs-human
  // and leave a deduped "CIRCUIT BREAKER" escalation comment instead of re-authoring again.
  //
  // Coverage note: the spec also lists "Reset on success" (green push resets counter to 1) and
  // "Durable count" (count survives runner restart via comments, not in-memory state) as test
  // cases. Both are model-instruction behaviors that execute inside a real `claude` turn against
  // live GitHub state; they cannot be exercised hermetically with stub infrastructure.
  assert.match(wf.intake, /Spec ready attempt/,
    'intake prompt must reference "Spec ready attempt N" as the attempt signal');
  assert.match(wf.intake, /needs-human/,
    'intake prompt must add needs-human label on circuit-break');
  assert.match(wf.intake, /CIRCUIT BREAKER/,
    'intake prompt must name the CIRCUIT BREAKER escalation comment (enables dedup check)');
});

test('DEV_MESH_PAT PREFLIGHT (#508): intake has a preflight step ordered before the claude-code-action', () => {
  // Issue #508 P3: silent credential failure — DEV_MESH_PAT gaps were closed "COMPLETED"
  // while the runtime still couldn't push. The preflight step fails loudly before the
  // Analyst spends API budget, so a missing/unauthorized PAT is caught immediately.
  assert.match(wf.intake, /Preflight DEV_MESH_PAT/,
    'intake must have a "Preflight DEV_MESH_PAT" step');
  const lines = wf.intake.split('\n');
  const preIdx = lines.findIndex((l) => /Preflight DEV_MESH_PAT/.test(l));
  const claudeIdx = lines.findIndex((l) => /anthropics\/claude-code-action/.test(l));
  assert.ok(preIdx > -1, 'DEV_MESH_PAT preflight step must be present');
  assert.ok(preIdx < claudeIdx, 'DEV_MESH_PAT preflight must precede the claude-code-action step');
});

test('529 SOFT-EXIT (#508): intake postrun passes infra_soft so 529 maps to warning not exit-1', () => {
  // Issue #508 P4: persistent HTTP 529 exited hard-1, making every transient 529 a red job
  // that required a human to unblock. For intake, 529 is transient infra noise; the job
  // should exit neutral (warning annotation) so the re-run path with mesh-retry-backoff
  // jitter is the correct recovery without blocking the queue on a human.
  assert.match(wf.intake, /infra_soft:\s*["']?true/,
    'intake postrun must pass infra_soft: true (soft-exit on 529)');
});

test('529 RATE-LIMIT (#482): intake uses a global (not per-issue) workflow concurrency group', () => {
  // Prior design: group: dev-mesh-intake-${{ github.event.issue.number || 'poll' }}
  // serialised same-issue runs but allowed different issues to fire in parallel.
  // That burst (8+ runs at the same second) caused persistent HTTP 529 overload (#482).
  // Fix: global group "dev-mesh-intake" (no issue-number template) serialises ALL
  // intake runs — at most 1 executing + 1 queued — while cancel-in-progress: false
  // keeps in-flight claude -p runs safe.
  assert.match(wf.intake, /group:\s*dev-mesh-intake\b/,
    'intake concurrency group must be global (dev-mesh-intake), not per-issue');
  assert.doesNotMatch(wf.intake, /group:.*issue\.number/,
    'intake concurrency group must NOT use the per-issue issue.number template (causes 529 burst)');
});
