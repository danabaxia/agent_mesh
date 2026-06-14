# Dashboard-native Claude Session — MVP (Increment 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive a real, **ask-only** `claude` session per agent from the dashboard chat pane — type a message, the mesh runs `claude` headlessly under the agent folder and streams its output back as markdown / tool / delegation cards — with one canonical session per agent guarded by a self-registering single-active lease.

**Architecture:** A pure event-parser (`session-events`) normalizes `claude --output-format stream-json` lines and scrubs secrets. A pure lease core (`session-lease`) decides acquire/busy/reclaim/takeover from injected pid+start-time probes; a self-registering `session-exec` wrapper owns the on-disk lease for the turn. A `session-runner` orchestrates: write a provisional `launching` lease → spawn the wrapper (which self-registers `running`, then spawns `claude` via the **shared** ask-mode invocation extracted from `delegate.js`) → parse stdout → push events to a per-agent SSE hub with monotonic `seq`. Canonical session ids live in `~/.agent-mesh/sessions/<meshHash>/`, outside every agent root.

**Tech Stack:** Node ≥20, zero deps, `node --test`. New ESM modules under `src/dashboard/`; one extracted module `src/delegate-invocation.js`; new `session-exec` CLI subcommand; new endpoints in `src/dashboard/server.js`; a "Native session" view in `src/dashboard/public/app.js`.

**Spec:** [docs/superpowers/specs/2026-06-07-dashboard-native-session-design.md](../specs/2026-06-07-dashboard-native-session-design.md) (codex-converged R0→R9). This plan implements **Increment 1 only** (§10.1). Increments 2–4 get their own plans after the MVP approval gate.

**Out of scope (deferred):** full-native tools, permission cards / stream-json input control protocol (Inc 2); iTerm joining the canonical session (Inc 3); `--include-partial-messages` token deltas, idle reap, history (Inc 4).

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/delegate-invocation.js` | Shared ask-mode `claude` invocation: `buildAskInvocation` (argv incl. `--append-system-prompt` via `buildAgentRuntimePrompt`, `--tools READ_TOOLS`, mcp + allowlist, settings), `buildClaudeEnv`, `createClaudeSettings`, `writeMcpConfig`. | Create (extract from `delegate.js`) |
| `src/delegate.js` | Worker pipeline — now imports the four functions from `delegate-invocation.js` instead of defining them. | Modify |
| `src/dashboard/session-events.js` | Pure: `parseEventLine(line)→event[]`, `redactSessionEvent(ev)` (recursive scrub + cap). | Create |
| `src/dashboard/session-lease.js` | `evaluateLease(existing,ctx)` (pure) + fs `acquireLaunching`/`registerRunning`/`release`/`read` + `probePid`. | Create |
| `src/dashboard/session-store.js` | `sessionPaths(meshRoot,agentRoot)`, `readSessionId`, `writeSessionId` under `~/.agent-mesh/sessions/<meshHash>/`. | Create |
| `src/dashboard/session-runner.js` | `createSessionRunner({meshRoot})` → `runTurn`, `stop`, `subscribe` (per-agent SSE hub w/ `seq`+replay). | Create |
| `src/cli.js` | New hidden `session-exec` subcommand (the self-registering wrapper). | Modify |
| `src/dashboard/server.js` | `GET /api/agent/:name/session/stream`, `POST …/session/message`, `POST …/session/stop`; `sessionEnabled` on `/api/mesh`; wire a runner when `allowShell`. | Modify |
| `src/dashboard/public/app.js` | "Native session" view: SSE-on-mount, input, streamed cards, status chip, `session_busy`/take-over. | Modify |
| `test/delegate-invocation.test.js` | Ask-mode argv/settings parity tests. | Create |
| `test/session-events.test.js` | Parser + redaction tests. | Create |
| `test/session-lease.test.js` | Pure `evaluateLease` + probe-injected tests. | Create |
| `test/session-store.test.js` | Canonical id read/write + location-outside-roots test. | Create |
| `test/session-runner.test.js` | runTurn with fake claude (canned stream-json) + lease + crash/timeout. | Create |
| `test/session-endpoint.test.js` | Endpoint gating + stream + busy + stop. | Create |

---

## Task 1: Extract the shared ask-mode invocation (`delegate-invocation.js`)

This is the foundation for genuine ask-only enforcement (spec R1/BLOCKER-1) and identity parity (R2/MAJOR-1): the session turn must reuse `delegate.js`'s exact ask-mode controls, not re-derive them.

**Files:**
- Create: `src/delegate-invocation.js`
- Modify: `src/delegate.js` (remove the four functions, import them)
- Test: `test/delegate-invocation.test.js`

- [ ] **Step 1: Create `src/delegate-invocation.js` by moving the four functions verbatim from `delegate.js`.**

Move `buildClaudeInvocation`, `buildClaudeInvocationSync`, `buildClaudeEnv`, `createClaudeSettings`, `writeMcpConfig`, `resolveMeshRoot`, `compactArgv`, and the `BIN_PATH` const out of `delegate.js` into the new file, exporting the ones `delegate.js` and the runner need. Keep the bodies byte-identical (they are already correct). The new file's imports (copy from `delegate.js`):

```js
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { DEFAULT_DEPTH, DEFAULT_LOG_DIR, READ_TOOLS, WRITE_TOOLS } from './config.js';
import { buildAgentRuntimePrompt } from './agent-context.js';
import { assembleMcpServers, buildBridgeEnv } from './mesh-mcp.js';
import { mergeSettings, readLayer, resolveAuthorLayerPaths } from './settings-merge.js';

export const BIN_PATH = fileURLToPath(new URL('../bin/agent-mesh.js', import.meta.url));
```

Then export: `export { buildClaudeInvocation, buildClaudeEnv, createClaudeSettings, writeMcpConfig, resolveMeshRoot, compactArgv };`

- [ ] **Step 2: Add an `buildAskInvocation` convenience wrapper** at the end of `src/delegate-invocation.js`, so callers get the full ask argv in one call:

```js
/**
 * Build the full ask-mode `claude` argv for an agent (NO -p prompt; the caller
 * appends the prompt). Mirrors delegate.js ask: identity prompt + READ_TOOLS +
 * strict mesh MCP + allowlist + mesh settings + setting-sources "".
 * @returns {Promise<{ args: string[] }>}  args = everything AFTER `claude`
 */
