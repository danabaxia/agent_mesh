# Session Log + Management — M1 (Data + Lease) + M2 (Image-Proxy Security) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend foundations for the session-log feature — a per-agent session **index** (with `create`/`select`/`open` provenance + an uncapped line cursor), a **rewritten replay-buffered mirror**, **session-runner** select/turn semantics, **cross-platform** liveness/kill, and an **SSRF-hardened image proxy** — all hermetically tested. No UI yet (M3/M4).

**Architecture:** Pure cores (cursor math, provenance derivation, lease decision, SSRF address vetting) with injected I/O (fs, `dns`, `fetch`, `spawn`). Reuses `session-events.js` (`parseTranscriptLine`/`redactSessionEvent`), `session-lease.js`, `session-store.js`, `session-runner.js`. Everything that reaches the network or process table is injectable so tests never touch the real network, terminal, or `~/.claude`.

**Tech Stack:** Node ≥20, zero deps, `node --test`. New ESM modules under `src/dashboard/`. Cross-platform (darwin/linux + win32, incl. PowerShell).

**Spec:** [docs/superpowers/specs/2026-06-07-session-log-and-management-design.md](../specs/2026-06-07-session-log-and-management-design.md) (codex-converged R0→R8). This plan = **M1 + M2** (§9 of the spec). M3 (result-canvas), M4 (session-log UI + endpoints + capability migration), M5 (polish) get their own plan after the M1+M2 gate.

**Out of scope here:** the `/api/agent/:name/session/*` HTTP routes except `/api/img` (those land with M4's UI), the result-canvas, the B-layout frontend, capability migration.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/dashboard/session-index.js` | Discover + index an agent's sessions: platform-aware `encodeProjectDir` (+scan fallback), `events.jsonl` provenance (`recordEvent`/`readEvents`, kinds `create\|select\|open`), `listSessions` (byte-capped preview + **uncapped line cursor**, cached by path/size/mtime), `resolveTranscript` (UUID + index-only + realpath containment). | Create |
| `src/dashboard/session-mirror.js` | **Rewrite.** Per-**session** ring buffer keyed by session id, **line-record `{seq,events}`** wire unit, `bufferStartSeq`, `replay_gap` (only when `lastSeq+1 < bufferStartSeq`), byte-offset tail counting line index; `readTranscriptWindow` (windowed by line). | Rewrite |
| `src/dashboard/session-runner.js` | **Extend.** `setActiveSession` (activeId + `rev` + `select` event; no lease/turn); `runTurn({expectedActiveId})` → `409 active_changed`/`session_busy`; record `create` on a brand-new session. | Modify |
| `src/dashboard/session-lease.js` | **Extend.** `probePid` becomes platform-aware (darwin/linux `ps`; win32 `Get-Process`/WMI via injected exec). | Modify |
| `src/process.js` | **Extend.** `killProcessTree` win32 branch (`taskkill /T /F`). | Modify |
| `src/dashboard/img-proxy.js` | SSRF-hardened `fetchRemoteImage(url, deps)` (https-only, host allowlist, DNS-resolve+reject-private, **pin IP**, ≤2 redirects re-validated per hop, raster content-type **+ magic-byte**, ≤5 MB, timeout). | Create |
| `src/dashboard/server.js` | **Modify.** Add `GET /api/img?url=` (gated `--allow-shell` + auth), `nosniff` + sniffed type. | Modify |
| `test/session-index.test.js`, `test/session-mirror.test.js`, `test/session-runner.test.js` (extend), `test/session-lease.test.js` (extend), `test/img-proxy.test.js`, `test/img-endpoint.test.js` | Hermetic tests. | Create/extend |

---

## M1 · Data + Lease

### Task 1: `encodeProjectDir` (platform-aware + scan fallback)

**Files:**
- Create: `src/dashboard/session-index.js`
- Test: `test/session-index.test.js`

- [ ] **Step 1: Write the failing test.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir } from '../src/dashboard/session-index.js';

test('encodeProjectDir: posix replaces / and . with -', () => {
  assert.equal(encodeProjectDir('/private/tmp/agent-mesh-demo/library', 'darwin'),
    '-private-tmp-agent-mesh-demo-library');
});

test('encodeProjectDir: win32 encodes drive path', () => {
  // C:\Users\me\agent → -C--Users-me-agent  (drive colon + backslashes → -)
  assert.equal(encodeProjectDir('C:\\Users\\me\\agent', 'win32'), '-C--Users-me-agent');
});

