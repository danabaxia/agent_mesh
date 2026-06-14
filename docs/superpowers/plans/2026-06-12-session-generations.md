# Session Generations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the [2026-06-12 session-generations spec](../specs/2026-06-12-session-generations-design.md): measure context headroom from usage data, digest closing `self` sessions into `memory/` + propose-only deliverables, and rotate to a fresh generation below a headroom threshold.

**Architecture:** Pure helpers land in shared core modules (`src/session-transcripts.js`, `src/digest-extract.js`, `src/digest.js`, `src/atomic-write.js`, `src/json-extract.js`); the dashboard runner gains a `runMaintenance` lease export and an `onTurnComplete` hook; a separate `src/dashboard/rotation.js` owns the threshold/idle/rotate state machine and is wired in `server.js`. Task 2's probe (`scripts/probe-headroom.mjs`) is the D7 gate: its results must be recorded in the spec §12 before Tasks 13–15 (control logic) ship.

**Tech Stack:** Node ≥ 20, zero deps, `node --test` + `node:assert/strict`. Hermetic tests use temp dirs + the existing `io = { projectsDir, platform }` seam; no real `claude` outside the probe.

**Branch:** `claude/dreamy-goodall-vcvash` (continue on it; commit after every task).

**House rules that bind every task:** no `Bash` in any `do` allowlist (nothing here uses `do`); all transcript access via `resolveTranscript`; new spawn sites (probe) via `spawnFile`/`resolveSpawnTarget`; failure is data — helpers return `null`/structured errors, never throw across a turn boundary (single exception: `containment` propagates).

---

## Task 1: Headroom primitives (`occupancyFromUsage`, `usageFromTail`, `headroomPctOf`, `readSessionHeadroom`) + config constants

**Files:**
- Modify: `src/config.js` (append constants)
- Modify: `src/session-transcripts.js` (append helpers; nothing existing changes)
- Test: `test/headroom.test.js` (new)

- [ ] **Step 1: Add config constants**

Append to `src/config.js` after `MAX_MEMORY_FILE_CHARS`:

```js
// Session-generations knobs (spec 2026-06-12). CONTEXT_WINDOW must be overridden
// for 1M-context models; ROTATE_HEADROOM_PCT of '0' disables auto-rotation.
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_ROTATE_HEADROOM_PCT = 25;
export const DEFAULT_ROTATE_IDLE_MS = 120_000;
export const DEFAULT_DIGEST_TIMEOUT_MS = 180_000;
export const DEFAULT_DIGEST_EXTRACT_MAX_CHARS = 120_000;
export const MAX_DECISIONS_INDEX_LINES = 30;
```

- [ ] **Step 2: Write the failing test**

Create `test/headroom.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  occupancyFromUsage, headroomPctOf, usageFromTail, readSessionHeadroom, encodeProjectDir
} from '../src/session-transcripts.js';

const SID = '11111111-2222-4333-8444-555555555555';

// A transcript "assistant" record with usage, as Claude Code writes it.
const aLine = (usage, text = 'hi') => JSON.stringify({
  type: 'assistant', timestamp: '2026-06-12T00:00:00Z',
  message: { role: 'assistant', content: [{ type: 'text', text }], usage }
});
const uLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const USAGE = { input_tokens: 100_000, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 10_000, output_tokens: 50 };

// Fake ~/.claude/projects layout for an agent root, via the io seam.
async function fixture(lines) {
  const base = await mkdtemp(join(tmpdir(), 'hr-'));
  const agentRoot = join(base, 'agent'); await mkdir(agentRoot);
  const projectsDir = join(base, 'projects');
  const enc = encodeProjectDir(agentRoot, 'linux', { projectsDir });
  await mkdir(join(projectsDir, enc), { recursive: true });
  const path = join(projectsDir, enc, `${SID}.jsonl`);
  await writeFile(path, lines.join('\n') + '\n');
  return { agentRoot, projectsDir, path, io: { projectsDir, platform: 'linux' } };
}

test('occupancyFromUsage sums the three input fields; null on garbage', () => {
  assert.equal(occupancyFromUsage(USAGE), 150_000);
  assert.equal(occupancyFromUsage({ input_tokens: 5 }), 5);
  assert.equal(occupancyFromUsage(null), null);
  assert.equal(occupancyFromUsage({ output_tokens: 9 }), null); // no input-side fields
});

test('headroomPctOf computes clamped integer percent; null on bad input', () => {
  assert.equal(headroomPctOf(150_000, 200_000), 25);
  assert.equal(headroomPctOf(250_000, 200_000), 0);
  assert.equal(headroomPctOf(0, 200_000), null);   // 0 occupancy = no signal
  assert.equal(headroomPctOf(100, 0), null);
});

test('usageFromTail finds the LAST assistant usage', async () => {
  const { path } = await fixture([
    uLine('q1'), aLine({ input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    uLine('q2'), aLine(USAGE)
  ]);
  const u = await usageFromTail(path);
  assert.equal(u.occupancy, 150_000);
  assert.ok(u.atMtime > 0);
});

test('usageFromTail: no usage anywhere → null; usage only beyond the tail window → null', async () => {
  const none = await fixture([uLine('q'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })]);
  assert.equal(await usageFromTail(none.path), null);
  const pad = uLine('x'.repeat(1000));
  const big = await fixture([aLine(USAGE), ...Array.from({ length: 400 }, () => pad)]);
  assert.equal(await usageFromTail(big.path, { tailBytes: 8 * 1024 }), null); // usage line is in the head
});

test('usageFromTail drops the partial first line of a mid-file tail window', async () => {
  const pad = uLine('y'.repeat(1000));
  const { path } = await fixture([...Array.from({ length: 50 }, () => pad), aLine(USAGE)]);
  const u = await usageFromTail(path, { tailBytes: 2048 }); // window starts mid-pad-line
  assert.equal(u.occupancy, 150_000);
});

test('readSessionHeadroom resolves via the containment gate and computes pct', async () => {
  const { agentRoot, io } = await fixture([aLine(USAGE)]);
  const h = await readSessionHeadroom(agentRoot, SID, { ...io, contextWindow: 200_000 });
  assert.deepEqual({ occupancy: h.occupancy, headroomPct: h.headroomPct }, { occupancy: 150_000, headroomPct: 25 });
});

test('readSessionHeadroom: unknown session → null; containment violation PROPAGATES', async () => {
  const { agentRoot, io } = await fixture([aLine(USAGE)]);
  assert.equal(await readSessionHeadroom(agentRoot, '99999999-9999-4999-8999-999999999999', io), null);
  // io.realpath seam: pretend the transcript resolves OUTSIDE the project dir.
  const evil = { ...io, realpath: async (p) => p.endsWith('.jsonl') ? '/etc/evil.jsonl' : p };
  await assert.rejects(() => readSessionHeadroom(agentRoot, SID, evil), (e) => e.code === 'containment');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test test/headroom.test.js`
Expected: FAIL — `occupancyFromUsage` etc. are not exported.

- [ ] **Step 4: Implement**

Append to `src/session-transcripts.js` (after `countTurns`); add `import { DEFAULT_CONTEXT_WINDOW } from './config.js';` at the top:

```js
// ── headroom (spec 2026-06-12 §3) ──────────────────────────────────────────
const HEADROOM_TAIL_BYTES = 256 * 1024;

/** Sum the input-side usage fields. null when usage carries no input signal. */
export function occupancyFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const a = usage.input_tokens, b = usage.cache_read_input_tokens, c = usage.cache_creation_input_tokens;
  if (typeof a !== 'number' && typeof b !== 'number' && typeof c !== 'number') return null;
  const n = (a ?? 0) + (b ?? 0) + (c ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Clamped integer headroom percent. null when inputs carry no signal. */
export function headroomPctOf(occupancy, contextWindow = DEFAULT_CONTEXT_WINDOW) {
  if (!Number.isFinite(occupancy) || occupancy <= 0) return null;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;
  return Math.max(0, Math.round((1 - occupancy / contextWindow) * 100));
}

/** Occupancy from ONE raw transcript JSONL line (assistant records carry
 *  message.usage — parseTranscriptLine deliberately drops it, so parse raw). */
export function occupancyFromTranscriptLine(line) {
  try {
    const msg = JSON.parse(line);
    if (msg?.type !== 'assistant') return null;
    return occupancyFromUsage(msg.message?.usage);
  } catch { return null; }
}

/**
 * Best-effort: last assistant usage within the final `tailBytes` of the file.
 * Returns { occupancy, atMtime } or null. Display/metrics only — never a
 * correctness-critical reader (byte-capped like countTurns).
 */
export async function usageFromTail(path, { tailBytes = HEADROOM_TAIL_BYTES } = {}) {
  try {
    const fh = await open(path, 'r');
    try {
      const s = await fh.stat();
      const cap = Math.min(s.size, tailBytes);
      if (cap === 0) return null;
      const offset = s.size - cap;
      const buf = Buffer.alloc(cap);
      await fh.read(buf, 0, cap, offset);
      let text = buf.toString('utf8');
      if (offset > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
      const lines = text.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].trim()) continue;
        const occ = occupancyFromTranscriptLine(lines[i]);
        if (occ !== null) return { occupancy: occ, atMtime: s.mtimeMs };
      }
      return null;
    } finally { await fh.close(); }
  } catch { return null; }
}

/**
 * Headroom for one session. null on any missing/unreadable/usage-less state
 * (callers omit the metric) — EXCEPT containment, which propagates: a path
 * escaping the project dir is a security signal, not a degrade case.
 */
export async function readSessionHeadroom(agentRoot, id, io = {}) {
  let path;
  try { path = await resolveTranscript(agentRoot, id, io); }
  catch (e) { if (e && e.code === 'containment') throw e; return null; }
  const u = await usageFromTail(path, io.tailBytes ? { tailBytes: io.tailBytes } : {});
  if (!u) return null;
  const pct = headroomPctOf(u.occupancy, io.contextWindow || DEFAULT_CONTEXT_WINDOW);
  return pct === null ? null : { occupancy: u.occupancy, headroomPct: pct, atMtime: u.atMtime };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/headroom.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Full suite + commit**

Run: `npm test` — expected: no regressions (suite is currently green).

```bash
git add src/config.js src/session-transcripts.js test/headroom.test.js
git commit -m "feat(headroom): occupancy/headroom primitives + bounded transcript tail scan"
```

---

## Task 2: Probe script — the D7 gate

**Files:**
- Create: `scripts/probe-headroom.mjs`
- Test: `test/probe-headroom.test.js` (smoke only — the real run is manual)

- [ ] **Step 1: Write the smoke test**

Create `test/probe-headroom.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/probe-headroom.mjs', import.meta.url));

