import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFindings } from '../src/concierge/monitor.js';

test('conformance failures → critical findings, deduped by id', () => {
  const f = buildFindings({ conformance: { ok: false, counts: { pass: 3, warn: 1, fail: 2 },
    problems: [{ rule: 'peer-edge', level: 'fail', detail: 'analyst→ghost missing' },
               { rule: 'peer-edge', level: 'fail', detail: 'analyst→ghost missing' }] } });
  const conf = f.filter((x) => x.kind === 'conformance');
  assert.equal(conf.length, 1, 'duplicate problems collapse to one finding');
  assert.equal(conf[0].severity, 'critical');
});

test('triage failures + stale tasks classify by severity', () => {
  const f = buildFindings({
    triage: { agents: { tester: { failures: 2, recent_failures: [{ id: 'r1' }] } } },
    staleTasks: { tasks: [{ id: 't1', to: 'coder', state: 'assigned', age_ms: 9e7 }] }
  });
  assert.ok(f.some((x) => x.kind === 'agent-failures' && x.severity === 'warn'));
  assert.ok(f.some((x) => x.kind === 'stale-task' && x.id === 'stale-task:t1'));
});

test('all-clear inputs → no findings', () => {
  assert.deepEqual(buildFindings({ conformance: { ok: true, counts: { fail: 0 }, problems: [] },
    triage: { agents: {} }, staleTasks: { tasks: [] } }), []);
});

test('tolerates missing/empty inputs', () => {
  assert.deepEqual(buildFindings({}), []);
});