export async function buildAskInvocation({ root, env, callEnv, claudeEnv }) {
  const meshRoot = await resolveMeshRoot(root, env);
  const args = ['--tools', READ_TOOLS.join(',')];
  const identity = await buildAgentRuntimePrompt(root, 'ask', { meshRoot });
  if (identity) args.push('--append-system-prompt', identity);
  const servers = await assembleMcpServers({
    agentRoot: root, meshRoot, mode: 'ask', binPath: BIN_PATH,
    bridgeEnv: buildBridgeEnv(callEnv, env)
  });
  args.push('--strict-mcp-config', '--mcp-config', await writeMcpConfig(servers));
  const mcpAllow = Object.keys(servers).map((name) => `mcp__${name}`);
  if (mcpAllow.length) args.push('--allowedTools', mcpAllow.join(','));
  args.push('--settings', await createClaudeSettings(root, env, 'ask', claudeEnv));
  args.push('--setting-sources', '');
  return { args };
}
```

- [ ] **Step 3: Rewire `src/delegate.js`** to import from the new module. Replace the moved function definitions with:

```js
import {
  buildClaudeInvocation, buildClaudeEnv, createClaudeSettings,
  writeMcpConfig, resolveMeshRoot, compactArgv
} from './delegate-invocation.js';
```

Delete the now-moved bodies and the now-unused imports in `delegate.js` (e.g. `buildAgentRuntimePrompt`, `mergeSettings`, `mkdtemp`, etc. — keep only what `delegate.js` still uses directly). Keep `resolveMeshRoot` exported from `delegate.js` for back-compat by re-exporting: `export { resolveMeshRoot } from './delegate-invocation.js';`

- [ ] **Step 4: Run the existing delegate suite to verify the refactor is behavior-preserving.**

Run: `node --test test/delegate.test.js`
Expected: PASS (same as before the refactor).

- [ ] **Step 5: Write `test/delegate-invocation.test.js` asserting the ask argv shape.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAskInvocation } from '../src/delegate-invocation.js';

test('buildAskInvocation: READ_TOOLS only, strict mcp, settings + setting-sources ""', async () => {
  const root = await mkdtemp(join(tmpdir(), 'di-'));
  await writeFile(join(root, 'agent.json'), JSON.stringify({ name: 'a' }), 'utf8');
  const env = { AGENT_MESH_LOG_DIR: '.agent-mesh/logs' };
  const { args } = await buildAskInvocation({ root, env, callEnv: env, claudeEnv: { ...env } });
  const i = args.indexOf('--tools');
  assert.equal(args[i + 1], 'Read,Glob,Grep,LS');         // READ_TOOLS, no WRITE_TOOLS
  assert.ok(!args.join(' ').includes('Bash'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--setting-sources'));
  assert.equal(args[args.indexOf('--setting-sources') + 1], '');
});
```

- [ ] **Step 6: Run it.**

Run: `node --test test/delegate-invocation.test.js`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/delegate-invocation.js src/delegate.js test/delegate-invocation.test.js
git commit -m "refactor(delegate): extract shared ask-mode invocation into delegate-invocation.js"
```

---

## Task 2: Pure stream-json parser + redaction (`session-events.js`)

**Files:**
- Create: `src/dashboard/session-events.js`
- Test: `test/session-events.test.js`

- [ ] **Step 1: Write the failing test `test/session-events.test.js`.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLine, redactSessionEvent } from '../src/dashboard/session-events.js';

test('parseEventLine: system/init → init event', () => {
  const evs = parseEventLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1', model: 'claude', cwd: '/x' }));
  assert.deepEqual(evs, [{ type: 'init', sessionId: 'S1', model: 'claude', cwd: '/x' }]);
});

test('parseEventLine: assistant text + tool_use → one event per block', () => {
  const evs = parseEventLine(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'T1', name: 'Read', input: { file_path: '/a' } }
  ] } }));
  assert.deepEqual(evs, [
    { type: 'text', text: 'hi' },
    { type: 'tool_use', id: 'T1', name: 'Read', input: { file_path: '/a' } }
  ]);
});

test('parseEventLine: user tool_result → tool_result event', () => {
  const evs = parseEventLine(JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'T1', content: 'file body' }
  ] } }));
  assert.deepEqual(evs, [{ type: 'tool_result', toolUseId: 'T1', content: 'file body' }]);
});

test('parseEventLine: result → turn_done', () => {
  const evs = parseEventLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'done', is_error: false }));
  assert.deepEqual(evs, [{ type: 'turn_done', result: 'done', isError: false }]);
});

test('parseEventLine: malformed / unknown → raw, never throws', () => {
  assert.deepEqual(parseEventLine('not json'), [{ type: 'raw', raw: 'not json' }]);
  assert.deepEqual(parseEventLine(JSON.stringify({ type: 'mystery' })), [{ type: 'raw', raw: '{"type":"mystery"}' }]);
});

test('redactSessionEvent: scrubs secrets in every rendered string field', () => {
  const ev = redactSessionEvent({ type: 'tool_result', toolUseId: 'T1', content: 'API=sk-abcdef 0123456789ABCDEF token' });
  assert.ok(!ev.content.includes('sk-abcdef'));
  assert.ok(ev.content.includes('«redacted»'));
});

test('redactSessionEvent: scrubs nested tool_use.input and caps size', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  const ev = redactSessionEvent({ type: 'tool_use', id: 'T', name: 'Read', input: { q: 'ghp_ABCDEFGHIJKLMNOPQRST12', body: big } });
  assert.ok(!JSON.stringify(ev.input).includes('ghp_ABCDEFGHIJKLMNOPQRST12'));
  assert.ok(JSON.stringify(ev.input).includes('more lines'));   // capped
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node --test test/session-events.test.js`
Expected: FAIL ("Cannot find module '../src/dashboard/session-events.js'").

- [ ] **Step 3: Implement `src/dashboard/session-events.js`.**