test('probe-headroom --help prints usage and exits 0 (no claude required)', () => {
  const out = execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
  assert.match(out, /probe-headroom/);
  assert.match(out, /assumption 1/i);
  assert.match(out, /assumption 2/i);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/probe-headroom.test.js` — expected: FAIL (script missing).

- [ ] **Step 3: Implement the probe**

Create `scripts/probe-headroom.mjs`:

```js
#!/usr/bin/env node
// probe-headroom — REAL-claude verification of the two undocumented assumptions
// behind spec 2026-06-12 §3.4. Run manually; record the PASS/FAIL table in the
// spec §12 review log before implementing Tasks 13-15 (rotation control logic).
//
//   assumption 1 (BLOCKS rotation): a --resume turn's input+cache usage reflects
//     the FULL conversation context (cumulative), not a per-request reset.
//   assumption 2 (gates at-rest surface only): the on-disk transcript's assistant
//     records embed message.usage with the three input fields.
//
// Usage: node scripts/probe-headroom.mjs [--help]   (uses AGENT_MESH_CLAUDE or `claude`)
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnFile } from '../src/process.js';
import { occupancyFromUsage, usageFromTail, encodeProjectDir } from '../src/session-transcripts.js';
import { homedir } from 'node:os';

if (process.argv.includes('--help')) {
  process.stdout.write(
    'probe-headroom: real-claude check of usage semantics (spec 2026-06-12 §3.4)\n' +
    '  assumption 1: --resume usage is cumulative (BLOCKING for rotation)\n' +
    '  assumption 2: transcript assistant records carry message.usage (at-rest surface)\n' +
    'Run with a working `claude` (or AGENT_MESH_CLAUDE). Exits 1 on any FAIL.\n');
  process.exit(0);
}

const claude = process.env.AGENT_MESH_CLAUDE || 'claude';
const cwd = await mkdtemp(join(tmpdir(), 'probe-headroom-'));
const sid = randomUUID();

async function turn(args) {
  const res = await spawnFile(claude, ['-p', ...args, '--output-format', 'stream-json', '--verbose'], {
    cwd, env: process.env, timeoutMs: 300_000
  });
  let init = null, usage = null;
  for (const line of String(res.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'system' && msg.subtype === 'init') init = msg.session_id;
      if (msg.type === 'result' && msg.usage) usage = msg.usage;
    } catch { /* non-JSON noise */ }
  }
  return { init, usage, occupancy: occupancyFromUsage(usage) };
}

const rows = [];
const t1 = await turn(['Reply with the single word: ready. Then stop.', '--session-id', sid]);
rows.push(['turn1 result usage present', t1.usage ? 'PASS' : 'FAIL', JSON.stringify(t1.usage)]);
const t2 = await turn(['Reply with the single word: again. Then stop.', '--resume', sid]);
rows.push(['turn2 (--resume) usage present', t2.usage ? 'PASS' : 'FAIL', JSON.stringify(t2.usage)]);
const cumulative = t1.occupancy !== null && t2.occupancy !== null && t2.occupancy >= t1.occupancy;
rows.push(['assumption 1: resume occupancy cumulative (t2 >= t1)', cumulative ? 'PASS' : 'FAIL',
  `t1=${t1.occupancy} t2=${t2.occupancy}`]);

const projectsDir = join(homedir(), '.claude', 'projects');
const enc = encodeProjectDir(cwd, process.platform, { projectsDir });
const fromDisk = await usageFromTail(join(projectsDir, enc, `${sid}.jsonl`));
rows.push(['assumption 2: transcript carries usage', fromDisk ? 'PASS' : 'FAIL',
  fromDisk ? `occupancy=${fromDisk.occupancy}` : 'no assistant usage found']);

let failed = false;
process.stdout.write('\nPROBE RESULTS\n');
for (const [name, verdict, detail] of rows) {
  if (verdict === 'FAIL') failed = true;
  process.stdout.write(`  ${verdict}  ${name}  (${detail})\n`);
}
process.stdout.write(failed ? '\nFAIL — record in spec §12; see §3.4 fallbacks.\n' : '\nALL PASS — record in spec §12.\n');
process.exit(failed ? 1 : 0);
```

- [ ] **Step 4: Run smoke test**

Run: `node --test test/probe-headroom.test.js` — expected: PASS.

- [ ] **Step 5: Run the real probe where `claude` is available**

Run (manual, POSIX or Windows): `node scripts/probe-headroom.mjs`
Expected: 4 PASS rows. **GATE:** append the printed table to the spec's §12 review log (`docs/superpowers/specs/2026-06-12-session-generations-design.md`) and commit. If assumption 1 FAILS, STOP and consult the spec §3.4 fallback (lineCount threshold) before Tasks 13–15. If assumption 2 FAILS, Tasks 5–6 ship `null`-degraded (already their behavior) — note it in the spec.

- [ ] **Step 6: Commit**

```bash
git add scripts/probe-headroom.mjs test/probe-headroom.test.js docs/superpowers/specs/2026-06-12-session-generations-design.md
git commit -m "feat(probe): real-claude headroom assumptions probe (spec §3.4 gate)"
```

---

## Task 3: Move `parseTranscriptLine` + `redactSessionEvent` into the shared module

**Files:**
- Modify: `src/session-transcripts.js` (receives the parsers + their private helpers)
- Modify: `src/dashboard/session-events.js` (keeps `parseEventLine`; re-exports the moved two)
- Test: `test/transcript-parsers-shared.test.js` (new, pins the re-export identity)

- [ ] **Step 1: Write the failing test**

Create `test/transcript-parsers-shared.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import * as shared from '../src/session-transcripts.js';
import * as events from '../src/dashboard/session-events.js';

test('parseTranscriptLine and redactSessionEvent live in the shared module', () => {
  assert.equal(typeof shared.parseTranscriptLine, 'function');
  assert.equal(typeof shared.redactSessionEvent, 'function');
});

test('session-events re-exports are the SAME functions (back-compat)', () => {
  assert.equal(events.parseTranscriptLine, shared.parseTranscriptLine);
  assert.equal(events.redactSessionEvent, shared.redactSessionEvent);
});

