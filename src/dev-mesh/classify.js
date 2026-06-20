// src/dev-mesh/classify.js — PURE CI-failure classifier (spec 2026-06-14 §8).
// Zero-dep. The Triager gathers the raw logs/context (impure); THIS decides the
// label from extracted signals, deterministically, so the decision is unit-
// provable. Mis-classifying is expensive — "fixing" a flake or an infra outage
// wastes money and thrashes the branch; re-kicking a real bug never goes green —
// so precedence is deliberate: infra > out-of-scope > flake > real_bug.

export const LABELS = Object.freeze({
  FLAKE: 'flake',
  REAL_BUG: 'real_bug',
  INFRA_AUTH: 'infra_auth',
  OUT_OF_SCOPE: 'out_of_scope'
});

export const ACTIONS = Object.freeze({
  [LABELS.FLAKE]: 're-kick (max 2x)',
  [LABELS.REAL_BUG]: 'fix (Coder)',
  [LABELS.INFRA_AUTH]: 'escalate (human)',
  [LABELS.OUT_OF_SCOPE]: 'report, no edit'
});

// Infra/auth signatures — auth, network, and (repo-specific) "the real `claude`
// never ran" markers seen in the nightly L1 failures (Command failed: claude,
// the e2e status assertion 'error' !== 'done', api_error_status).
const INFRA_RE = new RegExp([
  'not logged in', 'authentication_error', 'invalid auth', '401 unauthorized',
  '403 forbidden', 'resource not accessible by integration', 'secret is not set',
  'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'could not resolve host',
  'command failed: claude', "'error'\\s*!==\\s*'done'", 'claude -p failed', 'api_error_status":\\s*"(?!null)'
].join('|'), 'i');

const TESTS_RE = /# tests (\d+)/;
const NOTOK_RE = /^not ok \d+ - (.+)$/gm;
const DURATION_RE = /# duration_ms ([\d.]+)/;
const FILE_RE = /([A-Za-z0-9_.\-]+\.(?:m?js|cjs|ts))/;

/** Derive structured signals from a CI job log (best-effort, pure). */
export function extractSignals(logText = '', { fastFailMs = 2000 } = {}) {
  const text = String(logText);

  const testsM = text.match(TESTS_RE);
  const testCount = testsM ? Number(testsM[1]) : 0;

  const failingTests = [];
  for (const m of text.matchAll(NOTOK_RE)) failingTests.push(m[1].trim());

  // Failing-test FILE basenames from node --test `location:` lines (path-separator
  // agnostic: the basename is the only token ending in a JS/TS extension).
  const failingFiles = [];
  for (const line of text.split('\n')) {
    if (!/location:/i.test(line)) continue;
    const m = line.match(FILE_RE);
    if (m) failingFiles.push(m[1]);
  }

  const durM = text.match(DURATION_RE);

  return {
    ranAnyTest: testCount > 0,
    testCount,
    failingTests,
    failingFiles: [...new Set(failingFiles)],
    durationMs: durM ? Number(durM[1]) : null,
    infraError: INFRA_RE.test(text),
    fastFailMs
  };
}

// stem: basename minus `.test` and extension, so a failing test file relates to
// the source it covers (process.test.js ↔ src/process.js → both "process").
function stem(path) {
  const base = String(path).split(/[\\/]/).pop() || '';
  return base.replace(/\.test\.(m?js|cjs|ts)$/i, '').replace(/\.(m?js|cjs|ts)$/i, '');
}

function relatesToChange(failingFiles, changedFiles) {
  const changedStems = new Set(changedFiles.map(stem));
  return failingFiles.some((f) => changedStems.has(stem(f)));
}

const mk = (label, reason) => ({ label, reason, action: ACTIONS[label] });

/**
 * Classify a CI failure into exactly one LABEL from extracted signals + repo
 * context. `relatedToChange` may be passed to override the basename heuristic.
 */
export function classifyFailure(ctx = {}) {
  const {
    infraError = false,
    ranAnyTest = true,
    durationMs = null,
    fastFailMs = 2000,
    failedOnBaseBranch = false,
    rerunPassed = false,
    knownFlaky = false,
    failingFiles = [],
    changedFiles = [],
    relatedToChange
  } = ctx;

  const related = relatedToChange === undefined
    ? relatesToChange(failingFiles, changedFiles)
    : !!relatedToChange;

  // 1) infra / auth — highest priority; never treat an outage as a code bug.
  if (infraError) return mk(LABELS.INFRA_AUTH, 'auth/infra signature in log');
  if (!ranAnyTest) return mk(LABELS.INFRA_AUTH, 'no test executed before exit');
  if (durationMs != null && durationMs < fastFailMs && failingFiles.length === 0) {
    return mk(LABELS.INFRA_AUTH, `exited in <${fastFailMs}ms with no identified test failure`);
  }

  // 2) out-of-scope — reproduces on the base branch → not introduced by this diff.
  if (failedOnBaseBranch) {
    return mk(LABELS.OUT_OF_SCOPE, 'same failure present on the base branch (pre-existing)');
  }

  // 3) flake — known-intermittent OR passes on re-run, AND unrelated to the diff.
  //    If the diff touches the failing area we do NOT dismiss it as flake.
  if ((knownFlaky || rerunPassed) && !related) {
    return mk(LABELS.FLAKE, `${knownFlaky ? 'known-flaky test' : 'passed on re-run'}, unrelated to changed files`);
  }

  // 4) default — deterministic failure; treat as a real bug to fix.
  return mk(LABELS.REAL_BUG, related ? 'deterministic failure in changed code' : 'deterministic failure');
}

/** Convenience: extract signals from a log + classify in one call. */
export function classifyFromLog(logText, repoCtx = {}) {
  const sig = extractSignals(logText, { fastFailMs: repoCtx.fastFailMs });
  const knownFlaky = repoCtx.knownFlaky ?? (repoCtx.knownFlakyTests || []).some(
    (t) => sig.failingTests.some((ft) => ft.includes(t)) || sig.failingFiles.some((ff) => ff.includes(t))
  );
  return classifyFailure({ ...sig, ...repoCtx, knownFlaky });
}
