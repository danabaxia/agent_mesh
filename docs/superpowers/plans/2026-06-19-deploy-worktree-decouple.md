# Deploy-Worktree Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the 24/7 dev-society daemon from a dedicated git worktree pinned to `main` (synced + restarted by a new `deploy-sync`), so it never serves a dev checkout another agent has branch-switched.

**Architecture:** A pure planner (`planDeploySync`) decides reset/restart; a thin runner (`runDeploySyncOnce`) does `fetch` → `reset --hard origin/main` → restart-on-advance with a persisted `lastRestartedTarget` so a failed restart retries; an install/cutover shell script wires launchd to the deploy worktree and dedupes the legacy plist. Build + stage only — the operator runs the cutover; no code or test calls `launchctl` against the live daemon. Spec: `docs/superpowers/specs/2026-06-19-deploy-worktree-decouple-design.md`.

**Tech Stack:** Node ≥ 20 ESM, `node --test`, zero dependencies; bash for the install script; macOS launchd.

## Global Constraints

- **Node ≥ 20, ESM, zero dependencies** — no new packages; tests use `node --test`.
- **`planDeploySync` is pure** — no I/O, no `Date.now()`; inputs are parameters.
- **Reuse `runGit`-style `execFile('git')`** wrapping; only git/launchctl touch the outside world, in the runner/script (not the pure planner).
- **State contract (single definition):** `.dev-society/deploy-sync-state.json` = `{ "lastRestartedTarget": "<sha>" }`; `readState() → string` (field or `''`); `writeState(targetSha)` writes the object atomically (tmp + rename).
- **`reset` and `restart` are independent**: `reset = !!target && head !== target`; `restart = !!target && target !== lastRestartedTarget`. `writeState(target)` only after a **successful** restart.
- **Git failure → `{action:'error'}`, never restart** (the runner wraps git in try/catch; real `git` throws on failure).
- **Install script live mode pins `DEPLOY_ROOT = realpath($SCRIPT_DIR/..)`** and rejects a mismatching `DEV_SOCIETY_DEPLOY_ROOT`; the env is honored **only** under `--dry-run`.
- **No live mutation in code/tests** — `--dry-run` prints actions/plists and calls no `launchctl`; the legacy label `com.danabaxia.dev-society` is deduped; the `…dev-society-report` plist is out of scope.
- **Labels:** daemon `com.danabaxia.agent-mesh.dev-society`; deploy-sync `com.danabaxia.agent-mesh.deploy-sync`; legacy (removed) `com.danabaxia.dev-society`.

---

### Task 1: `deploy-sync` — pure planner + sync runner

**Files:**
- Create: `src/dev-society/deploy-sync.js` (pure `planDeploySync`)
- Create: `scripts/dev-society-deploy-sync.mjs` (runner + default fs/launchctl deps + CLI)
- Test: `test/deploy-sync.test.js`

**Interfaces:**
- Produces: `planDeploySync({ head, target, lastRestartedTarget }) → { reset:boolean, restart:boolean }`.
- Produces (from the runner module): `runDeploySyncOnce({ deployPath, git, restart, readState, writeState, now, log }) → record`; `makeFileState(statePath) → { readState, writeState }`; `makeLaunchctlRestart(label) → () => Promise<void>`; `runGitCap(deployPath, args) → Promise<string>` (trimmed stdout).

- [ ] **Step 1: Write the failing test**