test('moved redaction still scrubs and the parser still parses', () => {
  const line = JSON.stringify({ type: 'user', message: { content: 'token ghp_abcdefghijklmnopqrstuv plus text' } });
  const [ev] = shared.parseTranscriptLine(line);
  assert.equal(ev.type, 'user_text');
  const red = shared.redactSessionEvent(ev);
  assert.match(red.text, /«redacted»/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/transcript-parsers-shared.test.js` — expected: FAIL (`shared.parseTranscriptLine` undefined).

- [ ] **Step 3: Move the code**

In `src/session-transcripts.js`, paste — verbatim from `src/dashboard/session-events.js` — the following blocks (keep their comments): `MAX_FIELD_CHARS`, `MAX_FIELD_LINES`, `SECRET_PATTERNS`, `scrubString`, `capString`, `MAX_REDACT_DEPTH`, `redactValue`, the whole `parseTranscriptLine` function, `RENDER_FIELDS`, and the whole `redactSessionEvent` function. Place them under a banner comment:

```js
// ── transcript parsing + render redaction (moved verbatim from
// src/dashboard/session-events.js — spec 2026-06-12 §5.1 boundary hygiene:
// core digest-extract must use these without importing dashboard code;
// session-events re-exports them for back-compat) ───────────────────────────
```

In `src/dashboard/session-events.js`: delete those moved blocks, keep `parseEventLine` (it shares no helpers with them), and add at the top:

```js
export { parseTranscriptLine, redactSessionEvent } from '../session-transcripts.js';
```

In `src/session-transcripts.js`, fix `countTurns` to drop its dynamic dashboard import — replace:

```js
    const { parseTranscriptLine } = await import('./dashboard/session-events.js');
```

with nothing (delete the line) — `parseTranscriptLine` is now module-local. Also update `src/dashboard/session-index.js:133` — replace

```js
  const { parseTranscriptLine } = await import('./session-events.js');
```

with a static top-of-file import `import { parseTranscriptLine } from '../session-transcripts.js';` (and delete the dynamic line).

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS everywhere — the mirror (`session-mirror.js`), console, and board tests import via `session-events.js`, which now re-exports. Any failure here means a missed helper in the move; fix before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/session-transcripts.js src/dashboard/session-events.js src/dashboard/session-index.js test/transcript-parsers-shared.test.js
git commit -m "refactor(transcripts): move transcript parser + redaction to shared module (boundary hygiene)"
```

---

## Task 4: Surface `usage` on stream-json `result` events

**Files:**
- Modify: `src/dashboard/session-events.js:85-87` (`parseEventLine` result branch)
- Test: `test/stream-usage.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/stream-usage.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLine, redactSessionEvent } from '../src/dashboard/session-events.js';

const USAGE = { input_tokens: 9, cache_read_input_tokens: 1, cache_creation_input_tokens: 2, output_tokens: 3 };

test('result events surface usage for the runner', () => {
  const [ev] = parseEventLine(JSON.stringify({ type: 'result', result: 'ok', is_error: false, usage: USAGE }));
  assert.equal(ev.type, 'turn_done');
  assert.deepEqual(ev.usage, USAGE);
});

test('result events without usage omit the field (no null noise)', () => {
  const [ev] = parseEventLine(JSON.stringify({ type: 'result', result: 'ok' }));
  assert.equal('usage' in ev, false);
});

test('usage is a control field: redaction does NOT forward it to the browser', () => {
  const [ev] = parseEventLine(JSON.stringify({ type: 'result', result: 'ok', usage: USAGE }));
  const red = redactSessionEvent(ev);
  assert.equal('usage' in red, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/stream-usage.test.js` — expected: FAIL (`ev.usage` undefined).

- [ ] **Step 3: Implement**

In `src/dashboard/session-events.js`, replace the `result` branch of `parseEventLine`:

```js
    if (msg.type === 'result') {
      const ev = { type: 'turn_done', result: msg.result ?? '', isError: !!msg.is_error };
      // usage is a CONTROL field for the runner's headroom math (spec 2026-06-12
      // §3.2); redactSessionEvent does not carry it, so it never reaches the browser.
      if (msg.usage && typeof msg.usage === 'object') ev.usage = msg.usage;
      return [ev];
    }
```

(`redactSessionEvent` needs no change — `usage` is in neither `RENDER_FIELDS.turn_done` nor the control-field carry list.)

- [ ] **Step 4: Run tests**

Run: `node --test test/stream-usage.test.js` then `npm test` — expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/session-events.js test/stream-usage.test.js
git commit -m "feat(events): surface result usage as a runner-only control field"
```

---

## Task 5: `headroomPct` on `listSessions` rows

**Files:**
- Modify: `src/dashboard/session-index.js` (`derivePreview`, `listSessions`, `_cache` entry)
- Test: `test/session-headroom-rows.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/session-headroom-rows.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessions } from '../src/dashboard/session-index.js';
import { encodeProjectDir } from '../src/session-transcripts.js';

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USAGE = { input_tokens: 150_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const aLine = (usage) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }], usage } });
const uLine = JSON.stringify({ type: 'user', message: { content: 'q' } });

async function fixture(lines) {
  const base = await mkdtemp(join(tmpdir(), 'rows-'));
  const agentRoot = join(base, 'agent'); await mkdir(agentRoot);
  const projectsDir = join(base, 'projects');
  const enc = encodeProjectDir(agentRoot, 'linux', { projectsDir });
  await mkdir(join(projectsDir, enc), { recursive: true });
  await writeFile(join(projectsDir, enc, `${SID}.jsonl`), lines.join('\n') + '\n');
  return { agentRoot, io: { projectsDir, platform: 'linux' } };
}

test('rows carry headroomPct from the last assistant usage', async () => {
  const { agentRoot, io } = await fixture([uLine, aLine(USAGE)]);
  const [row] = await listSessions(agentRoot, io);
  assert.equal(row.id, SID);
  assert.equal(row.headroomPct, 25); // 150k of the 200k default window
});

test('rows degrade to headroomPct null when no usage exists', async () => {
  const { agentRoot, io } = await fixture([uLine, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } })]);
  const [row] = await listSessions(agentRoot, io);
  assert.equal(row.headroomPct, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/session-headroom-rows.test.js` — expected: FAIL (`headroomPct` undefined).

- [ ] **Step 3: Implement**

In `src/dashboard/session-index.js`:

1. Extend the imports from the shared module:

```js
import { encodeProjectDir, resolveTranscript, countLines, parseTranscriptLine, occupancyFromTranscriptLine, usageFromTail, headroomPctOf } from '../session-transcripts.js';
```

(keep the existing re-export line as is). Add `import { readPositiveInt, DEFAULT_CONTEXT_WINDOW } from '../config.js';`

2. In `derivePreview`, after the `for (const l of lines)` loop and before the `return`, add a backwards scan over the SAME buffer (whole-file only — the head buffer can miss the file's end when capped):

```js
    // headroom source: last assistant usage. Only trustworthy when the buffer
    // holds the WHOLE file (cap === s.size); capped files fall back to a tail
    // read in listSessions (spec 2026-06-12 §3.3 — one read serves both).
    let occupancy = null;
    if (cap === s.size) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const occ = occupancyFromTranscriptLine(lines[i]);
        if (occ !== null) { occupancy = occ; break; }
      }
    }
```

and include `occupancy` in the returned object:

```js
    return { turns, firstPrompt, turnsApprox: s.size > MAX_SCAN_BYTES, startedAt: s.birthtimeMs || s.mtimeMs, endedAt: s.mtimeMs, mtimeMs: s.mtimeMs, size: s.size, occupancy };
```

3. In `listSessions`, when (re)building a cache entry, resolve big-file occupancy via the bounded tail and store it on the entry; then emit the row field. Replace the cache-fill block:

```js
    let entry = _cache.get(path);
    if (!entry || entry.size !== s.size || entry.mtimeMs !== s.mtimeMs) {
      const preview = await derivePreview(path, parseTranscriptLine);
      let occupancy = preview.occupancy;
      if (occupancy == null && preview.turnsApprox) {
        const u = await usageFromTail(path);   // 256 KB tail; cached with the entry
        occupancy = u ? u.occupancy : null;
      }
      entry = { size: s.size, mtimeMs: s.mtimeMs, preview, lineCount: await countLines(path), occupancy };
      _cache.set(path, entry);
    }
```

and add to the pushed row (after `label`):

```js
      headroomPct: entry.occupancy == null
        ? null
        : headroomPctOf(entry.occupancy, readPositiveInt(process.env.AGENT_MESH_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW)),
```

(Note: `derivePreview`'s existing callers destructure named fields, so the added `occupancy` is additive-safe; the dynamic `parseTranscriptLine` import was already removed in Task 3.)

- [ ] **Step 4: Run tests**

Run: `node --test test/session-headroom-rows.test.js` then `npm test` — expected: PASS; existing `session-routes`/`dashboard-*` suites unaffected (additive row field).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/session-index.js test/session-headroom-rows.test.js
git commit -m "feat(sessions): headroomPct on session rows from one shared scan"
```

---

## Task 6: Peer-turn `agentmesh/metrics.headroom`

**Files:**
- Modify: `src/a2a/stdio-server.js:324-331` (next to the `countTurns` stamp)
- Test: extend `test/multi-turn-delegate.test.js` (it already stubs `claude` + uses the `AGENT_MESH_PROJECTS_DIR` seam)

- [ ] **Step 1: Write the failing test**

In `test/multi-turn-delegate.test.js`, locate the existing test that asserts `agentmesh/metrics.turn` on a SendMessage response (it seeds a transcript into the `AGENT_MESH_PROJECTS_DIR` fixture). Add a sibling test reusing the same harness helpers (same server-spawn + `send` helper used by the `metrics.turn` test):

```js
test('SendMessage stamps agentmesh/metrics.headroom when the thread transcript carries usage', async (t) => {
  // Reuse this file's harness: seed the per-caller transcript fixture exactly like
  // the metrics.turn test, but make the LAST assistant record carry usage:
  const usageLine = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 150000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  });
  // …append usageLine to the seeded transcript before sending, then:
  const res = await send(/* same ask SendMessage params as the metrics.turn test */);
  const metrics = res.result.task.metadata['agentmesh/metrics'];
  assert.equal(metrics.headroom, 25);   // 150k / 200k default window
});

test('metrics.headroom is omitted (never an error) when the transcript has no usage', async (t) => {
  const res = await send(/* metrics.turn fixture unchanged — no usage records */);
  const metrics = res.result.task.metadata['agentmesh/metrics'];
  assert.equal('headroom' in metrics, false);
});
```

