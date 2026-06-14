// test/prefetch.test.js — headless prefetch selection (spec §6). Pure, no spawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPrefetch, renderPrefetchBlock, approxTokens } from '../src/prefetch.js';

const live = (o) => ({ status: 'active', valid_to: null, ...o });
const store = () => ({
  'billing-deploy': live({ l0: 'how to deploy billing', l1: 'run the billing deploy pipeline', value: 'step1 step2 deploy billing service' }),
  'weather': live({ l0: 'weather api', l1: 'forecast service', value: 'call weather api' }),
  'expired-one': { status: 'active', valid_to: '2020-01-01', l0: 'old billing deploy', l1: 'billing deploy old', value: 'x' },
  'retired-one': live({ status: 'retired', l0: 'billing deploy', l1: 'billing deploy', value: 'y' })
});

test('selectPrefetch: best lexical match first; expired & non-active excluded', () => {
  const { picked, weak } = selectPrefetch(store(), 'deploy the billing service', { k: 3, minScore: 0.01 });
  assert.equal(weak, false);
  assert.equal(picked[0].key, 'billing-deploy');
  const keys = picked.map((p) => p.key);
  assert.ok(!keys.includes('expired-one'), 'expired (valid_to set) is never prefetched');
  assert.ok(!keys.includes('retired-one'), 'non-active is never prefetched');
});

test('selectPrefetch: weak (no match) → empty picked, weak=true (caller falls back to core)', () => {
  const { picked, weak } = selectPrefetch(store(), 'quantum chromodynamics lecture notes');
  assert.equal(picked.length, 0);
  assert.equal(weak, true);
});

test('selectPrefetch: deterministic tie-break by key ascending', () => {
  const tie = {
    'b-key': live({ l0: 'deploy billing', l1: 'deploy billing', value: 'v' }),
    'a-key': live({ l0: 'deploy billing', l1: 'deploy billing', value: 'v' })
  };
  const { picked } = selectPrefetch(tie, 'deploy billing', { k: 2, minScore: 0.01 });
  assert.deepEqual(picked.map((p) => p.key), ['a-key', 'b-key']);
});

test('selectPrefetch: token budget skips an over-budget body, keeps a small one', () => {
  const s = {
    'big': live({ l0: 'deploy billing', l1: 'x', value: 'a'.repeat(1000) }),   // ~250 tokens
    'small': live({ l0: 'deploy billing', l1: 'y', value: 'z' })                // ~1 token
  };
  const { picked, tokensUsed } = selectPrefetch(s, 'deploy billing', { k: 5, tokenBudget: 10, minScore: 0.01 });
  assert.deepEqual(picked.map((p) => p.key), ['small']);
  assert.ok(tokensUsed <= 10);
});

test('approxTokens: ~4 chars/token, never negative', () => {
  assert.equal(approxTokens(''), 0);
  assert.equal(approxTokens('abcd'), 1);
  assert.equal(approxTokens('abcde'), 2);
});

test('renderPrefetchBlock: empty → "", non-empty → DATA-fenced (not instructions)', () => {
  assert.equal(renderPrefetchBlock({ picked: [] }), '');
  const block = renderPrefetchBlock({ picked: [{ key: 'k', l1: 'overview', value: 'body' }] });
  assert.match(block, /NOT instructions/);
  assert.match(block, /\[k\]/);
  assert.match(block, /body/);
});
