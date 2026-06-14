# Skill Discovery, Linking & Dashboard Curation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-discover the user's global Claude skills, link (never copy) chosen ones into a mesh under `mesh/skills/`, and let the dashboard curate mesh membership and per-agent allowlists.

**Architecture:** A new pure-ish core module `src/skill-link.js` owns scanning the global skills root and mutating the mesh (creating directory junctions/symlinks under `mesh/skills/<name>` + a `meshSkills` provenance record in `mesh.json`, and editing per-agent `skills[]` allowlists). Four new dashboard routes in `src/dashboard/server.js` expose those operations. The frontend (`src/dashboard/public/app.js`) gains a "Skill Library" panel and per-agent curation controls. Discovery/policy/worker pipelines are unchanged — a junction is indistinguishable from a real skill dir to `readdir`/`readFile` and to `claude`.

**Tech Stack:** Node ≥20, `node --test` (zero deps), vanilla JS frontend served statically. Spec: [docs/superpowers/specs/2026-06-09-skill-linking-design.md](../specs/2026-06-09-skill-linking-design.md).

---

## File Structure

- **Create** `src/skill-link.js` — scan global skills; register/unregister mesh links + `meshSkills` record; mutate per-agent allowlist. Pure-ish: real fs on real temp dirs, with `io.globalRoot` / `io.platform` overrides for tests.
- **Create** `test/skill-link.test.js` — unit tests for the module (hermetic, real temp dirs).
- **Modify** `src/dashboard/server.js` — add 4 routes: `GET /api/skills/master`, `POST /api/skills/mesh`, `POST /api/skills/mesh/remove`, `POST /api/agent/:name/skills`.
- **Modify** `test/dashboard-server.test.js` — route tests for the 4 endpoints.
- **Modify** `src/dashboard/public/app.js` — `getMasterSkills()`, Skill Library panel, per-agent curation controls.
- **Modify** `src/dashboard/public/app.css` — styles for library rows, `linked`/`broken` badges, curation controls.
- **Modify** `PROJECT.md` and `CLAUDE.md` — document `meshSkills` and the linking feature.

**Module API (defined once, referenced by every task):**

```
globalSkillsRoot(env?)            → absolute path to (CLAUDE_CONFIG_DIR || ~/.claude)/skills
scanGlobalSkills(io?)             → [{ name, source, summary }]            (sorted)
listMeshSkills(meshRoot, io?)     → [{ name, source, linkType, broken }]
masterList(meshRoot, io?)         → [{ name, source, summary, registered, broken }]
registerMeshSkill(meshRoot, name, io?)   → { ok, name?, linkType?, code?, message? }
unregisterMeshSkill(meshRoot, name, io?) → { ok, name?, code?, message? }
setAgentSkill(meshRoot, agentName, name, action, io?)  action: 'add'|'remove'|'reset'
                                  → { ok, agent?, skills?, code?, message? }
```

`io` overrides: `io.globalRoot` (the scan root), `io.platform` (`'win32'|'posix'` for link-type selection). All other fs uses real `node:fs/promises` against real temp dirs in tests.

Error codes: `bad_name` (400), `not_found` (404), `already_exists` (409), `link_failed` (500), `not_registered` (404), `not_a_link` (409), `agent_not_found` (404), `bad_action` (400).

---

## Task 1: `scanGlobalSkills` + `globalSkillsRoot`

**Files:**
- Create: `src/skill-link.js`
- Test: `test/skill-link.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/skill-link.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  globalSkillsRoot, scanGlobalSkills, listMeshSkills, masterList,
  registerMeshSkill, unregisterMeshSkill, setAgentSkill
} from '../src/skill-link.js';
import { readManifest, writeManifest } from '../src/builder/manifest.js';

// A temp global skills root with the named skills (each gets a real SKILL.md).
async function makeGlobalRoot(names = []) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sl-global-')));
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`,
      'utf8'
    );
  }
  return root;
}

// A temp mesh root with a manifest holding the given agents.
async function makeMesh(agents = [{ name: 'lib', root: 'lib', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }]) {
  const meshRoot = await realpath(await mkdtemp(join(tmpdir(), 'sl-mesh-')));
  await mkdir(join(meshRoot, 'mesh', 'skills'), { recursive: true });
  await writeManifest(meshRoot, { meshVersion: '1', agents });
  return meshRoot;
}

test('globalSkillsRoot honors CLAUDE_CONFIG_DIR', () => {
  assert.equal(globalSkillsRoot({ CLAUDE_CONFIG_DIR: '/x/.claude' }), join('/x/.claude', 'skills'));
});