(Adapt the two `/* … */` spots to this file's existing helper names — the harness already constructs them for the `metrics.turn` assertions; the only new fixture content is `usageLine`.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/multi-turn-delegate.test.js` — expected: the two new tests FAIL (`headroom` undefined).

- [ ] **Step 3: Implement**

In `src/a2a/stdio-server.js`, extend the imports:

```js
import { countTurns, readSessionHeadroom } from '../session-transcripts.js';
import { readPositiveInt, DEFAULT_CONTEXT_WINDOW } from '../config.js';
```

(merge with whatever each module already imports from those files), then replace the `if (session)` metrics block (currently lines 328-331):

```js
    if (session) {
      const turn = await countTurns(root, session.id, transcriptIo(env));
      if (turn !== null) result.metrics.turn = turn;
      // Spec 2026-06-12 §3.3: additive, best-effort thread headroom — same
      // posture as metrics.turn; absent signal → field omitted, never an error.
      const h = await readSessionHeadroom(root, session.id, {
        ...transcriptIo(env),
        contextWindow: readPositiveInt(env.AGENT_MESH_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW)
      }).catch(() => null);
      if (h) result.metrics.headroom = h.headroomPct;
    }
```

- [ ] **Step 4: Run tests**

Run: `node --test test/multi-turn-delegate.test.js` then `npm test` — expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/a2a/stdio-server.js test/multi-turn-delegate.test.js
git commit -m "feat(a2a): stamp agentmesh/metrics.headroom on multi-turn peer responses"
```

---

## Task 7: `rotate` provenance kind

**Files:**
- Modify: `src/dashboard/session-index.js:53-58` (`deriveProvenance`)
- Test: extend `test/session-headroom-rows.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/session-headroom-rows.test.js`:

```js
import { deriveProvenance } from '../src/dashboard/session-index.js';

test('a rotate event establishes origin for the new generation', () => {
  const events = [{ at: 5, kind: 'rotate', source: 'headroom', sessionId: SID, priorSessionId: 'old' }];
  const prov = deriveProvenance(events, SID);
  assert.equal(prov.originSource, 'headroom');
  assert.equal(prov.lastManagedBy, 'headroom');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/session-headroom-rows.test.js` — expected: new test FAILS (`originSource` is `'cli'`).

- [ ] **Step 3: Implement**

In `deriveProvenance` replace the `create` lookup:

```js
  // `rotate` births the new generation exactly like `create` births a session
  // (spec 2026-06-12 §4.2) — either establishes origin.
  const create = mine.find((e) => e.kind === 'create' || e.kind === 'rotate');
```

Also update the `recordEvent` doc comment kind list to `{kind:'create'|'select'|'open'|'rotate', …}`.

- [ ] **Step 4: Run tests, commit**

Run: `node --test test/session-headroom-rows.test.js` and `npm test` — expected: PASS.

```bash
git add src/dashboard/session-index.js test/session-headroom-rows.test.js
git commit -m "feat(provenance): rotate event kind establishes generation origin"
```

---

## Task 8: `atomicWriteFile` shared util

**Files:**
- Create: `src/atomic-write.js`
- Modify: `src/a2a/session-id.js:52-58` (`persistEpoch` delegates to it)
- Test: `test/atomic-write.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/atomic-write.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '../src/atomic-write.js';
import { persistEpoch, readEpoch } from '../src/a2a/session-id.js';

test('atomicWriteFile creates parents, writes, and leaves no tmp residue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-'));
  const target = join(dir, 'nested', 'deep', 'file.md');
  await atomicWriteFile(target, 'hello');
  assert.equal(await readFile(target, 'utf8'), 'hello');
  await atomicWriteFile(target, 'replaced');
  assert.equal(await readFile(target, 'utf8'), 'replaced');
  const names = await readdir(join(dir, 'nested', 'deep'));
  assert.deepEqual(names, ['file.md']); // no .tmp left behind
});

test('persistEpoch still round-trips through the shared util', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-epoch-'));
  await persistEpoch(root, 'B', 3);
  assert.equal(await readEpoch(root, 'B'), 3);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/atomic-write.test.js` — expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/atomic-write.js`:

```js
// src/atomic-write.js — temp-file + atomic rename writer (the persistEpoch
// pattern, extracted per spec 2026-06-12 §5.3 so digest apply and the epoch
// store share one implementation). A torn write can never be observed.
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export async function atomicWriteFile(path, content, { mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content, { mode });
  await rename(tmp, path);
}
```

In `src/a2a/session-id.js`: add `import { atomicWriteFile } from '../atomic-write.js';`, drop the now-unused `writeFile, rename, mkdir` imports (keep `readFile`) and `randomBytes` if unused, and replace `persistEpoch`'s body:

```js
export async function persistEpoch(agentRoot, caller, n) {
  await atomicWriteFile(epochFile(agentRoot, caller), String(n));
}
```

- [ ] **Step 4: Run tests**

Run: `node --test test/atomic-write.test.js` then `npm test` — expected: PASS (epoch tests in the a2a suites stay green).

- [ ] **Step 5: Commit**

```bash
git add src/atomic-write.js src/a2a/session-id.js test/atomic-write.test.js
git commit -m "refactor(io): shared atomicWriteFile; persistEpoch delegates to it"
```

---

## Task 9: `extractForDigest` (bounded tail extract)

**Files:**
- Create: `src/digest-extract.js`
- Test: `test/digest-extract.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/digest-extract.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractForDigest } from '../src/digest-extract.js';

const u = (text) => JSON.stringify({ type: 'user', message: { content: text } });
const a = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const tool = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/x' } }] } });
const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'HUGE TOOL DUMP' }] } });

async function transcript(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'dx-'));
  const path = join(dir, 'x.jsonl');
  await writeFile(path, lines.join('\n') + '\n');
  return path;
}

test('keeps user/assistant text chronologically; drops tool dumps; redacts secrets', async () => {
  const path = await transcript([u('q1 with ghp_abcdefghijklmnopqrstuv'), tool, toolResult, a('a1')]);
  const out = await extractForDigest(path);
  assert.match(out, /USER: q1/);
  assert.match(out, /«redacted»/);
  assert.match(out, /ASSISTANT: a1/);
  assert.doesNotMatch(out, /HUGE TOOL DUMP/);
  assert.doesNotMatch(out, /tool_use/);
  assert.ok(out.indexOf('USER: q1') < out.indexOf('ASSISTANT: a1'));
});

test('newest-first budget: oldest content is dropped, output stays chronological', async () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(u(`question ${i} ${'pad'.repeat(40)}`));
  const path = await transcript(lines);
  const out = await extractForDigest(path, { maxChars: 2_000 });
  assert.ok(out.length <= 2_000);
  assert.doesNotMatch(out, /question 0 /);
  assert.match(out, /question 199 /);
  const m = [...out.matchAll(/question (\d+) /g)].map((x) => Number(x[1]));
  assert.deepEqual(m, [...m].sort((x, y) => x - y)); // chronological
});

test('the READ itself is bounded: content beyond 4x budget from the end is never parsed', async () => {
  const marker = u('NEEDLE_IN_HEAD');
  const pad = u('z'.repeat(1000));
  const path = await transcript([marker, ...Array.from({ length: 50 }, () => pad)]);
  const out = await extractForDigest(path, { maxChars: 1_000 }); // reads only last ~4KB
  assert.doesNotMatch(out, /NEEDLE_IN_HEAD/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/digest-extract.test.js` — expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/digest-extract.js`:

```js
// src/digest-extract.js — reduce a session transcript to a bounded, redacted,
// text-only extract for the digest worker (spec 2026-06-12 §5.1). The READ is
// bounded (last 4× the output budget), not just the output: a digest must
// never pay an unbounded parse of the very transcript that overflowed.
import { open } from 'node:fs/promises';
import { parseTranscriptLine, redactSessionEvent } from './session-transcripts.js';
import { DEFAULT_DIGEST_EXTRACT_MAX_CHARS } from './config.js';

const READ_FACTOR = 4;

export async function extractForDigest(transcriptPath, { maxChars = DEFAULT_DIGEST_EXTRACT_MAX_CHARS } = {}) {
  let text;
  const fh = await open(transcriptPath, 'r');
  try {
    const s = await fh.stat();
    const cap = Math.min(s.size, READ_FACTOR * maxChars);
    if (cap === 0) return '';
    const offset = s.size - cap;
    const buf = Buffer.alloc(cap);
    await fh.read(buf, 0, cap, offset);
    text = buf.toString('utf8');
    if (offset > 0) { const nl = text.indexOf('\n'); text = nl === -1 ? '' : text.slice(nl + 1); }
  } finally { await fh.close(); }

  // Conversation text only — tool_use/tool_result dropped (the same priority
  // order auto-compaction uses); every kept string goes through redaction.
  const sections = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    for (const raw of parseTranscriptLine(line)) {
      if (raw.type !== 'user_text' && raw.type !== 'text') continue;
      const ev = redactSessionEvent(raw);
      sections.push(`${raw.type === 'user_text' ? 'USER' : 'ASSISTANT'}: ${ev.text}`);
    }
  }
  // Newest-first budget, chronological output.
  const kept = [];
  let total = 0;
  for (let i = sections.length - 1; i >= 0; i--) {
    const len = sections[i].length + 2;
    if (total + len > maxChars) break;
    kept.push(sections[i]);
    total += len;
  }
  return kept.reverse().join('\n\n');
}
```

- [ ] **Step 4: Run tests, commit**

Run: `node --test test/digest-extract.test.js` then `npm test` — expected: PASS.

```bash
git add src/digest-extract.js test/digest-extract.test.js
git commit -m "feat(digest): bounded-tail redacted transcript extract"
```

---

## Task 10: Shared `extractFirstJson`

**Files:**
- Create: `src/json-extract.js`
- Modify: `src/orchestrator.js:174-188` (delete local copy, import the shared one)
- Test: `test/json-extract.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/json-extract.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFirstJson } from '../src/json-extract.js';

test('extracts the first balanced JSON object from prose / fences', () => {
  assert.deepEqual(extractFirstJson('Sure!\n```json\n{"a":{"b":1}}\n```\ntrailing {junk'), { a: { b: 1 } });
});