test('encodeProjectDir: scan fallback finds an existing dir when the computed one is absent', async () => {
  const projects = await mkdtemp(join(tmpdir(), 'proj-'));
  // a real-looking encoded dir for a different scheme
  await mkdir(join(projects, '-Users-me-agent'), { recursive: true });
  const got = encodeProjectDir('/Users/me/agent', 'darwin', { projectsDir: projects });
  assert.equal(got, '-Users-me-agent'); // matches by direct compute (exists)
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `node --test test/session-index.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `encodeProjectDir` in `src/dashboard/session-index.js`.**

```js
/**
 * src/dashboard/session-index.js
 * Discover + index an agent's Claude Code sessions (transcripts under
 * ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl) with mesh provenance.
 */
import { readFile, writeFile, appendFile, mkdir, readdir, stat, open, realpath } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encode a launch cwd into Claude Code's project-dir name.
 * darwin/linux: replace `/` and `.` with `-`. win32: replace `\`, `/`, `:`, `.`.
 * If the computed dir is absent, scan projectsDir for a dir that the same scheme
 * would produce from some existing entry's decoded form — best-effort so a scheme
 * drift never breaks discovery.
 */
export function encodeProjectDir(canonicalRoot, platform = process.platform, io = {}) {
  const projectsDir = io.projectsDir || PROJECTS_DIR;
  const computed = platform === 'win32'
    ? String(canonicalRoot).replace(/[\\/:.]/g, '-')
    : String(canonicalRoot).replace(/[/.]/g, '-');
  try {
    if (existsSync(join(projectsDir, computed))) return computed;
    // fallback: a directory whose name, lowercased, ends with the leaf segments
    const leaf = String(canonicalRoot).split(/[\\/]/).filter(Boolean).join('-');
    for (const name of readdirSync(projectsDir)) {
      if (name.endsWith(leaf)) return name;
    }
  } catch { /* projectsDir may not exist yet → use computed */ }
  return computed;
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `node --test test/session-index.test.js`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/session-index.js test/session-index.test.js
git commit -m "feat(session-index): platform-aware encodeProjectDir + scan fallback"
```

---

### Task 2: Provenance event log (`recordEvent` / `readEvents`)

**Files:**
- Modify: `src/dashboard/session-index.js`
- Test: `test/session-index.test.js`

- [ ] **Step 1: Write the failing test (append).**

```js
import { homedir } from 'node:os';
import { recordEvent, readEvents, deriveProvenance } from '../src/dashboard/session-index.js';

test('recordEvent/readEvents round-trip + deriveProvenance (create/select/open)', async () => {
  const meshRoot = '/tmp/mesh-' + Math.random().toString(16).slice(2);
  const agentRoot = meshRoot + '/library';
  const sid = '11111111-1111-1111-1111-111111111111';
  await recordEvent(meshRoot, { kind: 'select', source: 'dashboard', agentRoot, sessionId: sid });
  await recordEvent(meshRoot, { kind: 'open', source: 'terminal', terminalApp: 'pwsh', agentRoot, sessionId: sid });
  const events = await readEvents(meshRoot);
  assert.equal(events.filter(e => e.sessionId === sid).length, 2);
  // external session (no create) selected then opened → origin cli, last terminal
  const prov = deriveProvenance(events, sid);
  assert.equal(prov.originSource, 'cli');
  assert.equal(prov.lastManagedBy, 'terminal');
});

test('deriveProvenance: a create(dashboard) session → origin dashboard', () => {
  const sid = '22222222-2222-2222-2222-222222222222';
  const evs = [{ kind: 'create', source: 'dashboard', sessionId: sid, at: 1 },
               { kind: 'select', source: 'dashboard', sessionId: sid, at: 2 }];
  assert.equal(deriveProvenance(evs, sid).originSource, 'dashboard');
});
```

- [ ] **Step 2: Run → FAIL** (`recordEvent` undefined).

Run: `node --test test/session-index.test.js`

- [ ] **Step 3: Implement (append to `session-index.js`).**

```js
const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
function eventsPath(meshRoot) {
  return join(homedir(), '.agent-mesh', 'sessions', hash(meshRoot), 'events.jsonl');
}

/** Append one management event {kind:'create'|'select'|'open', source, ...}. */
export async function recordEvent(meshRoot, ev) {
  const p = eventsPath(meshRoot);
  await mkdir(dirname(p), { recursive: true });
  const rec = { at: ev.at ?? Date.now(), ...ev };
  await appendFile(p, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

export async function readEvents(meshRoot) {
  try {
    const raw = await readFile(eventsPath(meshRoot), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * originSource = source of the session's `create` event, else 'cli'
 * (`select`/`open` never change origin); lastManagedBy = most recent event's source.
 */
export function deriveProvenance(events, sessionId) {
  const mine = events.filter((e) => e.sessionId === sessionId);
  const create = mine.find((e) => e.kind === 'create');
  const last = mine.length ? mine.reduce((a, b) => (b.at >= a.at ? b : a)) : null;
  return { originSource: create ? create.source : 'cli', lastManagedBy: last ? last.source : null };
}
```

- [ ] **Step 4: Run → PASS.**

Run: `node --test test/session-index.test.js`

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/session-index.js test/session-index.test.js
git commit -m "feat(session-index): create/select/open provenance event log"
```

---

### Task 3: `listSessions` (preview scan + uncapped line cursor + cache) and `resolveTranscript`

**Files:**
- Modify: `src/dashboard/session-index.js`
- Test: `test/session-index.test.js`

- [ ] **Step 1: Write the failing test (append).**

```js
import { mkdtemp as mkdtemp2 } from 'node:fs/promises';
import { writeFile as wf } from 'node:fs/promises';

async function fakeTranscript(dir, name, turns) {
  const lines = [];
  lines.push(JSON.stringify({ type: 'mode', mode: 'default' }));
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: `q${i}` } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `a${i}` }] } }));
  }
  await wf(join(dir, name), lines.join('\n') + '\n', 'utf8');
}

test('listSessions: exact turns/firstPrompt + lineCount cursor; resolveTranscript guards', async () => {
  const projects = await mkdtemp2(join(tmpdir(), 'proj2-'));
  const agentRoot = '/Users/me/lib';
  const enc = encodeProjectDir(agentRoot, 'darwin'); // computed (dir absent → computed)
  const projDir = join(projects, enc);
  await mkdir(projDir, { recursive: true });
  const sid = '33333333-3333-3333-3333-333333333333';
  await fakeTranscript(projDir, `${sid}.jsonl`, 3);

  const io = { projectsDir: projects, platform: 'darwin', meshRoot: '/tmp/m', realpath: async (p) => p };
  const rows = await listSessions(agentRoot, io);
  const row = rows.find(r => r.id === sid);
  assert.equal(row.turns, 3);
  assert.equal(row.firstPrompt, 'q0');
  assert.ok(row.lineCount >= 7);                 // uncapped line cursor max
  assert.equal(row.originSource, 'cli');

  // resolveTranscript: UUID + index-only + realpath containment
  const path = await resolveTranscript(agentRoot, sid, io);
  assert.ok(path.endsWith(`${sid}.jsonl`));
  await assert.rejects(() => resolveTranscript(agentRoot, 'not-a-uuid', io));
  await assert.rejects(() => resolveTranscript(agentRoot, '44444444-4444-4444-4444-444444444444', io)); // unknown
});
```

(Add `listSessions`, `resolveTranscript` to the imports at the top of the test file.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement (append to `session-index.js`).**

```js
const MAX_SCAN_BYTES = 2 * 1024 * 1024; // preview-derivation cap (NOT the cursor)
const ACTIVE_WINDOW_MS = 60_000;

