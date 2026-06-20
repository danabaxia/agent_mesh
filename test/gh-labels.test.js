import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureLabels } from '../src/gh-labels.js';

function fakeGh({ failOn = () => false } = {}) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (failOn(args)) throw new Error('label already exists');
    return '';
  };
  return { gh, calls };
}

test('creates each unique label exactly once (dedup)', async () => {
  const { gh, calls } = fakeGh();
  const res = await ensureLabels(gh, ['idea', 'generated:analyst', 'idea']);
  assert.deepEqual(res.attempted, ['idea', 'generated:analyst']);
  const created = calls.filter((a) => a[0] === 'label' && a[1] === 'create').map((a) => a[2]);
  assert.deepEqual(created, ['idea', 'generated:analyst']);
});

test('passes --repo and --color when provided', async () => {
  const { gh, calls } = fakeGh();
  await ensureLabels(gh, ['regression'], { repo: 'o/r', color: 'd73a4a' });
  assert.deepEqual(calls[0], ['label', 'create', 'regression', '--color', 'd73a4a', '--repo', 'o/r']);
});

test('never throws when a label already exists (idempotent)', async () => {
  const { gh, calls } = fakeGh({ failOn: () => true });
  await assert.doesNotReject(ensureLabels(gh, ['idea', 'bug']));
  // it still ATTEMPTS each one
  assert.equal(calls.filter((a) => a[1] === 'create').length, 2);
});

test('ignores empty/non-string labels and an empty list', async () => {
  const { gh, calls } = fakeGh();
  const res = await ensureLabels(gh, ['', null, undefined, 'ok', 123]);
  assert.deepEqual(res.attempted, ['ok']);
  assert.equal(calls.length, 1);
  await assert.doesNotReject(ensureLabels(gh, []));
  await assert.doesNotReject(ensureLabels(gh, undefined));
});
