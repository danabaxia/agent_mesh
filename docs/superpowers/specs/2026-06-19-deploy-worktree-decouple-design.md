# Deploy-Worktree Decoupling — Design

## 1. Goal

Make the 24/7 dev-society daemon run **only pinned, known-good `main` code**, fully
isolated from the development checkout that humans and other agents (Codex, Claude)
branch-switch and edit. Today the daemon serves whatever the *shared dev checkout*
is on, so when another agent switches that checkout to its branch the daemon runs
stale/wrong code — exactly the failure we hit (the daemon's checkout lacked
freshly-merged code, and a second agent's branch was checked out).

After this change, "do I need to restart to see new features?" stops being a
question: a merge to `main` auto-deploys to the daemon within one sync interval.

## 2. Non-goals

- **No Docker / containerization.** The daemon spawns `claude`/`gh`/`git` and writes
  host agent folders under the path-guard model; containerizing would require
  creds-in-container + bind-mounting host paths (re-coupling) against the repo's
  zero-dependency ethos. Deferred to a future multi-host move (§8).
- **No Capistrano-style `releases/`+`current` symlink, no tagged-release pinning,
  no blue-green.** The daemon tracks `main` HEAD continuously (the per-PR CI gate is
  the quality bar). These are v2 if we ever need rollback granularity.
- **No live cutover during implementation.** We build + stage scripts + a runbook;
  the operator runs the cutover (it mutates a running 24/7 service). The
  implementation never calls `launchctl` or touches the live daemon.
- **No change to the existing `repo-sync`** (it harmlessly fast-forwards the dev
  checkout). Retiring it is out of scope.

## 3. Background — current machinery (verified)

- The daemon resolves `repoRoot` from its **own script location**
  (`scripts/dev-society-daemon.mjs` → `..`), and launchd sets
  `WorkingDirectory=/Users/jingbohan/Documents/dev/agent_mesh` (the shared dev
  checkout). So the daemon serves that checkout's current branch.
- `repo-sync` (`src/dev-society/repo-sync.js` + `scripts/dev-society-repo-sync.mjs`,
  launchd `StartInterval=300`) runs `runRepoSyncOnce({ repoPath })`: it `fetch`es,
  computes a pure `planRepoSync()` decision, and **`merge --ff-only`** when the
  branch is clean and behind. It already honors `DEV_SOCIETY_SYNC_REPO_PATH` to
  target an arbitrary checkout. It does **not** restart the daemon.
- Two daemon plists exist → two running instances: `com.danabaxia.dev-society`
  (legacy) and `com.danabaxia.agent-mesh.dev-society` (canonical, written by
  `scripts/dev-society-install.sh`).

## 4. Architecture

```
/Users/jingbohan/Documents/dev/agent_mesh        DEV checkout (shared; agents branch-switch + edit)
  └─ .claude/worktrees/<feature>                 per-agent dev worktrees
~/.agent-mesh/deploy   (NEW; $DEV_SOCIETY_DEPLOY_ROOT, configurable)
                                                 DEPLOY worktree — pinned to main, never branch-switched
  └─ the daemon + deploy-sync run from HERE
```

A git worktree on `main` whose `scripts/dev-society-daemon.mjs` the daemon runs
from. Because `repoRoot` is script-relative, pointing launchd at the deploy
worktree makes the daemon serve `main` exclusively. The deploy worktree is
deploy-only: never edited, never checked out to another branch, so no agent action
can affect what runs.

## 5. Components

### 5.1 Deploy worktree (operator-created, plain git)
`git worktree add "$DEV_SOCIETY_DEPLOY_ROOT" origin/main` (default
`~/.agent-mesh/deploy`). Created by the runbook (§7) with a plain git command — no
new code needed to create it — so the install script can then live *inside* it.

### 5.2 `deploy-sync` (new) — sync + restart-on-advance
- **Pure helper** `planDaemonRestart(syncRecord) → boolean` in
  `src/dev-society/deploy-sync.js`: returns `true` iff
  `syncRecord.action === 'fast_forwarded'` (the deploy worktree advanced). Trivially
  unit-testable.
- **Thin runner** `scripts/dev-society-deploy-sync.mjs` exporting
  `runDeploySyncOnce({ deployPath, git, restart, now, log }) → record`: calls the
  existing `runRepoSyncOnce({ repoPath: deployPath, git, now })`, and if
  `planDaemonRestart(rec)` then `await restart()`. Default `restart` =
  `launchctl kickstart -k gui/<uid>/com.danabaxia.agent-mesh.dev-society`. The
  deploy worktree is clean + on `main`, so `runRepoSyncOnce` yields `fast_forwarded`
  when behind, `up_to_date` otherwise (no daemon restart when nothing changed).
- Runs from its own launchd plist `com.danabaxia.agent-mesh.deploy-sync`
  (`StartInterval=300`, `WorkingDirectory=$DEPLOY_ROOT`, runs
  `node $DEPLOY_ROOT/scripts/dev-society-deploy-sync.mjs`). It updates the deploy
  worktree it runs from (self-updating), then restarts the daemon.

**Reuse, not rebuild:** `runRepoSyncOnce`/`planRepoSync`/`runGit` are reused
unchanged; deploy-sync adds only the restart decision + the launchctl call.

### 5.3 Cutover/install script (new) — `scripts/dev-society-deploy-install.sh`
Run **from inside the deploy worktree**. It (idempotently):
1. Computes `DEPLOY_ROOT` from its own location (`$SCRIPT_DIR/..`).
2. Writes the canonical daemon plist `com.danabaxia.agent-mesh.dev-society` with
   `ProgramArguments = <node> $DEPLOY_ROOT/scripts/dev-society-daemon.mjs`,
   `WorkingDirectory=$DEPLOY_ROOT`, `KeepAlive=true`, `ThrottleInterval=30`,
   logs under `$DEPLOY_ROOT/.dev-society/`.
3. Writes the `com.danabaxia.agent-mesh.deploy-sync` plist (§5.2).
4. **Removes the legacy duplicate**: `launchctl bootout` + delete
   `com.danabaxia.dev-society.plist`.
5. Boots/kickstarts a single canonical daemon from the deploy worktree.
- `--dry-run`: prints every action + the full plist contents and **touches nothing**
  (no `launchctl`, no fs writes) — this is the hermetic test surface.

## 6. Data / control flow

```
operator runbook: git worktree add ~/.agent-mesh/deploy origin/main
                  → bash ~/.agent-mesh/deploy/scripts/dev-society-deploy-install.sh
                      → write daemon plist (→ deploy worktree)
                      → write deploy-sync plist
                      → remove legacy plist
                      → kickstart single daemon
every 300s:  deploy-sync → runRepoSyncOnce(deployPath)
                  → fast_forwarded?  → launchctl kickstart -k <daemon>   (new code runs)
                  → up_to_date?      → no-op
                  → skip_dirty/skip_diverged/error → log, no restart (failure-is-data)
```

## 7. Cutover runbook (operator runs, after this spec's code is merged to main)

The deploy worktree runs `main`, so these changes must land on `main` first. Then:
```bash
cd /Users/jingbohan/Documents/dev/agent_mesh
git fetch origin
git worktree add ~/.agent-mesh/deploy origin/main          # 1. create deploy worktree on main
bash ~/.agent-mesh/deploy/scripts/dev-society-deploy-install.sh --dry-run   # 2. preview
bash ~/.agent-mesh/deploy/scripts/dev-society-deploy-install.sh             # 3. wire launchd, dedupe, restart
```
Rollback: `git -C ~/.agent-mesh/deploy reset --hard <good-sha>` + kickstart, or
re-point the plist back to the dev checkout and remove the new plists.

## 8. Future (v2, out of scope)

Docker image for multi-host/server deployment (CI already shows the install path);
Capistrano `releases/`+`current` for instant rollback; tagged-release pinning via
release-please; retiring the dev-checkout `repo-sync`.

## 9. Testing

**Hermetic unit tests (L0; no launchctl/git/network):**

| Test | Covers |
|------|--------|
| `test/deploy-sync.test.js` | `planDaemonRestart`: `fast_forwarded`→true; `up_to_date`/`skip_*`/`error`→false. `runDeploySyncOnce` with injected `git`+`restart`: advance→`restart` called once; up-to-date→`restart` not called; fetch error→structured record, no restart. |
| `test/deploy-install-lint.test.js` | Run `dev-society-deploy-install.sh --dry-run` with `DEV_SOCIETY_DEPLOY_ROOT=/tmp/x` and assert the emitted output: daemon plist `ProgramArguments` includes `/tmp/x/scripts/dev-society-daemon.mjs`; single canonical label `com.danabaxia.agent-mesh.dev-society`; deploy-sync plist with `StartInterval` 300; a bootout/remove step for `com.danabaxia.dev-society`; and that `--dry-run` invoked no `launchctl` (asserted by it running green with launchctl absent/stubbed). |

`runRepoSyncOnce`/`planRepoSync` keep their existing tests; deploy-sync reuses them.
**Live cutover is not auto-tested** (operator-run); the install script's `--dry-run`
is the CI-safe surface.

## 10. Config (env, all optional)

- `DEV_SOCIETY_DEPLOY_ROOT` (`~/.agent-mesh/deploy`) — deploy worktree path.
- `DEV_SOCIETY_DAEMON_LABEL` (`com.danabaxia.agent-mesh.dev-society`) — daemon
  launchd label the deploy-sync restarts.
- Reuses `DEV_SOCIETY_SYNC_IGNORE_PREFIXES` (`.dev-society/`) via `runRepoSyncOnce`.

## 11. Invariants preserved

- **The daemon never runs an agent's in-flight branch** — it runs only the deploy
  worktree, which is pinned to `main` and never branch-switched.
- **No agent edits the deploy worktree** — it is outside the dev checkout and
  deploy-only; the single-writable-root model is unaffected.
- **Failure is data** — a dirty/diverged/fetch-failed deploy-sync logs a structured
  record and does NOT restart, leaving the last good daemon running.
- **Implementation touches nothing live** — no `launchctl`/daemon mutation in code
  or tests; the operator performs the one cutover.
