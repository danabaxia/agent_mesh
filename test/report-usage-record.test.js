// test/report-usage-record.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageRecord } from '../src/report/usage-record.js';

test('buildUsageRecord shapes a CI usage record from an envelope + env', () => {
  const env = { GITHUB_WORKFLOW: 'dev-mesh-review', GITHUB_RUN_ID: '123', GITHUB_REF: 'refs/pull/9/merge' };
  const rec = buildUsageRecord(
    { result: 'ok', usage: { input_tokens: 10, output_tokens: 2 }, total_cost_usd: 0.1, num_turns: 3 },
    env,
    () => '2026-06-18T09:00:00.000Z',
  );
  assert.equal(rec.workflow, 'dev-mesh-review');
  assert.equal(rec.runId, '123');
  assert.equal(rec.ts, '2026-06-18T09:00:00.000Z');
  assert.equal(rec.usage.input_tokens, 10);
  assert.equal(rec.usage.total_cost_usd, 0.1);
});
