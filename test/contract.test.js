import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDelegateInput } from '../src/contract.js';

test('validateDelegateInput accepts the pinned public contract', () => {
  assert.deepEqual(validateDelegateInput({ mode: 'ask', task: 'inspect this' }), {
    ok: true,
    value: { mode: 'ask', task: 'inspect this' }
  });
});

test('validateDelegateInput rejects bad mode and empty task', () => {
  assert.equal(validateDelegateInput({ mode: 'write', task: 'x' }).ok, false);
  assert.equal(validateDelegateInput({ mode: 'ask', task: '' }).ok, false);
});

test('validateDelegateInput ignores anti-spoof bookkeeping fields', () => {
  assert.deepEqual(
    validateDelegateInput({
      mode: 'do',
      task: 'change local file',
      path: [],
      depth: 999
    }),
    {
      ok: true,
      value: { mode: 'do', task: 'change local file' }
    }
  );
});
