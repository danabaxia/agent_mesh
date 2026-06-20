import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileObserved } from '../src/dashboard/public/graph-observed.js';

test('adds a brand-new observed edge', () => {
  const { add, update, remove } = reconcileObserved([], [{ from: 'a', to: 'b', active: true }]);
  assert.deepEqual(add, [{ from: 'a', to: 'b', active: true }]);
  assert.deepEqual(update, []);
  assert.deepEqual(remove, []);
});

test('updates an edge that persists across reconciles', () => {
  const { add, update, remove } = reconcileObserved(['a|b'], [{ from: 'a', to: 'b', active: false }]);
  assert.deepEqual(add, []);
  assert.deepEqual(update, [{ key: 'a|b', active: false }]);
  assert.deepEqual(remove, []);
});

test('removes an edge that aged out of the window', () => {
  const { add, update, remove } = reconcileObserved(['a|b'], []);
  assert.deepEqual(add, []);
  assert.deepEqual(update, []);
  assert.deepEqual(remove, ['a|b']);
});

test('directionality is preserved (a|b not equal to b|a)', () => {
  const { add, remove } = reconcileObserved(['a|b'], [{ from: 'b', to: 'a', active: true }]);
  assert.deepEqual(add, [{ from: 'b', to: 'a', active: true }]);
  assert.deepEqual(remove, ['a|b']);
});

test('mixed add/update/remove in one reconcile', () => {
  const prev = ['a|b', 'c|d'];
  const edges = [
    { from: 'a', to: 'b', active: true },   // update
    { from: 'e', to: 'f', active: false },  // add
  ];                                         // c|d → remove
  const { add, update, remove } = reconcileObserved(prev, edges);
  assert.deepEqual(add, [{ from: 'e', to: 'f', active: false }]);
  assert.deepEqual(update, [{ key: 'a|b', active: true }]);
  assert.deepEqual(remove, ['c|d']);
});

test('coerces active to boolean', () => {
  const { add, update } = reconcileObserved([], [{ from: 'a', to: 'b' }]);
  assert.equal(add[0].active, false);
  const r2 = reconcileObserved(['a|b'], [{ from: 'a', to: 'b', active: 1 }]);
  assert.equal(r2.update[0].active, true);
});

test('empty in, empty out', () => {
  assert.deepEqual(reconcileObserved([], []), { add: [], update: [], remove: [] });
});