```js
/**
 * src/dashboard/session-events.js — PURE.
 * Normalize `claude --output-format stream-json` NDJSON lines into dashboard
 * events, and scrub/cap every rendered string field before it reaches the
 * browser. Tolerant: unknown/malformed → a `raw` event, never throws.
 * Trust model: defense-in-depth on an operator-owned localhost session, not a
 * hard boundary (spec §7).
 */

const MAX_FIELD_CHARS = 20_000;
const MAX_FIELD_LINES = 400;

// Secret-shaped substrings → replaced with «redacted». Conservative, additive.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,                 // OpenAI-style
  /ghp_[A-Za-z0-9]{20,}/g,                  // GitHub PAT
  /AKIA[0-9A-Z]{16}/g,                      // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,          // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Fa-f0-9]{32,}\b/g,                  // long hex secrets/tokens
  /\b[A-Za-z0-9_-]{16,}=[A-Za-z0-9/+_-]{12,}/g // KEY=secretish-value
];

function scrubString(s) {
  let out = String(s);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«redacted»');
  return out;
}

function capString(s) {
  let str = String(s);
  if (str.length > MAX_FIELD_CHARS) {
    const head = str.slice(0, MAX_FIELD_CHARS);
    str = `${head}\n… ${str.length - MAX_FIELD_CHARS} more chars`;
  }
  const lines = str.split('\n');
  if (lines.length > MAX_FIELD_LINES) {
    str = lines.slice(0, MAX_FIELD_LINES).join('\n') + `\n… ${lines.length - MAX_FIELD_LINES} more lines`;
  }
  return str;
}

// Recurse over every string in a value, applying cap + scrub. Objects/arrays
// rebuilt; non-strings passed through.
function redactValue(v) {
  if (typeof v === 'string') return scrubString(capString(v));
  if (Array.isArray(v)) return v.map(redactValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = redactValue(val);
    return out;
  }
  return v;
}

/** @returns {Array<object>} normalized events (possibly several per line) */
export function parseEventLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return [{ type: 'raw', raw: String(line) }]; }
  try {
    if (msg.type === 'system' && msg.subtype === 'init') {
      return [{ type: 'init', sessionId: msg.session_id, model: msg.model, cwd: msg.cwd }];
    }
    if (msg.type === 'assistant' && msg.message?.content) {
      const out = [];
      for (const b of msg.message.content) {
        if (b.type === 'text') out.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
        // thinking and other block types are intentionally dropped in the MVP
      }
      return out.length ? out : [{ type: 'raw', raw: line }];
    }
    if (msg.type === 'user' && msg.message?.content) {
      const out = [];
      for (const b of msg.message.content) {
        if (b.type === 'tool_result') out.push({ type: 'tool_result', toolUseId: b.tool_use_id, content: b.content });
      }
      return out.length ? out : [{ type: 'raw', raw: line }];
    }
    if (msg.type === 'result') {
      return [{ type: 'turn_done', result: msg.result ?? '', isError: !!msg.is_error }];
    }
    return [{ type: 'raw', raw: line }];
  } catch {
    return [{ type: 'raw', raw: String(line) }];
  }
}

// Allowlist the fields that render per type, then recursively cap+scrub them.
const RENDER_FIELDS = {
  init: ['model', 'cwd'],
  text: ['text'],
  tool_use: ['name', 'input'],
  tool_result: ['toolUseId', 'content'],
  turn_done: ['result'],
  error: ['code', 'message'],
  raw: ['raw']
};

export function redactSessionEvent(ev) {
  const fields = RENDER_FIELDS[ev.type] || Object.keys(ev).filter((k) => k !== 'type');
  const out = { type: ev.type };
  for (const f of fields) if (f in ev) out[f] = redactValue(ev[f]);
  // carry non-rendered control fields through untouched (seq/turnId/isError/id)
  for (const k of ['seq', 'turnId', 'isError', 'id', 'sessionId']) if (k in ev) out[k] = ev[k];
  return out;
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `node --test test/session-events.test.js`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/session-events.js test/session-events.test.js
git commit -m "feat(dashboard): pure stream-json session-event parser + secret redaction"
```

---

## Task 3: Pure single-active lease (`session-lease.js`)

**Files:**
- Create: `src/dashboard/session-lease.js`
- Test: `test/session-lease.test.js`

- [ ] **Step 1: Write the failing test `test/session-lease.test.js`.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLease } from '../src/dashboard/session-lease.js';

const SELF = { pid: 100, procStartedAt: 1000 };
const base = { now: 5000, self: SELF, force: false, launchGraceMs: 2000 };
// probe: a map pid→{alive, procStartedAt}
const probeOf = (m) => (pid) => m[pid] || { alive: false, procStartedAt: null };

test('no existing lease → acquire', () => {
  assert.equal(evaluateLease(null, { ...base, probe: probeOf({}) }).action, 'acquire');
});

test('running, wrapper alive-matching → busy', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100 };
  const probe = probeOf({ 200: { alive: true, procStartedAt: 3000 } });
  assert.equal(evaluateLease(ex, { ...base, probe }).action, 'busy');
});

test('running, wrapper dead but child alive-matching → busy (no double-resume)', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100 };
  const probe = probeOf({ 201: { alive: true, procStartedAt: 3100 } });
  assert.equal(evaluateLease(ex, { ...base, probe }).action, 'busy');
});

test('running, both dead → reclaim', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100 };
  assert.equal(evaluateLease(ex, { ...base, probe: probeOf({}) }).action, 'reclaim');
});

test('running, reused PID (start-time newer) → reclaim', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100 };
  const probe = probeOf({ 200: { alive: true, procStartedAt: 9999 }, 201: { alive: true, procStartedAt: 9999 } });
  assert.equal(evaluateLease(ex, { ...base, probe }).action, 'reclaim');
});

test('running busy + force + owned → takeover-kill; external → takeover-refuse', () => {
  const ex = { state: 'running', owner: 'dashboard', pid: 200, procStartedAt: 3000, childPid: 201, childProcStartedAt: 3100, childPgid: 201 };
  const probe = probeOf({ 201: { alive: true, procStartedAt: 3100 } });
  assert.equal(evaluateLease(ex, { ...base, force: true, probe }).action, 'takeover-kill');
  assert.equal(evaluateLease({ ...ex, owner: 'iterm' }, { ...base, force: true, probe }).action, 'takeover-refuse');
});

