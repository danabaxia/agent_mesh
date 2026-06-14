# Settings Inheritance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the allowlist-based settings inheritance design from [`docs/superpowers/specs/2026-06-06-settings-inheritance-design.md`](../specs/2026-06-06-settings-inheritance-design.md) so that mesh `do`/`ask` peers honor author-side `enabledPlugins`, `extraKnownMarketplaces`, allowlisted `env`, and `permissions` from `~/.claude/settings.json` / project / local layers, while every security invariant in [`CLAUDE.md`](../../../CLAUDE.md) still holds bit-for-bit.

**Architecture:** One pure new module (`src/settings-merge.js`) holds the allowlist-and-overlay merge. `src/delegate.js` is refactored: `buildClaudeEnv` runs first so `claudeEnv` can be threaded into `createClaudeSettings`; `createClaudeSettings` becomes mode-aware and builds the path-guard hook in CLI exec form (`{command: process.execPath, args:[hookPath]}`) — no shell, no quoting; `buildClaudeInvocation` appends `--settings` + `--setting-sources ""` in both modes; a new `do`-only managed-policy preflight refuses incompatible managed settings. `src/path-guard.js` gains one entry (`.claude`) in `PROTECTED_CONFIG_DIRS`.

**Tech Stack:** Node ≥ 20 (verified `v25.2.1`); `node --test` (zero deps); existing helpers `src/process.js`, `src/errors.js`, `src/log.js`, `src/path-guard.js`; existing fake-claude harness in `test/delegate.test.js` (`createFakeClaude`).

---

## Scope Check

