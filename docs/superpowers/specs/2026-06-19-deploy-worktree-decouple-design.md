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
`~/.agent-mesh/deploy`). This produces a **detached** worktree at `origin/main`'s
commit — which is **fine for this design** because deploy-sync uses `reset --hard`
(§5.2), which needs neither a branch nor an upstream. (We deliberately do *not*
reuse the dev-checkout `repo-sync`/`runRepoSyncOnce` here: that path is `ff-only`
and returns `skip_detached` on a detached worktree and `skip_dirty` if any tracked
file drifts — both would silently freeze the deploy at a stale commit.) Created by
the runbook (§7) with a plain git command — no new code needed to create it — so the
install script can then live *inside* it.

### 5.2 `deploy-sync` (new) — reset-to-main + restart-on-advance
A dedicated, deploy-appropriate sync (NOT `runRepoSyncOnce`). The deploy worktree is
deploy-only — it has no legitimate local edits — so the correct primitive is "make
it exactly `origin/main`", which is self-healing against any drift and works on a
detached HEAD.

- **Pure planner** `planDeploySync({ head, target, lastRestartedTarget }) →
  { reset, restart }` in `src/dev-society/deploy-sync.js` — `reset` and `restart` are
  **independent** so a failed restart is retried on a later tick:
  - `reset  = !!target && head !== target`         (advance the worktree to main)
  - `restart = !!target && target !== lastRestartedTarget`  (daemon not yet running this SHA)
  (empty/missing `target` → both false).
- **Runner** `scripts/dev-society-deploy-sync.mjs` exporting
  `runDeploySyncOnce({ deployPath, git, restart, readState, writeState, now, log }) →
  record`, wrapped in `try/catch` so a thrown git failure becomes
  `{ action: 'error', error }` and **never restarts**:
  1. `head = git rev-parse HEAD`
  2. `git fetch origin --prune -q`   *(throws → error record, no restart)*
  3. `target = git rev-parse origin/main`
  4. `lastRestartedTarget = readState()` — returns the **scalar SHA string** (or `''`
     if the state file is missing/unparseable)
  5. `{reset, restart} = planDeploySync({head, target, lastRestartedTarget})`
  6. if `reset`: `git reset --hard origin/main`
  7. if `restart`: `await restart()`; **only on success** `writeState(target)`.

  **State contract (single definition):** the file
  `.dev-society/deploy-sync-state.json` is `{ "lastRestartedTarget": "<sha>" }`;
  `readState() → string` returns that field or `''`; `writeState(targetSha)` writes
  the object atomically (tmp + rename). Tests and runner use this scalar API.
  Default `restart` = `launchctl kickstart -k gui/<uid>/<DEV_SOCIETY_DAEMON_LABEL>`.
  Because restart keys off `lastRestartedTarget` (persisted, written only after a
  successful kickstart), a reset that lands but whose restart fails/crashes is
  **retried every tick until the daemon is actually on `target`** — it is never
  stranded running old code despite the worktree being current.
- Runs from its own launchd plist `com.danabaxia.agent-mesh.deploy-sync`
  (`StartInterval=300`, `WorkingDirectory=$DEPLOY_ROOT`,
  `node $DEPLOY_ROOT/scripts/dev-society-deploy-sync.mjs`, with the same env block as
  the daemon — §5.3). It hard-resets the deploy worktree it runs from (self-updating)
  and then restarts the daemon.

**Reuse, not rebuild:** only `runGit` (the `execFile('git')` wrapper) is reused;
deploy-sync's `reset --hard` flow is new precisely to avoid `runRepoSyncOnce`'s
`skip_detached`/`skip_dirty` traps.

### 5.3 Cutover/install script (new) — `scripts/dev-society-deploy-install.sh`
Run **from inside the deploy worktree**. It reuses `dev-society-install.sh`'s
`resolve_paths`/env logic so the plists carry the **same required environment** the
working daemon needs (omitting these is a launchd failure):
- `DEV_SOCIETY_REPO` (the daemon exits without it),
- a launchd-safe `PATH` that resolves `git`/`gh`/`claude`/`node`/`launchctl`,
- `HOME` and `USER`.

`DEPLOY_ROOT` resolution (security): in **live mode** the script uses
`realpath("$SCRIPT_DIR/..")` and **must reject** any mismatching
`DEV_SOCIETY_DEPLOY_ROOT` (so the shared dev checkout can never point the daemon at
an arbitrary path). `DEV_SOCIETY_DEPLOY_ROOT` is honored **only** under `--dry-run`
(test/preview). It (idempotently):
1. Resolves `DEPLOY_ROOT` (live: `realpath($SCRIPT_DIR/..)`; dry-run: the env or that).
2. Writes the canonical daemon plist `com.danabaxia.agent-mesh.dev-society`:
   `ProgramArguments = <node> $DEPLOY_ROOT/scripts/dev-society-daemon.mjs`,
   `WorkingDirectory=$DEPLOY_ROOT`, `KeepAlive=true`, `ThrottleInterval=30`,
   the env block above, logs under `$DEPLOY_ROOT/.dev-society/`.