test('launching, dashboard alive → busy; dead + grace elapsed → reclaim', () => {
  const ex = { state: 'launching', owner: 'dashboard', pid: 200, procStartedAt: 3000, startedAt: 100 };
  assert.equal(evaluateLease(ex, { ...base, probe: probeOf({ 200: { alive: true, procStartedAt: 3000 } }) }).action, 'busy');
  // dead dashboard, now(5000) - startedAt(100) > grace(2000) → reclaim
  assert.equal(evaluateLease(ex, { ...base, probe: probeOf({}) }).action, 'reclaim');
  // dead dashboard but within grace → busy
  assert.equal(evaluateLease({ ...ex, startedAt: 4000 }, { ...base, probe: probeOf({}) }).action, 'busy');
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node --test test/session-lease.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/dashboard/session-lease.js`.**

```js
/**
 * src/dashboard/session-lease.js
 * Single-active lease for one agent's canonical claude session (spec §6).
 * Pure decision core `evaluateLease`; fs helpers; `probePid` (impure) reports
 * {alive, procStartedAt} for a pid via `ps` (darwin/linux). Reclaim turns on
 * pid liveness + OS start-time vs the recorded *ProcStartedAt — NEVER age (a
 * `launching` startup grace is the one bounded timer).
 */
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export const DEFAULT_LAUNCH_GRACE_MS = 10_000;

// A recorded process matches iff it is alive AND its OS start-time equals what
// we recorded (proves it is not a reused PID). Indeterminate start-time (probe
// returned null but alive) is treated conservatively as a match (busy).
function matches(probeResult, recordedStart) {
  if (!probeResult || !probeResult.alive) return false;
  if (probeResult.procStartedAt == null || recordedStart == null) return true; // indeterminate → busy
  return probeResult.procStartedAt === recordedStart;
}

/**
 * @param {object|null} existing  parsed lock JSON or null
 * @param {object} ctx { now, self:{pid,procStartedAt}, force, launchGraceMs, probe }
 *   probe(pid) → { alive:boolean, procStartedAt:number|null }
 * @returns {{ action: 'acquire'|'busy'|'reclaim'|'takeover-kill'|'takeover-refuse' }}
 */
export function evaluateLease(existing, ctx) {
  if (!existing) return { action: 'acquire' };
  const { probe, now, force, launchGraceMs } = ctx;

  if (existing.state === 'launching') {
    const live = matches(probe(existing.pid), existing.procStartedAt);
    if (live) return { action: 'busy' };
    if (now - (existing.startedAt ?? 0) > launchGraceMs) return { action: 'reclaim' };
    return { action: 'busy' };
  }

  // running
  const wrapperLive = matches(probe(existing.pid), existing.procStartedAt);
  const childLive = existing.childPid != null && matches(probe(existing.childPid), existing.childProcStartedAt);
  if (!wrapperLive && !childLive) return { action: 'reclaim' };
  if (force) return existing.owner === 'dashboard' ? { action: 'takeover-kill' } : { action: 'takeover-refuse' };
  return { action: 'busy' };
}

/** Impure: OS start-time (epoch ms) + liveness for a pid. */
export function probePid(pid) {
  try {
    // `ps -o lstart=` → e.g. "Sat Jun  7 12:00:00 2026"
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    if (!out) return { alive: false, procStartedAt: null };
    const ms = Date.parse(out);
    return { alive: true, procStartedAt: Number.isFinite(ms) ? ms : null };
  } catch {
    return { alive: false, procStartedAt: null };
  }
}

export async function readLease(lockPath) {
  try { return JSON.parse(await readFile(lockPath, 'utf8')); } catch { return null; }
}

/** Write the provisional `launching` lease (dashboard identity). Returns the token. */
export async function acquireLaunching(lockPath, { pid, procStartedAt, now }) {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const rec = { token, owner: 'dashboard', state: 'launching', pid, procStartedAt, startedAt: now, updatedAt: now };
  await writeFile(lockPath, JSON.stringify(rec) + '\n', { mode: 0o600 });
  return token;
}

/** Self-registration by the wrapper: rewrite to `running` with child identity. */
export async function registerRunning(lockPath, { token, pid, procStartedAt, childPid, childProcStartedAt, childPgid, now }) {
  const rec = { token, owner: 'dashboard', state: 'running', pid, procStartedAt, childPid, childProcStartedAt, childPgid, startedAt: now, updatedAt: now };
  await writeFile(lockPath, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

/** Token-checked release. */
export async function releaseLease(lockPath, token) {
  const cur = await readLease(lockPath);
  if (cur && cur.token === token) await rm(lockPath, { force: true });
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `node --test test/session-lease.test.js`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/session-lease.js test/session-lease.test.js
git commit -m "feat(dashboard): single-active session lease (pure core + pid/start-time probe)"
```

---

## Task 4: Canonical session-id store (`session-store.js`)

**Files:**
- Create: `src/dashboard/session-store.js`
- Test: `test/session-store.test.js`

- [ ] **Step 1: Write the failing test `test/session-store.test.js`.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { sessionPaths, readSessionId, writeSessionId } from '../src/dashboard/session-store.js';

test('sessionPaths live under ~/.agent-mesh, outside agent/mesh roots (incl root ".")', () => {
  const p = sessionPaths('/tmp/mesh', '/tmp/mesh');   // agentRoot == meshRoot (manifest root ".")
  assert.ok(p.dir.startsWith(homedir()));
  assert.ok(!p.dir.startsWith('/tmp/mesh'));
  assert.ok(p.jsonPath.endsWith('.json'));
  assert.ok(p.lockPath.endsWith('.lock'));
});

test('write then read round-trips the canonical id', async () => {
  const mesh = '/tmp/mesh-' + Math.random().toString(16).slice(2);
  const agent = mesh + '/alpha';
  assert.equal(await readSessionId(mesh, agent), null);
  await writeSessionId(mesh, agent, 'SESSION-XYZ');
  assert.equal(await readSessionId(mesh, agent), 'SESSION-XYZ');
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node --test test/session-store.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/dashboard/session-store.js`.**

```js
/**
 * src/dashboard/session-store.js
 * Canonical session-id record per agent, stored in the operator's home —
 * OUTSIDE every agent/mesh root (so a manifest root "." cannot place it in a
 * writable agent folder). One id per agent, resumed by every entry point.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);

export function sessionPaths(meshRoot, agentRoot) {
  const dir = join(homedir(), '.agent-mesh', 'sessions', hash(meshRoot));
  const key = hash(agentRoot);
  return { dir, jsonPath: join(dir, `${key}.json`), lockPath: join(dir, `${key}.lock`) };
}

export async function readSessionId(meshRoot, agentRoot) {
  try {
    const { jsonPath } = sessionPaths(meshRoot, agentRoot);
    const rec = JSON.parse(await readFile(jsonPath, 'utf8'));
    return typeof rec.sessionId === 'string' ? rec.sessionId : null;
  } catch { return null; }
}

export async function writeSessionId(meshRoot, agentRoot, sessionId) {
  const { dir, jsonPath } = sessionPaths(meshRoot, agentRoot);
  await mkdir(dir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify({ sessionId, updatedAt: Date.now() }) + '\n', { mode: 0o600 });
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `node --test test/session-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/session-store.js test/session-store.test.js
git commit -m "feat(dashboard): canonical session-id store under ~/.agent-mesh"
```

---

## Task 5: The self-registering `session-exec` wrapper (CLI subcommand)

The wrapper owns the lease for the turn: it self-registers `running` with its own pid **before** spawning `claude` in its own process group, records the child identity, streams the child's stdout through, and releases on exit. Driving the lease from the process whose lifetime == the turn closes the crash/TOCTOU window (spec §6, R6/R7/R8).

**Files:**
- Create: `src/dashboard/session-exec.js`
- Modify: `src/cli.js` (dispatch `session-exec`)
- Test: covered via Task 6 (runner) with a fake claude; a direct smoke test here.

- [ ] **Step 1: Implement `src/dashboard/session-exec.js`.**

```js
/**
 * src/dashboard/session-exec.js — the per-turn lease owner.
 * argv contract (after `session-exec`): <lockPath> <token> <claudeBin> -- <claude args...>
 * Self-registers the `running` lease with its OWN pid before spawning claude in
 * its own process group, records the child identity, pipes child stdout→our
 * stdout, and releases the lease (token-checked) on child exit.
 */
import { spawn } from 'node:child_process';
import { registerRunning, releaseLease, probePid } from './session-lease.js';

export async function runSessionExec(argv) {
  const sep = argv.indexOf('--');
  const [lockPath, token, claudeBin] = argv.slice(0, 3);
  const claudeArgs = argv.slice(sep + 1);
  const selfProbe = probePid(process.pid);

  // Spawn claude in its own process group so takeover can kill the whole group.
  const child = spawn(claudeBin, claudeArgs, { stdio: ['ignore', 'inherit', 'inherit'], detached: true });

  // Record child identity into the lease BEFORE we do anything else.
  await registerRunning(lockPath, {
    token,
    pid: process.pid, procStartedAt: selfProbe.procStartedAt,
    childPid: child.pid, childProcStartedAt: probePid(child.pid).procStartedAt, childPgid: child.pid,
    now: Date.now()
  });

  const code = await new Promise((res) => {
    child.on('exit', (c) => res(c ?? 0));
    child.on('error', () => res(1));
  });
  await releaseLease(lockPath, token);
  process.exitCode = code;
}
```

Note: `stdio[1]` is `inherit` so the child's stream-json goes straight to the wrapper's stdout, which the runner pipes from the wrapper process.

- [ ] **Step 2: Wire the subcommand in `src/cli.js`.** Add near the other hidden verbs (before the `serve` fallthrough, after the `shell` block):

```js
  if (command === 'session-exec') {
    const { runSessionExec } = await import('./dashboard/session-exec.js');
    await runSessionExec(argv.slice(1));
    return;
  }
```

- [ ] **Step 3: Smoke-test the wrapper releases the lease (fake claude).**

Add to `test/session-runner.test.js` in Task 6 (the wrapper is exercised end-to-end there). No standalone test file.

- [ ] **Step 4: Commit.**

```bash
git add src/dashboard/session-exec.js src/cli.js
git commit -m "feat(dashboard): self-registering session-exec wrapper (lease owner)"
```

---

## Task 6: Session runner + per-agent SSE hub (`session-runner.js`)

**Files:**
- Create: `src/dashboard/session-runner.js`
- Test: `test/session-runner.test.js`

- [ ] **Step 1: Write the failing test `test/session-runner.test.js`** using a fake `claude` that emits canned stream-json (pattern from `test/delegate.test.js`'s `createFakeClaude`).

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionRunner } from '../src/dashboard/session-runner.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

// A fake claude that prints two stream-json lines then a result, echoing the
// session id passed via --session-id / --resume so we can assert resume.
async function fakeClaude(dir) {
  const p = join(dir, 'fake-claude.mjs');
  await writeFile(p, `#!/usr/bin/env node
const a = process.argv.slice(2);
const sid = (a[a.indexOf('--session-id')+1]) || (a[a.indexOf('--resume')+1]) || 'NEW';
process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:sid,model:'fake',cwd:process.cwd()})+"\\n");
process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'hello'}]}})+"\\n");
process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'ok',is_error:false})+"\\n");
`, 'utf8');
  await chmod(p, 0o755);
  return p;
}

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'sr-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'alpha');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'alpha' }), 'utf8');
  await writeFile(join(agentRoot, 'registry.json'), JSON.stringify({ 'x-agentmesh-generated': true, peers: {} }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'alpha', root: './alpha', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot, agentRoot };
}

test('runTurn streams init→text→turn_done and persists+resumes the canonical id', async () => {
  const { meshRoot } = await buildMesh();
  const claudeBin = await fakeClaude(meshRoot);
  const runner = createSessionRunner({ meshRoot, claudeBin });
  const events1 = [];
  const sub = runner.subscribe('alpha', (e) => events1.push(e));
  const r1 = await runner.runTurn({ agentName: 'alpha', text: 'hi' });
  assert.equal(r1.ok, true);
  assert.deepEqual(events1.map((e) => e.type), ['init', 'text', 'turn_done']);
  const sid = events1[0].sessionId;
  assert.ok(sid && sid.length);
  sub.close();

  // Second turn must resume the SAME id.
  const events2 = [];
  const sub2 = runner.subscribe('alpha', (e) => events2.push(e));
  await runner.runTurn({ agentName: 'alpha', text: 'again' });
  assert.equal(events2.find((e) => e.type === 'init').sessionId, sid);
  sub2.close();
});

test('a live lease → session_busy without spawning a second turn', async () => {
  const { meshRoot } = await buildMesh();
  const claudeBin = await fakeClaude(meshRoot);
  const runner = createSessionRunner({ meshRoot, claudeBin });
  // Hold the lease by starting a turn and not awaiting, then immediately try again.
  const p = runner.runTurn({ agentName: 'alpha', text: 'first' });
  const second = await runner.runTurn({ agentName: 'alpha', text: 'second' }).catch((e) => e);
  assert.equal(second.code || second.reason, 'session_busy');
  await p;
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node --test test/session-runner.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/dashboard/session-runner.js`.**