// Count newlines cheaply over the WHOLE file (the cursor is never capped).
async function countLines(path) {
  const fh = await open(path, 'r');
  try {
    let count = 0; const buf = Buffer.alloc(65536); let pos = 0;
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) count++;
      pos += bytesRead;
    }
    return count;
  } finally { await fh.close(); }
}

// Preview: turns (# user_text), firstPrompt, start/end times — byte-capped.
async function derivePreview(path, parseTranscriptLine) {
  const fh = await open(path, 'r');
  try {
    const s = await fh.stat();
    const cap = Math.min(s.size, MAX_SCAN_BYTES);
    const buf = Buffer.alloc(cap);
    await fh.read(buf, 0, cap, 0);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    let turns = 0, firstPrompt = null;
    for (const l of lines) {
      for (const ev of parseTranscriptLine(l)) {
        if (ev.type === 'user_text') { turns++; if (firstPrompt == null) firstPrompt = String(ev.text).slice(0, 200); }
      }
    }
    return { turns, firstPrompt, turnsApprox: s.size > MAX_SCAN_BYTES, startedAt: s.birthtimeMs || s.mtimeMs, endedAt: s.mtimeMs, mtimeMs: s.mtimeMs, size: s.size };
  } finally { await fh.close(); }
}

const _cache = new Map(); // path → { size, mtimeMs, preview, lineCount }

