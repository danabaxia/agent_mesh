// test/integration-workflow.test.js — hermetic lint of the nightly integration
// pipeline. The repo is zero-dependency (no YAML parser), so this asserts the
// invariants that matter against the raw workflow text. It catches drift — a
// renamed eval script, a lost skip-guard, a tier that silently became gating —
// in the L0 suite, even though the workflow itself only runs nightly.
// Spec: docs/superpowers/specs/2026-06-13-integration-test-pipeline-design.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

test('integration workflow: schedule-from-default-branch caveat handled (checks out main)', () => {
  // schedule fires from the default branch; under trunk-based development the
  // integration tier evaluates `main` directly (the retired vN-development line
  // is no longer the integration branch). Jobs still check out INTEGRATION_REF
  // explicitly so a workflow_dispatch from any ref tests the trunk.
  assert.match(wf, /INTEGRATION_REF:\s*main\b/);
  assert.match(wf, /ref:\s*\$\{\{\s*env\.INTEGRATION_REF\s*\}\}/);
});

test('integration workflow: each declared tier runs its real harness', () => {
  // L1 — real-claude e2e (gating: a plain `node --test`, no record-only wrapper)
  assert.match(wf, /AGENT_MESH_E2E=1 node --test test\/demo-e2e\.test\.js/);
  // L2 — behavior eval scorecard
  assert.match(wf, /node scripts\/eval-a2a\.mjs --trials \d+ --out eval-results/);
  // L3/L4 — skip-guarded on script presence; scripts are on main (see existsSync test below)
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

test('integration workflow does not weaken the L0 gate (ci.yml L0 properties intact)', async () => {
  const ci = await readFile(ciPath, 'utf8');
  // ci.yml remains the per-PR gate: pull_request trigger, OS matrix, hermetic runner.
  assert.match(ci, /pull_request:/);
  assert.match(ci, /run-all-tests\.mjs/);
  assert.match(ci, /windows-latest/);   // L0 keeps the OS matrix the integration tier drops
  // Trunk-based: BOTH triggers (push + pull_request) must target only `main`. A count
  // (not a single match) so widening just one of them — e.g. push to [main, 'v2-release']
  // while pull_request stays [main] — is still caught (wasted CI minutes), not just the
  // retired-pattern case below.
  const branchMatches = ci.match(/branches:\s*\[main\]/g) ?? [];
  assert.equal(branchMatches.length, 2, 'both push and pull_request triggers must restrict to branches: [main]');
  assert.doesNotMatch(ci, /v\*-development/, 'ci.yml triggers must not re-add retired vN-development lines');
});

test('integration workflow: L3/L4 eval scripts are present on this ref', () => {
  // The YAML skip-guards (`if [ -f scripts/eval-*.mjs ]`) silently skip the tier
  // when the script is missing. Now that the nightly tracks `main` and CLAUDE.md
  // states L3 gates / L4 runs live, assert the files actually exist — otherwise an
  // accidental deletion would silently disarm both tiers with no L0 failure.
  assert.ok(existsSync(fileURLToPath(new URL('../scripts/eval-adversarial.mjs', import.meta.url))),
    'scripts/eval-adversarial.mjs must exist for L3 to gate the nightly');
  assert.ok(existsSync(fileURLToPath(new URL('../scripts/eval-perf.mjs', import.meta.url))),
    'scripts/eval-perf.mjs must exist for L4 to run');
});

test('every workflow that runs an agent uses agent-postrun (gate + usage capture)', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml'));
  for (const f of files) {
    const body = readFileSync(new URL(f, dir), 'utf8');
    if (!body.includes('steps.claude.outputs.execution_file')) continue;   // not an agent workflow
    assert.ok(body.includes('uses: ./.github/actions/agent-postrun'),
      `${f} runs an agent but does not use agent-postrun`);
    assert.ok(!/run: node scripts\/assert-run-healthy\.mjs/.test(body),
      `${f} still calls assert-run-healthy directly; route it through agent-postrun`);
  }
});

test('integration workflow: l0-json producer uploads test-results before exit', () => {
  assert.match(wf, /l0-json:/);
  assert.match(wf, /run-all-tests\.mjs --json test-results\.json/);
  // the upload must survive a red suite (nonzero exit) → if: always()
  assert.match(wf, /name: l0-json-results[\s\S]*?if: always\(\)/);
});

test('integration workflow: mir job aggregates, with permissions and schedule-gated mutation', () => {
  assert.match(wf, /\n  mir:/);
  assert.match(wf, /needs:\s*\[l0-json, l2-behavior, l3-adversarial, l4-perf\]/);
  assert.match(wf, /\n    if: always\(\)/);
  assert.match(wf, /issues: write/);
  assert.match(wf, /actions: read/);
  // live mutation only on schedule; workflow_dispatch is dry-run.
  assert.match(wf, /github\.event_name == 'schedule'/);
  assert.match(wf, /--dry-run/);
});