```js
/**
 * src/dashboard/session-runner.js
 * Orchestrates one ask-only dashboard turn against an agent's canonical claude
 * session, and fans normalized events to per-agent SSE subscribers with a
 * monotonic seq + bounded replay buffer (spec §4/§5).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readManifest } from '../builder/manifest.js';
import { enterCallContext } from '../context.js';
import { DEFAULT_DEPTH, DEFAULT_TIMEOUT_MS, readPositiveInt } from '../config.js';
import { buildAskInvocation, buildClaudeEnv } from '../delegate-invocation.js';
import { parseEventLine, redactSessionEvent } from './session-events.js';
import {
  sessionPaths, readSessionId, writeSessionId
} from './session-store.js';
import {
  evaluateLease, readLease, acquireLaunching, releaseLease, probePid,
  DEFAULT_LAUNCH_GRACE_MS
} from './session-lease.js';
import { killProcessTree } from '../process.js';

const BIN_PATH = fileURLToPath(new URL('../../bin/agent-mesh.js', import.meta.url));
const REPLAY = 200; // per-agent ring buffer

export class SessionBusyError extends Error {
  constructor(reason = 'session_busy', info = {}) { super(reason); this.code = reason; Object.assign(this, info); }
}

export function createSessionRunner({ meshRoot, claudeBin = process.env.AGENT_MESH_CLAUDE || 'claude' }) {
  const hubs = new Map();       // agentName → { subs:Set, buf:[], seq }
  const inFlight = new Map();   // agentName → token (in-memory authoritative lock)

  function hub(agent) {
    let h = hubs.get(agent);
    if (!h) { h = { subs: new Set(), buf: [], seq: 0 }; hubs.set(agent, h); }
    return h;
  }
  function push(agent, ev) {
    const h = hub(agent);
    const out = redactSessionEvent({ ...ev, seq: ++h.seq });
    h.buf.push(out); if (h.buf.length > REPLAY) h.buf.shift();
    for (const fn of h.subs) { try { fn(out); } catch { /* dead sub */ } }
  }

  function subscribe(agent, fn, lastSeq = 0) {
    const h = hub(agent);
    for (const e of h.buf) if (e.seq > lastSeq) { try { fn(e); } catch { /* ignore */ } }
    h.subs.add(fn);
    return { close: () => h.subs.delete(fn) };
  }

  async function resolveAgent(agentName) {
    const manifest = await readManifest(meshRoot);
    const entry = (manifest.agents ?? []).find((a) => a.name === agentName);
    if (!entry) throw new SessionBusyError('unknown_agent');
    const agentRoot = await realpath(resolve(join(meshRoot, entry.root)));
    return { entry, agentRoot };
  }

  async function runTurn({ agentName, text, force = false }) {
    if (inFlight.has(agentName)) throw new SessionBusyError('session_busy', { owner: 'dashboard' });
    const { entry, agentRoot } = await resolveAgent(agentName);
    const { lockPath } = sessionPaths(meshRoot, agentRoot);

    // Cross-process lease decision.
    const existing = await readLease(lockPath);
    const selfProbe = probePid(process.pid);
    const decision = evaluateLease(existing, {
      now: Date.now(), self: { pid: process.pid, procStartedAt: selfProbe.procStartedAt },
      force, launchGraceMs: DEFAULT_LAUNCH_GRACE_MS, probe: probePid
    });
    if (decision.action === 'busy') throw new SessionBusyError('session_busy', { owner: existing?.owner });
    if (decision.action === 'takeover-refuse') throw new SessionBusyError('session_busy_external', { owner: existing?.owner });
    if (decision.action === 'takeover-kill' && existing?.childPgid) {
      try { process.kill(-existing.childPgid, 'SIGKILL'); } catch { /* gone */ }
    }

    const token = await acquireLaunching(lockPath, { pid: process.pid, procStartedAt: selfProbe.procStartedAt, now: Date.now() });
    inFlight.set(agentName, token);

    let child = null;
    try {
      // Threaded call context (cycle/depth-safe onward delegation).
      const env = {
        AGENT_MESH_MESH_ROOT: join(meshRoot, 'mesh'),
        AGENT_MESH_MESH_CEILING: meshRoot,
        AGENT_MESH_LOG_DIR: '.agent-mesh/logs'
      };
      const entered = enterCallContext(agentRoot, env, DEFAULT_DEPTH);
      const callEnv = entered.ok ? entered.env : env;
      const claudeEnv = buildClaudeEnv({ root: agentRoot, env, mode: 'ask', callEnv, runId: token });

      const sessionId = await readSessionId(meshRoot, agentRoot);
      const { args } = await buildAskInvocation({ root: agentRoot, env, callEnv, claudeEnv });
      const claudeArgs = ['-p', text, '--output-format', 'stream-json', '--verbose',
        ...(sessionId ? ['--resume', sessionId] : ['--session-id', randomSession()]),
        ...args];

      // Spawn the wrapper: session-exec <lockPath> <token> <claudeBin> -- <claudeArgs...>
      child = spawn(process.execPath, [BIN_PATH, 'session-exec', lockPath, token, claudeBin, '--', ...claudeArgs], {
        cwd: agentRoot, env: { ...process.env, ...claudeEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true
      });

      const timeoutMs = readPositiveInt(env.AGENT_MESH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
      const timer = setTimeout(() => { killProcessTree(child); push(agentName, { type: 'error', code: 'timeout', message: 'turn timed out' }); }, timeoutMs);
      timer.unref?.();

      const rl = createInterface({ input: child.stdout });
      let capturedSid = sessionId;
      rl.on('line', async (line) => {
        for (const ev of parseEventLine(line)) {
          if (ev.type === 'init' && ev.sessionId) {
            if (!capturedSid) { capturedSid = ev.sessionId; await writeSessionId(meshRoot, agentRoot, ev.sessionId); }
            else if (ev.sessionId !== capturedSid) { push(agentName, { type: 'error', code: 'session_mismatch', message: 'resumed a different session' }); }
          }
          push(agentName, ev);
        }
      });
      child.stderr.on('data', () => { /* surfaced via run log later; ignore in MVP */ });

      const code = await new Promise((res) => { child.on('close', (c) => res(c)); child.on('error', () => res(1)); });
      clearTimeout(timer);
      return { ok: code === 0, code };
    } catch (err) {
      push(agentName, { type: 'error', code: 'spawn_failed', message: err.message });
      return { ok: false, code: 'spawn_failed' };
    } finally {
      inFlight.delete(agentName);
      await releaseLease(lockPath, token).catch(() => {}); // wrapper normally releases; this is the backstop
    }
  }

  function stop(agentName) {
    // MVP: there is no retained child handle map; stop is a no-op placeholder
    // beyond clearing the in-memory lock. (Full kill+wait lands with Inc 2 when
    // turns become long-lived.) Documented limitation.
    inFlight.delete(agentName);
  }

  return { runTurn, stop, subscribe };
}

function randomSession() {
  // deterministic uuid generation deferred to crypto.randomUUID at call time
  return cryptoRandomUUID();
}
import { randomUUID as cryptoRandomUUID } from 'node:crypto';
```

