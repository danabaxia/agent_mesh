import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMemoryPr } from '../src/automerge/memory-classify.js';

const validQuick = JSON.stringify({});   // empty store is valid shape
const okPr = { number: 7, isCrossRepository: false,
  files: ['dev-mesh/coder/memory/quick.json', 'dev-mesh/coder/memory/MEMORY.md'],
  quickJsonContents: [validQuick] };

test('valid same-repo memory PR → merge-candidate', () => {
  assert.deepEqual(classifyMemoryPr(okPr), { state: 'merge-candidate', reason: null });
});
test('fork → needs-human/fork', () => {
  assert.deepEqual(classifyMemoryPr({ ...okPr, isCrossRepository: true }), { state: 'needs-human', reason: 'fork' });
});
test('non-memory path → needs-human/non-memory-path', () => {
  assert.deepEqual(classifyMemoryPr({ ...okPr, files: ['src/index.js'] }), { state: 'needs-human', reason: 'non-memory-path' });
});
test('invalid quick.json → needs-human/invalid-quick-json', () => {
  const r = classifyMemoryPr({ ...okPr, quickJsonContents: ['{ not json'] });
  assert.equal(r.state, 'needs-human'); assert.equal(r.reason, 'invalid-quick-json');
});
