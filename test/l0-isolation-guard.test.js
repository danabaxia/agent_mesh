import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
test('no devDep-requiring test files at the top level of test/', () => {
  const top = readdirSync('test');
  const forbidden = top.filter((f) => f.endsWith('.component.test.js') || f.endsWith('.spec.js'));
  assert.deepEqual(forbidden, [], `these must move under test/ui or test/e2e: ${forbidden.join(', ')}`);
});
