// test/dev-mesh-classify.test.js — pure CI-failure classifier (spec §8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, classifyFromLog, extractSignals, LABELS } from '../src/dev-mesh/classify.js';

test('precedence: infra/auth wins even when tests ran and "failed"', () => {
  // The nightly L1 signature: real `claude` never ran, 5 e2e tests all assert
  // 'error' !== 'done'. Must be infra_auth (escalate), not real_bug.
  const log = [
    "not ok 1 - real claude: A delegates a do task to B",
    "  error: 'Command failed: claude -p ...'",
    "# tests 5", "# pass 0", "# fail 5", "# duration_ms 5437"
  ].join('\n');
  const r = classifyFromLog(log, { changedFiles: ['src/delegate.js'] });
  assert.equal(r.label, LABELS.INFRA_AUTH);
  assert.equal(r.action, 'escalate (human)');
});

test('infra_auth: no test executed before exit', () => {
  const log = '##[error]Process completed with exit code 1.';
  assert.equal(classifyFromLog(log).label, LABELS.INFRA_AUTH);
});

test('infra_auth: explicit auth / 403 marker', () => {
  assert.equal(classifyFailure({ infraError: true }).label, LABELS.INFRA_AUTH);
  assert.equal(classifyFromLog('device code request failed with status 403 Forbidden').label, LABELS.INFRA_AUTH);
});

test('infra_auth: OAuth "invalid auth" signature (broadened from invalid api key)', () => {
  // OAuth-authed runners emit "invalid auth …" rather than the API-key text; the
  // broadened INFRA_RE must still route this to infra_auth (escalate), not real_bug.
  assert.equal(classifyFromLog('Error: invalid auth token').label, LABELS.INFRA_AUTH);
});

test('out_of_scope: same failure reproduces on the base branch', () => {
  const r = classifyFailure({ ranAnyTest: true, failingFiles: ['foo.test.js'], failedOnBaseBranch: true });
  assert.equal(r.label, LABELS.OUT_OF_SCOPE);
});

test('flake: known-flaky OR rerun-passed AND unrelated to the diff', () => {
  const base = { ranAnyTest: true, failingFiles: ['process.test.js'], changedFiles: ['examples/eval-pair/lib/lib/strings.js'] };
  assert.equal(classifyFailure({ ...base, knownFlaky: true }).label, LABELS.FLAKE);
  assert.equal(classifyFailure({ ...base, rerunPassed: true }).label, LABELS.FLAKE);
});

test('NOT flake when the diff touches the failing area (real_bug)', () => {
  // knownFlaky is ignored if the change relates to the failing test → don't dismiss.
  const r = classifyFailure({
    ranAnyTest: true, knownFlaky: true,
    failingFiles: ['parser.test.js'], changedFiles: ['src/parser.js']
  });
  assert.equal(r.label, LABELS.REAL_BUG);
});

test('real_bug: deterministic failure in changed code', () => {
  const r = classifyFailure({ ranAnyTest: true, failingFiles: ['parser.test.js'], changedFiles: ['src/parser.js'] });
  assert.equal(r.label, LABELS.REAL_BUG);
  assert.equal(r.action, 'fix (Coder)');
});

test('extractSignals parses count / failing tests / files / duration (path-agnostic)', () => {
  const log = [
    'not ok 1 - spawnFile timeout kills the whole process tree',
    "  location: '/home/runner/work/agent_mesh/agent_mesh/test/process.test.js:65:1'",
    '# tests 4', '# pass 3', '# fail 1', '# duration_ms 14245'
  ].join('\n');
  const s = extractSignals(log);
  assert.equal(s.ranAnyTest, true);
  assert.equal(s.testCount, 4);
  assert.deepEqual(s.failingTests, ['spawnFile timeout kills the whole process tree']);
  assert.deepEqual(s.failingFiles, ['process.test.js']);   // basename, not the win/posix path
  assert.equal(s.durationMs, 14245);
  assert.equal(s.infraError, false);
});

test('extractSignals: api_error_status:null in success envelope does not trigger infraError', () => {
  const log = '{"result":"OK","is_error":false,"api_error_status":null,"num_turns":1}';
  const s = extractSignals(log);
  assert.equal(s.infraError, false);
});

test('extractSignals: api_error_status with a real error string triggers infraError', () => {
  const log = '{"result":null,"is_error":true,"api_error_status":"overloaded_error"}';
  const s = extractSignals(log);
  assert.equal(s.infraError, true);
});

test('end-to-end: the real Windows process-tree flake classifies as flake', () => {
  const log = [
    'not ok 1 - spawnFile timeout kills the whole process tree',
    "  location: 'D:\\\\a\\\\agent_mesh\\\\agent_mesh\\\\test\\\\process.test.js:65:1'",
    '# tests 4', '# pass 3', '# fail 1', '# duration_ms 14245'
  ].join('\n');
  const r = classifyFromLog(log, { knownFlakyTests: ['process.test.js'], changedFiles: ['examples/eval-pair/lib/lib/strings.js'] });
  assert.equal(r.label, LABELS.FLAKE);
});