3. Writes the `com.danabaxia.agent-mesh.deploy-sync` plist (§5.2) with the same env
   block + `DEV_SOCIETY_DAEMON_LABEL`.
4. **Re-points the daemon LaunchAgent correctly** (changing a loaded agent's
   `ProgramArguments`/`WorkingDirectory` needs a reload, not a bare kickstart):
   `launchctl bootout gui/$uid/$LABEL || true` → write plist →
   `launchctl bootstrap gui/$uid "$plist"` → `enable` → `kickstart -k`. Same for the
   deploy-sync agent.
5. **Removes the legacy duplicate**: `launchctl bootout` + delete
   `com.danabaxia.dev-society.plist`.
- **Out of scope:** the existing `com.danabaxia.agent-mesh.dev-society-report`
  LaunchAgent is NOT touched by this script (a separate, future report-repoint step);
  the dev-checkout `repo-sync` plist is left as-is.
- `--dry-run`: prints every action + the full plist contents and **touches nothing**
  (no `launchctl`, no fs writes) — the hermetic test surface (§9).

## 6. Data / control flow

```
operator runbook: git worktree add ~/.agent-mesh/deploy origin/main   (detached @ origin/main — OK)
                  → bash ~/.agent-mesh/deploy/scripts/dev-society-deploy-install.sh
                      → bootout+bootstrap daemon plist (→ deploy worktree, with env)
                      → bootout+bootstrap deploy-sync plist
                      → bootout+remove legacy plist
                      → kickstart single daemon
every 300s:  deploy-sync → fetch; head=HEAD; target=origin/main; last=readState()
                  → head != target        → reset --hard origin/main
                  → target != last        → kickstart -k <daemon>; on success writeState(last=target)
                  → (restart failed last tick) target!=last but head==target → RETRY kickstart (not stranded)
                  → head==target && target==last → no-op
                  → git throws (fetch/network) → {action:'error'} logged, NO restart (failure-is-data)
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
Rollback (durable): because deploy-sync continuously converges the deploy worktree to
`origin/main`, a manual `git reset --hard <good-sha>` would be **undone on the next
tick**. So roll back by fixing `main` itself — `git revert <bad-sha>` (or
roll-forward fix) + push; deploy-sync then converges to the corrected `main` within
one interval. For an *emergency* hold while you fix `main`, first
`launchctl bootout gui/$uid/com.danabaxia.agent-mesh.deploy-sync` (freeze syncing),
then optionally `git -C ~/.agent-mesh/deploy reset --hard <good-sha>` + kickstart the
daemon; re-`bootstrap` deploy-sync only after `main` is corrected.

## 8. Future (v2, out of scope)

Docker image for multi-host/server deployment (CI already shows the install path);
Capistrano `releases/`+`current` for instant rollback; tagged-release pinning via
release-please; retiring the dev-checkout `repo-sync`.

## 9. Testing

**Hermetic unit tests (L0; no launchctl/git/network):**

| Test | Covers |
|------|--------|
| `test/deploy-sync.test.js` | `planDeploySync`: `head!=target`→`reset:true`; `target!=lastRestartedTarget`→`restart:true`; both-equal→both false; empty `target`→both false; **`head==target` but `target!=lastRestartedTarget`→`reset:false, restart:true` (retry-after-failed-restart)**. `runDeploySyncOnce` with injected `git`/`restart`/`readState`/`writeState`: advance→`git reset --hard origin/main` issued, `restart` called, `writeState(target)` called; already-current+restarted→none called; **restart throws→`writeState` NOT called (so next tick retries)**; **`git` fetch throws→`{action:'error'}`, no reset, no restart**. |
| `test/deploy-install-lint.test.js` | Run `dev-society-deploy-install.sh --dry-run` with `DEV_SOCIETY_DEPLOY_ROOT=/tmp/x` and assert the printed output: daemon plist `ProgramArguments` includes `/tmp/x/scripts/dev-society-daemon.mjs`, `WorkingDirectory=/tmp/x`, and an `EnvironmentVariables` block containing `DEV_SOCIETY_REPO` + `PATH`; single canonical label `com.danabaxia.agent-mesh.dev-society`; deploy-sync plist with `StartInterval` 300 + `DEV_SOCIETY_DAEMON_LABEL`; a `bootout`+remove step for `com.danabaxia.dev-society`; a `bootout`→`bootstrap` (not bare kickstart) sequence; and **no real `launchctl` call** — run with a PATH-shadowing `launchctl` stub that exits non-zero if invoked, so any accidental invocation fails the test. Also assert live-mode `DEV_SOCIETY_DEPLOY_ROOT` mismatch is rejected (run without `--dry-run` in a temp dir with a mismatching env → non-zero exit, no fs/launchctl writes). |

deploy-sync uses only `runGit` from repo-sync (its existing tests stand).
**Live cutover is not auto-tested** (operator-run); the install script's `--dry-run`
is the CI-safe surface.

## 10. Config (env, all optional)

- `DEV_SOCIETY_DEPLOY_ROOT` (`~/.agent-mesh/deploy`) — deploy worktree path.
  **Honored only under `--dry-run`/tests**; in live install it must equal
  `realpath($SCRIPT_DIR/..)` or the script aborts (§5.3).
- `DEV_SOCIETY_DAEMON_LABEL` (`com.danabaxia.agent-mesh.dev-society`) — daemon
  launchd label the deploy-sync restarts.
- The daemon/deploy-sync plists also carry `DEV_SOCIETY_REPO`, `PATH`, `HOME`,
  `USER` (reused from `dev-society-install.sh`).
- deploy-sync persists `lastRestartedTarget` in
  `$DEPLOY_ROOT/.dev-society/deploy-sync-state.json` (ignored prefix); written only
  after a successful `kickstart -k`, so restart is retryable across ticks.

## 11. Invariants preserved

- **The daemon never runs an agent's in-flight branch** — it runs only the deploy
  worktree, which is pinned to `main` and never branch-switched.
- **No agent edits the deploy worktree** — it is outside the dev checkout and
  deploy-only; the single-writable-root model is unaffected.
- **Failure is data** — a dirty/diverged/fetch-failed deploy-sync logs a structured
  record and does NOT restart, leaving the last good daemon running.
- **Implementation touches nothing live** — no `launchctl`/daemon mutation in code
  or tests; the operator performs the one cutover. The install script's live mode
  refuses an externally-supplied `DEV_SOCIETY_DEPLOY_ROOT` (bootstrap can't be
  redirected by the shared checkout).
- **Drift can't freeze deployment** — deploy-sync `reset --hard origin/main` makes
  the deploy worktree converge to `main` regardless of any tracked-file drift
  (so it can never get stuck in `skip_dirty` like ff-only would). The deploy daemon's
  writable runtime state stays under ignored prefixes (`.dev-society/`,
  `.agent-mesh/`); scheduled jobs keep `saveArtifact:false` so nothing legitimate is
  clobbered by the reset.

## Review log

### Round 1 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → all 7 findings accepted

- **[BLOCKER] detached worktree → `runRepoSyncOnce` skip_detached** — accepted; pivoted
  deploy-sync off `runRepoSyncOnce` to a `reset --hard origin/main` flow (§5.2) that
  works on a detached HEAD; `git worktree add … origin/main` (detached) is now correct.
- **[BLOCKER] plist missing required env** — accepted; §5.3 reuses the installer's env
  block (`DEV_SOCIETY_REPO` + launchd-safe `PATH`/`HOME`/`USER`) for both plists.
- **[MAJOR] kickstart can't repoint a loaded agent** — accepted; §5.3/§6 now specify
  `bootout`→`bootstrap`→`enable`→`kickstart -k`.
- **[MAJOR] `runRepoSyncOnce` throws on fetch error (not `{action:'error'}`)** —
  accepted; `runDeploySyncOnce` wraps in try/catch, returns `error`, never restarts
  (§5.2/§9).
- **[MAJOR] `DEV_SOCIETY_DEPLOY_ROOT` honored live = bootstrap hole** — accepted;
  env honored only under `--dry-run`; live asserts `== realpath(script/..)` (§5.3/§10/§11).
- **[MAJOR] runtime writes → permanent `skip_dirty`** — accepted; `reset --hard`
  converges regardless of drift; runtime state under ignored prefixes +
  `saveArtifact:false` invariant (§11).
- **[MINOR] report LaunchAgent not addressed** — accepted; `…dev-society-report` is
  explicitly out of scope for this cutover (§5.3).

### Round 2 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → 1 MAJOR accepted (0 blockers)

- **[MAJOR] restart-after-reset failure strands daemon on old code** — accepted.
  Split the planner into independent `reset`/`restart` decisions; `restart` now keys
  off a persisted `lastRestartedTarget` (`.dev-society/deploy-sync-state.json`),
  written only after a successful `kickstart -k`. A reset whose restart fails is
  retried every tick until the daemon is actually on `target` (§5.2/§6/§9/§10).

### Round 3 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → 2 MAJOR accepted (0 blockers)

- **[MAJOR] state read/write contract inconsistent** — accepted; defined one scalar
  contract: file `{ "lastRestartedTarget": "<sha>" }`, `readState() → string|''`,
  `writeState(targetSha)` atomic (§5.2/§9).
- **[MAJOR] §7 rollback is temporary (re-reset next tick)** — accepted; durable
  rollback now means fixing `main` (`git revert` + push); emergency hold = `bootout`
  deploy-sync first, then manual reset + kickstart, re-`bootstrap` after `main` is fixed.

### Round 4 — Codex (gpt-5.5), VERDICT: APPROVED

No remaining actionable findings. Converged (7 → 1 → 2 → 0 across rounds 1–4).