```js
// test/deploy-sync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDeploySync } from '../src/dev-society/deploy-sync.js';
import { runDeploySyncOnce, makeFileState } from '../scripts/dev-society-deploy-sync.mjs';

const AT = () => new Date('2026-06-20T07:00:00.000Z');

test('planDeploySync: independent reset and restart', () => {
  assert.deepEqual(planDeploySync({ head: 'a', target: 'b', lastRestartedTarget: 'a' }), { reset: true, restart: true });
  assert.deepEqual(planDeploySync({ head: 'b', target: 'b', lastRestartedTarget: 'b' }), { reset: false, restart: false });
  // retry-after-failed-restart: tree already at target, but daemon not yet restarted onto it
  assert.deepEqual(planDeploySync({ head: 'b', target: 'b', lastRestartedTarget: 'a' }), { reset: false, restart: true });
  // empty target → both false
  assert.deepEqual(planDeploySync({ head: 'a', target: '', lastRestartedTarget: '' }), { reset: false, restart: false });
});

// Fake git keyed on the first args; records the commands issued.
function fakeGit({ head, target, fetchThrows }) {
  const calls = [];
  const git = async (_path, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return head;
    if (args[0] === 'fetch') { if (fetchThrows) throw new Error('network down'); return ''; }
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return target;
    if (args[0] === 'reset') return '';
    return '';
  };
  return { git, calls };
}

test('runDeploySyncOnce: advance resets, restarts, and persists target', async () => {
  const { git, calls } = fakeGit({ head: 'old', target: 'new' });
  let restarts = 0; const writes = [];
  const rec = await runDeploySyncOnce({
    deployPath: '/x', git, restart: async () => { restarts++; },
    readState: () => 'old', writeState: (t) => writes.push(t), now: AT,
  });
  assert.equal(rec.action, 'advanced');
  assert.ok(calls.includes('reset --hard origin/main'));
  assert.equal(restarts, 1);
  assert.deepEqual(writes, ['new']);
});

test('runDeploySyncOnce: already current + already restarted → no reset, no restart', async () => {
  const { git, calls } = fakeGit({ head: 'cur', target: 'cur' });
  let restarts = 0; const writes = [];
  const rec = await runDeploySyncOnce({ deployPath: '/x', git, restart: async () => { restarts++; },
    readState: () => 'cur', writeState: (t) => writes.push(t), now: AT });
  assert.equal(rec.action, 'up_to_date');
  assert.ok(!calls.includes('reset --hard origin/main'));
  assert.equal(restarts, 0);
  assert.deepEqual(writes, []);
});

test('runDeploySyncOnce: restart failure does NOT persist (so next tick retries)', async () => {
  const { git } = fakeGit({ head: 'old', target: 'new' });
  const writes = [];
  const rec = await runDeploySyncOnce({ deployPath: '/x', git,
    restart: async () => { throw new Error('launchctl boom'); },
    readState: () => 'old', writeState: (t) => writes.push(t), now: AT });
  assert.equal(rec.action, 'error');
  assert.deepEqual(writes, []);  // lastRestartedTarget unchanged → retried later
});

test('runDeploySyncOnce: git fetch failure → error, no reset, no restart', async () => {
  const { git, calls } = fakeGit({ head: 'old', target: 'new', fetchThrows: true });
  let restarts = 0;
  const rec = await runDeploySyncOnce({ deployPath: '/x', git, restart: async () => { restarts++; },
    readState: () => 'old', writeState: () => {}, now: AT });
  assert.equal(rec.action, 'error');
  assert.ok(!calls.includes('reset --hard origin/main'));
  assert.equal(restarts, 0);
});

test('makeFileState round-trips the scalar contract atomically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-'));
  const sp = join(dir, '.dev-society', 'deploy-sync-state.json');
  const s = makeFileState(sp);
  assert.equal(s.readState(), '');           // missing → ''
  s.writeState('abc123');
  assert.equal(s.readState(), 'abc123');
  assert.equal(JSON.parse(readFileSync(sp, 'utf8')).lastRestartedTarget, 'abc123');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deploy-sync.test.js`
Expected: FAIL — `Cannot find module '../src/dev-society/deploy-sync.js'`.

- [ ] **Step 3: Write the pure planner**

```js
// src/dev-society/deploy-sync.js — pure planner for the deploy-worktree sync. No I/O.
// reset:  the worktree is not at origin/main → hard-reset it.
// restart: the daemon has not been restarted onto this target yet (keyed off a
//          persisted lastRestartedTarget) → restart it. Independent of reset so a
//          failed restart is retried on a later tick even when the tree is current.
export function planDeploySync({ head, target, lastRestartedTarget } = {}) {
  const t = typeof target === 'string' ? target : '';
  const h = typeof head === 'string' ? head : '';
  const last = typeof lastRestartedTarget === 'string' ? lastRestartedTarget : '';
  return { reset: !!t && h !== t, restart: !!t && t !== last };
}
```

