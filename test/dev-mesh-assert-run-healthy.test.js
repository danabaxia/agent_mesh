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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
