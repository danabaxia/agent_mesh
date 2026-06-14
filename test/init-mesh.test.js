import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMesh } from '../src/builder/init-mesh.js';
import { validateManifest } from '../src/builder/manifest.js';

// ---------------------------------------------------------------------------
// initMesh
// ---------------------------------------------------------------------------

test('initMesh creates mesh.json with a valid manifest', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'initmesh-'));
  const created = await initMesh(tmp);

  // mesh.json must exist and parse
  const raw = JSON.parse(await readFile(join(tmp, 'mesh.json'), 'utf8'));
  assert.equal(raw['x-agentmesh-generated'], true);
  assert.equal(raw.meshVersion, '0.1.0');
  assert.ok(Array.isArray(raw.agents));
  assert.equal(raw.agents.length, 0);

  // must pass validateManifest
  const { ok, errors } = validateManifest(raw);
  assert.equal(ok, true, `validateManifest errors: ${errors.join(', ')}`);

  // mesh.json must appear in the created list
  assert.ok(created.some(p => p.endsWith('mesh.json')));
});

test('initMesh creates mesh/skills/citation-format/SKILL.md', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'initmesh-'));
  const created = await initMesh(tmp);

  const skillPath = join(tmp, 'mesh', 'skills', 'citation-format', 'SKILL.md');
  const content = await readFile(skillPath, 'utf8');

  // must have frontmatter
  assert.ok(content.includes('---'), 'SKILL.md must have frontmatter delimiters');
  assert.ok(content.includes('citation-format'), 'SKILL.md must mention skill name');
  assert.ok(content.includes('description:'), 'SKILL.md must have a description field');

  // path appears in created list
  assert.ok(created.some(p => p.includes('SKILL.md')));
});

test('initMesh creates mesh/mcp.json with empty mcpServers', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'initmesh-'));
  await initMesh(tmp);

  const mcpPath = join(tmp, 'mesh', 'mcp.json');
  const raw = JSON.parse(await readFile(mcpPath, 'utf8'));
  assert.deepEqual(raw, { mcpServers: {} });
});

test('initMesh creates README.md', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'initmesh-'));
  const created = await initMesh(tmp);

  const readmePath = join(tmp, 'README.md');
  const content = await readFile(readmePath, 'utf8');
  assert.ok(content.length > 0, 'README.md must not be empty');
  assert.ok(
    content.includes('mesh.json') || content.includes('agent-mesh'),
    'README.md must mention mesh.json or agent-mesh'
  );

  assert.ok(created.some(p => p.endsWith('README.md')));
});

test('initMesh refuses if mesh.json already exists', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'initmesh-exists-'));
  await writeFile(join(tmp, 'mesh.json'), JSON.stringify({ meshVersion: '0.1.0', agents: [] }));

  await assert.rejects(
    () => initMesh(tmp),
    (err) => {
      assert.ok(err.message.includes('mesh.json') || err.message.includes('already'));
      return true;
    }
  );
});

test('initMesh returns a list of all created paths', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'initmesh-paths-'));
  const created = await initMesh(tmp);

  assert.ok(Array.isArray(created), 'must return an array');
  assert.ok(created.length >= 4, `expected at least 4 created paths, got ${created.length}`);

  // Verify each path is absolute
  for (const p of created) {
    assert.ok(p.startsWith('/') || /^[A-Za-z]:\\/.test(p), `path must be absolute: ${p}`);
  }
});

test('initMesh creates nested directories with mkdir -p semantics', async () => {
  // Test that mesh/skills/ structure is created even from a brand-new empty dir
  const tmp = await mkdtemp(join(tmpdir(), 'initmesh-mkdirp-'));
  await initMesh(tmp);

  // mesh/skills/ must exist as a directory
  const skillsDir = join(tmp, 'mesh', 'skills');
  const s = await stat(skillsDir);
  assert.ok(s.isDirectory(), 'mesh/skills must be a directory');
});
