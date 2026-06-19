# Single-Instance Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agent-mesh dashboard` reaps any prior dashboard on the same port on launch (via a port-scoped pidfile), so stale instances stop piling up.

**Architecture:** A small injected-I/O helper `src/dashboard/single-instance.js` (`pidfilePath`/`reapExisting`/`writePidfile`/`removePidfile`/`isAlive`) that's hermetically unit-tested with a fake process table; thin wiring into the `dashboard` command in `src/cli.js` (reap before `start()`, write pidfile, remove on exit) + a `--no-replace` opt-out + an actionable `EADDRINUSE` message.

**Tech Stack:** Node ≥20, ESM, zero deps, `node --test`.

Spec: `docs/superpowers/specs/2026-06-19-dashboard-single-instance-design.md`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/dashboard/single-instance.js` (new) | `pidfilePath` · `reapExisting` (SIGTERM→grace→SIGKILL) · `writePidfile` · `removePidfile` · `isAlive` — all I/O injected |
| `src/cli.js` (modify) | wire into the `dashboard` command (`--no-replace`, reap+write before start, remove on exit, EADDRINUSE message) |
| `test/dashboard-single-instance.test.js` (new) | hermetic helper tests + CLI-wiring lint |

---

## Task 1: The `single-instance.js` helper

**Files:**
- Create: `src/dashboard/single-instance.js`
- Test: `test/dashboard-single-instance.test.js`

- [ ] **Step 1: Write the failing test `test/dashboard-single-instance.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pidfilePath, reapExisting, writePidfile, removePidfile } from '../src/dashboard/single-instance.js';

test('pidfilePath is port-scoped + deterministic', () => {
  assert.match(pidfilePath(7077, '/tmp'), /\/tmp\/agent-mesh-dashboard-7077\.pid$/);
  assert.notEqual(pidfilePath(7077, '/tmp'), pidfilePath(9000, '/tmp'));
});

// A fake process table + kill. table[pid] ∈ 'alive' | 'ignores-sigterm' | 'dead'.
function fakeKill(table) {
  return (pid, sig) => {
    const st = table[pid];
    if (sig === 0) { if (!st || st === 'dead') { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; } return; }
    if (sig === 'SIGTERM') { if (st === 'alive') table[pid] = 'dead'; return; }   // 'ignores-sigterm' survives
    if (sig === 'SIGKILL') { table[pid] = 'dead'; return; }
  };
}
const noSleep = async () => {};
const recorder = (table) => { const calls = []; const k = fakeKill(table); return { calls, signalKill: (pid, sig) => { calls.push(sig); return k(pid, sig); } }; };

test('reapExisting: no/unreadable pidfile → none', async () => {
  const r = await reapExisting({ pidfile: '/nope.pid', readFileSync: () => { const e = new Error('ENOENT'); throw e; }, sleep: noSleep });
  assert.equal(r.action, 'none');
});

test('reapExisting: stale (dead) pid → stale, no SIGTERM', async () => {
  const { calls, signalKill } = recorder({ 111: 'dead' });
  const r = await reapExisting({ pidfile: 'x', readFileSync: () => JSON.stringify({ pid: 111 }), signalKill, sleep: noSleep });
  assert.equal(r.action, 'stale');
  assert.ok(!calls.includes('SIGTERM') && !calls.includes('SIGKILL'));
});

test('reapExisting: live pid that exits on SIGTERM → reaped, no SIGKILL', async () => {
  const { calls, signalKill } = recorder({ 222: 'alive' });
  const r = await reapExisting({ pidfile: 'x', readFileSync: () => JSON.stringify({ pid: 222 }), signalKill, sleep: noSleep, graceMs: 300, pollMs: 100 });
  assert.equal(r.action, 'reaped');
  assert.ok(calls.includes('SIGTERM'));
  assert.ok(!calls.includes('SIGKILL'));
});

