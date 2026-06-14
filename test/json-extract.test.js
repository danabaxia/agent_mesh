import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFirstJson } from '../src/json-extract.js';

test('extracts the first balanced JSON object from prose / fences', () => {
  assert.deepEqual(extractFirstJson('Sure!\n```json\n{"a":{"b":1}}\n```\ntrailing {junk'), { a: { b: 1 } });
});

test('returns null on no object / unbalanced / invalid JSON', () => {
  assert.equal(extractFirstJson('no braces here'), null);
  assert.equal(extractFirstJson('{"a": '), null);
  assert.equal(extractFirstJson('{a: broken}'), null);
});
