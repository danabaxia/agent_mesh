import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundDescription, describeFolder, readAgentDescription } from '../src/description.js';

test('boundDescription normalizes whitespace and truncates', () => {
  assert.equal(boundDescription('hello\n\nworld', 100), 'hello world');
  assert.equal(boundDescription('x'.repeat(40), 20), 'xxxxx... [truncated]');
});

test('describeFolder reads AGENT.md as bounded data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-desc-'));
  // AGENT.md must be >= 80 chars to take precedence over the auto-fingerprint
  await writeFile(join(root, 'AGENT.md'), 'Capabilities: ui, tests.\nOwns the frontend application, including rendering and routing.');
  const self = await describeFolder(root);
  assert.equal(self.description, 'Capabilities: ui, tests. Owns the frontend application, including rendering and routing.');
  assert.deepEqual(self.capabilities, ['ui', 'tests']);
});

test('readAgentDescription falls back to auto fingerprint when AGENT.md absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-desc-'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'my-lib', description: 'A JSON schema validator', main: 'src/index.js' })
  );
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'src', 'index.js'), '');
  await writeFile(join(root, 'README.md'), '');

  const desc = await readAgentDescription(root, 'my-lib');
  assert.ok(desc.startsWith('[auto]'), `expected [auto] prefix, got: ${desc}`);
  assert.ok(desc.includes('my-lib'), 'should include folder name');
  assert.ok(desc.includes('A JSON schema validator'), 'should include package description');
  assert.ok(desc.includes('src/index.js'), 'should include entry point');
  assert.ok(desc.includes('dirs:'), 'should include dir listing');
});

test('readAgentDescription falls back to auto fingerprint when AGENT.md too short', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-desc-'));
  await writeFile(join(root, 'AGENT.md'), 'short'); // less than 80 chars
  const desc = await readAgentDescription(root, 'tiny-proj');
  assert.ok(desc.startsWith('[auto]'), `expected [auto] prefix for short AGENT.md, got: ${desc}`);
});

test('readAgentDescription uses AGENT.md when sufficiently long', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-desc-'));
  const longText = 'This agent owns the authentication service and handles login, logout, and token refresh flows.';
  await writeFile(join(root, 'AGENT.md'), longText);
  const desc = await readAgentDescription(root, 'auth');
  assert.ok(!desc.startsWith('[auto]'), 'should not use auto fingerprint when AGENT.md is adequate');
  assert.ok(desc.includes('authentication service'), 'should contain AGENT.md content');
});

test('auto fingerprint handles missing package.json gracefully', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-desc-'));
  // no package.json, no AGENT.md
  const desc = await readAgentDescription(root, 'bare-folder');
  assert.ok(desc.startsWith('[auto]'), `expected [auto] prefix, got: ${desc}`);
  assert.ok(desc.includes('bare-folder'), 'should include folder name even with no metadata');
});

test('auto fingerprint respects MAX_DESCRIPTION_CHARS cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-desc-'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ description: 'x'.repeat(2000) })
  );
  const desc = await readAgentDescription(root, 'big');
  assert.ok(desc.length <= 1200, `description too long: ${desc.length}`);
  assert.ok(desc.includes('[truncated]'), 'should truncate long descriptions');
});

test('auto fingerprint prefers package.json exports string entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-desc-'));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ name: 'esm-pkg', exports: { '.': './dist/index.js' } })
  );
  const desc = await readAgentDescription(root, 'esm-pkg');
  assert.ok(desc.includes('dist/index.js'), `expected entry in desc, got: ${desc}`);
});