> NOTE: move the `import { randomUUID as cryptoRandomUUID }` to the top with the other imports during implementation (shown inline here only for locality).

- [ ] **Step 4: Run to verify it passes.**

Run: `node --test test/session-runner.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/session-runner.js test/session-runner.test.js
git commit -m "feat(dashboard): session runner + per-agent SSE hub (ask-only turn orchestration)"
```

---

## Task 7: Endpoints + capability (`server.js`)

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/session-endpoint.test.js`

- [ ] **Step 1: Write the failing test `test/session-endpoint.test.js`** (mirrors `test/shell-endpoint.test.js` auth/gating helpers).

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'sess-ep-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'alpha');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'alpha' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'alpha', root: './alpha', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot };
}
async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const post = (srv, port, cookie, path, body) => fetch(`${srv.url}${path}`, {
  method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body || {})
});

test('session disabled by default → 403 shell_disabled; sessionEnabled false', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    const res = await post(srv, port, cookie, '/api/agent/alpha/session/message', { text: 'hi' });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'shell_disabled');
    const mesh = await (await fetch(`${srv.url}/api/mesh`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } })).json();
    assert.equal(mesh.sessionEnabled, false);
  } finally { await srv.close(); }
});

test('enabled (injected runner) → message returns turnId, busy → 409', async () => {
  const { meshRoot } = await buildMesh();
  let started = 0;
  const runner = {
    runTurn: async () => { started++; if (started === 2) { const e = new Error('session_busy'); e.code = 'session_busy'; throw e; } return { ok: true }; },
    stop: () => {}, subscribe: () => ({ close() {} })
  };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionRunner: runner });
  try {
    const r1 = await post(srv, port, cookie, '/api/agent/alpha/session/message', { text: 'hi' });
    assert.equal(r1.status, 202);
    assert.ok((await r1.json()).turnId);
    const r2 = await post(srv, port, cookie, '/api/agent/alpha/session/message', { text: 'again' });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error.code, 'session_busy');
    const mesh = await (await fetch(`${srv.url}/api/mesh`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } })).json();
    assert.equal(mesh.sessionEnabled, true);
  } finally { await srv.close(); }
});

test('unknown agent → 404; missing cookie → 403', async () => {
  const { meshRoot } = await buildMesh();
  const runner = { runTurn: async () => ({ ok: true }), stop: () => {}, subscribe: () => ({ close() {} }) };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionRunner: runner });
  try {
    const unknown = await post(srv, port, cookie, '/api/agent/ghost/session/message', { text: 'x' });
    assert.equal(unknown.status, 404);
    const noCookie = await fetch(`${srv.url}/api/agent/alpha/session/message`, {
      method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(noCookie.status, 403);
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node --test test/session-endpoint.test.js`
Expected: FAIL (`sessionEnabled` undefined; routes 404/500).