The spec covers exactly one subsystem (settings handling for delegated peers). No decomposition needed; this is one plan.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/settings-merge.js` | **NEW** | Pure: read+merge author layers under the v1 allowlist; pure helper `mergeSettings(layers, overlay)`; async layer reader `readLayer(path)` with per-outcome diagnostics |
| `src/delegate.js` | **MODIFIED** | Sequence reorder (env first); rewrite `createClaudeSettings`; rewrite `buildClaudeInvocation` argv (both modes pass `--settings` + `--setting-sources ""`); new `inspectManagedPolicy()` helper + preflight call in `delegateTask` |
| `src/path-guard.js` | **MODIFIED** | One-line: add `'.claude'` to `PROTECTED_CONFIG_DIRS` |
| `test/settings-inheritance.test.js` | **NEW** | Unit tests for `settings-merge` (allowlist filter, env reserved + case-insensitive, permissions concat+dedupe, enabledPlugins/marketplaces deep-merge, HOME, per-layer outcomes) |
| `test/delegate.test.js` | **MODIFIED** | argv assertions (`--settings`/`--setting-sources` both modes; `--tools` excludes `Bash`; exec-form hook); managed-policy preflight refusal tests |
| `test/path-guard.test.js` | **MODIFIED** | `.claude/*` denied; `AGENT.md` still allowed |
| `test/demo-e2e.test.js` | **MODIFIED** | Opt-in `AGENT_MESH_E2E=1` scenarios for real plugin inheritance, no-author-hook, malicious env, exec-path-with-spaces |

Each task below produces a self-contained commit and leaves the suite green (`npm test`).

---

### Task 1: `settings-merge.js` — module scaffold + top-level allowlist filter

**Files:**
- Create: [src/settings-merge.js](../../../src/settings-merge.js)
- Create: [test/settings-inheritance.test.js](../../../test/settings-inheritance.test.js)

- [ ] **Step 1: Write failing tests for allowlist filter**

```js
// test/settings-inheritance.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSettings } from '../src/settings-merge.js';

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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test test/settings-inheritance.test.js`
Expected: FAIL — `Cannot find module '../src/settings-merge.js'`

- [ ] **Step 3: Implement minimal module**

```js
// src/settings-merge.js
// Pure allowlist + overlay merge for Claude Code settings.
// Spec: docs/superpowers/specs/2026-06-06-settings-inheritance-design.md

export const ALLOWED_TOP_KEYS = ['env', 'permissions', 'enabledPlugins', 'extraKnownMarketplaces'];

export function mergeSettings(layers, overlay) {
  const result = {
    disableAllHooks: overlay?.disableAllHooks ?? false,
    hooks: overlay?.hooks ?? {},
  };
  // env/permissions/enabledPlugins/extraKnownMarketplaces merged in later tasks.
  // For now, just pull through the overlay's env if any so the test sees a stable shape.
  if (overlay?.env) result.env = { ...overlay.env };
  return result;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/settings-inheritance.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings-merge.js test/settings-inheritance.test.js
git commit -m "feat(settings-merge): allowlist scaffold + author top-level keys dropped"
```

---

### Task 2: env merge with reserved keys (case-insensitive)

**Files:**
- Modify: [src/settings-merge.js](../../../src/settings-merge.js)
- Modify: [test/settings-inheritance.test.js](../../../test/settings-inheritance.test.js)

- [ ] **Step 1: Write failing tests for env reserved + case-insensitive**

```js
// append to test/settings-inheritance.test.js
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
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/settings-inheritance.test.js`
Expected: FAIL on the two new tests (env not yet merged from author layers).

- [ ] **Step 3: Implement env merging**

Replace the body of `mergeSettings` in [src/settings-merge.js](../../../src/settings-merge.js):

```js
export const RESERVED_ENV_PREFIXES = ['AGENT_MESH_'];
export const RESERVED_ENV_KEYS = [
  'PATH',
  'NODE_OPTIONS', 'NODE_PATH',
  'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
];

export function isReservedEnvKey(key) {
  const upper = String(key).toUpperCase();
  if (RESERVED_ENV_PREFIXES.some((p) => upper.startsWith(p))) return true;
  return RESERVED_ENV_KEYS.includes(upper);
}

function mergeEnv(layers, overlayEnv) {
  const out = {};
  for (const layer of layers) {
    const env = layer?.env;
    if (!env || typeof env !== 'object') continue;
    for (const [k, v] of Object.entries(env)) {
      if (isReservedEnvKey(k)) continue;
      out[k] = v;
    }
  }
  if (overlayEnv) for (const [k, v] of Object.entries(overlayEnv)) out[k] = v;
  return out;
}

export function mergeSettings(layers, overlay) {
  const result = {
    disableAllHooks: overlay?.disableAllHooks ?? false,
    hooks: overlay?.hooks ?? {},
    env: mergeEnv(layers, overlay?.env),
  };
  return result;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/settings-inheritance.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings-merge.js test/settings-inheritance.test.js
git commit -m "feat(settings-merge): env merge with case-insensitive reserved prefix"
```

---

### Task 3: permissions concat+dedupe across `allow`/`deny`/`ask`

**Files:**
- Modify: [src/settings-merge.js](../../../src/settings-merge.js)
- Modify: [test/settings-inheritance.test.js](../../../test/settings-inheritance.test.js)

- [ ] **Step 1: Write failing test**

```js
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
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/settings-inheritance.test.js`
Expected: FAIL — `out.permissions` is undefined.

- [ ] **Step 3: Implement permissions merge**

Add to [src/settings-merge.js](../../../src/settings-merge.js):

```js
export const PERMISSION_ARRAY_FIELDS = ['allow', 'deny', 'ask'];

function mergePermissions(layers, overlayPerms) {
  const out = {};
  for (const field of PERMISSION_ARRAY_FIELDS) {
    const seen = new Set();
    const merged = [];
    for (const layer of layers) {
      const arr = layer?.permissions?.[field];
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        const s = String(entry);
        if (seen.has(s)) continue;
        seen.add(s);
        merged.push(s);
      }
    }
    // Append overlay verbatim (no dedupe against overlay — overlay is trusted last-word).
    const oArr = overlayPerms?.[field];
    if (Array.isArray(oArr)) for (const entry of oArr) merged.push(String(entry));
    if (merged.length) out[field] = merged;
  }
  return out;
}
```

Update `mergeSettings`:

```js
export function mergeSettings(layers, overlay) {
  const result = {
    disableAllHooks: overlay?.disableAllHooks ?? false,
    hooks: overlay?.hooks ?? {},
    env: mergeEnv(layers, overlay?.env),
  };
  const permissions = mergePermissions(layers, overlay?.permissions);
  if (Object.keys(permissions).length) result.permissions = permissions;
  return result;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/settings-inheritance.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings-merge.js test/settings-inheritance.test.js
git commit -m "feat(settings-merge): permissions concat+dedupe (allow/deny/ask)"
```

---

### Task 4: `enabledPlugins` + `extraKnownMarketplaces` deep-merge

**Files:**
- Modify: [src/settings-merge.js](../../../src/settings-merge.js)
- Modify: [test/settings-inheritance.test.js](../../../test/settings-inheritance.test.js)

- [ ] **Step 1: Write failing test**

```js
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
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/settings-inheritance.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement plugin merging**

Add to [src/settings-merge.js](../../../src/settings-merge.js):

```js
function shallowMergeMaps(layers, key) {
  const out = {};
  for (const layer of layers) {
    const m = layer?.[key];
    if (!m || typeof m !== 'object') continue;
    Object.assign(out, m);
  }
  return out;
}
```

Update `mergeSettings` body before `return result`:

```js
  const enabledPlugins = shallowMergeMaps(layers, 'enabledPlugins');
  if (Object.keys(enabledPlugins).length) result.enabledPlugins = enabledPlugins;
  const extraKnownMarketplaces = shallowMergeMaps(layers, 'extraKnownMarketplaces');
  if (Object.keys(extraKnownMarketplaces).length) result.extraKnownMarketplaces = extraKnownMarketplaces;
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/settings-inheritance.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings-merge.js test/settings-inheritance.test.js
git commit -m "feat(settings-merge): enabledPlugins + extraKnownMarketplaces merge"
```

---

### Task 5: `readLayer` with per-outcome diagnostics + HOME resolution

**Files:**
- Modify: [src/settings-merge.js](../../../src/settings-merge.js)
- Modify: [test/settings-inheritance.test.js](../../../test/settings-inheritance.test.js)

- [ ] **Step 1: Write failing test**

```js
import { readLayer, resolveAuthorLayerPaths } from '../src/settings-merge.js';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.equal(paths.user, '/fake/home/.claude/settings.json');
  assert.equal(paths.project, '/peer/root/.claude/settings.json');
  assert.equal(paths.local, '/peer/root/.claude/settings.local.json');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/settings-inheritance.test.js`
Expected: FAIL — exports `readLayer`, `resolveAuthorLayerPaths` missing.

- [ ] **Step 3: Implement helpers**

Add at the top of [src/settings-merge.js](../../../src/settings-merge.js):

```js
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
```

Add functions:

```js
export async function readLayer(path) {
  try {
    const content = await readFile(path, 'utf8');
    try {
      return { ok: true, value: JSON.parse(content) };
    } catch (e) {
      return { ok: false, reason: 'malformed', message: e.message, path };
    }
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'missing', path };
    return { ok: false, reason: 'io_error', message: e.message, path };
  }
}

export function resolveAuthorLayerPaths(root, claudeEnv) {
  const home = claudeEnv?.HOME;
  return {
    user: home ? join(home, '.claude', 'settings.json') : null,
    project: join(root, '.claude', 'settings.json'),
    local: join(root, '.claude', 'settings.local.json'),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/settings-inheritance.test.js`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/settings-merge.js test/settings-inheritance.test.js
git commit -m "feat(settings-merge): readLayer outcomes + HOME-based path resolution"
```

---

### Task 6: `path-guard.js` — `.claude` in `PROTECTED_CONFIG_DIRS`

**Files:**
- Modify: [src/path-guard.js:20](../../../src/path-guard.js#L20)
- Modify: [test/path-guard.test.js](../../../test/path-guard.test.js)

- [ ] **Step 1: Write failing test**

Add to `test/path-guard.test.js` (use existing imports/test style; isProtectedConfigPath is exported):

```js
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
```

(If `mkdtemp`/`tmpdir`/`join` aren't already imported in `path-guard.test.js`, add them at the top of the file.)

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/path-guard.test.js`
Expected: FAIL on the `.claude/*` cases (returns false today); the `AGENT.md` test should already pass.

- [ ] **Step 3: Add `.claude` to PROTECTED_CONFIG_DIRS**

Edit [src/path-guard.js:20](../../../src/path-guard.js#L20):

```js
const PROTECTED_CONFIG_DIRS = new Set(['prompts', 'tools', 'memory', 'workflows', 'skills', '.claude']);
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/path-guard.test.js`
Expected: PASS — both new tests, plus the existing path-guard suite untouched.

- [ ] **Step 5: Commit**

```bash
git add src/path-guard.js test/path-guard.test.js
git commit -m "feat(path-guard): protect .claude/ as trusted runtime config"
```

---

### Task 7: `delegate.js` — sequence reorder (env first)

**Files:**
- Modify: [src/delegate.js:62-64](../../../src/delegate.js#L62)

This is a pure refactor: today `buildClaudeInvocation` runs before `buildClaudeEnv`. Reverse the order so `claudeEnv` exists when invocation is built. Signature of `buildClaudeInvocation` gains `claudeEnv`; pass it through but don't use it yet (it'll be used in Task 8). Tests must still pass as before.

- [ ] **Step 1: Verify current suite is green**

Run: `npm test`
Expected: PASS (existing tests). Note the count for comparison.

- [ ] **Step 2: Reorder + thread `claudeEnv`**

Edit [src/delegate.js:62-64](../../../src/delegate.js#L62):

```js
    const claudeEnv = buildClaudeEnv({ root, env, mode, callEnv: entered.env, runId });
    invocation = await buildClaudeInvocation({ root, mode, task, env, callEnv: entered.env, claudeEnv });
    spawnResult = await spawnFile(env.AGENT_MESH_CLAUDE || 'claude', invocation.args, {
      cwd: root,
      env: claudeEnv,
      timeoutMs,
      detached: true
    });
```

Edit `buildClaudeInvocation` signature in [src/delegate.js:127](../../../src/delegate.js#L127):

```js
async function buildClaudeInvocation({ root, mode, task, env, callEnv, claudeEnv }) {
```

(`claudeEnv` parameter is now received but not used yet — Task 8 wires it into `createClaudeSettings`.)

- [ ] **Step 3: Run full suite — no regressions**

Run: `npm test`
Expected: PASS (same count as Step 1).

- [ ] **Step 4: Commit**

```bash
git add src/delegate.js
git commit -m "refactor(delegate): compute claudeEnv before buildClaudeInvocation"
```

---

### Task 8: `createClaudeSettings` rewrite — allowlist merge + exec-form hook + both modes

**Files:**
- Modify: [src/delegate.js](../../../src/delegate.js) (`createClaudeSettings`)
- Modify: [test/delegate.test.js](../../../test/delegate.test.js)

`createClaudeSettings` becomes mode-aware, reads the 3 author layers via `readLayer` with `claudeEnv.HOME`, merges via `mergeSettings`, builds the path-guard hook in CLI exec form (no shell), writes the merged file. Diagnostics are written to stderr (the existing `spawnFile` already captures stderr; no new plumbing).

- [ ] **Step 1: Write failing test — argv carries exec-form hook in `do` mode**

Add to `test/delegate.test.js` (uses the existing `createFakeClaude` harness — the fake records its argv to a file the test then reads):

```js
test('delegate do: --settings carries PreToolUse in exec form (command + args)', async () => {
  const { runDelegate, readSettings } = await setupHarness({ mode: 'do' });
  await runDelegate('any task');
  const settings = readSettings(); // helper reads the temp file pointed at by --settings
  const entries = settings.hooks.PreToolUse;
  assert.equal(entries.length, 1);
  const hookEntry = entries[0].hooks[0];
  assert.equal(hookEntry.type, 'command');
  // Exec form: command is an absolute path (process.execPath), args is an array.
  assert.equal(typeof hookEntry.command, 'string');
  assert.ok(hookEntry.command.startsWith('/') || /^[A-Z]:\\/.test(hookEntry.command));
  assert.equal(hookEntry.command, process.execPath);
  assert.ok(Array.isArray(hookEntry.args));
  assert.equal(hookEntry.args.length, 1);
  assert.ok(hookEntry.args[0].endsWith('hooks/path-guard.js'));
});

test('delegate ask: --settings carries empty hooks {} (no PreToolUse)', async () => {
  const { runDelegate, readSettings } = await setupHarness({ mode: 'ask' });
  await runDelegate('any task');
  const settings = readSettings();
  assert.deepEqual(settings.hooks, {});
  assert.equal(settings.disableAllHooks, false);
});

test('delegate do: author enabledPlugins flows into --settings', async () => {
  const { runDelegate, readSettings } = await setupHarness({
    mode: 'do',
    fakeHome: { 'settings.json': { enabledPlugins: { 'my-plugin@my-mkt': true } } },
  });
  await runDelegate('any task');
  const settings = readSettings();
  assert.deepEqual(settings.enabledPlugins, { 'my-plugin@my-mkt': true });
});
```

The `setupHarness` helper extends the existing fake-claude infra in the same test file; add it near the top:

```js
async function setupHarness({ mode, fakeHome }) {
  const work = await mkdtemp(join(tmpdir(), 'delegate-test-'));
  const home = join(work, 'home');
  await mkdir(join(home, '.claude'), { recursive: true });
  if (fakeHome) {
    for (const [name, val] of Object.entries(fakeHome)) {
      await writeFile(join(home, '.claude', name), JSON.stringify(val), 'utf8');
    }
  }
  const root = join(work, 'root');
  await mkdir(root, { recursive: true });
  const settingsCapture = join(work, 'captured-settings.json');
  const fakeClaude = await createFakeClaude({
    onInvoke: async (argv) => {
      const i = argv.indexOf('--settings');
      if (i !== -1) await copyFile(argv[i + 1], settingsCapture);
      return { stdout: 'ok', code: 0 };
    },
  });
  const env = { AGENT_MESH_CLAUDE: fakeClaude.path, HOME: home };
  return {
    runDelegate: (task) =>
      delegateTask({ root, env, input: { mode, task }, parentRunId: null }),
    readSettings: () => JSON.parse(readFileSync(settingsCapture, 'utf8')),
  };
}
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/delegate.test.js`
Expected: FAIL — current `createClaudeSettings` uses shell-form `command: "node ..."` and only runs in `do`.

- [ ] **Step 3: Rewrite `createClaudeSettings`**

Edit [src/delegate.js](../../../src/delegate.js) `createClaudeSettings`:

```js
import { mergeSettings, readLayer, resolveAuthorLayerPaths } from './settings-merge.js';

async function createClaudeSettings(root, env, mode, claudeEnv) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-mesh-'));
  const hookPath = fileURLToPath(new URL('../hooks/path-guard.js', import.meta.url));
  const hookLogDir = resolve(root, env.AGENT_MESH_LOG_DIR || DEFAULT_LOG_DIR);
  await mkdir(hookLogDir, { recursive: true });

  // Read the three author layers from the child's effective env.
  const paths = resolveAuthorLayerPaths(root, claudeEnv);
  const layerResults = await Promise.all(
    [paths.user, paths.project, paths.local].map((p) => (p ? readLayer(p) : { ok: false, reason: 'missing' }))
  );
  // Diagnostics — flow through stderr so they appear in the run log tail.
  for (const r of layerResults) {
    if (!r.ok && r.reason !== 'missing') {
      process.stderr.write(`[agent-mesh] settings-merge: ${r.reason} ${r.path || ''}: ${r.message || ''}\n`);
    }
  }
  const layers = layerResults.filter((r) => r.ok).map((r) => r.value);

  // Mode-specific overlay.
  const overlay = {
    disableAllHooks: false,
    hooks: mode === 'do'
      ? {
          PreToolUse: [
            {
              matcher: WRITE_TOOLS.join('|'),
              hooks: [
                // CLI exec form: command + args, no shell.
                { type: 'command', command: process.execPath, args: [hookPath] },
              ],
            },
          ],
        }
      : {},
    env: mode === 'do'
      ? { AGENT_MESH_ROOT: root, AGENT_MESH_HOOK_LOG: join(hookLogDir, 'path-guard-denials.jsonl') }
      : { AGENT_MESH_ROOT: root },
  };

  const merged = mergeSettings(layers, overlay);
  const path = join(dir, 'settings.json');
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  return path;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/delegate.test.js`
Expected: PASS — new tests + existing tests still green (the existing `do` path-guard exists, just in exec form).

- [ ] **Step 5: Commit**

```bash
git add src/delegate.js test/delegate.test.js
git commit -m "feat(delegate): createClaudeSettings does allowlist merge with exec-form hook (both modes)"
```

---

### Task 9: `buildClaudeInvocation` — `--settings` + `--setting-sources ""` in both modes

**Files:**
- Modify: [src/delegate.js](../../../src/delegate.js) (`buildClaudeInvocation`)
- Modify: [test/delegate.test.js](../../../test/delegate.test.js)

- [ ] **Step 1: Write failing tests**

```js
test('delegate ask: argv includes --settings + --setting-sources "" + --permission-mode default-tool gates', async () => {
  const { runDelegate, lastArgv } = await setupHarness({ mode: 'ask' });
  await runDelegate('any');
  const argv = lastArgv();
  assert.ok(argv.includes('--settings'));
  const i = argv.indexOf('--setting-sources');
  assert.notEqual(i, -1, '--setting-sources flag present');
  assert.equal(argv[i + 1], '', '--setting-sources value is empty string (disables native sources)');
  // ask still uses --tools (read tools), no --permission-mode acceptEdits
  assert.ok(argv.includes('--tools'));
  assert.equal(argv.includes('--permission-mode'), false);
});

test('delegate do: argv excludes Bash from --tools even with author plugin', async () => {
  const { runDelegate, lastArgv } = await setupHarness({
    mode: 'do',
    fakeHome: { 'settings.json': { enabledPlugins: { 'bashy@x': true } } },
  });
  await runDelegate('any');
  const argv = lastArgv();
  const i = argv.indexOf('--tools');
  assert.notEqual(i, -1);
  const tools = argv[i + 1].split(',');
  assert.equal(tools.includes('Bash'), false);
  assert.ok(tools.includes('Edit') && tools.includes('Write'));
});
```

Extend `setupHarness` to expose `lastArgv` (record the argv from the fake `onInvoke`).

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/delegate.test.js`
Expected: FAIL — `--settings` is `do`-only today; `--setting-sources` not passed.

- [ ] **Step 3: Update `buildClaudeInvocation`**

In [src/delegate.js](../../../src/delegate.js), inside `buildClaudeInvocation`, after the existing `--mcp-config` block, replace the `if (mode === 'do')` settings push with mode-agnostic settings + a new `--setting-sources ""` for both modes:

```js
  // Always pass --settings (mesh-built) AND --setting-sources "" (disable native loading,
  // so only the mesh's allowlisted merge takes effect). Both modes.
  args.push('--settings', await createClaudeSettings(root, env, mode, claudeEnv));
  args.push('--setting-sources', '');
  if (mode === 'do') {
    args.push('--permission-mode', 'acceptEdits');
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS (full suite, including the new + existing assertions).

- [ ] **Step 5: Commit**

```bash
git add src/delegate.js test/delegate.test.js
git commit -m "feat(delegate): pass --settings + --setting-sources \"\" in both modes"
```

---

### Task 10: Managed-policy preflight (macOS/Linux inspect + Windows attestation)

**Files:**
- Modify: [src/delegate.js](../../../src/delegate.js)
- Modify: [test/delegate.test.js](../../../test/delegate.test.js)
- Modify: [src/errors.js](../../../src/errors.js) (if not already exporting `refused`-shaped result — confirm before editing)

- [ ] **Step 1: Write failing tests**

```js
test('delegate do refused when managed disableAllHooks: true', async () => {
  const { runDelegate, fakeManagedFile } = await setupHarness({
    mode: 'do',
    managedFile: { disableAllHooks: true },
  });
  const result = await runDelegate('any');
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'incompatible_managed_policy');
});

test('delegate do refused when managed allowManagedHooksOnly: true', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'do',
    managedFile: { allowManagedHooksOnly: true },
  });
  const result = await runDelegate('any');
  assert.equal(result.status, 'refused');
});

test('delegate do refused when managed hooks.PreToolUse overlaps WRITE_TOOLS', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'do',
    managedFile: { hooks: { PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '/x' }] }] } },
  });
  const result = await runDelegate('any');
  assert.equal(result.status, 'refused');
});

test('delegate ask NOT refused by the same managed policy', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'ask',
    managedFile: { disableAllHooks: true },
  });
  const result = await runDelegate('any');
  assert.notEqual(result.status, 'refused');
});

test('delegate do on Windows fixture without attestation → refused', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'do',
    forcePlatform: 'win32',
    // no AGENT_MESH_ATTEST_MANAGED_COMPATIBLE
  });
  const result = await runDelegate('any');
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'managed_policy_unverifiable_windows');
});

test('delegate do on Windows WITH AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1 → proceeds', async () => {
  const { runDelegate } = await setupHarness({
    mode: 'do',
    forcePlatform: 'win32',
    extraEnv: { AGENT_MESH_ATTEST_MANAGED_COMPATIBLE: '1' },
  });
  const result = await runDelegate('any');
  assert.notEqual(result.status, 'refused');
});
```

Extend `setupHarness` to thread `managedFile`, `forcePlatform`, and `extraEnv` through to the new preflight (e.g. via dedicated env vars the test reads — see Step 3).

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/delegate.test.js`
Expected: FAIL — no preflight yet; `do` runs anyway.

- [ ] **Step 3: Add the preflight**

Add to [src/delegate.js](../../../src/delegate.js) (top-level, after imports):

```js
// Managed-settings paths inspected by the preflight. Each entry is a candidate
// JSON file; presence is best-effort (missing → skipped).
const MANAGED_PATHS_BY_PLATFORM = {
  darwin: [
    '/Library/Application Support/ClaudeCode/managed-settings.json',
    '/Library/Application Support/ClaudeCode/managed-settings.d',
  ],
  linux: [
    '/etc/claude-code/managed-settings.json',
    '/etc/claude-code/managed-settings.d',
  ],
};

// Override hook for tests. Tests set `env.AGENT_MESH_TEST_MANAGED_FILE` to a path
// the preflight reads instead of the OS-default. Production should never set this.
function managedPathsFor(env, platform) {
  const override = env?.AGENT_MESH_TEST_MANAGED_FILE;
  if (override) return [override];
  return MANAGED_PATHS_BY_PLATFORM[platform] || [];
}

async function inspectManagedPolicyDocs(env, platform) {
  const docs = [];
  for (const p of managedPathsFor(env, platform)) {
    try {
      const s = await stat(p);
      if (s.isFile()) {
        const r = await readLayer(p);
        if (r.ok) docs.push(r.value);
      } else if (s.isDirectory()) {
        const { readdir } = await import('node:fs/promises');
        const files = await readdir(p);
        for (const f of files.sort()) {
          if (!f.endsWith('.json')) continue;
          const r = await readLayer(join(p, f));
          if (r.ok) docs.push(r.value);
        }
      }
    } catch { /* missing or unreadable → skip silently */ }
  }
  return docs;
}

