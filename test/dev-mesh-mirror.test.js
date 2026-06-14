// test/dev-mesh-mirror.test.js — pure backlog markdown mirror (spec §5.4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBacklog } from '../src/dev-mesh/backlog-mirror.js';

const issue = (number, title, labels, assignees = []) => ({ number, title, labels, assignees });

const SNAPSHOT = [
  issue(7, 'Add retry budget', ['approved']),
  issue(3, 'Idea: cache prefetch', ['idea']),
  issue(5, 'Wire dashboard panel', ['in-progress'], ['dev-bot']),
  issue(9, 'Old thing', ['done']),
  issue(2, 'No labels here', [])
];

test('renders sections in lifecycle order with issues sorted by number', () => {
  const md = renderBacklog(SNAPSHOT);
  // Section order: Ideas before Approved before In progress before Done before Unlabeled.
  const order = ['## Ideas', '## Approved (ready)', '## In progress', '## Done', '## Unlabeled'];
  let last = -1;
  for (const h of order) {
    const at = md.indexOf(h);
    assert.ok(at > last, `${h} must appear in order`);
    last = at;
  }
});

test('lists issues with number, title, and assignee suffix', () => {
  const md = renderBacklog(SNAPSHOT);
  assert.match(md, /- #3 Idea: cache prefetch/);
  assert.match(md, /- #7 Add retry budget/);
  assert.match(md, /- #5 Wire dashboard panel _\(@dev-bot\)_/);
  assert.match(md, /- #2 No labels here/);   // unlabeled bucket
});

test('totals line reflects per-state counts', () => {
  const md = renderBacklog(SNAPSHOT);
  assert.match(md, /\*\*Totals:\*\*/);
  assert.match(md, /Ideas: 1/);
  assert.match(md, /Approved \(ready\): 1/);
});

test('deterministic: same snapshot renders identically', () => {
  assert.equal(renderBacklog(SNAPSHOT), renderBacklog(SNAPSHOT.slice().reverse()));
});

test('empty backlog renders the header + (empty) totals, no sections', () => {
  const md = renderBacklog([]);
  assert.match(md, /# Backlog/);
  assert.match(md, /\*\*Totals:\*\* \(empty\)/);
  assert.doesNotMatch(md, /^## /m);
});