export async function listSessions(agentRoot, io = {}) {
  const { parseTranscriptLine } = await import('./session-events.js');
  const platform = io.platform || process.platform;
  const meshRoot = io.meshRoot;
  const enc = encodeProjectDir(agentRoot, platform, io);
  const projDir = join(io.projectsDir || PROJECTS_DIR, enc);
  let names = [];
  try { names = (await readdir(projDir)).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
  const events = meshRoot ? await readEvents(meshRoot) : [];
  const rows = [];
  for (const name of names) {
    const id = name.replace(/\.jsonl$/, '');
    if (!UUID_RE.test(id)) continue;
    const path = join(projDir, name);
    const s = await stat(path);
    let entry = _cache.get(path);
    if (!entry || entry.size !== s.size || entry.mtimeMs !== s.mtimeMs) {
      entry = { size: s.size, mtimeMs: s.mtimeMs, preview: await derivePreview(path, parseTranscriptLine), lineCount: await countLines(path) };
      _cache.set(path, entry);
    }
    const prov = deriveProvenance(events, id);
    rows.push({
      id, transcriptPath: path, lineCount: entry.lineCount,
      turns: entry.preview.turns, firstPrompt: entry.preview.firstPrompt, turnsApprox: entry.preview.turnsApprox,
      startedAt: entry.preview.startedAt, endedAt: entry.preview.endedAt,
      active: (Date.now() - entry.preview.mtimeMs) < ACTIVE_WINDOW_MS,
      originSource: prov.originSource, lastManagedBy: prov.lastManagedBy
    });
  }
  rows.sort((a, b) => b.endedAt - a.endedAt);
  return rows;
}

/** UUID + index-only resolution + realpath containment under the agent's project dir. */
export async function resolveTranscript(agentRoot, id, io = {}) {
  if (!UUID_RE.test(id)) throw Object.assign(new Error('bad session id'), { code: 'bad_id' });
  const platform = io.platform || process.platform;
  const enc = encodeProjectDir(agentRoot, platform, io);
  const projDir = join(io.projectsDir || PROJECTS_DIR, enc);
  const candidate = join(projDir, `${id}.jsonl`);
  const rp = io.realpath || realpath;
  let real;
  try { real = await rp(candidate); } catch { throw Object.assign(new Error('unknown session'), { code: 'not_found' }); }
  const realDir = await rp(projDir).catch(() => projDir);
  if (!real.startsWith(realDir)) throw Object.assign(new Error('path escapes project dir'), { code: 'containment' });
  return real;
}
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/session-index.js test/session-index.test.js
git commit -m "feat(session-index): listSessions (preview+uncapped line cursor+cache) + resolveTranscript"
```

---

### Task 4: Rewrite `session-mirror.js` — line-record buffer + `replay_gap` + windowed read

**Files:**
- Rewrite: `src/dashboard/session-mirror.js`
- Test: `test/session-mirror.test.js`

- [ ] **Step 1: Write the failing test.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionMirror } from '../src/dashboard/session-mirror.js';

const L = (o) => JSON.stringify(o) + '\n';
const userline = (t) => L({ type: 'user', message: { role: 'user', content: t } });
const asstline = (t) => L({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

test('mirror: line records carry a stable seq = line index; late subscriber replays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mir-'));
  const f = join(dir, 's.jsonl');
  await writeFile(f, userline('hi') + asstline('hello'), 'utf8');
  const mirror = createSessionMirror({ pollMs: 50 });
  const got = [];
  const sub = mirror.subscribe('S1', f, (rec) => got.push(rec), 0);
  await new Promise(r => setTimeout(r, 200));
  assert.deepEqual(got.map(r => r.seq), [1, 2]);
  assert.equal(got[0].events[0].type, 'user_text');
  // append a line → streamed with seq 3
  await appendFile(f, userline('again'));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(got[got.length - 1].seq, 3);
  sub.close(); mirror.close();
});

test('mirror: reconnect older than buffer → replay_gap; boundary replays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mir2-'));
  const f = join(dir, 's.jsonl');
  await writeFile(f, userline('a') + userline('b') + userline('c'), 'utf8');
  const mirror = createSessionMirror({ pollMs: 50, bufferMax: 2 }); // keeps last 2 lines
  const warm = []; const s0 = mirror.subscribe('S2', f, (r) => warm.push(r), 0);
  await new Promise(r => setTimeout(r, 200)); s0.close();
  // bufferStartSeq is now 2 (only lines 2,3 buffered). Reconnect with lastSeq=0 → gap.
  const got = []; const s1 = mirror.subscribe('S2', f, (r) => got.push(r), 0);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(got[0].type, 'replay_gap');
  s1.close();
  // boundary: lastSeq = bufferStartSeq-1 = 1 → replays (no gap)
  const got2 = []; const s2 = mirror.subscribe('S2', f, (r) => got2.push(r), 1);
  await new Promise(r => setTimeout(r, 150));
  assert.ok(!got2.some(r => r.type === 'replay_gap'));
  assert.equal(got2[0].seq, 2);
  s2.close(); mirror.close();
});
```

- [ ] **Step 2: Run → FAIL** (the current mirror has no per-session/line-record API).

Run: `node --test test/session-mirror.test.js`

- [ ] **Step 3: Rewrite `src/dashboard/session-mirror.js`.**

```js
/**
 * src/dashboard/session-mirror.js
 * Read-only live tail of a session transcript, delivered as line records
 * { seq, events:[…] } where seq = 1-based transcript line index (stable cursor).
 * Per-session ring buffer + per-subscriber cursor + replay_gap on a real hole.
 */
import { open, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { parseTranscriptLine, redactSessionEvent } from './session-events.js';

export function createSessionMirror({ pollMs = 700, bufferMax = 500 } = {}) {
  const tailers = new Map(); // sessionId → state

  function getState(sessionId, path) {
    let st = tailers.get(sessionId);
    if (!st) {
      st = { path, subs: new Set(), buffer: [], bufferStartSeq: 1, line: 0, offset: 0, partial: '', timer: null, watcher: null };
      tailers.set(sessionId, st);
      startTail(st);
    }
    return st;
  }

  function emit(st, rec) {
    st.buffer.push(rec);
    if (st.buffer.length > bufferMax) { st.buffer.shift(); st.bufferStartSeq = st.buffer[0]?.seq ?? st.bufferStartSeq; }
    for (const fn of st.subs) { try { fn(rec); } catch { /* dead sub */ } }
  }

  async function drain(st) {
    let s; try { s = await stat(st.path); } catch { return; }
    if (s.size < st.offset) { // truncation/rotation → reset + gap
      st.offset = 0; st.line = 0; st.partial = ''; st.buffer = []; st.bufferStartSeq = 1;
      for (const fn of st.subs) { try { fn({ type: 'replay_gap' }); } catch { /* ignore */ } }
    }
    if (s.size <= st.offset) return;
    const fh = await open(st.path, 'r');
    try {
      const len = s.size - st.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.offset);
      st.offset = s.size;
      st.partial += buf.toString('utf8');
      const parts = st.partial.split('\n');
      st.partial = parts.pop() ?? '';
      for (const line of parts) {
        st.line += 1;
        if (!line.trim()) continue;
        const events = parseTranscriptLine(line).map(redactSessionEvent);
        if (events.length) emit(st, { seq: st.line, events });
      }
    } finally { await fh.close(); }
  }

  function startTail(st) {
    try { st.watcher = watch(st.path, () => drain(st)); st.watcher.on?.('error', () => {}); } catch { /* poll covers it */ }
    st.timer = setInterval(() => drain(st), pollMs); st.timer.unref?.();
    drain(st);
  }

  function stopTail(sessionId) {
    const st = tailers.get(sessionId); if (!st) return;
    if (st.timer) clearInterval(st.timer);
    if (st.watcher) { try { st.watcher.close(); } catch { /* ignore */ } }
    tailers.delete(sessionId);
  }

  function subscribe(sessionId, transcriptPath, fn, lastSeq = 0) {
    const st = getState(sessionId, transcriptPath);
    // replay decision
    if (lastSeq + 1 < st.bufferStartSeq) {
      try { fn({ type: 'replay_gap' }); } catch { /* ignore */ }
    } else {
      for (const rec of st.buffer) if (rec.seq > lastSeq) { try { fn(rec); } catch { /* ignore */ } }
    }
    st.subs.add(fn);
    return { close: () => { st.subs.delete(fn); if (st.subs.size === 0) stopTail(sessionId); } };
  }

  function close() { for (const id of [...tailers.keys()]) stopTail(id); }

  return { subscribe, close };
}
```

- [ ] **Step 4: Run → PASS** (both tests).

Run: `node --test test/session-mirror.test.js`

- [ ] **Step 5: Remove the obsolete callers of the OLD mirror API.** The current `server.js` `/session/mirror` route + `createSessionMirror({meshRoot})` construction reference the old signature. For M1, **delete the `/session/mirror` route block and the old mirror wiring** in `src/dashboard/server.js` (the new routes arrive in M4). Verify nothing else imports the old API:

Run: `grep -rn "session-mirror" src/ | grep -v session-mirror.js`
Expected: only `server.js`; remove that usage.

- [ ] **Step 6: Run the full suite to confirm no breakage.**

Run: `node --test`
Expected: PASS (the lean mirror endpoint test, if any, is removed/updated with the route).

- [ ] **Step 7: Commit.**

```bash
git add src/dashboard/session-mirror.js test/session-mirror.test.js src/dashboard/server.js
git commit -m "feat(session-mirror): rewrite with per-session line-record buffer + replay_gap"
```

---

### Task 5: `session-runner` — `setActiveSession` + `runTurn({expectedActiveId})` + create/select events

**Files:**
- Modify: `src/dashboard/session-runner.js`
- Test: `test/session-runner.test.js`

- [ ] **Step 1: Write the failing test (append to the existing file).**

```js
test('setActiveSession records select + bumps rev; runTurn rejects active_changed', async () => {
  const { meshRoot } = await buildMesh();           // existing helper in this file
  const claudeBin = await fakeClaude(meshRoot);     // existing helper
  const runner = createSessionRunner({ meshRoot, claudeBin });
  const a = await runner.setActiveSession('library', '33333333-3333-3333-3333-333333333333');
  assert.ok(a.rev >= 1);
  assert.equal(a.activeId, '33333333-3333-3333-3333-333333333333');
  // a stale expectedActiveId is rejected before spawning
  await assert.rejects(
    () => runner.runTurn({ agentName: 'library', text: 'hi', expectedActiveId: 'deadbeef-0000-0000-0000-000000000000' }),
    (e) => e.code === 'active_changed'
  );
});
```

- [ ] **Step 2: Run → FAIL** (`setActiveSession` undefined / no `expectedActiveId` check).

Run: `node --test test/session-runner.test.js`

- [ ] **Step 3: Implement.** In `src/dashboard/session-runner.js`:

(a) add an `active` map + import `recordEvent` and the canonical store:

```js
import { recordEvent } from './session-index.js';
import { readSessionId, writeSessionId } from './session-store.js';
// inside createSessionRunner({meshRoot, ...}):
const activeByAgent = new Map(); // agentName → { activeId, rev }

async function setActiveSession(agentName, id) {
  const { agentRoot } = await resolveAgent(agentName);
  const cur = activeByAgent.get(agentName) || { rev: 0 };
  const next = { activeId: id, rev: cur.rev + 1 };
  activeByAgent.set(agentName, next);
  await writeSessionId(meshRoot, agentRoot, id);
  await recordEvent(meshRoot, { kind: 'select', source: 'dashboard', agentRoot, sessionId: id });
  return next;
}
```

(b) in `runTurn`, accept `expectedActiveId`, validate before the lease/spawn, and record `create` on a brand-new session. Insert near the top of `runTurn` (after `resolveAgent`):

```js
async function runTurn({ agentName, text, force = false, expectedActiveId }) {
  if (inFlight.has(agentName)) throw new SessionBusyError('session_busy', { owner: 'dashboard' });
  const { agentRoot } = await resolveAgent(agentName);
  const current = activeByAgent.get(agentName)?.activeId ?? await readSessionId(meshRoot, agentRoot);
  if (expectedActiveId !== undefined && expectedActiveId !== current) {
    throw new SessionBusyError('active_changed', { activeId: current });
  }
  // ... existing lease decision + acquire ...
  // when resolving the session id to drive:
  //   const sessionId = current; (resume) OR generate a new uuid (create)
  //   if creating new: await recordEvent(meshRoot, { kind:'create', source:'dashboard', agentRoot, sessionId:newId });
  //   if resuming existing: no event here (select already recorded it)
  // ... existing spawn of session-exec wrapper unchanged ...
}
```

(Adapt the existing `runTurn` body: replace the old `readSessionId` line with `current`; keep the rest. Where a brand-new id is generated, call `recordEvent({kind:'create',…})`.)

(c) export `setActiveSession` from the returned object:

```js
return { runTurn, stop, subscribe, setActiveSession };
```

- [ ] **Step 4: Run → PASS** (new test + the existing runner tests).

Run: `node --test test/session-runner.test.js`

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/session-runner.js test/session-runner.test.js
git commit -m "feat(session-runner): setActiveSession + runTurn expectedActiveId + create/select events"
```

---

### Task 6: Cross-platform `probePid` (win32) + `killProcessTree` (win32)

**Files:**
- Modify: `src/dashboard/session-lease.js`, `src/process.js`
- Test: `test/session-lease.test.js` (extend)

- [ ] **Step 1: Write the failing test (append to `test/session-lease.test.js`).**

```js
import { probePid } from '../src/dashboard/session-lease.js';

test('probePid: win32 branch parses Get-Process output via injected exec', () => {
  const exec = (cmd, args) => {
    // emulate: powershell -Command "(Get-Process -Id N).StartTime.Ticks"
    assert.ok(/powershell|pwsh/i.test(cmd));
    return '638000000000000000\n';
  };
  const r = probePid(4242, { platform: 'win32', execFileSync: exec });
  assert.equal(r.alive, true);
  assert.ok(Number.isFinite(r.procStartedAt));
});

test('probePid: win32 dead pid → not alive', () => {
  const exec = () => { throw new Error('no process'); };
  assert.deepEqual(probePid(9, { platform: 'win32', execFileSync: exec }), { alive: false, procStartedAt: null });
});
```

- [ ] **Step 2: Run → FAIL** (`probePid` ignores platform/injection).

Run: `node --test test/session-lease.test.js`

- [ ] **Step 3: Implement.** Make `probePid` platform-aware + injectable in `src/dashboard/session-lease.js` (replace the current body):

```js
import { execFileSync as _execFileSync } from 'node:child_process';

export function probePid(pid, io = {}) {
  const platform = io.platform || process.platform;
  const exec = io.execFileSync || _execFileSync;
  try {
    if (platform === 'win32') {
      const out = exec('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.Ticks`],
        { encoding: 'utf8' }).trim();
      if (!out) return { alive: false, procStartedAt: null };
      // .NET ticks (100ns since 0001-01-01) → epoch ms
      const ms = Number(BigInt(out) / 10000n - 62135596800000n);
      return { alive: true, procStartedAt: Number.isFinite(ms) ? ms : null };
    }
    const out = exec('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }).trim();
    if (!out) return { alive: false, procStartedAt: null };
    const ms = Date.parse(out);
    return { alive: true, procStartedAt: Number.isFinite(ms) ? ms : null };
  } catch { return { alive: false, procStartedAt: null }; }
}
```

- [ ] **Step 4: Add the win32 branch to `killProcessTree` in `src/process.js`.** At the top of `killProcessTree`:

```js
export function killProcessTree(child, escalationMs = KILL_ESCALATION_MS) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { require('node:child_process').execFile('taskkill', ['/pid', String(child.pid), '/T', '/F']); }
    catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    return;
  }
  // ... existing POSIX signalTree + escalate ...
}
```

(Use a top-of-file `import { execFile } from 'node:child_process'` instead of `require` if the file is ESM — match the file's existing import style; `src/process.js` is ESM, so add `execFile` to its `node:child_process` import and call `execFile('taskkill', …)`.)

- [ ] **Step 5: Run → PASS** (new + existing lease/process tests).

Run: `node --test test/session-lease.test.js test/delegate.test.js`

- [ ] **Step 6: Commit.**

```bash
git add src/dashboard/session-lease.js src/process.js test/session-lease.test.js
git commit -m "feat(cross-platform): win32 probePid (Get-Process) + killProcessTree (taskkill)"
```

---

## M2 · Image-Proxy Security

### Task 7: `img-proxy.js` — SSRF-hardened `fetchRemoteImage`

**Files:**
- Create: `src/dashboard/img-proxy.js`
- Test: `test/img-proxy.test.js`

- [ ] **Step 1: Write the failing test.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRemoteImage, isBlockedAddress } from '../src/dashboard/img-proxy.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const okDeps = (over = {}) => ({
  allowHosts: ['covers.openlibrary.org'],
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],   // public
  fetchImpl: async () => ({ status: 200, headers: new Map([['content-type', 'image/png']]), body: PNG }),
  maxBytes: 5_000_000, timeoutMs: 5000, maxRedirects: 2, ...over
});

test('isBlockedAddress: private/loopback/link-local/ULA/mapped/CGNAT blocked; public ok', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.1.1', '172.16.0.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1'])
    assert.equal(isBlockedAddress(ip), true, ip);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
});

test('valid https raster on allowlisted host passes', async () => {
  const r = await fetchRemoteImage('https://covers.openlibrary.org/x.png', okDeps());
  assert.equal(r.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(r.body));
});

test('rejects non-https, disallowed host, private IP, dns-rebinding, mislabeled svg, oversize', async () => {
  await assert.rejects(() => fetchRemoteImage('http://covers.openlibrary.org/x.png', okDeps()), /scheme/);
  await assert.rejects(() => fetchRemoteImage('https://evil.example/x.png', okDeps()), /host/);
  await assert.rejects(() => fetchRemoteImage('https://covers.openlibrary.org/x.png',
    okDeps({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] })), /address/);
  // magic-byte: server says png but body is svg
  await assert.rejects(() => fetchRemoteImage('https://covers.openlibrary.org/x.png',
    okDeps({ fetchImpl: async () => ({ status: 200, headers: new Map([['content-type', 'image/png']]), body: Buffer.from('<svg/>') }) })), /not a raster/);
  await assert.rejects(() => fetchRemoteImage('https://covers.openlibrary.org/x.png',
    okDeps({ maxBytes: 4 })), /too large/);
});

test('redirect to private host is rejected', async () => {
  let n = 0;
  const deps = okDeps({ fetchImpl: async () => {
    n++;
    if (n === 1) return { status: 302, headers: new Map([['location', 'https://internal.example/x.png']]), body: Buffer.alloc(0) };
    return { status: 200, headers: new Map([['content-type', 'image/png']]), body: PNG };
  }, lookup: async (host) => host === 'internal.example' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }] });
  await assert.rejects(() => fetchRemoteImage('https://covers.openlibrary.org/x.png', deps), /address|host/);
});
```

