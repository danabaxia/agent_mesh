# Multi-turn Peer Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make worker→peer onward delegation (`delegate_to_peer`) stateful: repeated calls from agent B to peer C continue ONE persistent `claude` session named `from:B`, surviving the bridge's per-call peer teardown.

**Architecture:** C derives a **deterministic** session id from `uuidv5(caller:epoch, namespace=encodeProjectDir(C.root))` and chooses `--resume` vs `--session-id` by whether the on-disk transcript exists — so no in-memory state is needed and the thread persists across the per-call process teardown and future runs. `new_conversation` is a durable reset via a per-caller **epoch** file persisted atomically on C. The caller name is the mesh-unique manifest name (refuse if unresolvable). Ask-only; compaction is claude's built-in auto-compaction.

**Tech Stack:** Node ≥20, zero-dependency ESM, `node --test`. Tests stub `claude` via a generated `.mjs` (`createFakeClaude`) pointed at by `AGENT_MESH_CLAUDE`, capturing argv.

**Spec:** [docs/superpowers/specs/2026-06-09-multi-turn-peer-sessions-design.md](../specs/2026-06-09-multi-turn-peer-sessions-design.md)

---

## File structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/a2a/session-id.js` | `deriveSessionId` (uuidv5) + per-caller atomic epoch store (`readEpoch`/`persistEpoch`) | **New** |
| `src/session-transcripts.js` | shared `encodeProjectDir`/`resolveTranscript`/`countLines`/`transcriptExists` (moved from dashboard) | **New** |
| `src/dashboard/session-index.js` | re-export the moved helpers (back-compat) | Modify |
| `src/delegate-invocation.js` | `buildClaudeInvocation` accepts `session:{id,resume}` → emits `--session-id`/`--resume` | Modify |
| `src/delegate.js` | `delegateTask` accepts `session`; resume-load failure self-heal | Modify |
| `src/a2a/stdio-server.js` | read caller/reset → epoch → id → `transcriptExists` → `session` into delegate; stamp `metrics.turn` | Modify |
| `src/a2a/peer-bridge.js` | resolve unique caller name (refuse if unresolvable); `new_conversation` arg; stamp `agentmesh/caller`/`reset_conversation` | Modify |
| `test/session-id.test.js` | unit: id determinism + casing + epoch atomic/durable | **New** |
| `test/session-transcripts.test.js` | unit: moved helpers + `transcriptExists` (Windows-safe) | **New** |
| `test/multi-turn-delegate.test.js` | integration: session args, resume self-heal, B-vs-D isolation, durable reset | **New** |

---

## Task 1: `session-id.js` — deterministic id + atomic per-caller epoch