test('returns null on no object / unbalanced / invalid JSON', () => {
  assert.equal(extractFirstJson('no braces here'), null);
  assert.equal(extractFirstJson('{"a": '), null);
  assert.equal(extractFirstJson('{a: broken}'), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/json-extract.test.js` — expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/json-extract.js` with the function moved **verbatim** from `src/orchestrator.js:174-188`, plus `export`:

```js
// src/json-extract.js — first balanced {...} object out of model text (moved
// verbatim from orchestrator.js so digest parsing reuses it — spec §5.2).
export function extractFirstJson(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}
```

In `src/orchestrator.js`: delete the local `function extractFirstJson(...)` block and add `import { extractFirstJson } from './json-extract.js';` to its imports.

- [ ] **Step 4: Run tests, commit**

Run: `node --test test/json-extract.test.js`, `node --test test/orchestrator-e2e.test.js`, then `npm test` — expected: PASS.

```bash
git add src/json-extract.js src/orchestrator.js test/json-extract.test.js
git commit -m "refactor(json): shared extractFirstJson (orchestrator + digest)"
```

---

## Task 11: Digest core — `validateDigestOutput`, `applyDigest`, `runDigest`

**Files:**
- Create: `src/digest.js`
- Test: `test/digest.test.js` (new)

- [ ] **Step 1: Write the failing test**

Create `test/digest.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDigestOutput, runDigest } from '../src/digest.js';
import { encodeProjectDir } from '../src/session-transcripts.js';
import { MAX_MEMORY_FILE_CHARS } from '../src/config.js';

const SID = 'cccccccc-dddd-4eee-8fff-000000000000';
const GOOD = {
  learned: ['User prefers tabs', 'Repo uses node:test only'],
  decisions: ['2026-06-12 — adopted headroom rotation'],
  proposals: [{ type: 'skill', name: 'cite-sources', summary: 'how to cite', draft: '# SKILL\nbody' }]
};
const summaryFor = (obj) => 'Here you go:\n```json\n' + JSON.stringify(obj) + '\n```';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dg-'));
  const agentRoot = join(base, 'agent'); await mkdir(agentRoot);
  const projectsDir = join(base, 'projects');
  const enc = encodeProjectDir(agentRoot, 'linux', { projectsDir });
  await mkdir(join(projectsDir, enc), { recursive: true });
  await writeFile(join(projectsDir, enc, `${SID}.jsonl`),
    JSON.stringify({ type: 'user', message: { content: 'remember: tabs' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'noted' }] } }) + '\n');
  return { agentRoot, io: { projectsDir, platform: 'linux' } };
}

test('validateDigestOutput: GOOD passes; bad shapes and unsafe names fail closed', () => {
  assert.equal(validateDigestOutput(GOOD).ok, true);
  assert.equal(validateDigestOutput(null).ok, false);
  assert.equal(validateDigestOutput({ ...GOOD, learned: 'not-an-array' }).ok, false);
  assert.equal(validateDigestOutput({ ...GOOD, proposals: [{ type: 'skill', name: '../prompts/x', summary: 's', draft: 'd' }] }).ok, false);
  assert.equal(validateDigestOutput({ ...GOOD, proposals: [{ type: 'weird', name: 'ok-name', summary: 's', draft: 'd' }] }).ok, false);
});

test('runDigest happy path: extract written, worker called with digest timeout, files applied', async () => {
  const { agentRoot, io } = await fixture();
  const calls = [];
  const delegate = async (args) => { calls.push(args); return { status: 'done', summary: summaryFor(GOOD), log_path: '/log' }; };
  const r = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate, now: () => new Date('2026-06-12T10:00:00Z') });
  assert.equal(r.status, 'done');
  assert.equal(calls[0].input.mode, 'ask');
  assert.equal(calls[0].env.AGENT_MESH_TIMEOUT_MS, '180000');
  assert.match(calls[0].input.task, /\.agent-mesh[\\/]digest[\\/]/);
  const learned = await readFile(join(agentRoot, 'memory', 'learned.md'), 'utf8');
  assert.match(learned, /User prefers tabs/);
  assert.ok(learned.length <= MAX_MEMORY_FILE_CHARS);
  const decisions = await readFile(join(agentRoot, 'memory', 'decisions.md'), 'utf8');
  assert.match(decisions, /2026-06-12 — adopted headroom rotation/);
  const day = join(agentRoot, 'deliverables', 'digests', '2026-06-12', SID.slice(0, 8));
  const files = await readdir(day);
  assert.deepEqual(files, ['skill-cite-sources.md']);
  assert.deepEqual(r.applied, { learned: 2, decisions: 1, proposals: ['deliverables/digests/2026-06-12/' + SID.slice(0, 8) + '/skill-cite-sources.md'] });
});

test('oversized learned content is truncated to the memory cap', async () => {
  const { agentRoot, io } = await fixture();
  const big = { learned: Array.from({ length: 30 }, (_, i) => `fact ${i} ` + 'x'.repeat(180)), decisions: [], proposals: [] };
  const delegate = async () => ({ status: 'done', summary: summaryFor(big) });
  const r = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate });
  assert.equal(r.status, 'done');
  const learned = await readFile(join(agentRoot, 'memory', 'learned.md'), 'utf8');
  assert.ok(learned.length <= MAX_MEMORY_FILE_CHARS);
});

test('invalid contract → status error and ZERO writes', async () => {
  const { agentRoot, io } = await fixture();
  const delegate = async () => ({ status: 'done', summary: 'not json at all' });
  const r = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate });
  assert.equal(r.status, 'error');
  assert.equal(r.error.code, 'digest_contract_invalid');
  await assert.rejects(() => access(join(agentRoot, 'memory', 'learned.md')));
});

test('worker failure → status error, zero writes; empty learned never erases memory', async () => {
  const { agentRoot, io } = await fixture();
  await mkdir(join(agentRoot, 'memory'), { recursive: true });
  await writeFile(join(agentRoot, 'memory', 'learned.md'), 'precious');
  const fail = async () => ({ status: 'timeout', error: { message: 'killed' } });
  const r1 = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate: fail });
  assert.equal(r1.status, 'error');
  assert.equal(r1.error.code, 'digest_worker_failed');
  const empty = async () => ({ status: 'done', summary: summaryFor({ learned: [], decisions: [], proposals: [] }) });
  const r2 = await runDigest({ agentRoot, sessionId: SID, env: {}, io, delegate: empty });
  assert.equal(r2.status, 'done');
  assert.equal(await readFile(join(agentRoot, 'memory', 'learned.md'), 'utf8'), 'precious');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/digest.test.js` — expected: FAIL (module missing).

- [ ] **Step 3: Implement**

Create `src/digest.js`:

```js
// src/digest.js — the out-of-band distillation core (spec 2026-06-12 §5).
// The WORKER only emits text (ask-mode, no write tools); THIS module — the
// framework process, i.e. Boundary 5's "separate admin workflow" — validates
// against a fixed contract and applies hard-capped writes. Nothing that is
// obeyed as instructions (skills/workflows/prompts) is ever auto-applied.
import { realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { delegateTask } from './delegate.js';
import { resolveTranscript } from './session-transcripts.js';
import { extractForDigest } from './digest-extract.js';
import { extractFirstJson } from './json-extract.js';
import { atomicWriteFile } from './atomic-write.js';
import { isSafeSkillName } from './skills-policy.js';
import {
  readPositiveInt, MAX_MEMORY_FILE_CHARS,
  DEFAULT_DIGEST_TIMEOUT_MS, DEFAULT_DIGEST_EXTRACT_MAX_CHARS
} from './config.js';

const MAX_LEARNED_ITEMS = 20;
const MAX_LEARNED_ITEM_CHARS = 200;
const MAX_DECISION_ITEMS = 10;
const MAX_DECISION_ITEM_CHARS = 200;
const MAX_PROPOSALS = 5;
const MAX_PROPOSAL_DRAFT_CHARS = 65_536;

const digestPrompt = (extractRel) =>
  `Read the conversation extract at ${extractRel} (a file in your working directory). ` +
  'Distill it into durable knowledge for future sessions. Reply with ONLY a fenced JSON object:\n' +
  '{ "learned": ["durable fact/preference/constraint, <=200 chars each, max 20 items"],\n' +
  '  "decisions": ["YYYY-MM-DD — one-line self-contained decision, max 10 items"],\n' +
  '  "proposals": [{ "type": "skill" or "workflow", "name": "kebab-case-name", "summary": "one line", "draft": "full draft text" }] }\n' +
  'Use empty arrays for sections with nothing durable. Only include content grounded in the extract.';

/** Fail-closed contract check: ANY invalid entry rejects the whole digest. */
export function validateDigestOutput(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false };
  const { learned, decisions, proposals } = parsed;
  if (!Array.isArray(learned) || !Array.isArray(decisions) || !Array.isArray(proposals)) return { ok: false };
  if (learned.length > MAX_LEARNED_ITEMS || decisions.length > MAX_DECISION_ITEMS || proposals.length > MAX_PROPOSALS) return { ok: false };
  const oneLine = (s, cap) => typeof s === 'string' && s.trim() && !s.includes('\n') && s.length <= cap;
  if (!learned.every((s) => oneLine(s, MAX_LEARNED_ITEM_CHARS))) return { ok: false };
  if (!decisions.every((s) => oneLine(s, MAX_DECISION_ITEM_CHARS))) return { ok: false };
  for (const p of proposals) {
    if (!p || typeof p !== 'object') return { ok: false };
    if (p.type !== 'skill' && p.type !== 'workflow') return { ok: false };
    if (!isSafeSkillName(p.name)) return { ok: false };
    if (typeof p.summary !== 'string' || !oneLine(p.summary, 500)) return { ok: false };
    if (typeof p.draft !== 'string' || !p.draft.trim() || p.draft.length > MAX_PROPOSAL_DRAFT_CHARS) return { ok: false };
  }
  return { ok: true, value: { learned, decisions, proposals } };
}

function renderLearned(items, day) {
  const body = `# Learned (digest ${day})\n\n${items.map((s) => `- ${s.trim()}`).join('\n')}\n`;
  if (body.length <= MAX_MEMORY_FILE_CHARS) return body;
  return body.slice(0, MAX_MEMORY_FILE_CHARS - 15).trimEnd() + '\n…[truncated]\n';
}

async function applyDigest(root, sessionId, value, day) {
  const applied = { learned: 0, decisions: 0, proposals: [] };
  if (value.learned.length > 0) { // an EMPTY digest never erases prior memory
    await atomicWriteFile(join(root, 'memory', 'learned.md'), renderLearned(value.learned, day));
    applied.learned = value.learned.length;
  }
  if (value.decisions.length > 0) {
    const path = join(root, 'memory', 'decisions.md');
    const prior = await readFile(path, 'utf8').catch(() => '# Past decisions\n');
    const lines = value.decisions.map((s) => `- ${s.trim()}`).join('\n');
    await atomicWriteFile(path, prior.replace(/\n*$/, '\n') + lines + '\n');
    applied.decisions = value.decisions.length;
  }
  for (const p of value.proposals) {
    const rel = join('deliverables', 'digests', day, sessionId.slice(0, 8), `${p.type}-${p.name}.md`);
    await atomicWriteFile(join(root, rel),
      `# ${p.name} (${p.type} proposal)\n\n${p.summary}\n\n> Digest proposal from session ${sessionId} — propose-only; a human promotes (spec 2026-06-12 §5.3).\n\n---\n\n${p.draft}\n`);
    applied.proposals.push(rel.split('\\').join('/'));
  }
  return applied;
}

/**
 * Distill one session. Failure is data: every non-done outcome returns
 * { status:'error', error:{code,…} } and writes NOTHING.
 * `delegate` is injectable for hermetic tests (defaults to delegateTask).
 */
export async function runDigest({ agentRoot, sessionId, env = {}, io = {}, delegate = delegateTask, now = () => new Date() }) {
  const root = await realpath(agentRoot);
  let transcriptPath;
  try { transcriptPath = await resolveTranscript(root, sessionId, io); }
  catch (e) { return { status: 'error', error: { code: 'transcript_unavailable', message: e.message } }; }

  const extract = await extractForDigest(transcriptPath, {
    maxChars: readPositiveInt(env.AGENT_MESH_DIGEST_EXTRACT_MAX_CHARS, DEFAULT_DIGEST_EXTRACT_MAX_CHARS)
  }).catch(() => '');
  if (!extract.trim()) return { status: 'error', error: { code: 'empty_extract', message: 'nothing to digest' } };

  const extractRel = join('.agent-mesh', 'digest', `${sessionId}-extract.md`);
  await atomicWriteFile(join(root, extractRel), extract);

  const timeoutMs = readPositiveInt(env.AGENT_MESH_DIGEST_TIMEOUT_MS, DEFAULT_DIGEST_TIMEOUT_MS);
  const result = await delegate({
    root,
    env: { ...env, AGENT_MESH_TIMEOUT_MS: String(timeoutMs) },
    input: { mode: 'ask', task: digestPrompt(extractRel) },
    route: 'digest'
  });
  if (result.status !== 'done') {
    return { status: 'error', error: { code: 'digest_worker_failed', message: result.error?.message || result.status, log_path: result.log_path ?? null } };
  }
  const v = validateDigestOutput(extractFirstJson(result.summary || ''));
  if (!v.ok) return { status: 'error', error: { code: 'digest_contract_invalid', message: 'worker output failed the digest contract', log_path: result.log_path ?? null } };

  const day = now().toISOString().slice(0, 10);
  const applied = await applyDigest(root, sessionId, v.value, day);
  return { status: 'done', applied, log_path: result.log_path ?? null };
}
```

- [ ] **Step 4: Run tests, commit**

Run: `node --test test/digest.test.js` then `npm test` — expected: PASS.

```bash
git add src/digest.js test/digest.test.js
git commit -m "feat(digest): runDigest core — fail-closed contract, capped framework-applied writes"
```

---

## Task 12: Decisions-index line cap

**Files:**
- Modify: `src/agent-context.js:232-234` (`buildDecisionsIndex`)
- Test: extend `test/agent-context.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/agent-context.test.js` (match its existing fixture helpers for creating an agent root — it builds temp roots with `memory/` content; reuse the same `mkdtemp` pattern as its other tests):

```js
test('decisions index keeps only the most recent MAX_DECISIONS_INDEX_LINES bullets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ac-cap-'));
  await mkdir(join(root, 'memory'), { recursive: true });
  const bullets = Array.from({ length: 35 }, (_, i) => `- 2026-06-${String((i % 28) + 1).padStart(2, '0')} — decision number ${i}`).join('\n');
  await writeFile(join(root, 'memory', 'decisions.md'), `# Past decisions\n\n${bullets}\n`);
  const prompt = await buildAgentRuntimePrompt(root, 'ask', { meshRoot: null });
  const indexLines = prompt.split('\n').filter((l) => l.includes('(use recall_decision)'));
  assert.equal(indexLines.length, 30);
  assert.match(prompt, /decision number 34/);   // newest kept
  assert.doesNotMatch(prompt, /decision number 0 /); // oldest dropped
});
```

(Add any missing imports the file doesn't already have: `mkdtemp`, `tmpdir`, `mkdir`, `writeFile`, `join`.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/agent-context.test.js` — expected: the new test FAILS (35 lines present).