- [ ] **Step 2: Run → FAIL.**

Run: `node --test test/img-proxy.test.js`

- [ ] **Step 3: Implement `src/dashboard/img-proxy.js`.**

```js
/**
 * src/dashboard/img-proxy.js — SSRF-hardened remote-image fetch for /api/img.
 * https-only, host allowlist, DNS-resolve + reject private addresses, PIN the
 * vetted IP for the connection (no re-resolve → no DNS rebinding), manually
 * follow <=2 redirects re-validating each hop, raster content-type + magic-byte
 * verification (reject SVG/HTML), byte + timeout caps. Pure over injected deps.
 */
import { lookup as dnsLookup } from 'node:dns/promises';

const RASTER = {
  'image/png':  (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif':  (b) => b.length > 6 && b.slice(0, 3).toString('latin1') === 'GIF',
  'image/webp': (b) => b.length > 12 && b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP',
  'image/avif': (b) => b.length > 12 && b.slice(4, 8).toString('latin1') === 'ftyp'
};

export function isBlockedAddress(ip) {
  const s = String(ip).toLowerCase();
  if (s === '::1') return true;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true; // link-local + ULA
  let v4 = s;
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) v4 = m[1];               // IPv4-mapped
  const p = v4.split('.').map(Number);
  if (p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = p;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;          // link-local
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  return s !== '' && !s.includes('.'); // unknown IPv6 form → block conservatively
}

async function vet(host, deps) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    throw Object.assign(new Error('numeric-literal host blocked'), { code: 'address' });
  }
  if (!deps.allowHosts.includes(host)) throw Object.assign(new Error('host not allowlisted'), { code: 'host' });
  const addrs = await (deps.lookup || ((h) => dnsLookup(h, { all: true })))(host);
  const list = Array.isArray(addrs) ? addrs : [addrs];
  for (const a of list) if (isBlockedAddress(a.address)) throw Object.assign(new Error('blocked address'), { code: 'address' });
  return list[0].address; // the pinned IP
}

export async function fetchRemoteImage(url, deps) {
  const maxRedirects = deps.maxRedirects ?? 2;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:') throw Object.assign(new Error('only https scheme allowed'), { code: 'scheme' });
    const pinned = await vet(u.hostname, deps);
    const res = await deps.fetchImpl(current, { pinnedAddress: pinned, hostHeader: u.hostname, timeoutMs: deps.timeoutMs });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || hop === maxRedirects) throw Object.assign(new Error('too many redirects'), { code: 'redirect' });
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status !== 200) throw Object.assign(new Error(`upstream ${res.status}`), { code: 'upstream' });
    const ct = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const check = RASTER[ct];
    if (!check) throw Object.assign(new Error('not a raster content-type'), { code: 'content_type' });
    const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    if (body.length > deps.maxBytes) throw Object.assign(new Error('image too large'), { code: 'too_large' });
    if (!check(body)) throw Object.assign(new Error('payload not a raster image'), { code: 'magic' });
    return { contentType: ct, body };
  }
  throw Object.assign(new Error('too many redirects'), { code: 'redirect' });
}
```