**Files:**
- Create: `src/a2a/session-id.js`
- Test: `test/session-id.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/session-id.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveSessionId, readEpoch, persistEpoch } from '../src/session-id.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('deriveSessionId is a deterministic v5 UUID, namespaced by encoded root', () => {
  const a = deriveSessionId('B:0', 'C--AI-mesh-catalog');
  const b = deriveSessionId('B:0', 'C--AI-mesh-catalog');
  const other = deriveSessionId('B:0', 'C--AI-mesh-library');
  const reset = deriveSessionId('B:1', 'C--AI-mesh-catalog');
  assert.match(a, UUID_RE);
  assert.equal(a, b);                 // deterministic
  assert.notEqual(a, other);          // different peer (namespace) → different id
  assert.notEqual(a, reset);          // different epoch → different id
});

test('epoch store is per-caller, persistent, atomic, and tolerant', async () => {
  const root = await mkdtemp(join(tmpdir(), 'epoch-'));
  try {
    assert.equal(await readEpoch(root, 'B'), 0);          // default 0
    await persistEpoch(root, 'B', 1);
    assert.equal(await readEpoch(root, 'B'), 1);          // persisted
    assert.equal(await readEpoch(root, 'D'), 0);          // per-caller isolation
    await persistEpoch(root, 'D', 5);
    assert.equal(await readEpoch(root, 'B'), 1);          // B unaffected by D
    assert.equal(await readEpoch(root, 'B/../x'), 0);     // odd caller never escapes/crashes
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/session-id.test.js`
Expected: FAIL — `Cannot find module '../src/session-id.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/a2a/session-id.js
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// RFC-4122 v5 (SHA-1, name-based). namespace is a 16-byte Buffer; name a string.
function uuidv5(name, namespaceBytes) {
  const h = createHash('sha1').update(namespaceBytes).update(Buffer.from(name, 'utf8')).digest();
  const b = h.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;        // version 5
  b[8] = (b[8] & 0x3f) | 0x80;        // variant 10
  const hex = b.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// A fixed 16-byte namespace seed for agent-mesh peer sessions (any constant works;
// this keeps our ids out of any well-known namespace).
const MESH_NS = createHash('sha1').update('agent-mesh/peer-session').digest().subarray(0, 16);

/**
 * Deterministic claude session UUID for (conversationKey, encodedAgentRoot).
 * encodedRoot MUST be the encodeProjectDir() form so the id agrees with the
 * transcript lookup even under Windows drive-letter casing drift.
 */
export function deriveSessionId(conversationKey, encodedRoot) {
  const ns = uuidv5(String(encodedRoot), MESH_NS);          // per-peer namespace (string→uuid)
  const nsBytes = Buffer.from(ns.replace(/-/g, ''), 'hex');
  return uuidv5(String(conversationKey), nsBytes);
}

// ── per-caller epoch store: one tiny file per caller, atomic temp+rename ──────
function epochDir(agentRoot) { return join(agentRoot, '.agent-mesh', 'peer-epochs'); }
function epochFile(agentRoot, caller) {
  const safe = createHash('sha256').update(String(caller)).digest('hex').slice(0, 32);
  return join(epochDir(agentRoot), safe);
}

export async function readEpoch(agentRoot, caller) {
  try {
    const n = parseInt(await readFile(epochFile(agentRoot, caller), 'utf8'), 10);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch { return 0; }               // missing/corrupt → 0 for THIS caller only
}

export async function persistEpoch(agentRoot, caller, n) {
  await mkdir(epochDir(agentRoot), { recursive: true });
  const final = epochFile(agentRoot, caller);
  const tmp = `${final}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, String(n), { mode: 0o600 });
  await rename(tmp, final);           // atomic: a torn write can never be observed
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/session-id.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/a2a/session-id.js test/session-id.test.js
git commit -m "feat(a2a): deterministic session id + atomic per-caller epoch store"
```

---

## Task 2: `session-transcripts.js` — shared transcript helpers (Decision 3)

**Files:**
- Create: `src/session-transcripts.js`
- Modify: `src/dashboard/session-index.js` (re-export, drop local defs)
- Test: `test/session-transcripts.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/session-transcripts.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir, resolveTranscript, transcriptExists } from '../src/session-transcripts.js';

test('encodeProjectDir: win32 every non-alnum -> "-", no leading dash', () => {
  assert.equal(encodeProjectDir('C:\\AI\\agents_mesh\\x', 'win32'), 'C--AI-agents-mesh-x');
});