- [ ] **Step 4: Write the runner + default deps + CLI**

```js
// scripts/dev-society-deploy-sync.mjs — sync the deploy worktree to origin/main and
// restart the daemon on advance. Reset-to-main is correct for a deploy-only tree
// (self-healing, works on a detached HEAD). Restart is retryable via persisted state.
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { planDeploySync } from '../src/dev-society/deploy-sync.js';

const sh = promisify(execFile);

export async function runGitCap(deployPath, args) {
  const { stdout } = await sh('git', args, { cwd: deployPath, maxBuffer: 1 << 24 });
  return stdout.trim();
}

export function makeFileState(statePath) {
  return {
    readState() {
      try { return JSON.parse(readFileSync(statePath, 'utf8')).lastRestartedTarget || ''; }
      catch { return ''; }
    },
    writeState(targetSha) {
      mkdirSync(dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ lastRestartedTarget: targetSha }));
      renameSync(tmp, statePath);   // atomic replace
    },
  };
}

export function makeLaunchctlRestart(label) {
  return async () => {
    await sh('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { maxBuffer: 1 << 20 });
  };
}

export async function runDeploySyncOnce({
  deployPath, git = runGitCap, restart, readState, writeState,
  now = () => new Date(), log = () => {},
}) {
  const ts = now().toISOString();
  try {
    const head = await git(deployPath, ['rev-parse', 'HEAD']);
    await git(deployPath, ['fetch', 'origin', '--prune', '-q']);   // throws → caught
    const target = await git(deployPath, ['rev-parse', 'origin/main']);
    const lastRestartedTarget = readState();
    const { reset, restart: needRestart } = planDeploySync({ head, target, lastRestartedTarget });
    if (reset) await git(deployPath, ['reset', '--hard', 'origin/main']);
    let restarted = false;
    if (needRestart) {
      await restart();          // throws → caught below; writeState NOT reached
      writeState(target);       // persist only after a successful restart
      restarted = true;
    }
    const rec = { ts, action: reset ? 'advanced' : 'up_to_date', head, target, reset, restarted };
    log(rec);
    return rec;
  } catch (error) {
    const rec = { ts, action: 'error', error: error?.message || String(error) };
    log(rec);
    return rec;
  }
}

// CLI: node scripts/dev-society-deploy-sync.mjs  (run from inside the deploy worktree)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deployPath = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
  const label = process.env.DEV_SOCIETY_DAEMON_LABEL || 'com.danabaxia.agent-mesh.dev-society';
  const statePath = join(deployPath, '.dev-society', 'deploy-sync-state.json');
  const logPath = join(deployPath, '.dev-society', 'deploy-sync.log');
  const { readState, writeState } = makeFileState(statePath);
  const rec = await runDeploySyncOnce({
    deployPath, restart: makeLaunchctlRestart(label), readState, writeState,
    log: (r) => {
      try { mkdirSync(dirname(logPath), { recursive: true });
            writeFileSync(logPath, JSON.stringify(r) + '\n', { flag: 'a' }); } catch { /* best effort */ }
      console.log(r.ts, r.action, r.target || '', r.restarted ? 'restarted' : '');
    },
  });
  process.exitCode = rec.action === 'error' ? 1 : 0;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/deploy-sync.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Run the full suite (shared `src/dev-society/` namespace)**

Run: `node run-all-tests.mjs`
Expected: SUMMARY `red: 0`.

- [ ] **Step 7: Commit**

```bash
git add src/dev-society/deploy-sync.js scripts/dev-society-deploy-sync.mjs test/deploy-sync.test.js
git commit -m "feat(deploy): deploy-sync — reset-to-main + retryable restart-on-advance"
```

---

### Task 2: Install/cutover script + hermetic lint

**Files:**
- Create: `scripts/dev-society-deploy-install.sh`
- Test: `test/deploy-install-lint.test.js`

**Interfaces:**
- Consumes: the daemon (`scripts/dev-society-daemon.mjs`) and deploy-sync (`scripts/dev-society-deploy-sync.mjs`) paths under the deploy worktree.
- Produces: launchd plists for `com.danabaxia.agent-mesh.dev-society` + `com.danabaxia.agent-mesh.deploy-sync`; removes legacy `com.danabaxia.dev-society`. `--dry-run` prints actions + plists and calls no `launchctl`.

- [ ] **Step 1: Write the failing test**

```js
// test/deploy-install-lint.test.js — hermetic lint of the cutover script's --dry-run
// output + its live-mode root-mismatch guard. Never invokes real launchctl.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/dev-society-deploy-install.sh', import.meta.url));