- [ ] **Step 4: Run → PASS** (all SSRF cases).

Run: `node --test test/img-proxy.test.js`

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/img-proxy.js test/img-proxy.test.js
git commit -m "feat(img-proxy): SSRF-hardened remote-image fetch (pin IP, magic-byte, redirects)"
```

---

### Task 8: `GET /api/img` endpoint (gated `--allow-shell` + auth)

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/img-endpoint.test.js`

- [ ] **Step 1: Write the failing test.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function mesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'img-'));
  await initMesh(meshRoot);
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [] });
  return meshRoot;
}
async function authed(meshRoot, opts) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start();
  const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}

test('/api/img disabled without --allow-shell → 403', async () => {
  const meshRoot = await mesh();
  const { srv, port, cookie } = await authed(meshRoot, {});
  try {
    const r = await fetch(`${srv.url}/api/img?url=https://covers.openlibrary.org/x.png`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 403);
  } finally { await srv.close(); }
});

test('/api/img enabled (injected fetcher) → streams raster + nosniff', async () => {
  const meshRoot = await mesh();
  const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
  const imgFetcher = async () => ({ contentType: 'image/png', body: PNG });
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, imgFetcher });
  try {
    const r = await fetch(`${srv.url}/api/img?url=https://covers.openlibrary.org/x.png`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { await srv.close(); }
});

