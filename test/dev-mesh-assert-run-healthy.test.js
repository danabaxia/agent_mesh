// test/dev-mesh-assert-run-healthy.test.js — the per-workflow honesty GATE's exit policy.
// Standalone (no shared edits). The pure classifier is tested in dev-mesh-health.test.js;
// this asserts how scripts/assert-run-healthy.mjs MAPS a classification to a job result:
//   errored / noop / unknown / missing-file → fatal (exit 1)
//   blocked (>= denial threshold)           → fatal by default; ADVISORY (::warning::,
//                                              exit 0) only with --advisory-blocked
//   ok                                       → pass (exit 0)
// The --advisory-blocked scope fixes the 2026-06-15 bug where the ask-role Reviewer
// (granted only Read/Grep/Glob/Bash(gh:*)) probed ungranted shell commands, racked up
// >= 5 denials, and turned the advisory `review` check RED on every PR — while keeping
// do-mode pushers (autofix/mergefix/backlog/curate) hard-failing on a real misconfig.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('../scripts/assert-run-healthy.mjs', import.meta.url));

// Run the gate against an envelope written to a temp file. Returns { code, stdout, stderr }.
// extraArgs lets a test pass --advisory-blocked (the light comment/ask-role scope).
function runGate(envelope, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-gate-'));
  const file = join(dir, 'claude-execution-output.json');
  writeFileSync(file, JSON.stringify(envelope));
  try {
    const r = spawnSync(process.execPath, [gate, file, ...extraArgs], { encoding: 'utf8' });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('gate: a healthy run passes (exit 0)', () => {
  const r = runGate({ type: 'result', is_error: false, num_turns: 6, total_cost_usd: 0 });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /agent run healthy/);
});

test('gate: blocked is ADVISORY with --advisory-blocked — warns but exits 0', () => {
  // The light comment/ask-role case (review/triage/intake/research): real work
  // (62 turns) but many denials from probing ungranted shell. Must NOT fail the job.
  const env = { type: 'result', is_error: false, num_turns: 62, total_cost_usd: 0, permission_denials_count: 25 };
  const r = runGate(env, ['--advisory-blocked']);
  assert.equal(r.code, 0, 'blocked must not hard-fail under --advisory-blocked');
  assert.match(r.stderr + r.stdout, /::warning::/);
  assert.match(r.stderr + r.stdout, /blocked/);
});

test('gate: blocked is FATAL by default (do-mode pushers) — exit 1', () => {
  // Without the flag (autofix/mergefix/backlog/curate): >= 5 denials signals a real
  // misconfigured tool grant (the Bash(git) vs git:* bug the gate exists to catch).
  const env = { type: 'result', is_error: false, num_turns: 62, total_cost_usd: 0, permission_denials_count: 25 };
  const r = runGate(env);
  assert.equal(r.code, 1, 'blocked must hard-fail without --advisory-blocked');
  assert.match(r.stderr, /::error::/);
  assert.match(r.stderr, /blocked/);
});

test('gate: an errored run is fatal (exit 1)', () => {
  const r = runGate({ type: 'result', is_error: true, duration_ms: 218, num_turns: 1, total_cost_usd: 0 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /::error::/);
  assert.match(r.stderr, /errored/);
});

test('gate: a transient 529 overload soft-passes (exit 0) and flags retryable_overload (#386)', () => {
  // The overload run never did real work, but it is a known-transient infra blip — the
  // gate must NOT false-red it; it warns, exits 0, and writes the retryable flag so the
  // scheduled cadence (or a re-dispatch) retries it instead of an immediate failure.
  const dir = mkdtempSync(join(tmpdir(), 'agentmesh-gate-ovl-'));
  const file = join(dir, 'claude-execution-output.json');
  const out = join(dir, 'gh-output');
  writeFileSync(file, JSON.stringify({ type: 'result', is_error: true, api_error_status: 'overloaded_error', duration_ms: 300000, num_turns: 0, total_cost_usd: 0 }));
  try {
    const r = spawnSync(process.execPath, [gate, file], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } });
    assert.equal(r.status ?? 1, 0, 'a transient overload must not hard-fail the job');
    assert.match((r.stderr ?? '') + (r.stdout ?? ''), /::warning::/);
    assert.match((r.stderr ?? '') + (r.stdout ?? ''), /overload/i);
    assert.match(readFileSync(out, 'utf8'), /retryable_overload=true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gate: a no-op run (0 turns) is fatal (exit 1)', () => {
  const r = runGate({ type: 'result', is_error: false, num_turns: 0, total_cost_usd: 0 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /noop/);
});

test('gate: an unreadable/garbage envelope is fatal (exit 1)', () => {
  const r = runGate([{ type: 'system' }]); // no result event → unknown
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown/);
});

test('gate: a missing execution file is fatal (exit 1)', () => {
  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [gate, join(tmpdir(), 'definitely-missing-agentmesh.json')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    code = e.status ?? 1;
    stderr = e.stderr?.toString() ?? '';
  }
  assert.equal(code, 1);
  assert.match(stderr, /no claude execution output/);
});

// Convention lint (the Reviewer's #26 hardening note): the light-vs-do-mode boundary
// lives only in per-workflow YAML, so a future role could silently drift — a do-mode
// pusher wrongly given advisory_blocked would LOSE its honest RED on a real misconfig.
// Encode the rule as a test: a workflow is a do-mode pusher IFF it grants Bash(git:*)
// (the git-push signature); the gate must be advisory IFF it is NOT a pusher. The gate
// now runs via the agent-postrun composite action, which takes `advisory_blocked` as an
// input (was the `--advisory-blocked` CLI flag on a direct assert-run-healthy.mjs call).
test('convention: agent-postrun advisory_blocked iff the role lacks Bash(git:*)', () => {
  const wfDir = fileURLToPath(new URL('../.github/workflows', import.meta.url));
  const files = readdirSync(wfDir).filter((f) => f.startsWith('dev-mesh-') && f.endsWith('.yml'));
  let checked = 0;
  for (const f of files) {
    const wf = readFileSync(join(wfDir, f), 'utf8');
    if (!/agent-postrun/.test(wf)) continue; // dogfood/health don't run the composite gate
    checked++;
    // Heuristic: Bash(git:*) is the git-push signature of a do-mode pusher. A future role
    // granting a broader 'Bash' or a narrower 'Bash(git:push)' would NOT be detected here
    // and would be wrongly treated as light — update this pattern if such a grant is added.
    const isPusher = /Bash\(git:\*\)/.test(wf);
    // The composite gate is advisory when the workflow passes advisory_blocked: "true".
    const hasFlag = /advisory_blocked:\s*["']true["']/.test(wf);
    if (isPusher) {
      assert.equal(hasFlag, false, `${f}: do-mode pusher must set advisory_blocked: "false" (hard-fail on blocked)`);
    } else {
      assert.equal(hasFlag, true, `${f}: light role must set advisory_blocked: "true" (else its review check false-fails)`);
    }
  }
  // Track the ACTUAL gated count. An exact match forces a deliberate update when a workflow
  // is added OR un-gated — the lint's whole point is "nobody silently dropped one". Current
  // 11: autofix, backlog, ci-sweep, curate, intake, mergefix, research,
  // review-respond, review, security, triage (7 strict pushers + 4 --advisory-blocked light roles).
  // intake moved to strict (Bash(git:*) for spec branches, #227).
  assert.equal(checked, 11, `expected exactly 11 gated dev-mesh workflows, saw ${checked}`);
});
