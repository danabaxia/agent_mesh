import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundDescription, describeFolder } from '../src/description.js';

test('boundDescription normalizes whitespace and truncates', () => {
  assert.equal(boundDescription('hello\n\nworld', 100), 'hello world');
  assert.equal(boundDescription('x'.repeat(40), 20), 'xxxxx... [truncated]');
});

test('describeFolder reads AGENT.md as bounded data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-desc-'));
  await writeFile(join(root, 'AGENT.md'), 'Capabilities: ui, tests.\nOwns frontend.');
  const self = await describeFolder(root);
  assert.equal(self.description, 'Capabilities: ui, tests. Owns frontend.');
  assert.deepEqual(self.capabilities, ['ui', 'tests']);
});