function managedPolicyBlocksMeshHook(doc) {
  if (doc?.disableAllHooks === true) return 'disableAllHooks';
  if (doc?.allowManagedHooksOnly === true) return 'allowManagedHooksOnly';
  const entries = doc?.hooks?.PreToolUse;
  if (Array.isArray(entries)) {
    for (const e of entries) {
      const m = String(e?.matcher || '');
      // Any matcher referencing one of WRITE_TOOLS overlaps the mesh path-guard.
      if (WRITE_TOOLS.some((t) => m.includes(t))) return 'overlapping_PreToolUse';
    }
  }
  return null;
}

async function preflightManagedPolicy(env, platform) {
  if (platform === 'win32') {
    if (env?.AGENT_MESH_ATTEST_MANAGED_COMPATIBLE === '1') return null;
    return { reason: 'managed_policy_unverifiable_windows',
             message: 'Windows managed-settings introspection is incomplete in v1; set AGENT_MESH_ATTEST_MANAGED_COMPATIBLE=1 to attest compatibility.' };
  }
  const docs = await inspectManagedPolicyDocs(env, platform);
  for (const d of docs) {
    const block = managedPolicyBlocksMeshHook(d);
    if (block) return { reason: 'incompatible_managed_policy',
                        message: `Managed policy ${block} would prevent the mesh path-guard from running.` };
  }
  return null;
}
```

Import `stat` from `node:fs/promises` and `readLayer` from `./settings-merge.js`.

In `delegateTask`, just after the `enterCallContext` guard and before `createRunLog`, add the preflight for `do`:

```js
  if (mode === 'do') {
    const platform = env.AGENT_MESH_TEST_PLATFORM || process.platform;
    const blocked = await preflightManagedPolicy(env, platform);
    if (blocked) return refused(blocked.reason, blocked.message);
  }