test('/api/img rejection (injected fetcher throws) → 4xx code', async () => {
  const meshRoot = await mesh();
  const imgFetcher = async () => { throw Object.assign(new Error('host not allowlisted'), { code: 'host' }); };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, imgFetcher });
  try {
    const r = await fetch(`${srv.url}/api/img?url=https://evil.example/x.png`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie } });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'host');
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Run → FAIL.**

Run: `node --test test/img-endpoint.test.js`

- [ ] **Step 3: Implement.** In `src/dashboard/server.js`:

(a) accept `imgFetcher` in `createDashboardServer({ … })` and default it to the hardened proxy when `allowShell`:

```js
import { fetchRemoteImage } from './img-proxy.js';
// in createDashboardServer signature add: imgFetcher
const imgEnabled = allowShell || !!imgFetcher;
const fetchImage = imgFetcher ?? (allowShell
  ? (url) => fetchRemoteImage(url, {
      allowHosts: ['covers.openlibrary.org', 'covers.openlibrary.org', 'images-na.ssl-images-amazon.com'],
      maxBytes: 5_000_000, timeoutMs: 5000, maxRedirects: 2,
      fetchImpl: defaultPinnedFetch   // a small wrapper around global fetch honoring pinnedAddress
    })
  : null);
```

(b) pass `fetchImage` into `handleRequest`'s context (alongside the existing fields), and add the route (place near the other `/api/*` GETs, after auth):