test('reapExisting: live pid that ignores SIGTERM → SIGKILL after grace', async () => {
  const { calls, signalKill } = recorder({ 333: 'ignores-sigterm' });
  const r = await reapExisting({ pidfile: 'x', readFileSync: () => JSON.stringify({ pid: 333 }), signalKill, sleep: noSleep, graceMs: 300, pollMs: 100 });
  assert.equal(r.action, 'reaped');
  assert.ok(calls.includes('SIGTERM') && calls.includes('SIGKILL'));
});

test('reapExisting: --no-replace + live pid → throws refusal', async () => {
  const { signalKill } = recorder({ 444: 'alive' });
  await assert.rejects(
    reapExisting({ pidfile: 'x', replace: false, readFileSync: () => JSON.stringify({ pid: 444 }), signalKill, sleep: noSleep }),
    /already running/,
  );
});

test('writePidfile/removePidfile: round-trip + best-effort (never throw)', () => {
  let written = null;
  writePidfile('p', { pid: 5, port: 7077, now: 123 }, { writeFileSync: (f, c) => { written = c; } });
  assert.deepEqual(JSON.parse(written), { pid: 5, port: 7077, startedAt: 123 });
  assert.doesNotThrow(() => writePidfile('p', { pid: 5, port: 7077, now: 1 }, { writeFileSync: () => { throw new Error('EACCES'); } }));
  assert.doesNotThrow(() => removePidfile('p', { rmSync: () => { throw new Error('boom'); } }));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/dashboard-single-instance.test.js`
Expected: FAIL — `Cannot find module '../src/dashboard/single-instance.js'`.

- [ ] **Step 3: Write `src/dashboard/single-instance.js`**

```js
// Single-instance dashboard: reap a prior dashboard on the same port (via a
// port-scoped pidfile) before launching a new one. All process/fs I/O is
// injectable so the reap logic is hermetically testable with a fake process table.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync, rmSync as fsRmSync } from 'node:fs';

export function pidfilePath(port, dir = tmpdir()) {
  return join(dir, `agent-mesh-dashboard-${port}.pid`);
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// process.kill(pid, 0): throws ESRCH if dead, EPERM if alive-but-not-ours.
export function isAlive(pid, signalKill = process.kill) {
  try { signalKill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

/**
 * Reap the prior dashboard recorded in the pidfile. Graceful (SIGTERM) → grace
 * poll → forceful (SIGKILL). Fail-open for launch (signal errors swallowed)
 * EXCEPT the --no-replace refusal, which throws.
 * @returns {Promise<{action:'none'|'stale'|'reaped', pid?:number}>}
 */
export async function reapExisting({ pidfile, replace = true, signalKill = process.kill, sleep = defaultSleep, readFileSync = fsReadFileSync, log = () => {}, graceMs = 3000, pollMs = 100 }) {
  let pid;
  try { pid = JSON.parse(readFileSync(pidfile, 'utf8')).pid; } catch { return { action: 'none' }; }
  if (typeof pid !== 'number' || pid <= 0 || pid === process.pid) return { action: 'none' };
  if (!isAlive(pid, signalKill)) return { action: 'stale', pid };
  if (!replace) { const e = new Error(`a dashboard is already running (pid ${pid}); stop it or use a different --port`); e.code = 'DASHBOARD_RUNNING'; throw e; }
  log(`single-instance: reaping prior dashboard pid ${pid}…`);
  try { signalKill(pid, 'SIGTERM'); } catch { /* already gone */ }
  let waited = 0;
  while (waited < graceMs) {
    await sleep(pollMs); waited += pollMs;
    if (!isAlive(pid, signalKill)) return { action: 'reaped', pid };
  }
  try { signalKill(pid, 'SIGKILL'); } catch { /* gone */ }
  await sleep(pollMs);
  return { action: 'reaped', pid };
}

export function writePidfile(pidfile, { pid, port, now }, { writeFileSync = fsWriteFileSync } = {}) {
  try { writeFileSync(pidfile, JSON.stringify({ pid, port, startedAt: now })); } catch { /* best-effort */ }
}

export function removePidfile(pidfile, { rmSync = fsRmSync } = {}) {
  try { rmSync(pidfile, { force: true }); } catch { /* best-effort */ }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/dashboard-single-instance.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/single-instance.js test/dashboard-single-instance.test.js
git commit -m "feat(dashboard): single-instance pidfile reap helper (injected I/O)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Wire into the `dashboard` CLI command

**Files:**
- Modify: `src/cli.js` (the `if (command === 'dashboard')` block, ~line 301)
- Test: `test/dashboard-single-instance.test.js` (add a CLI-wiring lint)

- [ ] **Step 1: Add the failing CLI-wiring lint to `test/dashboard-single-instance.test.js`**

Append:
```js
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const cli = readFileSync(fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'utf8');

test('cli dashboard command wires single-instance', () => {
  assert.match(cli, /single-instance\.js/, 'imports the helper');
  assert.match(cli, /reapExisting/, 'reaps a prior instance');
  assert.match(cli, /writePidfile/, 'records its own pidfile');
  assert.match(cli, /removePidfile/, 'cleans up on exit');
  assert.match(cli, /--no-replace/, 'has the opt-out flag');
  assert.match(cli, /EADDRINUSE/, 'gives an actionable port-in-use message');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/dashboard-single-instance.test.js`
Expected: FAIL — the CLI-wiring assertions fail (not yet wired).

- [ ] **Step 3: Wire it into `src/cli.js`**

First READ the full `dashboard` command block (`if (command === 'dashboard') { … }`, ~lines 301–365) including its `try { … } catch (err) { … }` and the SIGINT/SIGTERM `await new Promise(...)` + `await srv.close()`. Then:

(a) Parse the `--no-replace` flag — in the `for` loop that handles `--no-open`/`--allow-shell`/`--enable-chat`, add (and declare `let replace = true;` near the other flag vars):
```js
      if (arg === '--no-replace') { replace = false; continue; }
```

(b) Import the helper + compute the pidfile, and REAP + WRITE before `await srv.start()`. Inside the `try`, before `await srv.start();`:
```js
      const { pidfilePath, reapExisting, writePidfile, removePidfile } = await import('./dashboard/single-instance.js');
      const pidfile = pidfilePath(port);
      await reapExisting({ pidfile, replace, log: (m) => process.stdout.write(m + '\n') });
      writePidfile(pidfile, { pid: process.pid, port, now: Date.now() });
```
(`removePidfile` is imported here too for use in cleanup below.)

(c) CLEANUP on exit — after the SIGINT/SIGTERM `await new Promise(...)` resolves and `await srv.close();`, add:
```js
      removePidfile(pidfile);
```
AND in the `catch (err)` block, also `removePidfile(pidfile)` IF `pidfile` is in scope there (if the `const pidfile` is block-scoped inside the `try` and not visible in `catch`, hoist `let pidfile = null;` to just before the `try` and assign `pidfile = pidfilePath(port);` inside — so `catch`/cleanup can reference it; only `removePidfile` when `pidfile` is set).

(d) ACTIONABLE EADDRINUSE — in the `catch (err)` block, replace the plain `process.stderr.write(\`error: ${err.message}\n\`)` with an EADDRINUSE-aware message (keep the existing non-zero exit behavior, whatever it is):
```js
    } catch (err) {
      const msg = err.code === 'EADDRINUSE'
        ? `port ${port} is already in use by another process (not a tracked dashboard); free it or use --port`
        : err.message;
      process.stderr.write(`error: ${msg}\n`);
      if (pidfile) removePidfile(pidfile);
      process.exitCode = 1;
    }
```
Match the REAL catch structure (it may already set `process.exitCode`); adapt — the key additions are the EADDRINUSE branch + the cleanup. A `reapExisting` `--no-replace` refusal (code `DASHBOARD_RUNNING`) also lands here and prints its message — that's correct.

Update the usage string (the `agent-mesh dashboard …` line, ~line 20) to include `[--no-replace]`.

- [ ] **Step 4: Run the lint + a quick CLI smoke**

Run: `node --test test/dashboard-single-instance.test.js` → PASS (8 tests: 7 helper + 1 lint).
Run: `node --check src/cli.js` → clean (valid syntax).
Run (usage shows the flag): `node ./bin/agent-mesh.js --help 2>&1 | grep -- '--no-replace'` → the dashboard usage line includes `--no-replace`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.js test/dashboard-single-instance.test.js
git commit -m "feat(cli): single-instance dashboard — reap prior instance on launch (--no-replace opt-out)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Full-suite verification + live single-instance check

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS — all existing + new (`dashboard-single-instance` 8); 0 failures.

- [ ] **Step 2: Live single-instance check (real CLI, a spare port)**

Prove a relaunch reaps the prior process (and the lingering-process case):
```bash
cd /Users/jingbohan/Documents/dev/agent_mesh-siwt
# start instance A on a spare port
node ./bin/agent-mesh.js dashboard dev-mesh --port 7195 --no-open > /tmp/si-a.log 2>&1 &
sleep 3
A=$(lsof -ti tcp:7195 2>/dev/null | head -1); echo "instance A pid=$A"
cat /tmp/agent-mesh-dashboard-7195.pid   # pidfile records A
# start instance B on the SAME port — should reap A
node ./bin/agent-mesh.js dashboard dev-mesh --port 7195 --no-open > /tmp/si-b.log 2>&1 &
sleep 5
echo "B log (expect 'reaping prior dashboard pid $A'):"; grep -i 'reaping' /tmp/si-b.log
B=$(lsof -ti tcp:7195 2>/dev/null | head -1); echo "now serving pid=$B (should differ from A=$A)"
echo "is A still alive? (expect: no)"; ps -p "$A" >/dev/null 2>&1 && echo "A STILL ALIVE — FAIL" || echo "A reaped ✓"
echo "exactly one dashboard on 7195?"; ps -eo pid,command | grep '[a]gent-mesh.js dashboard' | grep 7195
# cleanup
lsof -ti tcp:7195 2>/dev/null | xargs kill 2>/dev/null; rm -f /tmp/agent-mesh-dashboard-7195.pid
```
Expected: B's log shows `reaping prior dashboard pid <A>`; A is no longer alive; one dashboard process remains on 7195. (This is the exact stale-process scenario, now self-healed.)

- [ ] **Step 3: Commit (empty if clean)**

```bash
git commit --allow-empty -m "test(dashboard): single-instance verified — npm test green + live reap-on-relaunch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes (author)

- **Spec: reap prior on same port (SIGTERM→grace→SIGKILL)** → Task 1 (`reapExisting`). ✓
- **Spec: port-scoped pidfile in os.tmpdir()** → Task 1 (`pidfilePath`). ✓
- **Spec: --no-replace opt-out (refuse if running)** → Task 1 (throws) + Task 2 (flag). ✓
- **Spec: never blind-kill an untracked holder → clear EADDRINUSE error** → Task 2 (catch maps EADDRINUSE). ✓
- **Spec: fail-open launch (best-effort pidfile I/O)** → Task 1 (writePidfile/removePidfile swallow; reap swallows signal errors). ✓
- **Spec: cleanup pidfile on exit** → Task 2 (removePidfile after close + in catch). ✓
- **Spec: hermetic tests (fake process table)** → Task 1; CLI lint → Task 2; live check → Task 3. ✓
- **Naming consistency:** `pidfilePath`, `reapExisting`, `writePidfile`, `removePidfile`, `isAlive`, `--no-replace`, `DASHBOARD_RUNNING` — identical across tasks.
- **Deferred (per spec):** lsof/netstat reap of untracked instances; `dashboard --status/--stop`.