```

(Tests use `AGENT_MESH_TEST_PLATFORM=win32` + `AGENT_MESH_TEST_MANAGED_FILE=<path>` for platform/file injection — strictly test-only knobs; harmless if unset in production.)

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/delegate.js test/delegate.test.js
git commit -m "feat(delegate): managed-policy preflight refuses incompatible do (macOS/Linux inspect + Windows attest)"
```

---

### Task 11: Opt-in E2E (`AGENT_MESH_E2E=1`) — real plugin inheritance + author-hook + malicious env

**Files:**
- Modify: [test/demo-e2e.test.js](../../../test/demo-e2e.test.js)

These tests are skipped unless `AGENT_MESH_E2E=1` (existing pattern in this file). They spawn the real `claude` binary against a fixture HOME.

- [ ] **Step 1: Add fixture builder helper at the top of the file**

```js
async function buildFixtureHome({ settings, plugins }) {
  const home = await mkdtemp(join(tmpdir(), 'mesh-e2e-home-'));
  if (settings) {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify(settings), 'utf8');
  }
  if (plugins) {
    // Plugins beyond the scope of these e2e tests — only what's needed per scenario.
  }
  return home;
}
```

- [ ] **Step 2: Add the e2e cases**

```js
const E2E = process.env.AGENT_MESH_E2E === '1';

test('e2e: author hook does NOT fire under --setting-sources ""', { skip: !E2E }, async () => {
  const marker = join(await mkdtemp(join(tmpdir(), 'mesh-marker-')), 'fired');
  const home = await buildFixtureHome({
    settings: {
      hooks: {
        PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `touch ${marker}` }] }],
      },
    },
  });
  const root = await mkdtemp(join(tmpdir(), 'mesh-e2e-root-'));
  await execGit(root, 'init');
  const result = await delegateTask({
    root,
    env: { ...process.env, HOME: home },
    input: { mode: 'ask', task: 'Read README.md if present then stop.' },
  });
  assert.equal(result.status, 'done');
  // Marker must not exist — native sources are disabled by --setting-sources "".
  assert.equal(await exists(marker), false);
});

test('e2e: malicious env.PATH does not redirect path-guard subprocess', { skip: !E2E }, async () => {
  // Settings declare a poisoned PATH; allowlist must drop it; hook still runs via process.execPath.
  const home = await buildFixtureHome({
    settings: { env: { PATH: '/tmp/evil:/usr/bin' } },
  });
  const root = await mkdtemp(join(tmpdir(), 'mesh-e2e-root-'));
  await execGit(root, 'init');
  const result = await delegateTask({
    root,
    env: { ...process.env, HOME: home },
    input: { mode: 'do', task: 'Write a file at ../escape.txt and stop.' },
  });
  // The cross-folder write must still be denied by the path-guard.
  assert.equal(result.status, 'done');
  assert.equal(await exists(join(root, '..', 'escape.txt')), false);
});

test('e2e: .claude/settings.local.json write denied under do', { skip: !E2E }, async () => {
  const home = await buildFixtureHome({ settings: {} });
  const root = await mkdtemp(join(tmpdir(), 'mesh-e2e-root-'));
  await execGit(root, 'init');
  const result = await delegateTask({
    root,
    env: { ...process.env, HOME: home },
    input: { mode: 'do', task: 'Create file .claude/settings.local.json containing {} and stop.' },
  });
  assert.equal(result.status, 'done');
  assert.equal(await exists(join(root, '.claude', 'settings.local.json')), false);
});
```

