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

test('describeFolder reads an adequate AGENT.md as bounded data (precedence)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-desc-'));
  const agentMd = 'Capabilities: ui, tests. Owns the frontend rendering layer and ' +
    'component library for the mesh dashboard.';
  await writeFile(join(root, 'AGENT.md'), agentMd);
  const self = await describeFolder(root);
  assert.equal(self.description, agentMd);
  assert.deepEqual(self.capabilities, ['ui', 'tests']);
});

test('readAgentDescription auto-harvests a fingerprint when AGENT.md is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-fp-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'my-lib',
    description: 'A JSON schema validator',
    main: 'src/index.js'
  }));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'test'));
  await writeFile(join(root, 'src', 'index.js'), '');
  await writeFile(join(root, 'README.md'), '');

  const desc = await readAgentDescription(root);
  assert.match(desc, /^\[auto\] /);
  assert.match(desc, /name: my-lib/);
  assert.match(desc, /A JSON schema validator/);
  assert.match(desc, /entry: src\/index\.js/);
  assert.match(desc, /dirs: src,test/);   // sorted, package.json/README are files
  assert.match(desc, /\.json:1/);          // package.json counted by extension
  assert.match(desc, /\.md:1/);            // README.md counted by extension
});

test('readAgentDescription falls back to folder name and skips noise dirs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-bare-'));
  await mkdir(join(root, 'node_modules'));
  await mkdir(join(root, 'lib'));
  const desc = await readAgentDescription(root, 'widget');
  assert.match(desc, /^\[auto\] name: widget/);
  assert.match(desc, /dirs: lib/);
  assert.doesNotMatch(desc, /node_modules/);
});

test('readAgentDescription supplements a thin AGENT.md instead of discarding it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-thin-'));
  await writeFile(join(root, 'AGENT.md'), 'Owns frontend.');
  await mkdir(join(root, 'src'));
  const desc = await readAgentDescription(root, 'frontend');
  assert.match(desc, /^Owns frontend\. \[auto\] /); // human text kept, fingerprint appended
  assert.match(desc, /dirs: src/);
});
