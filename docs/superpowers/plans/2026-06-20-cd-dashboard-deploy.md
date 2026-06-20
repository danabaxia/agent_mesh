# CD for the Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the dashboard under the existing `deploy-sync` CD so it auto-updates and restarts when code is pushed to `main`, as a managed launchd service from the deploy checkout.

**Architecture:** Extend the injected restart in `scripts/dev-society-deploy-sync.mjs` to kick a second (dashboard) launchd label — best-effort, after the required daemon kick — via a new `makeMultiRestart`. Add a dashboard plist to `scripts/dev-society-deploy-install.sh` and teach the deploy-sync plist the new label. The pure `planDeploySync` planner is untouched. Document the new operation in README + CLAUDE.md.

**Tech Stack:** Node ≥ 20 ESM, `node --test` (zero deps), bash (macOS launchd), Markdown.

---

## Background the implementer needs

- **Repo conventions:** zero runtime deps; tests are `node --test` files under `test/`; ES modules; run one file `node --test test/<f>.js`, all `npm test`. Node ≥ 20.
- **The existing CD (don't re-derive it):**
  - `src/dev-society/deploy-sync.js` — **pure** `planDeploySync({head,target,lastRestartedTarget,buildBusy})` → `{reset,restart,deferredRestart}`. **Do not modify.**
  - `scripts/dev-society-deploy-sync.mjs` — the impure runner. Exports `runGitCap`, `makeFileState`, `makeLaunchctlRestart(label)`, `runDeploySyncOnce({deployPath,git,restart,readState,writeState,buildBusy,now,log})`. At the bottom is a CLI block (`if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`) that wires `restart: makeLaunchctlRestart(label)` where `label = process.env.DEV_SOCIETY_DAEMON_LABEL || 'com.danabaxia.agent-mesh.dev-society'`.
    - `runDeploySyncOnce` calls `await restart()` only when `planDeploySync` says restart, and calls `writeState(target)` **only after** `restart()` resolves. So: a restart that **throws** ⇒ state not advanced ⇒ retried next tick; a restart that **resolves** ⇒ state advanced.
    - Module-level `const sh = promisify(execFile)`.
  - `scripts/dev-society-deploy-install.sh` — bash cutover/installer. Has `LABEL` (daemon), `SYNC_LABEL` (deploy-sync), `LEGACY_LABEL`; functions `daemon_plist()` / `sync_plist()` (heredocs using `$NODE_BIN`, `$DEPLOY_ROOT`, `$PATH_ENV`, `$HOME`, `$USER`, `$REPO`); `reload(label,plist)` = bootout+bootstrap+enable+kickstart; a `--dry-run` branch that **echoes** the plist bodies + reload lines; and a live branch that writes plists + reloads + dedupes legacy.
- **Test patterns to mirror:**
  - `test/deploy-sync.test.js` — imports `{ runDeploySyncOnce, makeFileState }` from the `.mjs`; injects a fake `restart`/`git`. Cross-platform.
  - `test/deploy-install-lint.test.js` — `spawnSync('bash', [script, '--dry-run'], { env: { …, PATH: stubPath, DEV_SOCIETY_DEPLOY_ROOT:'/tmp/x', DEV_SOCIETY_REPO:'o/r' } })`, asserts on `r.stdout`. PATH-shadows `launchctl` with a stub that exits 99 if called. **POSIX-only** (`skip` on win32 via `POSIX_ONLY`).
- **The deploy checkout** is `~/.agent-mesh/deploy`; it contains its own `dev-mesh/`. The dashboard CLI entry is `bin/agent-mesh.js dashboard <mesh-root> --no-open`; default port is 7077.

---

## File Structure

- **Modify** `scripts/dev-society-deploy-sync.mjs` — add `makeMultiRestart` (exported, injectable `kick`) + `launchctlKick`; refactor `makeLaunchctlRestart` to use `launchctlKick`; switch the CLI block to `makeMultiRestart` with the daemon (required) + optional dashboard label.
- **Modify** `test/deploy-sync.test.js` — unit tests for `makeMultiRestart` + one integration test through `runDeploySyncOnce`.
- **Modify** `scripts/dev-society-deploy-install.sh` — `DASH_LABEL`, `dashboard_plist()`, `DEV_SOCIETY_DASHBOARD_LABEL` in `sync_plist`, dry-run + live + summary.
- **Modify** `test/deploy-install-lint.test.js` — assert the dashboard plist + sync env + reload in `--dry-run` output.
- **Modify** `README.md` — "Always-on / auto-updating operation (optional)" note.
- **Modify** `CLAUDE.md` — Config section: `DEV_SOCIETY_DASHBOARD_LABEL` + dashboard-restart sentence.
- **Unchanged** `src/dev-society/deploy-sync.js`.

---

## Task 1: `makeMultiRestart` — multi-label restart helper

**Files:**
- Modify: `scripts/dev-society-deploy-sync.mjs`
- Test: `test/deploy-sync.test.js`

- [ ] **Step 1: Write the failing tests**

In `test/deploy-sync.test.js`, change the import on line 7 from:

```js
import { runDeploySyncOnce, makeFileState } from '../scripts/dev-society-deploy-sync.mjs';
```

to:

```js
import { runDeploySyncOnce, makeFileState, makeMultiRestart } from '../scripts/dev-society-deploy-sync.mjs';
```

Then append these tests to the end of the file:

```js
test('makeMultiRestart: kicks required then optional, in order', async () => {
  const calls = [];
  const r = makeMultiRestart({ required: ['daemon'], optional: ['dash'], kick: async (l) => { calls.push(l); } });
  await r();
  assert.deepEqual(calls, ['daemon', 'dash']);
});

test('makeMultiRestart: optional failure is swallowed + logged, promise resolves', async () => {
  const logs = [];
  const r = makeMultiRestart({
    required: ['daemon'], optional: ['dash'],
    kick: async (l) => { if (l === 'dash') throw new Error('not loaded'); },
    log: (x) => logs.push(x),
  });
  await r(); // must not throw
  assert.equal(logs.length, 1);
  assert.equal(logs[0].action, 'dashboard_restart_failed');
  assert.equal(logs[0].label, 'dash');
});

test('makeMultiRestart: required failure rejects (so state does not advance)', async () => {
  const r = makeMultiRestart({ required: ['daemon'], optional: ['dash'], kick: async (l) => { if (l === 'daemon') throw new Error('boom'); } });
  await assert.rejects(r, /boom/);
});

test('runDeploySyncOnce: advances state even when the optional (dashboard) kick fails', async () => {
  const git = async (_d, args) => {
    const k = args.join(' ');
    if (k === 'rev-parse HEAD') return 'a';
    if (k === 'rev-parse origin/main') return 'b';
    return '';
  };
  let persisted = '';
  const restart = makeMultiRestart({
    required: ['daemon'], optional: ['dash'],
    kick: async (l) => { if (l === 'dash') throw new Error('not loaded'); },
  });
  const r = await runDeploySyncOnce({
    deployPath: '/d', git, restart,
    readState: () => '', writeState: (t) => { persisted = t; },
    buildBusy: () => false,
  });
  assert.equal(r.restarted, true);
  assert.equal(persisted, 'b');   // daemon kick succeeded → state advanced despite dashboard failure
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/deploy-sync.test.js`
Expected: FAIL — `makeMultiRestart` is not exported (`SyntaxError`/`undefined`).

- [ ] **Step 3: Implement `makeMultiRestart` + `launchctlKick`**

In `scripts/dev-society-deploy-sync.mjs`, replace the existing `makeLaunchctlRestart` function:

```js
export function makeLaunchctlRestart(label) {
  return async () => {
    await sh('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { maxBuffer: 1 << 20 });
  };
}
```

with:

```js
function launchctlKick(label) {
  return sh('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { maxBuffer: 1 << 20 });
}

export function makeLaunchctlRestart(label) {
  return () => launchctlKick(label);
}

// Restart several launchd labels per advance: `required` labels are kicked first
// and any failure propagates (so deploy-sync does NOT persist state → retried next
// tick); `optional` labels (e.g. the dashboard) are best-effort — a failure is
// logged and swallowed so it can never wedge the daemon's retry state.
export function makeMultiRestart({ required = [], optional = [], kick = launchctlKick, log = () => {} }) {
  return async () => {
    for (const label of required) await kick(label);
    for (const label of optional) {
      try {
        await kick(label);
      } catch (e) {
        log({ ts: new Date().toISOString(), action: 'dashboard_restart_failed', label, error: e?.message || String(e) });
      }
    }
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/deploy-sync.test.js`
Expected: PASS — all existing tests plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-society-deploy-sync.mjs test/deploy-sync.test.js
git commit -m "feat(cd): makeMultiRestart — best-effort multi-label restart for deploy-sync"
```

---

## Task 2: Wire the CLI to restart daemon + dashboard

**Files:**
- Modify: `scripts/dev-society-deploy-sync.mjs` (the bottom CLI block only)

This wires the new helper into the launchd entrypoint. The CLI block isn't unit-tested (it reads real env + does real launchctl); Task 1's unit tests cover the logic, and `npm test` confirms nothing regressed.

- [ ] **Step 1: Switch the CLI restart wiring**

In `scripts/dev-society-deploy-sync.mjs`, in the CLI block at the bottom, find:

```js
  const label = process.env.DEV_SOCIETY_DAEMON_LABEL || 'com.danabaxia.agent-mesh.dev-society';
  const statePath = join(deployPath, '.dev-society', 'deploy-sync-state.json');
  const logPath = join(deployPath, '.dev-society', 'deploy-sync.log');
  const { readState, writeState } = makeFileState(statePath);
  const rec = await runDeploySyncOnce({
    deployPath, restart: makeLaunchctlRestart(label), readState, writeState,
    log: (r) => {
      try { mkdirSync(dirname(logPath), { recursive: true });
            writeFileSync(logPath, JSON.stringify(r) + '\n', { flag: 'a' }); } catch { /* best effort */ }
      console.log(r.ts, r.action, r.target || '', r.restarted ? 'restarted' : (r.deferredRestart ? 'restart-deferred(build-busy)' : ''));
    },
  });
```

Replace it with:

```js
  const daemonLabel = process.env.DEV_SOCIETY_DAEMON_LABEL || 'com.danabaxia.agent-mesh.dev-society';
  const dashLabel = process.env.DEV_SOCIETY_DASHBOARD_LABEL || '';   // optional; unset → daemon-only (back-compat)
  const statePath = join(deployPath, '.dev-society', 'deploy-sync-state.json');
  const logPath = join(deployPath, '.dev-society', 'deploy-sync.log');
  const { readState, writeState } = makeFileState(statePath);
  const appendLog = (r) => {
    try { mkdirSync(dirname(logPath), { recursive: true });
          writeFileSync(logPath, JSON.stringify(r) + '\n', { flag: 'a' }); } catch { /* best effort */ }
  };
  const restart = makeMultiRestart({
    required: [daemonLabel],
    optional: dashLabel ? [dashLabel] : [],
    log: (r) => { appendLog(r); console.log(r.ts, r.action, r.label || ''); },
  });
  const rec = await runDeploySyncOnce({
    deployPath, restart, readState, writeState,
    log: (r) => {
      appendLog(r);
      console.log(r.ts, r.action, r.target || '', r.restarted ? 'restarted' : (r.deferredRestart ? 'restart-deferred(build-busy)' : ''));
    },
  });
```

- [ ] **Step 2: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — including `test/deploy-sync.test.js`. (The CLI block is import-side-effect-free; the module still loads.)

- [ ] **Step 3: Commit**

```bash
git add scripts/dev-society-deploy-sync.mjs
git commit -m "feat(cd): deploy-sync restarts daemon + optional dashboard label"
```

---

## Task 3: Installer — dashboard plist + sync env

**Files:**
- Modify: `scripts/dev-society-deploy-install.sh`
- Test: `test/deploy-install-lint.test.js`

- [ ] **Step 1: Write the failing test**

In `test/deploy-install-lint.test.js`, append a new test (mirrors the existing dry-run test's spawn pattern):

```js
test('--dry-run emits the dashboard plist + sync env + reload', { skip: POSIX_ONLY }, () => {
  const stubDir = mkdtempSync(join(tmpdir(), 'stub-'));
  for (const name of ['launchctl', 'claude', 'gh', 'node']) {
    const p = join(stubDir, name);
    writeFileSync(p, name === 'launchctl'
      ? '#!/bin/sh\necho "launchctl must not be called" >&2\nexit 99\n'
      : '#!/bin/sh\ntrue\n');
    chmodSync(p, 0o755);
  }
  const r = spawnSync('bash', [script, '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, DEV_SOCIETY_DEPLOY_ROOT: '/tmp/x', DEV_SOCIETY_REPO: 'o/r' },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  // dashboard plist is written, pinned to the deploy worktree's dev-mesh, read-only
  assert.match(out, /com\.danabaxia\.agent-mesh\.dashboard\.plist/);
  assert.match(out, /<string>dashboard<\/string>/);
  assert.match(out, /\/tmp\/x\/dev-mesh/);
  assert.match(out, /<string>--no-open<\/string>/);
  assert.match(out, /<string>--port<\/string><string>7077<\/string>/);
  assert.match(out, /<key>KeepAlive<\/key><true\/>/);
  // deploy-sync plist learns the dashboard label
  assert.match(out, /<key>DEV_SOCIETY_DASHBOARD_LABEL<\/key><string>com\.danabaxia\.agent-mesh\.dashboard<\/string>/);
  // and the dashboard is reloaded
  assert.match(out, /reload dashboard/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/deploy-install-lint.test.js`
Expected: FAIL — the install script emits no dashboard plist yet.

- [ ] **Step 3a: Add `DASH_LABEL`**

In `scripts/dev-society-deploy-install.sh`, find:

```sh
LABEL="com.danabaxia.agent-mesh.dev-society"
SYNC_LABEL="com.danabaxia.agent-mesh.deploy-sync"
LEGACY_LABEL="com.danabaxia.dev-society"
```

Add a line after `SYNC_LABEL`:

```sh
LABEL="com.danabaxia.agent-mesh.dev-society"
SYNC_LABEL="com.danabaxia.agent-mesh.deploy-sync"
DASH_LABEL="com.danabaxia.agent-mesh.dashboard"
LEGACY_LABEL="com.danabaxia.dev-society"
```

- [ ] **Step 3b: Add `DEV_SOCIETY_DASHBOARD_LABEL` to `sync_plist`**

In the `sync_plist()` heredoc, find:

```sh
    <key>DEV_SOCIETY_DAEMON_LABEL</key><string>$LABEL</string>
  </dict>
```

Replace with:

```sh
    <key>DEV_SOCIETY_DAEMON_LABEL</key><string>$LABEL</string>
    <key>DEV_SOCIETY_DASHBOARD_LABEL</key><string>$DASH_LABEL</string>
  </dict>
```

- [ ] **Step 3c: Add the `dashboard_plist()` function**

Immediately after the entire `sync_plist() { … }` function (after its closing `}`), add:

```sh
dashboard_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$DASH_LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$DEPLOY_ROOT/bin/agent-mesh.js</string><string>dashboard</string><string>$DEPLOY_ROOT/dev-mesh</string><string>--no-open</string><string>--port</string><string>7077</string></array>
  <key>WorkingDirectory</key><string>$DEPLOY_ROOT</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH_ENV</string>
    <key>HOME</key><string>$HOME</string>
    <key>USER</key><string>${USER:-$(id -un)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DEPLOY_ROOT/.dev-society/dashboard.out.log</string>
  <key>StandardErrorPath</key><string>$DEPLOY_ROOT/.dev-society/dashboard.err.log</string>
</dict></plist>
PLIST
}
```

- [ ] **Step 3d: Emit the dashboard plist in the dry-run branch**

Find the dry-run echoes:

```sh
  echo "[dry-run] write $LA_DIR/$SYNC_LABEL.plist:"; sync_plist
  echo "[dry-run] reload daemon: launchctl bootout gui/$UID_NUM/$LABEL || true; bootstrap; enable; kickstart -k"
  echo "[dry-run] reload sync:   launchctl bootout gui/$UID_NUM/$SYNC_LABEL || true; bootstrap; enable; kickstart -k"
```

Replace with (adds the dashboard write + reload):

```sh
  echo "[dry-run] write $LA_DIR/$SYNC_LABEL.plist:"; sync_plist
  echo "[dry-run] write $LA_DIR/$DASH_LABEL.plist:"; dashboard_plist
  echo "[dry-run] reload daemon: launchctl bootout gui/$UID_NUM/$LABEL || true; bootstrap; enable; kickstart -k"
  echo "[dry-run] reload sync:   launchctl bootout gui/$UID_NUM/$SYNC_LABEL || true; bootstrap; enable; kickstart -k"
  echo "[dry-run] reload dashboard: launchctl bootout gui/$UID_NUM/$DASH_LABEL || true; bootstrap; enable; kickstart -k"
```

- [ ] **Step 3e: Write + reload the dashboard plist in the live branch**

Find the live writes:

```sh
daemon_plist > "$LA_DIR/$LABEL.plist"
sync_plist  > "$LA_DIR/$SYNC_LABEL.plist"
reload "$LABEL"      "$LA_DIR/$LABEL.plist"
reload "$SYNC_LABEL" "$LA_DIR/$SYNC_LABEL.plist"
launchctl bootout "gui/$UID_NUM/$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LA_DIR/$LEGACY_LABEL.plist"
echo "installed daemon + deploy-sync from $DEPLOY_ROOT; removed legacy $LEGACY_LABEL"
```

Replace with:

```sh
daemon_plist    > "$LA_DIR/$LABEL.plist"
sync_plist      > "$LA_DIR/$SYNC_LABEL.plist"
dashboard_plist > "$LA_DIR/$DASH_LABEL.plist"
reload "$LABEL"      "$LA_DIR/$LABEL.plist"
reload "$SYNC_LABEL" "$LA_DIR/$SYNC_LABEL.plist"
reload "$DASH_LABEL" "$LA_DIR/$DASH_LABEL.plist"
launchctl bootout "gui/$UID_NUM/$LEGACY_LABEL" 2>/dev/null || true
rm -f "$LA_DIR/$LEGACY_LABEL.plist"
echo "installed daemon + deploy-sync + dashboard from $DEPLOY_ROOT; removed legacy $LEGACY_LABEL"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/deploy-install-lint.test.js`
Expected: PASS — the new dashboard test plus the existing ones.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev-society-deploy-install.sh test/deploy-install-lint.test.js
git commit -m "feat(cd): installer adds dashboard launchd service + sync label"
```

---

## Task 4: Documentation — README + CLAUDE.md

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

No tests (prose). Reflects the new operation per the user's request.

- [ ] **Step 1: README — add the always-on operation note**

In `README.md`, find the manual dashboard usage block and the line after it:

```sh
node ./bin/agent-mesh.js dashboard /path/to/mesh --no-open
node ./bin/agent-mesh.js dashboard /path/to/mesh --allow-shell --enable-chat
```

After the paragraph that ends `…the in-dashboard ask-only A2A chat composer.`, insert a new subsection:

```markdown
### Always-on / auto-updating operation (optional)

For a host that should keep the mesh running and **update itself on every push to
`main`**, install the dev-society services with
`scripts/dev-society-deploy-install.sh`. It provisions three launchd jobs from a
dedicated deploy checkout (`~/.agent-mesh/deploy`) pinned to `main`:

- the **dev-society daemon** (builds issues through the mesh),
- **deploy-sync** — polls `origin/main` (~5 min), hard-resets the deploy checkout, and
- the **dashboard** — served read-only on `:7077` from the deploy checkout's `dev-mesh`.

When `main` advances, deploy-sync restarts the daemon **and** the dashboard, so the
running services always reflect merged code. The manual `dashboard` command above
remains the ad-hoc/dev path. Design:
[`docs/superpowers/specs/2026-06-20-cd-dashboard-deploy-design.md`](docs/superpowers/specs/2026-06-20-cd-dashboard-deploy-design.md).
```

- [ ] **Step 2: CLAUDE.md — extend the deploy-worktree config note**

In `CLAUDE.md`, in the **Config (env, all optional)** section, find:

```
`DEV_SOCIETY_DAEMON_LABEL` (`com.danabaxia.agent-mesh.dev-society`) — deploy-worktree decoupling (spec 2026-06-19): the 24/7 daemon runs from a dedicated git worktree pinned to `main`; `scripts/dev-society-deploy-sync.mjs` (launchd `StartInterval` 300) hard-resets it to `origin/main` and restarts the daemon on advance (retryable via `.dev-society/deploy-sync-state.json`). Cutover: `scripts/dev-society-deploy-install.sh` (see `docs/superpowers/specs/2026-06-19-deploy-worktree-decouple-design.md` §7).
```

Replace it with:

```
`DEV_SOCIETY_DAEMON_LABEL` (`com.danabaxia.agent-mesh.dev-society`) · `DEV_SOCIETY_DASHBOARD_LABEL` (`com.danabaxia.agent-mesh.dashboard`) — deploy-worktree decoupling (specs 2026-06-19 deploy-worktree-decouple, 2026-06-20 cd-dashboard-deploy): the 24/7 daemon **and** the read-only dashboard (served on `:7077` from the deploy checkout's `dev-mesh`) run from a dedicated git worktree pinned to `main`; `scripts/dev-society-deploy-sync.mjs` (launchd `StartInterval` 300) hard-resets it to `origin/main` and on advance restarts the daemon (required, retryable via `.dev-society/deploy-sync-state.json`) and the dashboard (**best-effort** — a failed dashboard kick is logged but never blocks the daemon's retry state). Cutover: `scripts/dev-society-deploy-install.sh` installs all three launchd jobs.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(cd): document the auto-updating dashboard service (README + CLAUDE.md)"
```

---

## Verification (manual, on the host — after merge + install)

The unit tests are hermetic (no launchd). The runtime proof requires the host:

1. `bash scripts/dev-society-deploy-install.sh --dry-run` → output includes the dashboard plist + `reload dashboard` + `DEV_SOCIETY_DASHBOARD_LABEL` in sync.
2. Run the live installer; `launchctl list | grep -E 'dashboard|deploy-sync|dev-society'` shows all three loaded.
3. Open `http://127.0.0.1:7077/?t=<token>` → dashboard serves the deploy checkout's `dev-mesh`.
4. Push a trivial commit to `main`; within ~5 min the deploy-sync log shows `advanced … restarted`, and a changed served asset reflects the new commit (curl with the session cookie, or reload).

---

## Self-Review notes (author)

- **Spec coverage:** `makeMultiRestart` (T1) · CLI wiring + `DEV_SOCIETY_DASHBOARD_LABEL` (T2) · dashboard plist + sync env + dry-run/live (T3) · README + CLAUDE.md (T4) · pure planner unchanged (no task touches it) · tests for restart ordering/best-effort/required-fail (T1) and installer dry-run (T3). All spec §1–§4 + Testing mapped.
- **Type consistency:** `makeMultiRestart({required,optional,kick,log})` signature identical in T1 def, T1 tests, and T2 wiring. Label defaults (`com.danabaxia.agent-mesh.dashboard`, `…dev-society`) consistent across mjs, install script, README, CLAUDE.md, and tests. `dashboard_plist` ProgramArguments (`dashboard`, `$DEPLOY_ROOT/dev-mesh`, `--no-open`, `--port`, `7077`) match the T3 lint assertions.
- **No placeholders:** every code step shows complete code; commands have expected output.