- [ ] **Step 3: Implement**

In `src/agent-context.js`: add `MAX_DECISIONS_INDEX_LINES` to the config import, then in `buildDecisionsIndex` replace the final formatting block:

```js
    // Most recent N only (file order is oldest→newest): a digest that appends
    // forever must not regrow the prompt it exists to shrink (spec §5.3).
    const recent = formattedBullets.slice(-MAX_DECISIONS_INDEX_LINES);
    if (recent.length > 0) {
      return `### System Decisions Index:\n${recent.join('\n')}`;
    }
```

- [ ] **Step 4: Run tests, commit**

Run: `node --test test/agent-context.test.js` then `npm test` — expected: PASS.

```bash
git add src/agent-context.js test/agent-context.test.js
git commit -m "feat(memory): cap decisions index at most recent 30 bullets"
```

---

## Task 13: `runMaintenance` on the session runner

**Files:**
- Modify: `src/dashboard/session-runner.js` (new export; runTurn untouched)
- Test: extend `test/session-runner.test.js` (its harness already builds `createSessionRunner({ meshRoot, claudeBin })` hermetically)

- [ ] **Step 1: Write the failing test**

Append to `test/session-runner.test.js`, reusing this file's existing mesh fixture helper (the same one its `runTurn` tests use to get a `meshRoot` + agent):

```js
test('runMaintenance holds the agent lease: concurrent runTurn gets session_busy; release on throw', async (t) => {
  const { meshRoot, agentName, claudeBin } = await makeFixture(t); // ← use this file's existing fixture helper name
  const runner = createSessionRunner({ meshRoot, claudeBin });
  let release;
  const gate = new Promise((res) => { release = res; });
  const inside = runner.runMaintenance(agentName, async ({ agentRoot }) => {
    assert.ok(agentRoot.length > 0);
    await gate;
    return 'done';
  });
  await new Promise((r) => setTimeout(r, 50)); // let maintenance acquire
  await assert.rejects(() => runner.runTurn({ agentName, text: 'hi' }), (e) => e.code === 'session_busy');
  release();
  assert.equal(await inside, 'done');
  // lease released → a throwing maintenance also releases:
  await assert.rejects(() => runner.runMaintenance(agentName, async () => { throw new Error('boom'); }), /boom/);
  const again = await runner.runMaintenance(agentName, async () => 'ok-after-throw');
  assert.equal(again, 'ok-after-throw');
});
```

(If the file's fixture helper has a different name/shape, mirror exactly how its first `runTurn` test obtains `meshRoot`/`agentName` — do not invent a new harness.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/session-runner.test.js` — expected: new test FAILS (`runner.runMaintenance` is not a function).

- [ ] **Step 3: Implement**

In `src/dashboard/session-runner.js`, inside `createSessionRunner` (after `setActiveSession`), add — note it deliberately does NOT duplicate `runTurn`'s takeover-kill: maintenance never kills an external session, it defers:

```js
  /**
   * Run a framework maintenance task (digest/rotate — spec 2026-06-12 §4.1.1)
   * under the SAME single-active lease a turn takes, so maintenance and turns
   * can never overlap. Unlike runTurn there is no force/takeover: any busy or
   * external-owner state throws SessionBusyError and the caller defers.
   */
  async function runMaintenance(agentName, fn) {
    if (inFlight.has(agentName)) throw new SessionBusyError('session_busy', { owner: 'dashboard' });
    const { agentRoot } = await resolveAgent(agentName);
    const { lockPath } = sessionPaths(meshRoot, agentRoot);
    const existing = await readLease(lockPath);
    const selfProbe = probePid(process.pid);
    const decision = evaluateLease(existing, {
      now: Date.now(), self: { pid: process.pid, procStartedAt: selfProbe.procStartedAt },
      force: false, launchGraceMs: DEFAULT_LAUNCH_GRACE_MS, probe: probePid
    });
    if (decision.action !== 'acquire') throw new SessionBusyError('session_busy', { owner: existing?.owner });
    const token = await acquireLaunching(lockPath, { pid: process.pid, procStartedAt: selfProbe.procStartedAt, now: Date.now() });
    inFlight.set(agentName, token);
    try {
      return await fn({ agentRoot });
    } finally {
      inFlight.delete(agentName);
      await releaseLease(lockPath, token).catch(() => {});
    }
  }
```

> If `evaluateLease`'s acquire-state action name differs from `'acquire'` (check `src/dashboard/session-lease.js` — `runTurn` treats anything that isn't `busy`/`takeover-refuse`/`takeover-kill` as acquirable), mirror `runTurn`'s exact decision handling but map BOTH takeover actions to a thrown `SessionBusyError('session_busy', …)`.

Update the export line:

```js
  return { runTurn, stop, setActiveSession, runMaintenance };
```

- [ ] **Step 4: Run tests, commit**

Run: `node --test test/session-runner.test.js` then `npm test` — expected: PASS.

```bash
git add src/dashboard/session-runner.js test/session-runner.test.js
git commit -m "feat(runner): runMaintenance — lease-held framework maintenance window"
```

---

## Task 14: Rotation manager + runner `onTurnComplete` hook

**Files:**
- Create: `src/dashboard/rotation.js`
- Modify: `src/dashboard/session-runner.js` (capture usage; invoke hook)
- Test: `test/rotation.test.js` (new)

**GATE CHECK:** Task 2's probe assumption 1 must be PASS-recorded in the spec §12 before this task ships.

- [ ] **Step 1: Write the failing test**

Create `test/rotation.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRotationManager } from '../src/dashboard/rotation.js';

const USAGE_LOW = { input_tokens: 160_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; // 20% headroom
const USAGE_HIGH = { input_tokens: 50_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; // 75% headroom

function harness({ digestResult = { status: 'done', applied: {} }, env = {} } = {}) {
  const fired = [];   // captured idle timers
  const calls = { digest: [], writes: [], events: [], busyOnce: false };
  const mgr = createRotationManager({
    meshRoot: '/mesh',
    runMaintenance: async (agentName, fn) => {
      if (calls.busyOnce) { calls.busyOnce = false; const e = new Error('busy'); e.code = 'session_busy'; throw e; }
      return fn({ agentRoot: `/mesh/${agentName}` });
    },
    runDigest: async (args) => { calls.digest.push(args); return digestResult; },
    writeSessionId: async (meshRoot, agentRoot, id) => { calls.writes.push({ agentRoot, id }); },
    recordEvent: async (meshRoot, ev) => { calls.events.push(ev); },
    env: { AGENT_MESH_ROTATE_IDLE_MS: '1', ...env },
    schedule: (fn) => { fired.push(fn); return { unref() {} }; },
    clearSchedule: () => {}
  });
  return { mgr, fired, calls, async fire() { const fn = fired.pop(); await fn(); } };
}

test('below threshold arms; firing digests then rotates with provenance', async () => {
  const h = harness();
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 'old-id', usage: USAGE_LOW });
  assert.equal(h.fired.length, 1);
  await h.fire();
  assert.equal(h.calls.digest[0].sessionId, 'old-id');
  assert.equal(h.calls.writes.length, 1);
  assert.notEqual(h.calls.writes[0].id, 'old-id');
  const ev = h.calls.events[0];
  assert.equal(ev.kind, 'rotate');
  assert.equal(ev.source, 'headroom');
  assert.equal(ev.priorSessionId, 'old-id');
  assert.equal(ev.sessionId, h.calls.writes[0].id);
});

test('digest failure → no rotation, error retained; healthy turn above threshold cancels a pending one', async () => {
  const h = harness({ digestResult: { status: 'error', error: { code: 'digest_contract_invalid' } } });
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 's', usage: USAGE_LOW });
  await h.fire();
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.mgr.lastErrorFor('a'), 'digest_contract_invalid');
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 's', usage: USAGE_LOW });
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 's', usage: USAGE_HIGH });
  assert.equal(h.fired.length, 1); // the LOW arm remains captured, but pending was cancelled…
  await h.fire();                  // …so firing the stale timer is a no-op
  assert.equal(h.calls.digest.length, 1); // still only the first run's digest
});

test('runMaintenance busy → re-arms instead of erroring; no usage or threshold 0 → never arms', async () => {
  const h = harness();
  h.calls.busyOnce = true;
  h.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/mesh/a', sessionId: 's', usage: USAGE_LOW });
  await h.fire();
  assert.equal(h.fired.length, 1); // re-armed
  const off = harness({ env: { AGENT_MESH_ROTATE_HEADROOM_PCT: '0' } });
  off.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/a', sessionId: 's', usage: USAGE_LOW });
  assert.equal(off.fired.length, 0);
  const noUsage = harness();
  noUsage.mgr.onTurnComplete({ agentName: 'a', agentRoot: '/a', sessionId: 's', usage: null });
  assert.equal(noUsage.fired.length, 0);
});

test('isDigesting reflects the maintenance window', async () => {
  let resolveGate; const gate = new Promise((r) => { resolveGate = r; });
  const seen = [];
  const mgr = createRotationManager({
    meshRoot: '/m',
    runMaintenance: async (n, fn) => fn({ agentRoot: '/m/a' }),
    runDigest: async () => { seen.push(mgr.isDigesting('a')); await gate; return { status: 'done', applied: {} }; },
    writeSessionId: async () => {}, recordEvent: async () => {},
    env: { AGENT_MESH_ROTATE_IDLE_MS: '1' },
    schedule: (fn) => { seen.fire = fn; return { unref() {} }; }, clearSchedule: () => {}
  });
  mgr.onTurnComplete({ agentName: 'a', agentRoot: '/m/a', sessionId: 's', usage: USAGE_LOW });
  const p = seen.fire();
  resolveGate();
  await p;
  assert.deepEqual([seen[0], mgr.isDigesting('a')], [true, false]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/rotation.test.js` — expected: FAIL (module missing).

- [ ] **Step 3: Implement the manager**

Create `src/dashboard/rotation.js`:

```js
// src/dashboard/rotation.js — the generation state machine (spec 2026-06-12 §4).
// IN-MEMORY ONLY by design (D8): a restart loses a pending rotation and the
// next below-threshold turn re-arms it. Control input is the LIVE usage the
// runner captured — never a disk fallback (§3.2).
import { randomUUID } from 'node:crypto';
import { occupancyFromUsage, headroomPctOf } from '../session-transcripts.js';
import { readPositiveInt, DEFAULT_CONTEXT_WINDOW, DEFAULT_ROTATE_HEADROOM_PCT, DEFAULT_ROTATE_IDLE_MS } from '../config.js';

export function createRotationManager({
  meshRoot, runMaintenance, runDigest, writeSessionId, recordEvent,
  env = process.env, schedule = setTimeout, clearSchedule = clearTimeout,
  log = (line) => process.stderr.write(`[agent-mesh] ${line}\n`)
}) {
  const pending = new Map();   // agentName → { timer, token }
  const digesting = new Set(); // agentName
  const lastError = new Map(); // agentName → error code
  const disabled = env.AGENT_MESH_ROTATE_HEADROOM_PCT === '0';
  const thresholdPct = readPositiveInt(env.AGENT_MESH_ROTATE_HEADROOM_PCT, DEFAULT_ROTATE_HEADROOM_PCT);
  const idleMs = readPositiveInt(env.AGENT_MESH_ROTATE_IDLE_MS, DEFAULT_ROTATE_IDLE_MS);
  const contextWindow = readPositiveInt(env.AGENT_MESH_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW);

  function cancel(agentName) {
    const p = pending.get(agentName);
    if (p) { try { clearSchedule(p.timer); } catch { /* fake timers */ } pending.delete(agentName); }
  }

  function arm(agentName, agentRoot, sessionId) {
    cancel(agentName);
    const token = {};  // staleness guard: a fired timer must still be the armed one
    // NOTE: return the rotate promise from the callback so test harnesses (and
    // any awaiting scheduler) can await completion — do not wrap in a void block.
    const timer = schedule(() => rotate(agentName, agentRoot, sessionId, token).catch(() => {}), idleMs);
    timer?.unref?.();
    pending.set(agentName, { timer, token });
  }

  async function rotate(agentName, agentRoot, sessionId, token) {
    const p = pending.get(agentName);
    if (!p || p.token !== token) return; // cancelled/re-armed since scheduling
    pending.delete(agentName);
    try {
      await runMaintenance(agentName, async () => {
        digesting.add(agentName);
        try {
          const r = await runDigest({ agentRoot, sessionId, env });
          if (r.status !== 'done') {
            lastError.set(agentName, r.error?.code || 'digest_failed');
            log(`digest failed for ${agentName}: ${r.error?.code} (no rotation)`);
            return;
          }
          const next = randomUUID();
          await writeSessionId(meshRoot, agentRoot, next);
          await recordEvent(meshRoot, { kind: 'rotate', source: 'headroom', agentRoot, sessionId: next, priorSessionId: sessionId });
          lastError.delete(agentName);
          log(`rotated ${agentName}: ${sessionId} → ${next}`);
        } finally { digesting.delete(agentName); }
      });
    } catch (e) {
      if (e && (e.code === 'session_busy' || e.code === 'session_busy_external')) { arm(agentName, agentRoot, sessionId); return; }
      lastError.set(agentName, 'maintenance_failed');
      log(`rotation maintenance failed for ${agentName}: ${e?.message}`);
    }
  }

  /** Runner hook — called after every completed dashboard turn. */
  function onTurnComplete({ agentName, agentRoot, sessionId, usage }) {
    if (disabled || !agentName || !agentRoot || !sessionId) return;
    const pct = headroomPctOf(occupancyFromUsage(usage), contextWindow);
    if (pct === null) return;                       // no signal → no decision (§3.2)
    if (pct >= thresholdPct) { cancel(agentName); return; }
    arm(agentName, agentRoot, sessionId);
  }

  return {
    onTurnComplete,
    isDigesting: (agentName) => digesting.has(agentName),
    lastErrorFor: (agentName) => lastError.get(agentName) ?? null,
    stop() { for (const name of [...pending.keys()]) cancel(name); }
  };
}
```