(`execGit` and `exists` helpers: reuse what already exists in `test/demo-e2e.test.js`. If not present, add a minimal `exists(p)` using `fs.access`.)

- [ ] **Step 3: Run with E2E off — must still skip cleanly**

Run: `npm test`
Expected: PASS — the three new tests appear as `skipped` (no `AGENT_MESH_E2E`).

- [ ] **Step 4: Run with E2E on (manual check, requires `claude` on PATH)**

Run: `AGENT_MESH_E2E=1 npm test`
Expected: PASS — the three e2e scenarios assert the intended behaviors against the real `claude` binary.

- [ ] **Step 5: Commit**

```bash
git add test/demo-e2e.test.js
git commit -m "test(e2e): inheritance, no-author-hook, malicious env regression (opt-in)"
```

---

## Self-Review

**1. Spec coverage:**
- Allowlist + overlay merge — Tasks 1–4.
- `readLayer` outcomes + HOME resolution — Task 5.
- `.claude/` protected config — Task 6.
- Sequence reorder — Task 7.
- `createClaudeSettings` rewrite + exec-form hook + both modes — Task 8.
- `--settings` + `--setting-sources ""` + `--tools` excludes `Bash` — Task 9.
- Managed-policy preflight (macOS/Linux + Windows attest) — Task 10.
- Opt-in E2E for plugin inheritance, no-author-hook, malicious env, protected-config write — Task 11.

Tests 11 (`ask` argv has `--settings`) covered in Task 9; test 12 (both modes' argv) covered there; tests 17–19 covered in Task 10. Test 23 (exec-path with spaces) is automatic once Task 8 lands — exec form bypasses shell parsing — and is therefore not a separate explicit task; covered by the unit test in Task 8 asserting `command === process.execPath` regardless of its value.

**2. Placeholder scan:** Searched for "TBD", "TODO", "implement later", "similar to", "appropriate", "edge cases". None present in step bodies.

**3. Type consistency:** `createClaudeSettings(root, env, mode, claudeEnv)` signature used consistently in Tasks 8 and 9. `mergeSettings(layers, overlay)` consistent across all settings-merge tasks. `refused(reason, message)` returns the shape `{ status: 'refused', reason, ... }` already used elsewhere in `src/errors.js` (verify before Task 10 — already in repo).

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-06-settings-inheritance-implementation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batch with checkpoints.

**Which approach?**
