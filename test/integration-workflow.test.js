// test/integration-workflow.test.js — hermetic lint of the nightly integration
// pipeline. The repo is zero-dependency (no YAML parser), so this asserts the
// invariants that matter against the raw workflow text. It catches drift — a
// renamed eval script, a lost skip-guard, a tier that silently became gating —
// in the L0 suite, even though the workflow itself only runs nightly.
// Spec: docs/superpowers/specs/2026-06-13-integration-test-pipeline-design.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const wfPath = fileURLToPath(new URL('../.github/workflows/integration.yml', import.meta.url));
const ciPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const wf = await readFile(wfPath, 'utf8');

test('integration workflow: scheduled + manual, never per-PR', () => {
  assert.match(wf, /^on:/m);
  assert.match(wf, /schedule:/);
  assert.match(wf, /cron:\s*'[^']+'/);
  assert.match(wf, /workflow_dispatch:/);
  // It must NOT trigger on push/pull_request — that's ci.yml's (L0) job. A
  // per-PR trigger here would run a real claude on every PR.
  assert.doesNotMatch(wf, /^\s*push:/m, 'integration must not run on push');
  assert.doesNotMatch(wf, /^\s*pull_request:/m, 'integration must not run on pull_request');
});

test('integration workflow: POSIX-only, scorecard-safe concurrency', () => {
  assert.match(wf, /runs-on:\s*ubuntu-latest/);
  // real-claude e2e is POSIX-first; no Windows runner in this pipeline.
  assert.doesNotMatch(wf, /windows-latest/);
  // a long scorecard must never be cancelled by the next schedule tick.
  assert.match(wf, /cancel-in-progress:\s*false/);
});

test('integration workflow: real-claude auth is OAuth-only with fail-fast preflight', () => {
  assert.doesNotMatch(wf, /ANTHROPIC_API_KEY/, 'integration must never use API-key auth');
  assert.match(wf, /RAW_OAUTH:\s*\$\{\{\s*secrets\.CLAUDE_CODE_OAUTH_TOKEN\s*\}\}/);
  assert.match(wf, /tr -d '\[:space:\]'/, 'OAuth token must be sanitized before use');
  assert.match(wf, /::add-mask::\$CLEAN/, 'sanitized token must be re-masked so stripped whitespace variant is also secret');
  assert.match(wf, /echo "CLAUDE_CODE_OAUTH_TOKEN=\$CLEAN" >> "\$GITHUB_ENV"/);
  assert.match(wf, /npm i -g @anthropic-ai\/claude-code/);
  // a missing secret errors out (::error::) rather than timing out per tier.
  assert.match(wf, /if \[ -z "\$CLEAN" \]/);
  assert.match(wf, /::error::CLAUDE_CODE_OAUTH_TOKEN/);
});

test('integration workflow: schedule-from-default-branch caveat handled (checks out v0.4-development)', () => {
  // schedule fires from the default branch, so jobs explicitly evaluate the
  // integration branch.
  assert.match(wf, /INTEGRATION_REF:\s*v0\.4-development/);
  assert.match(wf, /ref:\s*\$\{\{\s*env\.INTEGRATION_REF\s*\}\}/);
});

test('integration workflow: each declared tier runs its real harness', () => {
  // L1 — real-claude e2e (gating: a plain `node --test`, no record-only wrapper)
  assert.match(wf, /AGENT_MESH_E2E=1 node --test test\/demo-e2e\.test\.js/);
  // L2 — behavior eval scorecard
  assert.match(wf, /node scripts\/eval-a2a\.mjs --trials \d+ --out eval-results/);
  // L3/L4 — skip-guarded on the forthcoming scripts (backlog #3/#4)
  assert.match(wf, /if \[ -f scripts\/eval-adversarial\.mjs \]/);
  assert.match(wf, /scripts\/eval-adversarial\.mjs --min-pass-rate 1\.0/);  // L3 gates when present
  assert.match(wf, /if \[ -f scripts\/eval-perf\.mjs \]/);
  assert.match(wf, /node scripts\/eval-perf\.mjs --trials \d+/);
});

test('integration workflow: scorecards uploaded as artifacts', () => {
  assert.match(wf, /actions\/upload-artifact@v4/);
  assert.match(wf, /name:\s*l2-behavior-scorecard/);
  assert.match(wf, /\$GITHUB_STEP_SUMMARY/);
});

test('integration workflow does not weaken the L0 gate (ci.yml unchanged in shape)', async () => {
  const ci = await readFile(ciPath, 'utf8');
  // ci.yml remains the per-PR gate: push + pull_request, OS matrix, hermetic runner.
  assert.match(ci, /pull_request:/);
  assert.match(ci, /run-all-tests\.mjs/);
  assert.match(ci, /windows-latest/);   // L0 keeps the OS matrix the integration tier drops
});