- [ ] **Step 4: Wire the runner hook**

In `src/dashboard/session-runner.js`:

1. Constructor signature gains the hook:

```js
export function createSessionRunner({ meshRoot, claudeBin = process.env.AGENT_MESH_CLAUDE || 'claude', sessionLive = null, onTurnComplete = null }) {
```

2. In `runTurn`, capture usage in the existing readline loop — extend the `for (const ev of events)` body:

```js
          if (ev.type === 'turn_done' && ev.usage) lastUsage = ev.usage;
```

and declare `let lastUsage = null;` next to `let capturedSid = storedSessionId;`.

3. In the `finish` function, after `res({ ok: code === 0, code });` add:

```js
          // Rotation hook (spec 2026-06-12 §4.1): live usage only; never throws
          // into the turn path.
          try { onTurnComplete?.({ agentName, agentRoot, sessionId: capturedSid, usage: lastUsage, ok: code === 0 }); } catch { /* hook must not break turns */ }
```

and change `res({ ok: code === 0, code })` to `res({ ok: code === 0, code, usage: lastUsage })` (additive — existing callers destructure `ok`/`code`).

- [ ] **Step 5: Run tests, commit**

Run: `node --test test/rotation.test.js`, `node --test test/session-runner.test.js`, then `npm test` — expected: PASS.

```bash
git add src/dashboard/rotation.js src/dashboard/session-runner.js test/rotation.test.js
git commit -m "feat(rotation): headroom-armed digest+rotate manager wired to turn completion"
```

---

## Task 15: Server wiring + minimal UI

**Files:**
- Modify: `src/dashboard/server.js` (construct manager; pass hook; expose `digesting` + `rotationError` on `/session/list`) — locate with `grep -n "createSessionRunner(" src/dashboard/server.js` (currently :2541)
- Modify: `src/dashboard/public/session-log.js:283-294` (meta rows)
- Test: extend `test/session-headroom-rows.test.js` is NOT possible for routes — extend `test/session-routes.test.js` instead (it exercises `/session/list` with an injected `sessionRunner`/`sessionIndex`)

- [ ] **Step 1: Write the failing test**

In `test/session-routes.test.js`, find the existing `/session/list` test (it asserts `canonicalId` + rows) and add a sibling that injects a fake rotation manager (mirror the file's existing server-construction options):

```js
test('session list exposes digesting + rotationError from the rotation manager', async (t) => {
  // mirror this file's existing /session/list harness; add:
  const rotation = { isDigesting: (name) => name === AGENT_NAME, lastErrorFor: () => 'digest_contract_invalid' };
  // pass `rotation` through createDashboardServer/options the same way sessionRunner is injected
  const res = await getJson(`/api/agent/${AGENT_NAME}/session/list`);
  assert.equal(res.digesting, true);
  assert.equal(res.rotationError, 'digest_contract_invalid');
});
```

(Use the file's actual helper names — `getJson`/server bootstrap differ slightly; the assertion payload is the contract.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/session-routes.test.js` — expected: new test FAILS (fields missing).

- [ ] **Step 3: Implement server wiring**

In `src/dashboard/server.js`:

1. Imports: `import { createRotationManager } from './rotation.js';` and `import { runDigest } from '../digest.js';` plus `writeSessionId` is already imported; `recordEvent` comes via the injected `sessionIndex` default import (`defaultRecordEvent` is already imported at :40).

2. Where the runner is constructed (`:2541`), replace:

```js
  const runner = sessionRunner ?? (allowShell ? createSessionRunner({ meshRoot, sessionLive: live }) : null);
```

with:

```js
  let rotationManager = rotation ?? null;   // `rotation` = new injectable option, default null
  const runner = sessionRunner ?? (allowShell
    ? createSessionRunner({
        meshRoot, sessionLive: live,
        onTurnComplete: (info) => rotationManager?.onTurnComplete(info)
      })
    : null);
  if (!rotationManager && runner && typeof runner.runMaintenance === 'function') {
    rotationManager = createRotationManager({
      meshRoot,
      runMaintenance: runner.runMaintenance,
      runDigest,
      writeSessionId,
      recordEvent: defaultRecordEvent
    });
  }
```

Add `rotation` to the server factory's options destructuring (default `undefined`), and call `rotationManager?.stop?.()` wherever the server's close/cleanup path tears down the runner.

3. In the `/session/list` route (the `verb === 'list'` block), extend the final send:

```js
      sendJson(res, 200, {
        ok: true, sessions, canonicalId,
        digesting: !!rotationManager?.isDigesting?.(name),
        rotationError: rotationManager?.lastErrorFor?.(name) ?? null
      });
```

- [ ] **Step 4: Implement the UI rows**

In `src/dashboard/public/session-log.js`, the meta rows block (currently :283-294) — after the `['turns', String(turns)]` row add:

```js
      ['turns',      String(turns)],
      ...(s.headroomPct != null ? [['headroom', `${s.headroomPct}%`]] : []),
```

and where the fetch handler receives the `/session/list` payload (`j`), thread the flag onto the pinned session before render:

```js
    if (j.digesting) s.digesting = true;
```

then in the rows block:

```js
    if (s.digesting)   rows.push(['status', 'digesting…']);
```

(Keep `session-view.js` untouched — the canonical poll already switches generations; richer UI is out of scope per the spec.)

- [ ] **Step 5: Run tests, commit**

Run: `node --test test/session-routes.test.js` then `npm test` — expected: PASS.

```bash
git add src/dashboard/server.js src/dashboard/public/session-log.js test/session-routes.test.js
git commit -m "feat(dashboard): wire rotation manager; surface headroom + digesting state"
```

---

## Task 16: Docs + final verification

**Files:**
- Modify: `CLAUDE.md` (Config section)
- Modify: `PROJECT.md` (metrics + changelog)
- Modify: `docs/superpowers/specs/2026-06-12-session-generations-design.md` (§12 — implementation note)

- [ ] **Step 1: CLAUDE.md config line**

In `CLAUDE.md`'s "Config (env, all optional)" section, append to the env list (same `·`-separated style):

```
`AGENT_MESH_CONTEXT_WINDOW` (200000) · `AGENT_MESH_ROTATE_HEADROOM_PCT` (25; `0` disables auto-rotation) · `AGENT_MESH_ROTATE_IDLE_MS` (120000) · `AGENT_MESH_DIGEST_TIMEOUT_MS` (180000) · `AGENT_MESH_DIGEST_EXTRACT_MAX_CHARS` (120000)
```

- [ ] **Step 2: PROJECT.md**

Locate the `agentmesh/metrics` documentation (grep `metrics.turn` in PROJECT.md) and add, in the same style as the `turn` entry: `headroom` — *approximate thread headroom percent from the last assistant usage in the transcript tail; additive minor field, omitted when unmeasurable*. Append a changelog entry: `2026-06-12 — session generations: headroom measurement, digest pipeline, self-session rotation (spec docs/superpowers/specs/2026-06-12-session-generations-design.md).`

- [ ] **Step 3: Spec §12 implementation note**

Append to the spec's review log: implementation landed on `claude/dreamy-goodall-vcvash` per `docs/superpowers/plans/2026-06-12-session-generations.md`; restate the probe verdict line (from Task 2).

- [ ] **Step 4: Full suite, final commit**

Run: `npm test` — expected: full PASS (and on Windows additionally run `node scripts/live-a2a-check.mjs` if touching this from a Windows machine).

```bash
git add CLAUDE.md PROJECT.md docs/superpowers/specs/2026-06-12-session-generations-design.md
git commit -m "docs: session-generations config, metrics.headroom contract, changelog"
git push -u origin claude/dreamy-goodall-vcvash
```

---

## Self-review checklist (run after Task 16)

- Spec §6 component table ↔ tasks: session-transcripts (T1/T3), session-events (T3/T4), runner (T13/T14), session-index (T5/T7), stdio-server (T6), digest-extract (T9), digest (T11), atomic-write (T8), agent-context (T12), config (T1), probe (T2), UI+server (T15), docs (T16), json-extract (T10). All §10 spec tests map to task tests 1:1.
- The probe gate (Task 2 step 5) was recorded in the spec BEFORE Tasks 13–15 merged.
- Grep the diff for `do`-mode or `Bash` additions: there must be none.
