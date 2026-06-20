import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIdeas, extractMarkers, planIdeaIssues, analystMarker } from '../src/dev-society/analyst-ideas.js';

const fenced = (obj) => '```json\n' + JSON.stringify(obj) + '\n```';

test('parseIdeas extracts a valid json block', () => {
  const out = 'blah\n' + fenced([{ title: 'Speed up routing', body: 'because X', dedupeKey: 'routing-latency', labels: ['perf'] }]) + '\nmore';
  const ideas = parseIdeas(out);
  assert.equal(ideas.length, 1);
  assert.equal(ideas[0].dedupeKey, 'routing-latency');
});

test('parseIdeas returns [] for absent/malformed blocks (never throws)', () => {
  assert.deepEqual(parseIdeas('no json here'), []);
  assert.deepEqual(parseIdeas('```json\n{not valid\n```'), []);
  assert.deepEqual(parseIdeas(''), []);
  assert.deepEqual(parseIdeas(null), []);
});

test('parseIdeas drops items with bad dedupeKey or empty title', () => {
  const out = fenced([
    { title: 'ok', body: 'b', dedupeKey: 'good-key' },
    { title: '', body: 'b', dedupeKey: 'empty-title' },
    { title: 'bad key', body: 'b', dedupeKey: 'Has Spaces!' },
  ]);
  const ideas = parseIdeas(out);
  assert.deepEqual(ideas.map((i) => i.dedupeKey), ['good-key']);
});

test('extractMarkers pulls keys from issue bodies', () => {
  const set = extractMarkers([
    { body: 'text\n<!-- analyst-idea:routing-latency -->' },
    { body: '<!-- analyst-idea:eval-flake -->\nmore' },
    { body: 'no marker' },
  ]);
  assert.ok(set.has('routing-latency') && set.has('eval-flake'));
  assert.equal(set.size, 2);
});

test('planIdeaIssues dedups by marker, caps at 2, labels idea+scanLabel', () => {
  const ideas = [
    { title: 'A', body: 'a', dedupeKey: 'k1' },
    { title: 'B', body: 'b', dedupeKey: 'k2' },
    { title: 'C', body: 'c', dedupeKey: 'k3' },
  ];
  const plan = planIdeaIssues(ideas, new Set(['k2']), {});
  assert.equal(plan.length, 2); // k2 deduped, then capped at 2 (k1, k3)
  assert.deepEqual(plan.map((p) => p.action), ['create', 'create']);
  for (const p of plan) {
    assert.deepEqual(p.labels, ['idea', 'generated:analyst']);
    assert.ok(p.body.startsWith(analystMarker(p.marker.match(/analyst-idea:([a-z0-9:_-]+)/)[1])));
  }
});

test('planIdeaIssues never throws on empty input', () => {
  assert.deepEqual(planIdeaIssues([], new Set(), {}), []);
  assert.deepEqual(planIdeaIssues(undefined, undefined, undefined), []);
});