// PATH-shadow launchctl with a stub that fails loudly if invoked, so any real
// launchctl call during --dry-run / the mismatch guard fails the test.
function stubPath() {
  const dir = mkdtempSync(join(tmpdir(), 'stub-'));
  const lc = join(dir, 'launchctl');
  writeFileSync(lc, '#!/bin/sh\necho "launchctl must not be called" >&2\nexit 99\n');
  chmodSync(lc, 0o755);
  return `${dir}:${process.env.PATH}`;
}

test('--dry-run emits correct daemon + deploy-sync plists and dedupe, no launchctl', () => {
  const r = spawnSync('bash', [script, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: stubPath(), DEV_SOCIETY_DEPLOY_ROOT: '/tmp/x', DEV_SOCIETY_REPO: 'o/r' },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  // daemon plist points at the deploy worktree, with env
  assert.match(out, /<string>\/tmp\/x\/scripts\/dev-society-daemon\.mjs<\/string>/);
  assert.match(out, /<key>WorkingDirectory<\/key>\s*<string>\/tmp\/x<\/string>/);
  assert.match(out, /<key>DEV_SOCIETY_REPO<\/key>/);
  assert.match(out, /<key>PATH<\/key>/);
  assert.match(out, /com\.danabaxia\.agent-mesh\.dev-society/);
  // deploy-sync plist
  assert.match(out, /com\.danabaxia\.agent-mesh\.deploy-sync/);
  assert.match(out, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
  assert.match(out, /<key>DEV_SOCIETY_DAEMON_LABEL<\/key>/);
  // legacy dedupe + bootout->bootstrap ordering (not bare kickstart-only)
  assert.match(out, /com\.danabaxia\.dev-society(?!\.)/);   // legacy label mentioned
  assert.match(out, /bootout/);
  assert.match(out, /bootstrap/);
});

test('live mode rejects a mismatching DEV_SOCIETY_DEPLOY_ROOT before any side effect', () => {
  const fakeLaDir = mkdtempSync(join(tmpdir(), 'la-'));
  const r = spawnSync('bash', [script], {   // no --dry-run
    encoding: 'utf8',
    env: { ...process.env, PATH: stubPath(), HOME: fakeLaDir, DEV_SOCIETY_DEPLOY_ROOT: '/nope/not/script/root' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /refusing|mismatch|!=/i);
  // nothing written under the fake LaunchAgents dir
  const la = join(fakeLaDir, 'Library', 'LaunchAgents');
  assert.ok(!existsSync(la) || readdirSync(la).length === 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/deploy-install-lint.test.js`
Expected: FAIL — script missing (`bash: …deploy-install.sh: No such file`).

- [ ] **Step 3: Write the install/cutover script**

```bash
#!/usr/bin/env bash
# Cutover/install for the deploy-worktree daemon. Run from INSIDE the deploy worktree.
# Build+stage: --dry-run prints everything and touches nothing. Live mode pins the
# deploy root to this script's location and refuses an external override.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEPLOY_ROOT_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

if [ "$DRY_RUN" = "1" ]; then
  DEPLOY_ROOT="${DEV_SOCIETY_DEPLOY_ROOT:-$DEPLOY_ROOT_DEFAULT}"
else
  DEPLOY_ROOT="$DEPLOY_ROOT_DEFAULT"
  if [ -n "${DEV_SOCIETY_DEPLOY_ROOT:-}" ] && [ "$DEV_SOCIETY_DEPLOY_ROOT" != "$DEPLOY_ROOT" ]; then
    echo "error: DEV_SOCIETY_DEPLOY_ROOT ($DEV_SOCIETY_DEPLOY_ROOT) != script root ($DEPLOY_ROOT) — refusing in live mode" >&2
    exit 1
  fi
fi

LABEL="com.danabaxia.agent-mesh.dev-society"
SYNC_LABEL="com.danabaxia.agent-mesh.deploy-sync"
LEGACY_LABEL="com.danabaxia.dev-society"
NODE_BIN="$(command -v node)"
UID_NUM="$(id -u)"
LA_DIR="$HOME/Library/LaunchAgents"
PATH_ENV="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$NODE_BIN")"
REPO="${DEV_SOCIETY_REPO:-}"

daemon_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DEPLOY_ROOT/scripts/dev-society-daemon.mjs</string></array>
  <key>WorkingDirectory</key><string>$DEPLOY_ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH_ENV</string>
    <key>HOME</key><string>$HOME</string>
    <key>USER</key><string>${USER:-$(id -un)}</string>
    <key>DEV_SOCIETY_REPO</key><string>$REPO</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DEPLOY_ROOT/.dev-society/daemon.out.log</string>
  <key>StandardErrorPath</key><string>$DEPLOY_ROOT/.dev-society/daemon.err.log</string>
</dict></plist>
PLIST
}

sync_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SYNC_LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DEPLOY_ROOT/scripts/dev-society-deploy-sync.mjs</string></array>
  <key>WorkingDirectory</key><string>$DEPLOY_ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH_ENV</string>
    <key>HOME</key><string>$HOME</string>
    <key>USER</key><string>${USER:-$(id -un)}</string>
    <key>DEV_SOCIETY_REPO</key><string>$REPO</string>
    <key>DEV_SOCIETY_DAEMON_LABEL</key><string>$LABEL</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$DEPLOY_ROOT/.dev-society/deploy-sync.out.log</string>
  <key>StandardErrorPath</key><string>$DEPLOY_ROOT/.dev-society/deploy-sync.err.log</string>
</dict></plist>
PLIST
}

reload() {   # $1 = label, $2 = plist path  (bootout then bootstrap — required to repoint)
  launchctl bootout "gui/$UID_NUM/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$2"
  launchctl enable "gui/$UID_NUM/$1"
  launchctl kickstart -k "gui/$UID_NUM/$1"
}

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] DEPLOY_ROOT=$DEPLOY_ROOT"
  echo "[dry-run] write $LA_DIR/$LABEL.plist:"; daemon_plist
  echo "[dry-run] write $LA_DIR/$SYNC_LABEL.plist:"; sync_plist
  echo "[dry-run] reload daemon: launchctl bootout gui/$UID_NUM/$LABEL || true; bootstrap; enable; kickstart -k"
  echo "[dry-run] reload sync:   launchctl bootout gui/$UID_NUM/$SYNC_LABEL || true; bootstrap; enable; kickstart -k"
  echo "[dry-run] dedupe legacy: launchctl bootout gui/$UID_NUM/$LEGACY_LABEL || true; rm -f $LA_DIR/$LEGACY_LABEL.plist"
  exit 0
fi

mkdir -p "$LA_DIR" "$DEPLOY_ROOT/.dev-society"
daemon_plist > "$LA_DIR/$LABEL.plist"
sync_plist  > "$LA_DIR/$SYNC_LABEL.plist"
reload "$LABEL"      "$LA_DIR/$LABEL.plist"
reload "$SYNC_LABEL" "$LA_DIR/$SYNC_LABEL.plist"
launchctl bootout "gui/$UID_NUM/$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LA_DIR/$LEGACY_LABEL.plist"
echo "installed daemon + deploy-sync from $DEPLOY_ROOT; removed legacy $LEGACY_LABEL"
```

- [ ] **Step 4: Make it executable**

Run: `chmod +x scripts/dev-society-deploy-install.sh`

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/deploy-install-lint.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-society-deploy-install.sh test/deploy-install-lint.test.js
git commit -m "feat(deploy): cutover/install script (build+stage, --dry-run, legacy dedupe)"
```

---

### Task 3: Docs + full-suite green

**Files:**
- Modify: `CLAUDE.md` (Config section — append the deploy env vars)
- Modify: `INSTALL.md` (add a short "deploy worktree cutover" pointer to the spec runbook)

- [ ] **Step 1: Run the full suite**

Run: `node run-all-tests.mjs`
Expected: SUMMARY `red: 0`.

- [ ] **Step 2: Append deploy env vars to the `CLAUDE.md` Config paragraph**

Add to the Config list:

```markdown
`DEV_SOCIETY_DEPLOY_ROOT` (`~/.agent-mesh/deploy`; honored only under the install script's `--dry-run`, live mode pins to the script's own worktree) · `DEV_SOCIETY_DAEMON_LABEL` (`com.danabaxia.agent-mesh.dev-society`) — deploy-worktree decoupling (spec 2026-06-19): the 24/7 daemon runs from a dedicated git worktree pinned to `main`; `scripts/dev-society-deploy-sync.mjs` (launchd `StartInterval` 300) hard-resets it to `origin/main` and restarts the daemon on advance (retryable via `.dev-society/deploy-sync-state.json`). Cutover: `scripts/dev-society-deploy-install.sh` (see `docs/superpowers/specs/2026-06-19-deploy-worktree-decouple-design.md` §7).
```

- [ ] **Step 3: Add a cutover pointer to `INSTALL.md`**

Append a short section:

```markdown
## Deploy-worktree cutover (24/7 daemon)

To run the dev-society daemon from a dedicated worktree pinned to `main` (isolated
from dev checkouts other agents branch-switch):

```bash
git fetch origin
git worktree add ~/.agent-mesh/deploy origin/main
bash ~/.agent-mesh/deploy/scripts/dev-society-deploy-install.sh --dry-run   # preview
bash ~/.agent-mesh/deploy/scripts/dev-society-deploy-install.sh             # wire launchd + dedupe + restart
```

Full design + rollback: `docs/superpowers/specs/2026-06-19-deploy-worktree-decouple-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md INSTALL.md
git commit -m "docs(deploy): document deploy-worktree env + cutover runbook"
```

---

## Self-Review

**Spec coverage:**
- §5.1 deploy worktree (operator git command) → covered by the runbook in Task 3 / INSTALL.md (no code needed). ✅
- §5.2 `planDeploySync` + `runDeploySyncOnce` + state contract + restart-on-advance → Task 1. ✅
- §5.3 install script (env block, `bootout`→`bootstrap`, live root-pin, legacy dedupe, report plist OOS) → Task 2. ✅
- §6 control flow → Task 1 runner. ✅
- §7 runbook → Task 3 INSTALL.md. ✅
- §9 tests (planner+runner incl. retry/error; install dry-run lint + live root-mismatch + no-launchctl) → Tasks 1 & 2. ✅
- §10 config → Task 3 CLAUDE.md. ✅
- §11 invariants → enforced by Task 1 (failure-is-data try/catch; reset-hard converges; retryable restart) + Task 2 (live root-pin; no launchctl in dry-run/tests). ✅

**Placeholder scan:** none — every code step carries complete code; every run step has command + expected result.

**Type consistency:** `planDeploySync({head,target,lastRestartedTarget})→{reset,restart}`, `runDeploySyncOnce({deployPath,git,restart,readState,writeState,now,log})→record`, `makeFileState(statePath)→{readState,writeState}`, `makeLaunchctlRestart(label)`, `runGitCap(deployPath,args)` are used identically across Task 1's code and tests. Labels (`com.danabaxia.agent-mesh.dev-society` / `…deploy-sync` / legacy `com.danabaxia.dev-society`) and the state file path (`.dev-society/deploy-sync-state.json`) match between the runner, the install script, and both tests.
