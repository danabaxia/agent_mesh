import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectInputs } from '../src/mesh-improvement/collect.js';

test('reads latest scorecards, run-logs, and previous mir', () => {
  const root = mkdtempSync(join(tmpdir(), 'mir-collect-'));
  const beh = join(root, 'eval-results', '2026-06-20T06-00-00');
  mkdirSync(beh, { recursive: true });
  writeFileSync(join(beh, 'scorecard.json'), JSON.stringify({ aggregate: { trials: 9, passed: 8, passRate: 0.889 }, scenarios: [] }));
  const logDir = join(root, 'logs'); mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'delegate-2026-06-20.jsonl'),
    JSON.stringify({ id: 'd1', state: 'done', route: 'ask', status: 'timeout', summary: 'killed' }) + '\n');
  const mirDir = join(root, 'mir'); mkdirSync(mirDir, { recursive: true });
  writeFileSync(join(mirDir, 'mir-2026-06-19.json'), JSON.stringify({ schema: 'mesh-improvement-report/v1', at: '2026-06-19T06:30:00Z' }));

  const { inputs, previousMir } = collectInputs({
    resultsRoots: { tests: join(root, 'test-results.json'), behavior: join(root, 'eval-results'),
                    adversarial: join(root, 'adversarial-results'), perf: join(root, 'perf-results') },
    logDir, mirDir });
  assert.equal(inputs.behavior.aggregate.passRate, 0.889);
  assert.equal(inputs.runLogs.length, 1);
  assert.equal(inputs.runLogs[0].status, 'timeout');
  assert.equal(inputs.tests, null);            // missing test-results.json tolerated
  assert.equal(previousMir.at, '2026-06-19T06:30:00Z');
});