test('transcriptExists: true when the transcript file is present, false on not_found', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'proj-'));
  try {
    const id = '11111111-1111-4111-8111-111111111111';
    const enc = encodeProjectDir('/Users/me/agent', 'darwin');
    await mkdir(join(projects, enc), { recursive: true });
    const io = { projectsDir: projects, platform: 'darwin' };
    assert.equal(await transcriptExists('/Users/me/agent', id, io), false);   // dir exists, file absent
    await writeFile(join(projects, enc, `${id}.jsonl`), '{}\n');
    assert.equal(await transcriptExists('/Users/me/agent', id, io), true);
  } finally { await rm(projects, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/session-transcripts.test.js`
Expected: FAIL — `Cannot find module '../src/session-transcripts.js'`.

- [ ] **Step 3a: Create the shared module** by MOVING `encodeProjectDir`, `resolveTranscript`, and `countLines` verbatim out of `src/dashboard/session-index.js` into `src/session-transcripts.js`, plus the small `transcriptExists` wrapper. Keep the imports those functions need (`existsSync`, `readdirSync`, `readdir`, `realpath`, `open`, `homedir`, `join`, `dirname`, `sep as PATH_SEP`).

```js
// src/session-transcripts.js — shared Windows-safe transcript helpers.
import { readdir, realpath, open } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep as PATH_SEP } from 'node:path';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// <PASTE encodeProjectDir EXACTLY as it currently exists in session-index.js>
// <PASTE resolveTranscript EXACTLY (the PATH_SEP containment version)>
// <PASTE countLines EXACTLY>

/** Boolean wrapper over resolveTranscript (which returns a path / throws not_found). */
export async function transcriptExists(agentRoot, id, io = {}) {
  try { await resolveTranscript(agentRoot, id, io); return true; }
  catch (e) { if (e && e.code === 'not_found') return false; throw e; }
}
```

> Copy the three function bodies unchanged from `session-index.js` (they are already Windows-safe from prior work). Export `encodeProjectDir`, `resolveTranscript`, `countLines`, `transcriptExists`.

- [ ] **Step 3b: Re-export from session-index.js** — in `src/dashboard/session-index.js`, delete the three moved function definitions and add at the top (after existing imports):

```js
export { encodeProjectDir, resolveTranscript, countLines } from '../session-transcripts.js';
import { encodeProjectDir, resolveTranscript, countLines } from '../session-transcripts.js';
```

> Keep every other export (`listSessions`, `derivePreview`, `recordEvent`, `setLabel`, …) unchanged — they call `encodeProjectDir`/`resolveTranscript`/`countLines` which are now imported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session-transcripts.test.js test/session-index.test.js`
Expected: PASS (new file + the existing session-index suite still green — proves the move is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add src/session-transcripts.js src/dashboard/session-index.js test/session-transcripts.test.js
git commit -m "refactor(session): extract Windows-safe transcript helpers to src/session-transcripts.js"
```

---

## Task 3: delegate path carries session args + resume self-heal

**Files:**
- Modify: `src/delegate-invocation.js:25` (`buildClaudeInvocation`)
- Modify: `src/delegate.js:~85,~138` (`delegateTask` signature + spawn)
- Test: `test/multi-turn-delegate.test.js`

- [ ] **Step 1: Write the failing test** (uses the `createFakeClaude` pattern from `test/delegate.test.js`)

```js
// test/multi-turn-delegate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delegateTask } from '../src/delegate.js';

async function fakeClaude(body) {
  const dir = await mkdtemp(join(tmpdir(), 'fc-'));
  const p = join(dir, 'fake-claude.mjs');
  await writeFile(p, `#!/usr/bin/env node\n${body}\n`);
  await chmod(p, 0o755);
  return p;
}

test('ask delegate threads --session-id (new) / --resume (resume) into the claude argv', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-'));
  const fc = await fakeClaude(`
    const fs = await import('node:fs/promises');
    await fs.writeFile(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)));
    console.log('ok');`);
  const env = { AGENT_MESH_CLAUDE: fc, AGENT_MESH_TEST_PLATFORM: 'linux', CAPTURE_PATH: join(root, 'argv.json') };
  const sid = '22222222-2222-4222-8222-222222222222';

  await delegateTask({ root, env, input: { mode: 'ask', task: 't' }, session: { id: sid, resume: false } });
  let argv = JSON.parse(await readFile(join(root, 'argv.json'), 'utf8'));
  assert.ok(argv.includes('--session-id') && argv[argv.indexOf('--session-id') + 1] === sid);

  await delegateTask({ root, env, input: { mode: 'ask', task: 't2' }, session: { id: sid, resume: true } });
  argv = JSON.parse(await readFile(join(root, 'argv.json'), 'utf8'));
  assert.ok(argv.includes('--resume') && argv[argv.indexOf('--resume') + 1] === sid);
});

test('resume-load failure self-heals: re-spawn once with --session-id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-'));
  // fake claude: if invoked with --resume, exit 1 with a resume error; with --session-id, succeed.
  const fc = await fakeClaude(`
    const a = process.argv.slice(2);
    if (a.includes('--resume')) { process.stderr.write('Error: No conversation found to resume'); process.exit(1); }
    console.log('fresh ok');`);
  const env = { AGENT_MESH_CLAUDE: fc, AGENT_MESH_TEST_PLATFORM: 'linux' };
  const r = await delegateTask({ root, env, input: { mode: 'ask', task: 't' },
    session: { id: '33333333-3333-4333-8333-333333333333', resume: true } });
  assert.equal(r.status, 'done');                       // recovered, not error
  assert.match(r.summary, /fresh ok/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/multi-turn-delegate.test.js`
Expected: FAIL — `delegateTask` ignores `session` (no `--session-id`/`--resume` in argv); self-heal returns `status:error`.

- [ ] **Step 3a: `buildClaudeInvocation` accepts `session`** — in `src/delegate-invocation.js`, change the signature and insert the flags right after the base args:

```js
export async function buildClaudeInvocation({ root, mode, task, env, callEnv, claudeEnv, session = null }) {
  const meshRoot = await resolveMeshRoot(root, env);
  const skillPolicy = await resolveSkillPolicy(root, meshRoot ? dirname(meshRoot) : null);
  const args = buildClaudeInvocationSync(mode, task, skillToolEnabled(skillPolicy));
  if (session && session.id) {
    args.push(session.resume ? '--resume' : '--session-id', session.id);   // multi-turn (§5.5)
  }
  // …unchanged below (identity, MCP, settings)…
```

- [ ] **Step 3b: `delegateTask` accepts `session` + self-heal** — in `src/delegate.js`, thread `session` into `delegateTask({ ... })`, pass it to `buildClaudeInvocation`, and after the spawn add the one-shot resume re-spawn:

```js
// signature: export async function delegateTask({ root, env, input, parentRunId = null, session = null }) {

// at the spawn site (replacing the single buildClaudeInvocation/spawnFile pair):
invocation = await buildClaudeInvocation({ root, mode, task, env, callEnv: entered.env, claudeEnv, session });
spawnResult = await spawnFile(env.AGENT_MESH_CLAUDE || 'claude', invocation.args, {
  cwd: root, env: claudeEnv, timeoutMs, detached: true
});
// Resume-load self-heal (§3.3/§8): a deleted/broken transcript fails --resume; retry once fresh.
const RESUME_FAIL = /no conversation|session not found|could not resume|--resume/i;
if (session && session.resume && spawnResult.code !== 0 && RESUME_FAIL.test(spawnResult.stderr || '')) {
  invocation = await buildClaudeInvocation({ root, mode, task, env, callEnv: entered.env, claudeEnv,
    session: { id: session.id, resume: false } });
  spawnResult = await spawnFile(env.AGENT_MESH_CLAUDE || 'claude', invocation.args, {
    cwd: root, env: claudeEnv, timeoutMs, detached: true
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/multi-turn-delegate.test.js`
Expected: PASS (2 tests). Also run `node --test test/delegate.test.js` — still green (the `session=null` default keeps every existing call unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/delegate.js src/delegate-invocation.js test/multi-turn-delegate.test.js
git commit -m "feat(delegate): carry --session-id/--resume + resume-load self-heal (ask)"
```

---

## Task 4: A2A server derives the session per turn and stamps it

**Files:**
- Modify: `src/a2a/stdio-server.js` (the `SendMessage` handler, ~line 248-317)
- Test: extend `test/multi-turn-delegate.test.js`

- [ ] **Step 1: Write the failing test** (drive the in-process server with `PassThrough`, like `test/serve-mode-gate.test.js`; assert resume decision + durable epoch via the stub claude's captured argv). Add to `test/multi-turn-delegate.test.js`:

```js
import { createA2AStdioServer } from '../src/a2a/stdio-server.js';
import { PassThrough } from 'node:stream';

async function sendOnce({ root, env, caller, reset }) {
  const input = new PassThrough(), output = new PassThrough();
  const lines = [];
  output.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => lines.push(JSON.parse(l))));
  const server = await createA2AStdioServer({ root, env });
  const done = server.start(input, output);
  const md = { 'agentmesh/mode': 'ask' };
  if (caller) md['agentmesh/caller'] = caller;
  if (reset) md['agentmesh/reset_conversation'] = true;
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage',
    params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hi' }], metadata: md } } }) + '\n');
  await new Promise((r) => setTimeout(r, 200));
  input.end();
  await done.catch(() => {});
  return lines[0];
}

test('C derives a stable per-caller session: 1st turn --session-id, 2nd --resume; reset bumps durably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'peer-'));
  const fc = await fakeClaude(`
    const fs = await import('node:fs/promises'); const a = process.argv.slice(2);
    // emulate claude writing its transcript so transcriptExists() flips to true next turn:
    const i = a.indexOf('--session-id') >= 0 ? a.indexOf('--session-id') : a.indexOf('--resume');
    await fs.appendFile(process.env.CAPTURE_PATH, JSON.stringify({ flag: a[i], id: a[i+1] }) + '\\n');
    console.log('ok');`);
  // Point the fake at writing a real transcript so transcriptExists toggles — handled by a test helper
  // that creates ~/.claude/projects/<enc>/<id>.jsonl after the first send (see note below).
  // …assert first send used --session-id <X>, second used --resume <X>, and a reset used a DIFFERENT id…
});
```

> **Implementation note for this test:** because `transcriptExists` reads the real `~/.claude/projects` dir, the test should pass an `io`-style override is not available through the server; instead, after the first `sendOnce`, the test creates the transcript file at `encodeProjectDir(realpath(root))/<id>.jsonl` (compute the expected `id` with `deriveSessionId('caller:0', encodeProjectDir(realpath(root)))`) so the second turn observes it. Keep the projects dir under a temp `HOME`/override if the server supports it; otherwise assert the **id stability + flag** purely from captured argv and stub `transcriptExists` via a seam (see Step 3).

- [ ] **Step 2: Run to verify it fails** — `node --test test/multi-turn-delegate.test.js` → the server ignores `agentmesh/caller`, passes no `session` to `delegateTask`.

- [ ] **Step 3: Implement in `src/a2a/stdio-server.js`** — in the `SendMessage` handler, before building `run`, resolve the session for ask turns:

```js
import { deriveSessionId, readEpoch, persistEpoch } from './session-id.js';
import { encodeProjectDir, transcriptExists } from '../session-transcripts.js';
import { setLabel, recordEvent } from '../dashboard/session-index.js';
import { realpath } from 'node:fs/promises';

// inside the SendMessage handler, after the mode gates, for ask mode only:
let session = null;
if (validation.value.input.mode === 'ask') {
  const md = validation.value.metadata || {};
  const caller = typeof md['agentmesh/caller'] === 'string' && md['agentmesh/caller'] ? md['agentmesh/caller'] : '_anon';
  let epoch = await readEpoch(root, caller);
  if (md['agentmesh/reset_conversation'] === true) {
    epoch += 1;
    try { await persistEpoch(root, caller, epoch); }
    catch (e) { process.stderr.write(`[agent-mesh] persistEpoch failed for ${caller}: ${e.message}\n`); }
  }
  const encoded = encodeProjectDir(await realpath(root));
  const id = deriveSessionId(`${caller}:${epoch}`, encoded);
  const resume = await transcriptExists(root, id).catch(() => false);
  session = { id, resume };
  // best-effort dashboard naming; never fails the turn
  try { await setLabel(root, id, `from:${caller}`); await recordEvent(root, { kind: 'create', source: `peer:${caller}`, sessionId: id, agentRoot: root }); } catch { /* ignore */ }
}
// …pass `session` into delegateTask:
: () => delegateTask({ root, env, input: validation.value.input, parentRunId, session });
```

> `setLabel`/`recordEvent` are keyed by `meshRoot`; pass `root` (the agent's own root) — acceptable for v1 naming and consistent with the spec's best-effort note. If `setLabel`'s UUID validation rejects, it's caught. Stamp `agentmesh/metrics.turn` in `buildTaskFromDelegateResult`'s metrics path (derive from `derivePreview(...).turns` over the resolved transcript; if unavailable, omit — it is observability only).

- [ ] **Step 4: Run to verify it passes** — `node --test test/multi-turn-delegate.test.js`. Also `node --test test/serve-mode-gate.test.js test/a2a-stdio-server.test.js` stay green (`do` path and non-multi-turn asks unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/a2a/stdio-server.js test/multi-turn-delegate.test.js
git commit -m "feat(a2a): C derives per-caller session (epoch+transcript) and threads it into delegate"
```

---

## Task 5: peer bridge — unique caller name (refuse if unresolvable) + new_conversation

**Files:**
- Modify: `src/a2a/peer-bridge.js` (`createBridge`, `delegateToPeer`, the `delegate_to_peer` tool schema)
- Test: extend `test/multi-turn-delegate.test.js` (or `test/onward-delegation*.test.js` if present)

- [ ] **Step 1: Write the failing test** — assert the bridge stamps the manifest name, refuses when the manifest is unresolvable, and sets `reset_conversation` on `new_conversation:true`. Use the injectable `createClient` seam (`createBridge({ root, env, createClient })`) to capture the outgoing message:

```js
import { createBridge } from '../src/a2a/peer-bridge.js';
// build a tiny mesh: meshRoot/mesh.json with agents [{name:'B', root:'./B'}, {name:'C', root:'./C'}],
// and a marker-validated registry.json in B with peer C. (Mirror test/onward-delegation setup.)
test('bridge stamps the manifest caller name and reset flag; refuses when caller identity is unresolvable', async () => {
  // captured = the message passed to client.send
  let captured = null;
  const createClient = async () => ({ send: async (_p, m) => { captured = m; return { status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [], metadata: {} }; }, close: async () => {} });
  const env = { AGENT_MESH_MESH_CEILING: MESH_ROOT };       // resolvable manifest
  const bridge = createBridge({ root: B_ROOT, env, createClient });
  await bridge.delegateToPeer({ peer: 'C', mode: 'ask', task: 'q1', new_conversation: true });
  assert.equal(captured.metadata['agentmesh/caller'], 'B');
  assert.equal(captured.metadata['agentmesh/reset_conversation'], true);

  const bad = createBridge({ root: B_ROOT, env: {}, createClient }); // no mesh env → unresolvable
  const r = await bad.delegateToPeer({ peer: 'C', mode: 'ask', task: 'q' });
  assert.equal(r.status, 'rejected');
  assert.equal(r.error_code, 'caller_identity_unresolved');
});
```

- [ ] **Step 2: Run to verify it fails** — `node --test test/multi-turn-delegate.test.js` → caller not stamped, no refusal, `new_conversation` ignored.

- [ ] **Step 3a: Add the caller-name resolver** to `src/a2a/peer-bridge.js`:

```js
import { readManifest } from '../builder/manifest.js';
import { realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';

async function resolveCallerName(root, env) {
  const meshRoot = env?.AGENT_MESH_MESH_CEILING
    || (env?.AGENT_MESH_MESH_ROOT ? dirname(env.AGENT_MESH_MESH_ROOT) : null);
  if (!meshRoot) return null;
  try {
    const self = await realpath(root);
    const manifest = await readManifest(meshRoot);
    for (const a of (manifest.agents || [])) {
      const aReal = await realpath(resolve(join(meshRoot, a.root))).catch(() => null);
      if (aReal && aReal === self) return a.name;          // unique manifest name (Decision 2)
    }
  } catch { /* unreadable manifest → unresolvable */ }
  return null;
}
```

- [ ] **Step 3b: Use it in `delegateToPeer`** — add `new_conversation = false` to the signature, refuse on unresolvable identity, and stamp the metadata:

```js
async function delegateToPeer({ peer, mode = ONWARD_MODE, task, new_conversation = false } = {}) {
  if (mode !== ONWARD_MODE) return refusal('mode_disabled', `Onward delegation is ask-only in v1; mode "${mode}" is disabled.`, peer);
  // …existing peer/task validation + registry checks unchanged…
  const callerName = await resolveCallerName(root, env);
  if (!callerName) return refusal('caller_identity_unresolved',
    'cannot resolve a unique caller name from the mesh manifest; refusing to risk a colliding session key.', peer);
  // …existing createClient…
  const metadata = { 'agentmesh/mode': ONWARD_MODE, 'agentmesh/caller': callerName };
  if (parentRunId) metadata['agentmesh/parent_run_id'] = parentRunId;
  if (new_conversation === true) metadata['agentmesh/reset_conversation'] = true;
  // …build message with this metadata, client.send, mapTask…
}
```

- [ ] **Step 3c: Add `new_conversation` to the tool schema** — in the `delegate_to_peer` tool definition (the `tools/list` payload in this file), add an optional boolean property and forward it in `tools/call`:

```js
// in the inputSchema.properties for delegate_to_peer:
new_conversation: { type: 'boolean', description: 'Start a fresh conversation with this peer instead of continuing the existing one.' }
// in the tools/call dispatch, pass args.new_conversation through to delegateToPeer.
```

- [ ] **Step 4: Run to verify it passes** — `node --test test/multi-turn-delegate.test.js`. Also `node --test test/onward-delegation*.test.js` (or the peer-bridge tests) stay green — the ask-only refusal and registry checks are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/a2a/peer-bridge.js test/multi-turn-delegate.test.js
git commit -m "feat(bridge): stamp unique manifest caller name (refuse if unresolvable) + new_conversation"
```

---

## Task 6: end-to-end multi-turn + isolation + durable reset

**Files:**
- Test: extend `test/multi-turn-delegate.test.js` (full path with a real `serve-a2a` peer over `createA2AClient`, stubbed claude)

- [ ] **Step 1: Write the failing test** — wire a tiny 2-agent mesh (B with a marker registry pointing at C), drive `delegateToPeer` through the REAL `createA2AClient` (no `createClient` stub) so C is actually spawned via `node bin/agent-mesh.js serve-a2a`, with `AGENT_MESH_CLAUDE` = a stub that records `(--session-id|--resume, id)` and writes a transcript. Assert: turn 1 → `--session-id X`; turn 2 → `--resume X`; `new_conversation` → `--session-id Y` (Y≠X); a delegation from a *different* caller D → a different id. Mirror `test/complex-demo.test.js`'s subprocess style and set `AGENT_MESH_ATTEST_MANAGED_COMPATIBLE` only if any `do` is used (not here — ask-only).

- [ ] **Step 2: Run to verify it fails** (before Tasks 3-5 land it would; here it should reveal any wiring gap).

- [ ] **Step 3: Fix any wiring gaps** surfaced (e.g., the C-side `HOME`/projects dir must be consistent between the stub's transcript write and `transcriptExists` — pass a shared `HOME` env to both the peer spawn and the stub so they agree on `~/.claude/projects`).

- [ ] **Step 4: Run to verify it passes** — `node --test test/multi-turn-delegate.test.js`.

- [ ] **Step 5: Commit**

```bash
git add test/multi-turn-delegate.test.js
git commit -m "test(a2a): end-to-end multi-turn resume, caller isolation, durable reset"
```

---

## Final verification

- [ ] **Full suite, sequential (avoids the Windows parallel-load flakiness):**

Run: `node --test --test-concurrency=1`
Expected: the new suites pass; the pre-existing environment-bound failures (symlink `EPERM`, macOS-only, POSIX file modes) are unchanged — no NEW failures from this work.

- [ ] **Commit any test-harness adjustments**, then report the pass/fail delta.

---

## Notes for the implementer (domain context)

- **Failure is data:** every non-`done` outcome is a structured result with a `log_path`; never throw to the caller. The bridge already maps this (`refusal`/`mapTask`).
- **`AGENT_MESH_TEST_PLATFORM='linux'`** in delegate tests bypasses the win32 `do`-mode managed-policy preflight so `do` (and, defensively, the spawn path) runs on a Windows host. Ask turns are not preflight-gated, but set it anyway for determinism.
- **The fake claude is a `.mjs`** mapped to `node <file>` by `resolveSpawnTarget` (src/process.js) — works on every platform; it captures argv by writing JSON to `process.env.CAPTURE_PATH`.
- **Do NOT add `Bash`/`do` to the multi-turn path** — it is ask-only by the bridge's existing gate; keep it that way.
- **Anti-spoof / single-user trust:** `agentmesh/caller` is framework-set and not cryptographic (spec §9). Don't add wire-level auth — out of scope.