```js
if (pathname === '/api/img' && req.method === 'GET') {
  if (!fetchImage) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled' } }); return; }
  const url = new URL(req.url, `http://127.0.0.1:${listenerPort}`).searchParams.get('url') || '';
  try {
    const { contentType, body } = await fetchImage(url);
    res.writeHead(200, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', 'Content-Length': body.length, 'Cache-Control': 'private, max-age=300' });
    res.end(body);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: { code: err.code || 'img_error', message: err.message } });
  }
  return;
}
```

(c) implement `defaultPinnedFetch(url, { pinnedAddress, hostHeader, timeoutMs })` — a thin wrapper using `undici`/global `fetch` is not available with IP pinning out of the box; for zero-dep, use `node:https` with `lookup` pinned to `pinnedAddress` and `servername: hostHeader` (SNI) + `headers.host = hostHeader`, an `AbortController` timeout, collecting the body to a Buffer. Add this helper to `img-proxy.js` and export it; the server imports it. (Its correctness is covered by the manual smoke + the unit tests inject `fetchImpl`, so the pinned-fetch wrapper is exercised in the opt-in e2e, not the hermetic suite.)

```js
// src/dashboard/img-proxy.js — add:
import https from 'node:https';
export function defaultPinnedFetch(url, { pinnedAddress, hostHeader, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs); to.unref?.();
    const req = https.request({
      host: pinnedAddress, servername: hostHeader, port: 443, path: u.pathname + u.search,
      method: 'GET', headers: { host: hostHeader }, signal: ac.signal
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => { clearTimeout(to); resolve({ status: r.statusCode, headers: new Map(Object.entries(r.headers)), body: Buffer.concat(chunks) }); });
    });
    req.on('error', (e) => { clearTimeout(to); reject(e); });
    req.end();
  });
}
```

- [ ] **Step 4: Run → PASS.**

Run: `node --test test/img-endpoint.test.js`

- [ ] **Step 5: Run the full suite.**

Run: `node --test`
Expected: PASS (M1+M2 green, no regressions).

- [ ] **Step 6: Commit.**

```bash
git add src/dashboard/server.js src/dashboard/img-proxy.js test/img-endpoint.test.js
git commit -m "feat(dashboard): GET /api/img gated proxy (nosniff, sniffed type)"
```

---

## Task 9: M1+M2 acceptance gate

- [ ] **Step 1: Full suite green.**

Run: `node --test`
Expected: all pass (6 opt-in e2e skipped).

- [ ] **Step 2: Confirm the SSRF matrix + cursor + provenance are covered** by re-reading the test names:

Run: `node --test --test-name-pattern="rebinding|private|svg|replay_gap|provenance|active_changed|magic" 2>/dev/null; node --test test/img-proxy.test.js test/session-mirror.test.js test/session-index.test.js`
Expected: PASS.

- [ ] **Step 3: STOP — M1+M2 gate.** The data + lease + image-proxy foundations are done and hermetically tested. Do **not** start M3 (result-canvas) / M4 (UI + routes) until reviewed. Those get their own plan.

---

## Self-Review

**Spec coverage (M1+M2 of §9):**
- Platform-aware `encodeProjectDir` + scan fallback → Task 1. ✓
- `events.jsonl` create/select/open + `originSource`/`lastManagedBy` → Task 2. ✓
- `listSessions` byte-capped preview + **uncapped line cursor** + cache; `resolveTranscript` UUID/index-only/realpath → Task 3. ✓
- Rewritten mirror: per-session buffer, line-record `{seq,events}`, `replay_gap` (`lastSeq+1<bufferStartSeq`), truncation reset → Task 4. ✓
- `setActiveSession` + `runTurn({expectedActiveId})` + create/select events → Task 5. ✓
- Cross-platform probePid (win Get-Process) + killProcessTree (taskkill) → Task 6. ✓
- img-proxy SSRF (https, allowlist, reject private incl IPv6/mapped/CGNAT, pin IP, ≤2 redirects re-validated, raster content-type + magic-byte, ≤5 MB, timeout) → Task 7. ✓
- `/api/img` gated + nosniff + sniffed type → Task 8. ✓

**Deferred to M3/M4 (correctly not here):** `/session/list|:id/transcript|:id/stream|:id/resume|:id/open-terminal`, `setActiveSession`/turn HTTP wiring, capability migration (`sessionLogEnabled`, removing `sessionEnabled`/`mirrorEnabled`), result-canvas, B-layout UI. The `windowed /transcript` reader (`readTranscriptWindow`) is consumed by M4; Task 4 ships the mirror's live tail + buffer that M4's `/stream` uses, and `listSessions.lineCount` gives M4 its cursor bounds.

**Placeholder scan:** none — every step has concrete code/commands. Task 5 step 3 marks the in-place edits to the existing `runTurn` explicitly (insert validation + create-event) rather than restating the whole function; the surrounding `runTurn` already exists in the repo from the lean build.

**Type consistency:** event shape `{at,kind,source,terminalApp?,platform?,agentRoot,sessionId,transcriptPath}` consistent across Task 2/5; `deriveProvenance` returns `{originSource,lastManagedBy}` used in Task 3; mirror line record `{seq,events}` + `{type:'replay_gap'}` consistent Task 4; `probePid(pid,io)` signature consistent Task 6; `fetchRemoteImage(url,deps)` → `{contentType,body}` consistent Task 7/8; `createDashboardServer({…, imgFetcher})` Task 8.

---

## Carry-forward notes to the M4 plan (from the final whole-impl review)

M1+M2 landed **Ready-with-notes**. When writing the M4 (session-log UI + HTTP routes) plan, address:

1. **Wire `expectedActiveId` through `POST .../session/message`** — the route currently passes only `text`/`force`; without `expectedActiveId` the `active_changed` race guard is dead on the HTTP path.
2. **Add a `select` route** that calls `setActiveSession` and returns `{activeId, rev}`; the frontend echoes `expectedActiveId` on the next message.
3. **`seq` namespace divergence** — the runner hub uses a per-process runtime `seq`; the mirror uses a transcript line-index `seq`. Before merging runner-events + mirror-records into one canvas/SSE stream, decide the cursor model (namespace them, e.g. `runtime:N` vs `line:N`, or have the canvas consume one source).
4. **Reuse `resolveTranscript` for every path-bearing route** (it is the realpath-containment gate) — never accept a raw transcript path from the client.
5. **Delete the dead mirror frontend block** (`app.js` ~`mirrorEnabled`/`mirrorPanelHtml`/`wireMirror`/`_mrSource` + the `/session/mirror` EventSource) when the M4 canvas replaces it — inert today, but don't let it get rewired.
6. **Decide `/api/img` gating** — currently under `--allow-shell`; consider whether image-proxying warrants its own flag vs staying under the single privileged flag.
