import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, ORDER, isValidTransition, applyTransition, canAdvance
} from '../src/board/task-state.js';

test('states are the v1 minimal lifecycle in order', () => {
  assert.deepEqual(ORDER, ['assigned', 'acknowledged', 'in-progress', 'done']);
  assert.equal(STATES.ASSIGNED, 'assigned');
  assert.equal(STATES.DONE, 'done');
});

test('only forward single-step transitions are valid', () => {
  assert.equal(isValidTransition('assigned', 'acknowledged'), true);
  assert.equal(isValidTransition('acknowledged', 'in-progress'), true);
  assert.equal(isValidTransition('in-progress', 'done'), true);
  assert.equal(isValidTransition('assigned', 'in-progress'), false);
  assert.equal(isValidTransition('in-progress', 'acknowledged'), false);
  assert.equal(isValidTransition('done', 'done'), false);
  assert.equal(isValidTransition('done', 'in-progress'), false);
});

test('canAdvance enforces only the `to` agent may advance', () => {
  const task = { from: 'agentA', to: 'agentB', state: 'assigned' };
  assert.equal(canAdvance(task, 'agentB').ok, true);
  const denied = canAdvance(task, 'agentA');
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'not_assignee');
});

test('applyTransition returns a new record with appended history (no mutation)', () => {
  const task = {
    id: 't1', from: 'agentA', to: 'agentB', state: 'assigned',
    history: [{ state: 'assigned', at: '2026-06-15T00:00:00.000Z', by: 'agentA' }]
  };
  const next = applyTransition(task, {
    to: 'acknowledged', by: 'agentB', at: '2026-06-15T01:00:00.000Z'
  });
  assert.equal(next.ok, true);
  assert.equal(next.task.state, 'acknowledged');
  assert.equal(next.task.history.length, 2);
  assert.deepEqual(next.task.history[1], { state: 'acknowledged', at: '2026-06-15T01:00:00.000Z', by: 'agentB' });
  assert.equal(task.state, 'assigned');
  assert.equal(task.history.length, 1);
});

test('applyTransition records result on done', () => {
  const task = { id: 't1', from: 'agentA', to: 'agentB', state: 'in-progress', history: [] };
  const next = applyTransition(task, { to: 'done', by: 'agentB', at: '2026-06-15T02:00:00.000Z', result: 'Shipped it.' });
  assert.equal(next.ok, true);
  assert.equal(next.task.result, 'Shipped it.');
});

test('applyTransition rejects an invalid transition as data (never throws)', () => {
  const task = { id: 't1', from: 'agentA', to: 'agentB', state: 'assigned', history: [] };
  const next = applyTransition(task, { to: 'done', by: 'agentB', at: '2026-06-15T02:00:00.000Z' });
  assert.equal(next.ok, false);
  assert.equal(next.error, 'invalid_transition');
});