test('scanGlobalSkills lists subdirs with SKILL.md, sorted, with summaries', async () => {
  const globalRoot = await makeGlobalRoot(['zeta', 'alpha']);
  // a dir without SKILL.md must be ignored
  await mkdir(join(globalRoot, 'not-a-skill'), { recursive: true });
  const skills = await scanGlobalSkills({ globalRoot });
  assert.deepEqual(skills.map(s => s.name), ['alpha', 'zeta']);
  assert.equal(skills[0].summary, 'The alpha skill.');
  assert.equal(skills[0].source, join(globalRoot, 'alpha'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skill-link.test.js`
Expected: FAIL — `Cannot find module '../src/skill-link.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/skill-link.js
/**
 * src/skill-link.js
 *
 * Discover the user's GLOBAL Claude skills (~/.claude/skills) and curate which of
 * them are LINKED into a mesh (mesh/skills/<name>) — a directory junction (Windows)
 * / symlink (POSIX), NEVER a copy — plus a `meshSkills` provenance record in
 * mesh.json. Also mutates per-agent `skills[]` allowlists.
 *
 * Pure-ish: real fs against real dirs. Tests inject `io.globalRoot` (scan root) and
 * `io.platform` (link-type selection); everything else is real node:fs/promises.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  readdir, stat, lstat, symlink, unlink, rmdir, mkdir
} from 'node:fs/promises';
import { readManifest, writeManifest } from './builder/manifest.js';
import { isSafeSkillName } from './skills-policy.js';
import { extractSkillSummary } from './agent-context.js';

export function globalSkillsRoot(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(base, 'skills');
}

export async function scanGlobalSkills(io = {}) {
  const root = io.globalRoot || globalSkillsRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillMd = join(root, e.name, 'SKILL.md');
    try {
      await stat(skillMd);
    } catch {
      continue;
    }
    out.push({ name: e.name, source: join(root, e.name), summary: await extractSkillSummary(skillMd) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/skill-link.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/skill-link.js test/skill-link.test.js
git commit -m "feat(skill-link): scan global Claude skills into a master list"
```

---

## Task 2: `listMeshSkills` + `masterList`

**Files:**
- Modify: `src/skill-link.js`
- Test: `test/skill-link.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('masterList tags registered + broken; listMeshSkills flags missing source', async () => {
  const globalRoot = await makeGlobalRoot(['alpha', 'beta']);
  const meshRoot = await makeMesh();
  // Manually record alpha as registered, and a ghost whose source is gone.
  const m = await readManifest(meshRoot);
  m.meshSkills = [
    { name: 'alpha', source: join(globalRoot, 'alpha'), linkType: 'dir' },
    { name: 'ghost', source: join(globalRoot, 'ghost'), linkType: 'dir' }
  ];
  await writeManifest(meshRoot, m);

  const mesh = await listMeshSkills(meshRoot, { globalRoot });
  assert.equal(mesh.find(s => s.name === 'alpha').broken, false);
  assert.equal(mesh.find(s => s.name === 'ghost').broken, true);

  const master = await masterList(meshRoot, { globalRoot });
  const byName = Object.fromEntries(master.map(s => [s.name, s]));
  assert.equal(byName.alpha.registered, true);
  assert.equal(byName.beta.registered, false);
  // ghost is registered but absent from disk → surfaced as broken
  assert.equal(byName.ghost.registered, true);
  assert.equal(byName.ghost.broken, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skill-link.test.js`
Expected: FAIL — `listMeshSkills is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `src/skill-link.js`)

```js
export async function listMeshSkills(meshRoot, io = {}) {
  let manifest;
  try {
    manifest = await readManifest(meshRoot);
  } catch {
    return [];
  }
  const list = Array.isArray(manifest.meshSkills) ? manifest.meshSkills : [];
  const out = [];
  for (const s of list) {
    let broken = false;
    try {
      await stat(join(s.source, 'SKILL.md'));
    } catch {
      broken = true;
    }
    out.push({ name: s.name, source: s.source, linkType: s.linkType, broken });
  }
  return out;
}

export async function masterList(meshRoot, io = {}) {
  const scanned = await scanGlobalSkills(io);
  const mesh = await listMeshSkills(meshRoot, io);
  const meshByName = new Map(mesh.map((m) => [m.name, m]));
  const fromDisk = scanned.map((s) => ({
    ...s,
    registered: meshByName.has(s.name),
    broken: false
  }));
  // Registered skills whose source vanished still appear, flagged broken.
  const ghosts = mesh
    .filter((m) => !scanned.some((s) => s.name === m.name))
    .map((m) => ({ name: m.name, source: m.source, summary: '', registered: true, broken: true }));
  return [...fromDisk, ...ghosts].sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/skill-link.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-link.js test/skill-link.test.js
git commit -m "feat(skill-link): masterList with registered/broken flags"
```

---

## Task 3: `registerMeshSkill` (link + record, refuse clobber, not_found)

**Files:**
- Modify: `src/skill-link.js`
- Test: `test/skill-link.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('registerMeshSkill creates a link + record; reads through the link', async () => {
  const globalRoot = await makeGlobalRoot(['alpha']);
  const meshRoot = await makeMesh();

  const res = await registerMeshSkill(meshRoot, 'alpha', { globalRoot });
  assert.equal(res.ok, true);

  const linkPath = join(meshRoot, 'mesh', 'skills', 'alpha');
  assert.equal((await lstat(linkPath)).isSymbolicLink(), true);
  // SKILL.md is reachable THROUGH the link (proves it points at the source)
  const body = await readFile(join(linkPath, 'SKILL.md'), 'utf8');
  assert.match(body, /name: alpha/);

  const m = await readManifest(meshRoot);
  assert.deepEqual(m.meshSkills.map(s => s.name), ['alpha']);
  assert.equal(m.meshSkills[0].source, join(globalRoot, 'alpha'));
});

test('registerMeshSkill is idempotent and rejects bad names / missing source', async () => {
  const globalRoot = await makeGlobalRoot(['alpha']);
  const meshRoot = await makeMesh();
  await registerMeshSkill(meshRoot, 'alpha', { globalRoot });
  const again = await registerMeshSkill(meshRoot, 'alpha', { globalRoot });
  assert.equal(again.ok, true);
  assert.equal((await readManifest(meshRoot)).meshSkills.length, 1); // no dupe

  assert.equal((await registerMeshSkill(meshRoot, 'bad name', { globalRoot })).code, 'bad_name');
  assert.equal((await registerMeshSkill(meshRoot, 'nope', { globalRoot })).code, 'not_found');
});

test('registerMeshSkill refuses to clobber a real directory', async () => {
  const globalRoot = await makeGlobalRoot(['alpha']);
  const meshRoot = await makeMesh();
  await mkdir(join(meshRoot, 'mesh', 'skills', 'alpha'), { recursive: true }); // real dir
  const res = await registerMeshSkill(meshRoot, 'alpha', { globalRoot });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'already_exists');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skill-link.test.js`
Expected: FAIL — `registerMeshSkill is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `src/skill-link.js`)

```js
function linkTypeFor(io) {
  const platform = io.platform || process.platform;
  return platform === 'win32' ? 'junction' : 'dir';
}

export async function registerMeshSkill(meshRoot, name, io = {}) {
  if (!isSafeSkillName(name)) {
    return { ok: false, code: 'bad_name', message: `invalid skill name "${name}"` };
  }
  const source = join(io.globalRoot || globalSkillsRoot(), name);
  try {
    await stat(join(source, 'SKILL.md'));
  } catch {
    return { ok: false, code: 'not_found', message: `no global skill "${name}"` };
  }

  const linkPath = join(meshRoot, 'mesh', 'skills', name);
  let existing = null;
  try {
    existing = await lstat(linkPath);
  } catch { /* absent */ }
  if (existing && !existing.isSymbolicLink()) {
    return { ok: false, code: 'already_exists', message: `mesh/skills/${name} is a real directory` };
  }

  const linkType = linkTypeFor(io);
  if (!existing) {
    await mkdir(join(meshRoot, 'mesh', 'skills'), { recursive: true });
    try {
      await symlink(source, linkPath, linkType);
    } catch (err) {
      return { ok: false, code: 'link_failed', message: err.message };
    }
  }

  const manifest = await readManifest(meshRoot);
  const list = Array.isArray(manifest.meshSkills) ? manifest.meshSkills : [];
  if (!list.some((s) => s.name === name)) list.push({ name, source, linkType });
  manifest.meshSkills = list;
  await writeManifest(meshRoot, manifest);
  return { ok: true, name, linkType };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/skill-link.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-link.js test/skill-link.test.js
git commit -m "feat(skill-link): register a global skill as a mesh link"
```

---

## Task 4: `unregisterMeshSkill` (remove link not target, prune allowlists, guard)

**Files:**
- Modify: `src/skill-link.js`
- Test: `test/skill-link.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('unregisterMeshSkill removes the LINK not the target, and prunes allowlists', async () => {
  const globalRoot = await makeGlobalRoot(['alpha']);
  const meshRoot = await makeMesh([
    { name: 'lib', root: 'lib', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [], skills: ['alpha', 'keep'] }
  ]);
  await registerMeshSkill(meshRoot, 'alpha', { globalRoot });

  const res = await unregisterMeshSkill(meshRoot, 'alpha', { globalRoot });
  assert.equal(res.ok, true);

  // link gone…
  await assert.rejects(lstat(join(meshRoot, 'mesh', 'skills', 'alpha')));
  // …but the TARGET skill survives untouched
  assert.match(await readFile(join(globalRoot, 'alpha', 'SKILL.md'), 'utf8'), /name: alpha/);

  const m = await readManifest(meshRoot);
  assert.deepEqual(m.meshSkills, []);
  assert.deepEqual(m.agents[0].skills, ['keep']); // 'alpha' pruned from the allowlist
});

test('unregisterMeshSkill refuses a real (non-link) dir and reports not_registered', async () => {
  const globalRoot = await makeGlobalRoot(['alpha']);
  const meshRoot = await makeMesh();
  assert.equal((await unregisterMeshSkill(meshRoot, 'alpha', { globalRoot })).code, 'not_registered');

  // record it as registered but place a REAL dir at the link path → must refuse
  const m = await readManifest(meshRoot);
  m.meshSkills = [{ name: 'alpha', source: join(globalRoot, 'alpha'), linkType: 'dir' }];
  await writeManifest(meshRoot, m);
  await mkdir(join(meshRoot, 'mesh', 'skills', 'alpha'), { recursive: true });
  assert.equal((await unregisterMeshSkill(meshRoot, 'alpha', { globalRoot })).code, 'not_a_link');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skill-link.test.js`
Expected: FAIL — `unregisterMeshSkill is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `src/skill-link.js`)

```js
// Remove a link without ever following it into the target. POSIX dir-symlinks go
// via unlink; Windows junctions reject unlink (EPERM) and need rmdir — both remove
// only the link, leaving the target intact.
async function removeLinkOnly(linkPath) {
  try {
    await unlink(linkPath);
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EISDIR') {
      await rmdir(linkPath);
    } else {
      throw err;
    }
  }
}

export async function unregisterMeshSkill(meshRoot, name, io = {}) {
  const manifest = await readManifest(meshRoot);
  const list = Array.isArray(manifest.meshSkills) ? manifest.meshSkills : [];
  if (!list.some((s) => s.name === name)) {
    return { ok: false, code: 'not_registered', message: `"${name}" is not a mesh-registered skill` };
  }

  const linkPath = join(meshRoot, 'mesh', 'skills', name);
  let st = null;
  try {
    st = await lstat(linkPath);
  } catch { /* already gone */ }
  if (st && !st.isSymbolicLink()) {
    return { ok: false, code: 'not_a_link', message: `mesh/skills/${name} is a real directory; refusing to delete` };
  }
  if (st) await removeLinkOnly(linkPath);

  manifest.meshSkills = list.filter((s) => s.name !== name);
  for (const agent of manifest.agents || []) {
    if (Array.isArray(agent.skills)) agent.skills = agent.skills.filter((s) => s !== name);
  }
  await writeManifest(meshRoot, manifest);
  return { ok: true, name };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/skill-link.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-link.js test/skill-link.test.js
git commit -m "feat(skill-link): unregister removes link not target, prunes allowlists"
```

---

## Task 5: `setAgentSkill` (add / remove / reset)

**Files:**
- Modify: `src/skill-link.js`
- Test: `test/skill-link.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('setAgentSkill add flips absent→list, remove can empty (disabled), reset clears field', async () => {
  const meshRoot = await makeMesh(); // agent 'lib', no skills field (inherit all)

  let r = await setAgentSkill(meshRoot, 'lib', 'alpha', 'add');
  assert.deepEqual(r.skills, ['alpha']); // absent → list
  r = await setAgentSkill(meshRoot, 'lib', 'beta', 'add');
  assert.deepEqual(r.skills, ['alpha', 'beta']);
  r = await setAgentSkill(meshRoot, 'lib', 'alpha', 'remove');
  assert.deepEqual(r.skills, ['beta']);
  r = await setAgentSkill(meshRoot, 'lib', 'beta', 'remove');
  assert.deepEqual(r.skills, []); // empty list = disabled (NOT inherit-all)

  r = await setAgentSkill(meshRoot, 'lib', null, 'reset');
  assert.equal(r.skills, null); // field removed → inherit-all
  assert.equal((await readManifest(meshRoot)).agents[0].skills, undefined);
});

test('setAgentSkill rejects bad name, unknown agent, bad action', async () => {
  const meshRoot = await makeMesh();
  assert.equal((await setAgentSkill(meshRoot, 'lib', 'bad name', 'add')).code, 'bad_name');
  assert.equal((await setAgentSkill(meshRoot, 'ghost', 'alpha', 'add')).code, 'agent_not_found');
  assert.equal((await setAgentSkill(meshRoot, 'lib', 'alpha', 'frob')).code, 'bad_action');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/skill-link.test.js`
Expected: FAIL — `setAgentSkill is not a function`.

- [ ] **Step 3: Write minimal implementation** (append to `src/skill-link.js`)

```js
export async function setAgentSkill(meshRoot, agentName, name, action, io = {}) {
  const manifest = await readManifest(meshRoot);
  const agent = (manifest.agents || []).find((a) => a.name === agentName);
  if (!agent) return { ok: false, code: 'agent_not_found', message: `no agent "${agentName}"` };

  if (action === 'reset') {
    delete agent.skills;
  } else if (action === 'add' || action === 'remove') {
    if (action === 'add' && !isSafeSkillName(name)) {
      return { ok: false, code: 'bad_name', message: `invalid skill name "${name}"` };
    }
    let list = Array.isArray(agent.skills) ? agent.skills.slice() : [];
    if (action === 'add') {
      if (!list.includes(name)) list.push(name);
    } else {
      list = list.filter((s) => s !== name);
    }
    agent.skills = list;
  } else {
    return { ok: false, code: 'bad_action', message: `unknown action "${action}"` };
  }

  await writeManifest(meshRoot, manifest);
  return { ok: true, agent: agentName, skills: agent.skills ?? null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/skill-link.test.js`
Expected: PASS. Then run the whole module file: `node --test test/skill-link.test.js` → all green.

- [ ] **Step 5: Commit**

```bash
git add src/skill-link.js test/skill-link.test.js
git commit -m "feat(skill-link): per-agent allowlist add/remove/reset"
```

---

## Task 6: Route `GET /api/skills/master`

**Files:**
- Modify: `src/dashboard/server.js` (import + route near the existing `/api/skills` route at line 679)
- Test: `test/dashboard-server.test.js`

- [ ] **Step 1: Write the failing test**

Add near the other route tests. Reuse the existing `buildTestMesh` and `startAuthedServer` helpers. `initMesh` already creates the real `mesh/skills/citation-format` dir, but it is NOT in any global root, so it won't appear in the master list — the test injects skills by registering them through the API in later tasks; here we assert the endpoint shape with an empty global root.

```js
test('GET /api/skills/master returns ok + skills array', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, baseUrl } = await startAuthedServer(meshRoot);
  try {
    const res = await fetchFrom(`${baseUrl}/api/skills/master`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(Array.isArray(json.skills));
  } finally {
    await srv.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dashboard-server.test.js --test-name-pattern="skills/master"`
Expected: FAIL — 404 (route not wired) → `assert 404 == 200`.

- [ ] **Step 3: Write minimal implementation**

At the top of `src/dashboard/server.js`, add to the imports:

```js
import { masterList, registerMeshSkill, unregisterMeshSkill, setAgentSkill } from '../skill-link.js';
```

Immediately after the `GET /api/skills` block (after line 684), add:

```js
  if (pathname === '/api/skills/master' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, skills: await masterList(meshRoot) });
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/dashboard-server.test.js --test-name-pattern="skills/master"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/dashboard-server.test.js
git commit -m "feat(dashboard): GET /api/skills/master"
```

---

## Task 7: Routes `POST /api/skills/mesh` and `POST /api/skills/mesh/remove`

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/dashboard-server.test.js`

- [ ] **Step 1: Write the failing test**

This test needs a global root to register from. Set `CLAUDE_CONFIG_DIR` to a temp dir so the server's `globalSkillsRoot()` resolves to skills we control, then restore it.

```js
test('POST /api/skills/mesh registers, then /remove unregisters', async () => {
  // Build a fake global root: <tmp>/.claude/skills/demo/SKILL.md
  const cfg = await mkdtemp(join(tmpdir(), 'sl-cfg-'));
  await mkdir(join(cfg, 'skills', 'demo'), { recursive: true });
  await writeFile(join(cfg, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo.\n---\n# demo\n', 'utf8');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const { meshRoot } = await buildTestMesh();
    const { srv, cookie, baseUrl } = await startAuthedServer(meshRoot);
    try {
      const post = (path, obj) => fetchFrom(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(obj)
      });
      let res = await post('/api/skills/mesh', { name: 'demo' });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).ok, true);
      assert.equal((await lstat(join(meshRoot, 'mesh', 'skills', 'demo'))).isSymbolicLink(), true);

      // bad name → 400
      res = await post('/api/skills/mesh', { name: 'bad name' });
      assert.equal(res.status, 400);

      // remove → 200, link gone
      res = await post('/api/skills/mesh/remove', { name: 'demo' });
      assert.equal(res.status, 200);
      await assert.rejects(lstat(join(meshRoot, 'mesh', 'skills', 'demo')));
    } finally {
      await srv.stop();
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
```

Ensure `lstat` is imported in the test file (add to the `node:fs/promises` import: `lstat`).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dashboard-server.test.js --test-name-pattern="skills/mesh"`
Expected: FAIL — 404 on POST.

- [ ] **Step 3: Write minimal implementation**

Add a status map helper near `sendJson` (after line 380):

```js
const SKILL_ERR_STATUS = {
  bad_name: 400, bad_action: 400, not_found: 404, not_registered: 404,
  agent_not_found: 404, already_exists: 409, not_a_link: 409, link_failed: 500
};
function sendSkillResult(res, result) {
  if (result.ok) { sendJson(res, 200, result); return; }
  const status = SKILL_ERR_STATUS[result.code] || 400;
  sendJson(res, status, { ok: false, error: { code: result.code, message: result.message } });
}
```

After the `/api/skills/master` route, add:

```js
  if (pathname === '/api/skills/mesh' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBodyCapped(req, 4096)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
    sendSkillResult(res, await registerMeshSkill(meshRoot, body.name));
    return;
  }

  if (pathname === '/api/skills/mesh/remove' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBodyCapped(req, 4096)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
    sendSkillResult(res, await unregisterMeshSkill(meshRoot, body.name));
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/dashboard-server.test.js --test-name-pattern="skills/mesh"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/dashboard-server.test.js
git commit -m "feat(dashboard): POST register/unregister mesh skill links"
```

---

## Task 8: Route `POST /api/agent/:name/skills`

**Files:**
- Modify: `src/dashboard/server.js` (add near the `/api/agent/.../worklog` route at line 528)
- Test: `test/dashboard-server.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('POST /api/agent/:name/skills add/remove/reset', async () => {
  const { meshRoot } = await buildTestMesh();
  const { srv, cookie, baseUrl } = await startAuthedServer(meshRoot);
  try {
    const post = (obj) => fetchFrom(`${baseUrl}/api/agent/agent-a/skills`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj)
    });
    let res = await post({ name: 'demo', action: 'add' });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).skills, ['demo']);

    res = await post({ name: 'demo', action: 'remove' });
    assert.deepEqual((await res.json()).skills, []);

    res = await post({ action: 'reset' });
    assert.equal((await res.json()).skills, null);

    res = await post({ name: 'x', action: 'add' });
    res = await fetchFrom(`${baseUrl}/api/agent/ghost/skills`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'demo', action: 'add' })
    });
    assert.equal(res.status, 404); // agent_not_found
  } finally {
    await srv.stop();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/dashboard-server.test.js --test-name-pattern="agent/:name/skills"`
Expected: FAIL — 404 on POST (route not wired).

- [ ] **Step 3: Write minimal implementation**

After the `/api/agent/.../worklog` route block (after line ~550), add:

```js
  if (pathname.startsWith('/api/agent/') && pathname.endsWith('/skills') && req.method === 'POST') {
    const name = decodeURIComponent(pathname.slice('/api/agent/'.length, -'/skills'.length));
    let body;
    try { body = JSON.parse((await readBodyCapped(req, 4096)) || '{}'); }
    catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
    sendSkillResult(res, await setAgentSkill(meshRoot, name, body.name, body.action));
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/dashboard-server.test.js --test-name-pattern="agent/:name/skills"`
Then the full suite: `npm test`
Expected: PASS, whole suite green.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.js test/dashboard-server.test.js
git commit -m "feat(dashboard): POST per-agent skill allowlist add/remove/reset"
```

---

## Task 9: Frontend — `getMasterSkills()` + Skill Library panel

> Frontend has no DOM unit harness in this repo; these tasks use **manual verification** against a running dashboard. That is the honest test surface here — the logic is backend-tested in Tasks 1-8.

**Files:**
- Modify: `src/dashboard/public/app.js`
- Modify: `src/dashboard/public/app.css`

- [ ] **Step 1: Add the fetch helper** (near `getResources` at line 235)

```js
async function getMasterSkills() {
  try {
    const res = await apiFetch('/api/skills/master');
    const json = await res.json();
    return json.ok ? json.skills : [];
  } catch { return []; }
}

async function postSkillAction(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json().catch(() => ({ ok: false }));
}
```

- [ ] **Step 2: Render the library panel above the skills board** (in `renderSkillCards`, line 600)

```js
async function renderSkillCards(cardsEl) {
  await renderSkillLibrary(cardsEl);     // NEW: master-list curation panel on top
  const board = document.createElement('div');
  cardsEl.appendChild(board);
  await renderResourceBoard(board, 'skills');
}

async function renderSkillLibrary(cardsEl) {
  cardsEl.className = 'cards';
  cardsEl.innerHTML = '';
  const skills = await getMasterSkills();
  const panel = document.createElement('div');
  panel.className = 'skill-library reveal';
  panel.innerHTML =
    `<div class="sl-head"><h3>Skill Library</h3>` +
    `<span>${skills.filter(s => s.registered).length}/${skills.length} linked into mesh</span></div>` +
    `<div class="sl-rows">` +
    (skills.length ? skills.map(skillLibraryRow).join('') : `<div class="info-panel">No global skills found in ~/.claude/skills.</div>`) +
    `</div>`;
  cardsEl.appendChild(panel);
  wireSkillLibrary(panel, cardsEl);
}

function skillLibraryRow(s) {
  const badge = s.broken ? `<span class="pill warn">broken</span>`
    : s.registered ? `<span class="pill served">linked</span>` : '';
  const btn = s.registered
    ? `<button class="sl-btn unlink" data-sl-action="remove" data-sl-name="${esc(s.name)}">Unlink</button>`
    : `<button class="sl-btn add" data-sl-action="add" data-sl-name="${esc(s.name)}">Add → mesh</button>`;
  return `<div class="sl-row"><span class="sl-name"><b>${esc(s.name)}</b>${badge}</span>` +
    `<span class="sl-desc">${esc(s.summary || '')}</span>${btn}</div>`;
}

function wireSkillLibrary(panel, cardsEl) {
  panel.querySelectorAll('[data-sl-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.slName;
      const path = btn.dataset.slAction === 'add' ? '/api/skills/mesh' : '/api/skills/mesh/remove';
      btn.disabled = true;
      const r = await postSkillAction(path, { name });
      if (!r.ok && r.error) alert(`Skill action failed: ${r.error.code} — ${r.error.message || ''}`);
      await renderSkillCards(cardsEl.parentElement || cardsEl); // re-render board + library
    });
  });
}
```

- [ ] **Step 3: Add styles** (append to `src/dashboard/public/app.css`)

```css
.skill-library { margin-bottom: 18px; }
.skill-library .sl-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
.skill-library .sl-head h3 { margin: 0; }
.sl-rows { display: flex; flex-direction: column; gap: 6px; }
.sl-row { display: grid; grid-template-columns: 220px 1fr auto; align-items: center; gap: 12px; padding: 8px 10px; border: 1px solid var(--line, #2a2a2a); border-radius: 8px; }
.sl-name { display: flex; gap: 8px; align-items: center; }
.sl-desc { color: var(--muted, #888); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sl-btn { cursor: pointer; border-radius: 6px; padding: 4px 10px; border: 1px solid var(--line, #2a2a2a); background: transparent; color: inherit; }
.sl-btn.add:hover { background: #1f3a1f; }
.sl-btn.unlink:hover { background: #3a1f1f; }
.sl-btn:disabled { opacity: .5; cursor: default; }
```

- [ ] **Step 4: Manual verification**

Run: `node ./bin/agent-mesh.js` is not the dashboard entry; start the dashboard the way the repo does (check `bin/` for the dashboard command, e.g. `node ./bin/agent-mesh.js dashboard <meshRoot>` or the documented script). With a mesh whose `~/.claude/skills` has at least one skill:
- Open the Skills board. Expect the "Skill Library" panel listing global skills, each with **Add → mesh**.
- Click **Add → mesh** on one → it flips to **linked** + **Unlink**, and `mesh/skills/<name>` appears as a link (verify in a terminal: the dir exists and `SKILL.md` is readable through it).
- Click **Unlink** → row reverts; the link is gone but the global skill still exists.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/app.js src/dashboard/public/app.css
git commit -m "feat(dashboard): Skill Library panel to link/unlink global skills"
```

---

## Task 10: Frontend — per-agent curation in the agent detail

**Files:**
- Modify: `src/dashboard/public/app.js` (the agent-detail renderer, the `detail.innerHTML = …` block around line 1186)

- [ ] **Step 1: Build the curation section**

Add this helper and call it in the agent-detail `innerHTML`, right after `resourceDetailSection(group, 'skills')`:

```js
// Effective allowlist mode for an agent, from its manifest entry `skills` field.
function skillModeLabel(skills) {
  if (skills === undefined || skills === null) return 'Inherit all';
  if (Array.isArray(skills) && skills.length === 0) return 'Disabled';
  return `Restricted to ${skills.length}`;
}

async function agentSkillCuration(name, entry) {
  const mesh = (await getMasterSkills()).filter(s => s.registered && !s.broken);
  const allow = entry.skills; // undefined | [] | [names]
  const isInheritAll = allow === undefined || allow === null;
  const checked = new Set(Array.isArray(allow) ? allow : []);
  const rows = mesh.map(s => {
    const on = isInheritAll || checked.has(s.name);
    return `<label class="asc-row"><input type="checkbox" data-asc-name="${esc(s.name)}" ${on ? 'checked' : ''}>` +
      `<span>${esc(s.name)}</span></label>`;
  }).join('') || `<div class="muted">No mesh-registered skills yet — add some from the Skills board.</div>`;
  return `<div class="agent-skill-curation" data-asc-agent="${esc(name)}">` +
    `<div class="asc-head"><b>Skills for this agent</b>` +
    `<span class="pill ${isInheritAll ? 'served' : 'warn'}">${skillModeLabel(allow)}</span>` +
    `<button class="asc-reset" type="button">Reset to inherit all</button></div>` +
    (isInheritAll ? `<div class="asc-note">Inheriting ALL mesh skills. Ticking any one below restricts this agent to your selection.</div>` : '') +
    `<div class="asc-rows">${rows}</div></div>`;
}
```

Because `detail.innerHTML = …` is synchronous, render the curation block asynchronously and inject it. After the existing `detail.innerHTML = …;` assignment and the `wireResourceItemClicks(detail, resources, 'skills');` line, add:

```js
  agentSkillCuration(name, entry).then(html => {
    const slot = document.createElement('div');
    slot.innerHTML = html;
    detail.appendChild(slot.firstElementChild);
    wireAgentSkillCuration(detail, name, entry);
  });
```

- [ ] **Step 2: Wire the controls**

```js
function wireAgentSkillCuration(detail, name, entry) {
  const root = detail.querySelector('.agent-skill-curation');
  if (!root) return;
  const refresh = () => { showAgentDetail(name); }; // re-open detail to reflect new state
  root.querySelectorAll('[data-asc-name]').forEach(cb => {
    cb.addEventListener('change', async () => {
      const wasInheritAll = entry.skills === undefined || entry.skills === null;
      if (wasInheritAll && cb.checked) {
        // First explicit pick: warn that this flips inherit-all → restricted.
        if (!confirm('This agent currently inherits ALL mesh skills. Selecting specific skills will restrict it to only those you tick. Continue?')) {
          cb.checked = true; return;
        }
      }
      const action = cb.checked ? 'add' : 'remove';
      await postSkillAction(`/api/agent/${encodeURIComponent(name)}/skills`, { name: cb.dataset.ascName, action });
      refresh();
    });
  });
  root.querySelector('.asc-reset')?.addEventListener('click', async () => {
    await postSkillAction(`/api/agent/${encodeURIComponent(name)}/skills`, { action: 'reset' });
    refresh();
  });
}
```

The agent-detail open function is `showAgentDetail(name)` (defined at `src/dashboard/public/app.js:1154`, building its body via `openCardDetail`); `refresh()` re-invokes it to re-render the detail with the new allowlist state. The `detail` element and the `detail.innerHTML = …` assignment live inside that function (around line 1186).

- [ ] **Step 3: Add styles** (append to `app.css`)

```css
.agent-skill-curation { margin-top: 14px; border-top: 1px solid var(--line, #2a2a2a); padding-top: 10px; }
.asc-head { display: flex; gap: 10px; align-items: center; }
.asc-head .asc-reset { margin-left: auto; cursor: pointer; background: transparent; border: 1px solid var(--line, #2a2a2a); color: inherit; border-radius: 6px; padding: 3px 8px; }
.asc-note { color: var(--muted, #888); font-size: 12px; margin: 6px 0; }
.asc-rows { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; max-height: 220px; overflow: auto; }
.asc-row { display: flex; gap: 8px; align-items: center; }
```

- [ ] **Step 4: Manual verification**

Start the dashboard, open an agent's detail:
- A "Skills for this agent" section lists mesh-registered skills with checkboxes; mode pill shows **Inherit all** initially.
- Tick one → confirm dialog warns about the flip → on confirm, pill becomes **Restricted to 1**, only that skill stays ticked.
- Untick all → pill shows **Disabled**.
- Click **Reset to inherit all** → pill returns to **Inherit all**, all ticks reflect inherit.
- Cross-check `mesh.json`: `agents[i].skills` reflects each action; verify by reading the file.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/public/app.js src/dashboard/public/app.css
git commit -m "feat(dashboard): per-agent skill curation with inherit/restrict/disable"
```

---

## Task 11: Bulk "Link all" + broken-link cleanup affordance

**Files:**
- Modify: `src/dashboard/public/app.js` (the `renderSkillLibrary` head)

- [ ] **Step 1: Add the bulk button to the library head**

In `renderSkillLibrary`, change the `sl-head` to include a bulk action and wire it:

```js
  panel.innerHTML =
    `<div class="sl-head"><h3>Skill Library</h3>` +
    `<span>${skills.filter(s => s.registered).length}/${skills.length} linked into mesh</span>` +
    `<button class="sl-linkall" type="button">Link all</button></div>` +
    `<div class="sl-rows">` +
    (skills.length ? skills.map(skillLibraryRow).join('') : `<div class="info-panel">No global skills found in ~/.claude/skills.</div>`) +
    `</div>`;
  cardsEl.appendChild(panel);
  wireSkillLibrary(panel, cardsEl);
  panel.querySelector('.sl-linkall')?.addEventListener('click', async () => {
    const unlinked = skills.filter(s => !s.registered && !s.broken);
    for (const s of unlinked) await postSkillAction('/api/skills/mesh', { name: s.name });
    await renderSkillCards(cardsEl.parentElement || cardsEl);
  });
```

For broken rows, `skillLibraryRow` already shows a **broken** badge; change its button to an **Unlink** (cleanup) action since broken skills are still registered:

```js
function skillLibraryRow(s) {
  const badge = s.broken ? `<span class="pill warn">broken</span>`
    : s.registered ? `<span class="pill served">linked</span>` : '';
  const btn = (s.registered || s.broken)
    ? `<button class="sl-btn unlink" data-sl-action="remove" data-sl-name="${esc(s.name)}">${s.broken ? 'Clean up' : 'Unlink'}</button>`
    : `<button class="sl-btn add" data-sl-action="add" data-sl-name="${esc(s.name)}">Add → mesh</button>`;
  return `<div class="sl-row"><span class="sl-name"><b>${esc(s.name)}</b>${badge}</span>` +
    `<span class="sl-desc">${esc(s.summary || '')}</span>${btn}</div>`;
}
```

- [ ] **Step 2: Add the button style** (append to `app.css`)

```css
.sl-linkall { margin-left: 12px; cursor: pointer; border-radius: 6px; padding: 4px 10px; border: 1px solid var(--line, #2a2a2a); background: transparent; color: inherit; }
.sl-linkall:hover { background: #1f2a3a; }
```

- [ ] **Step 3: Manual verification**

- Click **Link all** with several unlinked global skills → all flip to **linked**; verify `mesh.json.meshSkills` lists them and each link exists.
- Manually delete a global skill folder that is registered, reload → its row shows **broken** + **Clean up**; click it → record + link removed.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/public/app.js src/dashboard/public/app.css
git commit -m "feat(dashboard): bulk Link all + broken-link cleanup"
```

---

## Task 12: Docs + full verification

**Files:**
- Modify: `PROJECT.md` (document `meshSkills` and the linking feature)
- Modify: `CLAUDE.md` (one line under Architecture pointing at `src/skill-link.js`)

- [ ] **Step 1: Document `meshSkills` in PROJECT.md**

Add a short subsection (near the skills/policy discussion) describing: the master list = `~/.claude/skills` (or `CLAUDE_CONFIG_DIR`); registered skills are **directory junctions/symlinks** under `mesh/skills/<name>` recorded in `mesh.json.meshSkills: [{name, source, linkType}]`; never copies; the dashboard curates membership; per-agent `skills[]` is unchanged in meaning. Note the invariant: **unregister removes the link, never the target; register never clobbers a real dir.**

- [ ] **Step 2: Add the CLAUDE.md Architecture bullet**

```md
- [src/skill-link.js](src/skill-link.js): discover global Claude skills (`~/.claude/skills`), link chosen ones into `mesh/skills/<name>` (junction/symlink, never copy) with a `mesh.json` `meshSkills` provenance record, and edit per-agent `skills[]` allowlists. Curated from the dashboard. Never deletes a link target; never clobbers a real skill dir.
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all tests pass, including `test/skill-link.test.js` and the new `test/dashboard-server.test.js` cases.

- [ ] **Step 4: Final manual smoke**

Start the dashboard against a real mesh, exercise: Add → mesh, Link all, per-agent restrict + reset, Unlink, broken cleanup. Confirm `mesh.json` and `mesh/skills/` reflect every action and no global skill file was ever modified or deleted.

- [ ] **Step 5: Commit**

```bash
git add PROJECT.md CLAUDE.md
git commit -m "docs: document mesh skill linking (meshSkills) and src/skill-link.js"
```

---

## Self-Review (completed)

- **Spec coverage:** §2 scope (`~/.claude/skills` only, configurable via `CLAUDE_CONFIG_DIR`) → Task 1. §3 data model + zero-runtime-change → Tasks 1-5 + unchanged discovery. §4.1 module → Tasks 1-5. §4.2 per-agent three states → Task 5 + Task 10. §4.3 four routes → Tasks 6-8. §4.4 UI (library, badges, per-agent, broken) → Tasks 9-11. §5 security (lstat guard, server-derived source, no-clobber, link-not-target) → Tasks 3-4 tests. §6 testing → Tasks 1-8 hermetic, 9-11 manual (no DOM harness — stated honestly). §7 bulk "Link all" → Task 11.
- **Placeholder scan:** none — every code/test step has complete code and exact commands.
- **Type/name consistency:** module API table matches each task's signatures; `setAgentSkill(meshRoot, agentName, name, action, io)`, `registerMeshSkill`, `unregisterMeshSkill`, `masterList` used identically in module, routes, and tests. Error codes match `SKILL_ERR_STATUS`. Agent-detail open function pinned to `showAgentDetail(name)` (`app.js:1154`).