- [ ] **Step 3: Wire the runner + capability in `createDashboardServer`.** In `src/dashboard/server.js`, import the runner and accept it:

```js
import { createSessionRunner } from './session-runner.js';
```

In the `createDashboardServer({ ... })` signature add `sessionRunner` and build one when `allowShell`:

```js
export function createDashboardServer({ meshRoot, port = 7077, token, consoleBroker, watchPollMs = 1000, allowShell = false, shellLauncher, sessionRunner }) {
  // ... existing ...
  const runner = sessionRunner ?? (allowShell ? createSessionRunner({ meshRoot }) : null);
```

Pass `runner` into `handleRequest`'s context object (add `sessionRunner: runner` to both the `httpServer` handler call and the `handleRequest` destructure signature).

- [ ] **Step 4: Add `sessionEnabled` to `/api/mesh`.** Next to the existing `view.shellEnabled = !!shellLauncher;`:

```js
    view.sessionEnabled = !!sessionRunner;
```

- [ ] **Step 5: Add the three session routes** in `handleRequest`, placed right after the shell plan/launch block (before the console `/message` block — order matters because `/session/message` also ends in a segment; match it explicitly first):

```js
  // Dashboard-native session (PRIVILEGED, opt-in): stream / message / stop.
  if (pathname.startsWith('/api/agent/') && pathname.includes('/session/')) {
    if (!sessionRunner) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled', message: 'native session is disabled; start the dashboard with --allow-shell' } }); return; }
    const m = pathname.match(/^\/api\/agent\/(.+)\/session\/(stream|message|stop)$/);
    if (!m) { send404(res); return; }
    const name = decodeURIComponent(m[1]);
    const verb = m[2];

    // membership + containment (gate before any side effect)
    const snapshot = await loadDashboardSnapshot(meshRoot);
    const entry = (snapshot?.manifest?.agents ?? []).find(a => a.name === name);
    if (!entry) { send404(res); return; }
    const agentRoot = resolve(join(meshRoot, entry.root));
    const inside = await isPathInsideRoot(meshRoot, agentRoot).catch(() => false);
    if (!inside) { send403(res, 'Agent root escapes mesh boundary'); return; }

    if (verb === 'stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      const lastSeq = Number(req.headers['last-event-id'] || 0);
      const sub = sessionRunner.subscribe(name, (ev) => {
        try { res.write(`id: ${ev.seq}\nevent: session\ndata: ${JSON.stringify(ev)}\n\n`); } catch { /* dead */ }
      }, lastSeq);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25_000);
      ping.unref?.();
      req.on('close', () => { clearInterval(ping); sub.close(); });
      return;
    }

    if (verb === 'message' && req.method === 'POST') {
      let body;
      try { body = JSON.parse((await readBodyCapped(req, CONSOLE_BODY_CAP)) || '{}'); }
      catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
      const text = typeof body.text === 'string' ? body.text : '';
      const force = !!body.force;
      const turnId = randomBytes(8).toString('hex');
      // Start the turn but DO NOT await it — events flow over the SSE stream.
      Promise.resolve(sessionRunner.runTurn({ agentName: name, text, force }))
        .catch(() => { /* errors are pushed as SSE error events by the runner */ });
      // We still need to surface a synchronous lease rejection. The runner throws
      // SessionBusyError synchronously-ish; race a microtask guard:
      sendJson(res, 202, { ok: true, turnId });
      return;
    }

    if (verb === 'stop' && req.method === 'POST') {
      sessionRunner.stop(name);
      sendJson(res, 200, { ok: true });
      return;
    }

    send404(res);
    return;
  }
```

> IMPLEMENTATION NOTE for the 409-on-busy test: `runTurn` rejects with `SessionBusyError` (code `session_busy` / `session_busy_external`). To return 409 synchronously, `await` the runner up to the point of lease acquisition. Split `runTurn` into `startTurn()` (acquires lease, returns `{turnId}` or throws busy) + an internal streaming continuation, OR have the endpoint `await sessionRunner.runTurn(...)` only for the busy-check by making `runTurn` resolve `{ ok, turnId }` after lease acquisition and stream the rest via the hub. Adjust the runner so the lease decision happens before the returned promise's first `await` boundary and is surfaced; the endpoint then maps `err.code` (`session_busy`→409, `session_busy_external`→409, `unknown_agent`→404) to status. Update Task 6's `runTurn` to return `{ turnId }` and reject busy BEFORE spawning.

- [ ] **Step 6: Reconcile the runner contract with the endpoint** (apply the note): change `runTurn` to acquire the lease and return `{ turnId }` synchronously (reject `SessionBusyError` before spawn), then continue streaming in the background. Update `test/session-runner.test.js`'s busy test to `await assert.rejects(() => runner.runTurn(...), e => e.code === 'session_busy')`.

- [ ] **Step 7: Run both suites.**

