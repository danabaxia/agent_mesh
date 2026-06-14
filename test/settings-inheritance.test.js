import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings, readLayer, resolveAuthorLayerPaths } from '../src/settings-merge.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const overlayAsk = { disableAllHooks: false, hooks: {}, env: { AGENT_MESH_ROOT: '/r' } };

test('settings-merge: non-allowlisted top-level keys dropped', () => {
  const out = mergeSettings(
    [{ apiKeyHelper: '/bin/sh', statusLine: { command: '/bin/sh' }, fileSuggestion: { command: '/bin/sh' }, theme: 'dark' }],
    overlayAsk
  );
  assert.equal(out.apiKeyHelper, undefined);
  assert.equal(out.statusLine, undefined);
  assert.equal(out.fileSuggestion, undefined);
  assert.equal(out.theme, undefined);
});

test('settings-merge: author hooks dropped (allowlist)', () => {
  const out = mergeSettings(
    [{ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'evil' }] }] } }],
    overlayAsk
  );
  assert.deepEqual(out.hooks, {}); // overlay's empty hooks (ask) — author's hooks gone
});

test('settings-merge: overlay disableAllHooks always wins (false)', () => {
  const out = mergeSettings([{ disableAllHooks: true }], overlayAsk);
  assert.equal(out.disableAllHooks, false);
});

test('settings-merge: env reserved prefix + keys dropped, case-insensitive', () => {
  const out = mergeSettings(
    [{
      env: {
        AGENT_MESH_ROOT: '/evil',
        AGENT_MESH_NEWKEY: 'x',
        PATH: '/evil:/bin',
        Path: '/evil2:/bin',  // Windows aliasing
        path: '/evil3:/bin',
        NODE_OPTIONS: '--require=/evil.js',
        Node_Options: '--require=/evil2.js',
        NODE_PATH: '/evil',
        LD_PRELOAD: '/evil.so',
        LD_preload: '/evil2.so',
        LD_LIBRARY_PATH: '/evil',
        DYLD_INSERT_LIBRARIES: '/evil',
        dyld_library_path: '/evil',
        MY_OWN_VAR: 'kept',
      },
    }],
    { disableAllHooks: false, hooks: {}, env: { AGENT_MESH_ROOT: '/safe' } }
  );
  assert.equal(out.env.AGENT_MESH_ROOT, '/safe');
  assert.equal(out.env.AGENT_MESH_NEWKEY, undefined);
  assert.equal(out.env.PATH, undefined);
  assert.equal(out.env.Path, undefined);
  assert.equal(out.env.path, undefined);
  assert.equal(out.env.NODE_OPTIONS, undefined);
  assert.equal(out.env.Node_Options, undefined);
  assert.equal(out.env.NODE_PATH, undefined);
  assert.equal(out.env.LD_PRELOAD, undefined);
  assert.equal(out.env.LD_preload, undefined);
  assert.equal(out.env.LD_LIBRARY_PATH, undefined);
  assert.equal(out.env.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(out.env.dyld_library_path, undefined);
  assert.equal(out.env.MY_OWN_VAR, 'kept');
});

test('settings-merge: env merged across layers, later wins', () => {
  const out = mergeSettings(
    [{ env: { A: '1', B: '1' } }, { env: { B: '2', C: '2' } }, { env: { C: '3' } }],
    { disableAllHooks: false, hooks: {}, env: { AGENT_MESH_ROOT: '/r' } }
  );
  assert.equal(out.env.A, '1');
  assert.equal(out.env.B, '2');
  assert.equal(out.env.C, '3');
  assert.equal(out.env.AGENT_MESH_ROOT, '/r');
});

test('settings-merge: permissions concat+dedupe across allow/deny/ask, user→project→local order', () => {
  const layers = [
    { permissions: { allow: ['Read(*.md)'], deny: ['Write(/etc/**)'], ask: ['Bash(rm *)'] } },
    { permissions: { allow: ['Read(*.json)'], deny: ['Write(/etc/**)'] } }, // duplicate deny
    { permissions: { allow: ['Read(*.md)'], deny: ['Write(/tmp/secret)'] } }, // duplicate allow
  ];
  const overlay = { disableAllHooks: false, hooks: {}, env: { AGENT_MESH_ROOT: '/r' } };
  const out = mergeSettings(layers, overlay);
  assert.deepEqual(out.permissions.allow, ['Read(*.md)', 'Read(*.json)']);
  assert.deepEqual(out.permissions.deny, ['Write(/etc/**)', 'Write(/tmp/secret)']);
  assert.deepEqual(out.permissions.ask, ['Bash(rm *)']);
});

test('settings-merge: overlay permissions appended last verbatim, no dedupe against overlay', () => {
  const layers = [{ permissions: { deny: ['X'] } }];
  const overlay = {
    disableAllHooks: false, hooks: {}, env: { AGENT_MESH_ROOT: '/r' },
    permissions: { deny: ['X', 'Y'] },
  };
  const out = mergeSettings(layers, overlay);
  // Author 'X' first (from layer), then overlay's 'X','Y' appended verbatim — overlay rules are trusted.
  assert.deepEqual(out.permissions.deny, ['X', 'X', 'Y']);
});

test('settings-merge: enabledPlugins + extraKnownMarketplaces deep-merge, later layer wins per key', () => {
  const layers = [
    { enabledPlugins: { a: true }, extraKnownMarketplaces: { m1: { source: { repo: 'org/m1' } } } },
    { enabledPlugins: { b: true } },
    { enabledPlugins: { a: false }, extraKnownMarketplaces: { m2: { source: { repo: 'org/m2' } } } },
  ];
  const overlay = { disableAllHooks: false, hooks: {}, env: { AGENT_MESH_ROOT: '/r' } };
  const out = mergeSettings(layers, overlay);
  assert.deepEqual(out.enabledPlugins, { a: false, b: true });
  assert.deepEqual(out.extraKnownMarketplaces, {
    m1: { source: { repo: 'org/m1' } },
    m2: { source: { repo: 'org/m2' } },
  });
});

test('settings-merge: empty enabledPlugins not added to result', () => {
  const out = mergeSettings([{}], { disableAllHooks: false, hooks: {}, env: { AGENT_MESH_ROOT: '/r' } });
  assert.equal(out.enabledPlugins, undefined);
  assert.equal(out.extraKnownMarketplaces, undefined);
});

test('readLayer: missing → reason "missing"', async () => {
  const r = await readLayer('/does/not/exist');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
});

test('readLayer: malformed → reason "malformed", message present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-'));
  const p = join(dir, 's.json');
  await writeFile(p, '{not-json', 'utf8');
  const r = await readLayer(p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'malformed');
  assert.ok(r.message);
});

test('readLayer: valid JSON → ok with value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sm-'));
  const p = join(dir, 's.json');
  await writeFile(p, JSON.stringify({ enabledPlugins: { a: true } }), 'utf8');
  const r = await readLayer(p);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { enabledPlugins: { a: true } });
});

test('resolveAuthorLayerPaths: uses claudeEnv.HOME for ~/.claude, root for project + local', () => {
  const paths = resolveAuthorLayerPaths('/peer/root', { HOME: '/fake/home' });
  // path.join yields '\\' separators on Windows; normalize for comparison.
  const s = (x) => String(x).replace(/\\/g, '/');
  assert.equal(s(paths.user), '/fake/home/.claude/settings.json');
  assert.equal(s(paths.project), '/peer/root/.claude/settings.json');
  assert.equal(s(paths.local), '/peer/root/.claude/settings.local.json');
});
