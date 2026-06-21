/**
 * test/dashboard-sse-secret-safety.test.js
 *
 * /api/events secret-safety coverage (Plan 1 Task 7).
 *
 * INVESTIGATION RESULT (Task 7 adapted path):
 *   The SSE hub (createSseHub in server.js) has NO per-frame filter of its own:
 *   it calls `JSON.stringify(data)` verbatim. The secret-safety boundary is
 *   therefore the RECORD SOURCE: loadActivitySnapshot() → buildActivity()
 *   (src/dashboard/activity.js), which is a PURE, side-effect-free transform that
 *   whitelists only structural/phase-indicator fields:
 *     agents: { name, state, route, since }
 *     edges:  { from, to, active, kind }
 *     events: { kind, agent|from/to, route|mode/status, at }
 *   No task text, no result data, no secrets can survive into the output —
 *   the code comment says "structurally incapable of carrying a path, a secret,
 *   or model output."
 *
 *   Because buildActivity() is a pure function with no DOM/network/Date.now()
 *   dependency it is directly unit-testable without any stubs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActivity } from '../src/dashboard/activity.js';

const SECRET = 'sk-ant-DO-NOT-LEAK-super-secret-value';

test('buildActivity: planted secret in task text is never serialised into the output', () => {
  const records = [
    {
      agent: 'app',
      id: 'run-1',
      started_at: '2026-06-20T00:00:00.000Z',
      finished_at: '2026-06-20T00:01:00.000Z',
      route: 'ask',
      // These fields carry the secret — they must never reach the SSE frame
      task: `Call this API with key ${SECRET}`,
      result: `The answer is ${SECRET}`,
      summary: `Summary contains ${SECRET}`,
    },
    {
      kind: 'a2a',
      from: 'app',
      to: 'lib',
      mode: 'ask',
      status: 'done',
      started_at: '2026-06-20T00:00:01.000Z',
      finished_at: '2026-06-20T00:01:01.000Z',
      // Secret in a2a record too
      task: `Secret ${SECRET}`,
    },
  ];

  const result = buildActivity(records);
  const serialised = JSON.stringify(result);

  assert.equal(serialised.includes(SECRET), false,
    `buildActivity output must not contain the secret; found it in: ${serialised.slice(0, 200)}`);
});

test('buildActivity: output only contains whitelisted structural fields', () => {
  const records = [
    {
      agent: 'app',
      id: 'run-1',
      started_at: '2026-06-20T00:00:00.000Z',
      finished_at: '2026-06-20T00:01:00.000Z',
      route: 'ask',
      task: 'sensitive task text',
      result: 'sensitive result',
    },
  ];

  const result = buildActivity(records);

  // agents: only allowed keys
  for (const a of result.agents) {
    const keys = Object.keys(a).sort();
    assert.deepEqual(keys, ['name', 'route', 'since', 'state'].sort(),
      `agent object has unexpected keys: ${JSON.stringify(a)}`);
  }

  // events: only allowed keys
  for (const e of result.events) {
    const allowed = new Set(['kind', 'agent', 'from', 'to', 'route', 'mode', 'status', 'at']);
    for (const k of Object.keys(e)) {
      assert.equal(allowed.has(k), true, `event has unexpected key "${k}": ${JSON.stringify(e)}`);
    }
  }

  // edges: only allowed keys
  for (const edge of result.edges) {
    const allowed = new Set(['from', 'to', 'active', 'kind']);
    for (const k of Object.keys(edge)) {
      assert.equal(allowed.has(k), true, `edge has unexpected key "${k}": ${JSON.stringify(edge)}`);
    }
  }
});

test('buildActivity: no free-text fields in the output at all', () => {
  const records = [
    {
      agent: 'worker',
      id: 'run-x',
      started_at: '2026-06-20T00:00:00.000Z',
      task: 'free text that must not appear',
      result: 'output that must not appear',
      log_path: '/sensitive/path/to/log',
    },
  ];

  const result = buildActivity(records);
  const serialised = JSON.stringify(result);

  assert.equal(serialised.includes('free text'), false, 'task text must not appear in output');
  assert.equal(serialised.includes('output that must not'), false, 'result text must not appear in output');
  assert.equal(serialised.includes('/sensitive/path'), false, 'log_path must not appear in output');
});
