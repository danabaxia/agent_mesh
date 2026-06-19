import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatEvent, filterEvents } from '../src/activity-log/event.js';

const NOW = new Date('2026-06-19T12:00:00Z');
const now = () => NOW;

test('formatEvent: normalizes, stamps ts, defaults level, drops empty optionals', () => {
  const e = formatEvent({ source: 'daemon', type: 'issue.picked', summary: 'took #98' }, { now });
  assert.equal(e.ts, '2026-06-19T12:00:00.000Z');
  assert.equal(e.source, 'daemon');
  assert.equal(e.type, 'issue.picked');
  assert.equal(e.level, 'info');
  assert.equal(e.summary, 'took #98');
  assert.equal('agent' in e, false);
  assert.equal('ref' in e, false);
  assert.equal('detail' in e, false);
});

test('formatEvent: keeps agent/ref/detail, validates level, caps summary', () => {
  const e = formatEvent({ source: 'gh-activity', agent: 'coder', type: 'ci.run', level: 'warn', summary: 'x'.repeat(500), ref: 'run#5', detail: { status: 'success' } }, { now });
  assert.equal(e.agent, 'coder');
  assert.equal(e.level, 'warn');
  assert.equal(e.summary.length, 240);
  assert.equal(e.ref, 'run#5');
  assert.deepEqual(e.detail, { status: 'success' });
});

test('formatEvent: bad level → info; missing fields → safe defaults', () => {
  const e = formatEvent({ level: 'screaming' }, { now });
  assert.equal(e.level, 'info');
  assert.equal(e.source, 'daemon');
  assert.equal(e.type, 'event');
  assert.equal(e.summary, '');
});

test('filterEvents: by agent/type/level/since, combined', () => {
  const evs = [
    { ts: '2026-06-19T10:00:00Z', agent: 'coder', type: 'delegate.done', level: 'info' },
    { ts: '2026-06-19T11:00:00Z', agent: 'reviewer', type: 'delegate.done', level: 'info' },
    { ts: '2026-06-18T09:00:00Z', agent: 'coder', type: 'task.error', level: 'error' },
  ];
  assert.equal(filterEvents(evs, { agent: 'coder' }).length, 2);
  assert.equal(filterEvents(evs, { type: 'delegate.done' }).length, 2);
  assert.equal(filterEvents(evs, { level: 'error' }).length, 1);
  assert.equal(filterEvents(evs, { since: '2026-06-19T00:00:00Z' }).length, 2);
  assert.equal(filterEvents(evs, { agent: 'coder', since: '2026-06-19T00:00:00Z' }).length, 1);
  assert.equal(filterEvents(evs, {}).length, 3);
  assert.deepEqual(filterEvents(null, {}), []);
});