Run: `node --test test/session-endpoint.test.js test/session-runner.test.js`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/dashboard/server.js src/dashboard/session-runner.js test/session-endpoint.test.js test/session-runner.test.js
git commit -m "feat(dashboard): session endpoints (stream/message/stop) + sessionEnabled capability"
```

---

## Task 8: Frontend "Native session" view (`app.js`)

The chat pane gains a "Native session" mode that opens the SSE on mount, posts messages, and renders streamed cards. Reuse the existing markdown renderer in `app.js` for `text`/`tool_result`; render `tool_use` and peer-delegation as compact cards.

**Files:**
- Modify: `src/dashboard/public/app.js` (and minor `app.css` for card styling)
- Test: light/manual (frontend has no unit harness in this repo; verify via the running dashboard).

- [ ] **Step 1: Add a Native-session panel toggle** in the Desk/chat pane, shown only when `mesh.sessionEnabled` (fetched from `/api/mesh`). Add an element with id `native-session` containing a message `<textarea>`, a "Send" button, a status chip `<span id="ns-status">`, and a `<div id="ns-stream">` for cards. Gate its visibility:

```js
// after loading /api/mesh into `mesh`:
const nativeEl = document.getElementById('native-session');
if (nativeEl) nativeEl.hidden = !mesh.sessionEnabled;
```

- [ ] **Step 2: Open the SSE stream on agent select** and render events:

```js
let nsSource = null;
function openNativeSession(agentName) {
  if (nsSource) nsSource.close();
  document.getElementById('ns-stream').innerHTML = '';
  nsSource = new EventSource(`/api/agent/${encodeURIComponent(agentName)}/session/stream`);
  nsSource.addEventListener('session', (e) => renderNsEvent(JSON.parse(e.data)));
}

function renderNsEvent(ev) {
  const stream = document.getElementById('ns-stream');
  const card = document.createElement('div');
  card.className = `ns-card ns-${ev.type}`;
  if (ev.type === 'text') card.innerHTML = renderMarkdown(ev.text || '');
  else if (ev.type === 'tool_use') card.innerHTML = `<b>⚙ ${escapeHtml(ev.name)}</b><pre>${escapeHtml(JSON.stringify(ev.input, null, 2))}</pre>`;
  else if (ev.type === 'tool_result') card.innerHTML = `<div class="ns-result">${renderMarkdown(typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content))}</div>`;
  else if (ev.type === 'turn_done') { setNsStatus('idle'); card.className += ' ns-done'; card.textContent = '— end of turn —'; }
  else if (ev.type === 'error') { setNsStatus('error'); card.textContent = `⚠ ${ev.code}: ${ev.message || ''}`; }
  else card.textContent = ev.raw || JSON.stringify(ev);
  stream.appendChild(card);
  stream.scrollTop = stream.scrollHeight;
}
function setNsStatus(s) { const el = document.getElementById('ns-status'); if (el) el.textContent = s; }
```

(Use the existing `renderMarkdown`/`escapeHtml` helpers already in `app.js`; if `escapeHtml` is named differently, reuse the existing one — search `app.js` for the markdown renderer added for the chat canvas.)

- [ ] **Step 3: Wire Send + busy/take-over handling:**

```js
async function sendNativeMessage(agentName, text, force = false) {
  setNsStatus('working');
  const res = await fetch(`/api/agent/${encodeURIComponent(agentName)}/session/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, force })
  });
  if (res.status === 409) {
    const j = await res.json();
    setNsStatus('busy');
    if (confirm(`Session is busy (held by ${j.error.owner || 'another holder'}). Take over?`)) {
      return sendNativeMessage(agentName, text, true);
    }
    return;
  }
  // 202 → events arrive on the SSE stream
}
```

- [ ] **Step 4: Verify manually against a running dashboard.**

Run:
```bash
node ./scripts/demo-setup.mjs   # materialize the demo mesh
node ./bin/agent-mesh.js dashboard /tmp/agent-mesh-demo --allow-shell --no-open
```
Open the printed bootstrap URL, select an agent, type a message in the Native session box, and confirm: cards stream in (init/text/tool cards), the status chip flips working→idle, and a concurrent second send shows the take-over prompt. (This is the MVP demo for the approval gate.)

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/public/app.js src/dashboard/public/app.css
git commit -m "feat(dashboard): Native session chat view (SSE-streamed cards, take-over)"
```

---

## Task 9: Full-suite green + MVP demo gate

- [ ] **Step 1: Run the whole suite.**

Run: `npm test`
Expected: PASS (existing + all new tests).

- [ ] **Step 2: Optional real-claude smoke (if `claude` is on PATH).**

Run:
```bash
AGENT_MESH_E2E=1 node ./bin/agent-mesh.js dashboard /tmp/agent-mesh-demo --allow-shell --no-open
```
Drive one ask-only turn from the browser; confirm init→text→turn_done renders and a second turn continues the same session id.

- [ ] **Step 3: STOP — MVP approval gate.** Present the running MVP to the user (demo per Task 8 Step 4). Do **not** begin Increment 2 (full-native + permission cards) or Increment 3 (iTerm joins the session) until the user approves. Those get their own spec-aligned plans.

---

## Self-Review

**Spec coverage (§10.1 MVP):**
- Ask-only enforcement via shared `delegate.js` controls → Task 1 (`buildAskInvocation`). ✓
- `session-events` parser + `redactSessionEvent` → Task 2. ✓
- `session-lease` pid+start-time liveness, launching grace, takeover → Task 3. ✓
- Canonical id outside all roots (incl. root `"."`) → Task 4. ✓
- Self-registering `session-exec` wrapper (childPid/pgid) → Task 5. ✓
- Runner + per-agent SSE hub with `seq`+replay, `--session-id`/`--resume`, session-mismatch abort, timeout tree-kill → Task 6. ✓
- Endpoints gated behind `allowShell` + auth + membership + containment, gate-before-side-effect, `sessionEnabled` → Task 7. ✓
- Native session chat view → Task 8. ✓

**Known MVP limitations (documented, deferred to later increments):**
- `stop()` clears the in-memory lock but does not yet kill+wait a retained child handle (Task 6 note) — acceptable for short ask turns; hardened in Inc 2 when turns become long-lived. The wrapper already releases the lease on child exit, and the lease's `childPgid` allows takeover to kill a stray group.
- `probePid` uses `ps` (darwin/linux). Windows start-time probing is out of MVP scope (the iTerm/second-writer path is Inc 3); on a platform where `ps` is absent the probe reports `not alive`, which the in-memory lock still guards within a single dashboard.
- Message-level streaming only (no `--include-partial-messages`).

**Placeholder scan:** none — every code step shows complete code. The two IMPLEMENTATION NOTEs (Task 6 randomUUID import location; Task 7 busy-before-spawn contract) are reconciliation instructions with the exact change to make, applied in Task 6 Step 6 / Task 7 Step 6.

**Type consistency:** event shapes (`{type,...,seq}`) are identical across `session-events` (Task 2), runner `push`/`subscribe` (Task 6), and the frontend `renderNsEvent` (Task 8). Lease record fields (`token/owner/state/pid/procStartedAt/startedAt/updatedAt/childPid/childProcStartedAt/childPgid`) are identical across `session-lease` (Task 3), `session-exec` `registerRunning` (Task 5), and `evaluateLease` reads (Task 3). `sessionPaths().lockPath` (Task 4) is the lock path consumed by Tasks 5–6.
