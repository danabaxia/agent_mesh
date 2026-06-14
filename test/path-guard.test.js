import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractToolPaths, isPathInsideRoot, isProtectedConfigPath } from '../src/path-guard.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('isPathInsideRoot accepts local paths and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-guard-'));
  await writeFile(join(root, 'file.txt'), 'x');

  assert.equal(await isPathInsideRoot(root, 'file.txt'), true);
  assert.equal(await isPathInsideRoot(root, '../outside.txt'), false);
});

test('isPathInsideRoot resolves symlinks before authorization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-guard-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-mesh-outside-'));
  await mkdir(join(outside, 'target'));
  await symlink(join(outside, 'target'), join(root, 'linked'));

  assert.equal(await isPathInsideRoot(root, 'linked/file.txt'), false);
});

test('isPathInsideRoot preserves missing nested path segments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-guard-'));
  assert.equal(await isPathInsideRoot(root, 'new/dir/file.txt'), true);
  assert.equal(await isPathInsideRoot(root, '../new/dir/file.txt'), false);
});

test('extractToolPaths handles every structured write tool and nothing else', () => {
  assert.deepEqual(extractToolPaths('Write', { file_path: 'a.txt' }), ['a.txt']);
  assert.deepEqual(extractToolPaths('Edit', { file_path: 'a.txt' }), ['a.txt']);
  assert.deepEqual(extractToolPaths('MultiEdit', { file_path: 'a.txt', edits: [] }), ['a.txt']);
  // NotebookEdit's path argument is notebook_path, not file_path.
  assert.deepEqual(extractToolPaths('NotebookEdit', { notebook_path: 'nb.ipynb', new_source: 'x' }), [
    'nb.ipynb'
  ]);
  assert.deepEqual(extractToolPaths('NotebookEdit', { file_path: 'wrong.ipynb' }), []);
  assert.deepEqual(extractToolPaths('Bash', { command: 'echo x > a' }), []);
  assert.deepEqual(extractToolPaths('SomeUnknownTool', { file_path: 'a.txt' }), []);
});

test('isProtectedConfigPath flags trusted config inside the root, allows runtime/work paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-protected-'));
  for (const p of [
    'agent.json', '.mcp.json', 'registry.json',
    'prompts/system.md', 'tools/book-search/server.mjs', 'memory/profile.md',
    'workflows/ask.md', 'skills/x/SKILL.md', 'prompts', 'tools'
  ]) {
    assert.equal(await isProtectedConfigPath(root, p), true, `${p} should be protected`);
  }
  // Runtime/state, logs, data, ad-hoc work, and AGENT.md (public, never obeyed) are writable.
  for (const p of ['state/cache/x', 'logs/run.json', 'books.json', 'output.txt', 'src/lib.js', 'AGENT.md']) {
    assert.equal(await isProtectedConfigPath(root, p), false, `${p} should not be protected`);
  }
  // Outside the root is not "protected config" — inside-root is a separate check.
  assert.equal(await isProtectedConfigPath(root, '../prompts/system.md'), false);
});

test('path-guard hook allows inside writes and blocks outside writes with exit code 2', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-hook-'));
  const allowed = execHook(root, {
    tool_name: 'Write',
    tool_input: { file_path: 'inside.txt' }
  });
  assert.equal(allowed.status, 0);

  const blocked = execHook(root, {
    tool_name: 'Write',
    tool_input: { file_path: '../outside.txt' }
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Write denied outside agent-mesh root/);

  const log = await readFile(join(root, '.agent-mesh/logs/path-guard-denials.jsonl'), 'utf8');
  assert.match(log, /Write denied outside agent-mesh root/);
});

test('path-guard hook denies a write through an in-root symlink that escapes the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-hook-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-mesh-outside-'));
  await mkdir(join(outside, 'target'));
  // `linked` lives inside root but resolves outside it.
  await symlink(join(outside, 'target'), join(root, 'linked'));

  const blocked = execHook(root, {
    tool_name: 'Write',
    tool_input: { file_path: 'linked/escape.txt' }
  });
  assert.equal(blocked.status, 2, 'symlink escape must be denied through the real hook');
  assert.match(blocked.stderr, /Write denied outside agent-mesh root/);
});

test('path-guard hook fail-closes (deny) when the tool exposes no extractable path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-hook-'));

  // An unknown tool, or a NotebookEdit using the wrong key, yields no path.
  const unknown = execHook(root, { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /No canonicalizable path argument/);

  const notebook = execHook(root, { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'nb.ipynb' } });
  assert.equal(notebook.status, 0, 'NotebookEdit with notebook_path inside root is allowed');
});

test('path-guard hook denies a do-task write to protected agent config (Boundary 5)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-mesh-hook-'));

  const blocked = execHook(root, {
    tool_name: 'Write',
    tool_input: { file_path: 'prompts/system.md' }
  });
  assert.equal(blocked.status, 2, 'rewriting the agent identity must be denied');
  assert.match(blocked.stderr, /Write denied to protected agent config/);

  // A non-config write inside the root is still allowed.
  const allowed = execHook(root, {
    tool_name: 'Write',
    tool_input: { file_path: 'state/scratch.txt' }
  });
  assert.equal(allowed.status, 0);
});

test('path-guard: .claude/settings.json under root is protected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-'));
  assert.equal(await isProtectedConfigPath(root, join(root, '.claude/settings.json')), true);
  assert.equal(await isProtectedConfigPath(root, join(root, '.claude/settings.local.json')), true);
  assert.equal(await isProtectedConfigPath(root, join(root, '.claude/agents/foo.md')), true);
});

test('path-guard: AGENT.md under root is NOT protected (data, not config)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pg-'));
  assert.equal(await isProtectedConfigPath(root, join(root, 'AGENT.md')), false);
});

function execHook(root, payload) {
  const result = spawnSync('node', ['hooks/path-guard.js'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      AGENT_MESH_ROOT: root,
      AGENT_MESH_HOOK_LOG: join(root, '.agent-mesh/logs/path-guard-denials.jsonl')
    },
    input: JSON.stringify(payload),
    encoding: 'utf8'
  });
  if (result.error) throw result.error;
  return result;
}
