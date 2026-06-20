# Single-instance dashboard (pidfile) — design

**Date:** 2026-06-19
**Status:** design — approved, ready for implementation plan
**Topic:** make `agent-mesh dashboard` terminate any existing dashboard on the same port when it launches, so stale instances never pile up.

## Problem & goal

Every dashboard restart leaves the previous process **lingering**: the old instance catches SIGTERM and *releases its port* but the process hangs around (slow/incomplete exit), and `pkill -f 'agent-mesh.js dashboard'` doesn't reliably reap it — so each restart accumulates stale processes, forcing a manual `kill -9`. (Observed repeatedly: `9803`, `78802`, … surviving restarts this session.)

**Goal:** `agent-mesh dashboard` is **single-instance per port** — on launch it cleanly terminates any prior dashboard on that port (including a lingering one), then starts. No manual cleanup.

## Decisions (from brainstorming)
- **pidfile mechanism** (not lsof/port-scan): cross-platform via `process.kill` (no platform-specific `lsof`/`netstat`), and it reaps a *lingering* old process that a port-scan would miss (the zombie no longer holds the port).
- **per-port scope:** the pidfile is keyed by port, so `--port 7077` and `--port 9000` coexist; a second launch on the **same port** replaces the first.
- **pidfile in `os.tmpdir()`** (machine-local, port-scoped): `agent-mesh-dashboard-<port>.pid`.
- **always replace by default**, with a `--no-replace` opt-out (keep the old instance; fail if one is running).
- **never blind-kill an unknown port-holder:** we only SIGTERM/SIGKILL a PID we recorded in the pidfile; if `listen` still hits `EADDRINUSE` (port held by an untracked process), we exit with a clear error.

## Architecture

A small testable helper module + thin wiring in the `dashboard` CLI command (the only place the dashboard is launched). The reap logic is fully injected (kill / liveness / sleep / fs) so it is hermetically unit-tested without real processes.

```
 agent-mesh dashboard <mesh> [--port P] [--no-replace]
   1. reapExisting(pidfile)   ── read prior {pid} → SIGTERM → grace poll → SIGKILL (if --no-replace: refuse instead)
   2. writePidfile(pidfile, {pid: process.pid, port, startedAt})
   3. srv.start()             ── listen(P); EADDRINUSE (untracked holder) → clear error, exit non-zero
   4. on SIGINT/SIGTERM/exit  ── srv.close() + removePidfile(pidfile)
```

## Components

### 1. `src/dashboard/single-instance.js` (new)
- `pidfilePath(port, dir = os.tmpdir()) → string` — `join(dir, 'agent-mesh-dashboard-' + port + '.pid')`. Pure.
- `reapExisting({ pidfile, replace = true, signalKill = process.kill, sleep = defaultSleep, now = () => Date.now(), readFileSync, log = () => {}, graceMs = 3000, pollMs = 100 }) → Promise<{ action: 'none'|'reaped'|'stale'|'refused', pid?: number }>`
  - Read+parse the pidfile (`{ pid }`); missing/corrupt → `{action:'none'}`.
  - If the pid is **not alive** (`signalKill(pid, 0)` throws `ESRCH`) → `{action:'stale'}` (nothing to kill; the writePidfile step overwrites it).
  - If alive and `replace === false` → throw a clear "a dashboard is already running on port … (pid …); use a different --port or stop it" error (so `--no-replace` refuses).
  - If alive and `replace`: `signalKill(pid, 'SIGTERM')`; poll `signalKill(pid, 0)` every `pollMs` up to `graceMs`; if still alive, `signalKill(pid, 'SIGKILL')` and one final short poll → `{action:'reaped', pid}`. Swallow `signalKill` errors except the refusal throw (a kill failure must not crash the launch).
- `writePidfile(pidfile, { pid, port, now }, { writeFileSync, mkdirSync })` — writes `JSON.stringify({ pid, port, startedAt: now })`. Best-effort (try/catch — a pidfile write failure must not block the dashboard).
- `removePidfile(pidfile, { rmSync })` — best-effort unlink (ENOENT ignored).
- `isAlive(pid, signalKill = process.kill)` — `try { signalKill(pid, 0); return true } catch (e) { return e.code === 'EPERM' /* alive but not ours */ }` (helper used by reapExisting).

All I/O is injected so the unit tests use a fake process table + in-memory pidfile.

### 2. `src/cli.js` — wire into the `dashboard` command (~line 301)
- Parse a new `--no-replace` flag (default replace = true).
- Compute `const pidfile = pidfilePath(port);`.
- **Before `await srv.start()`:** `await reapExisting({ pidfile, replace }).catch((e) => { throw e; });` then `writePidfile(pidfile, { pid: process.pid, port, now: Date.now() });`. (A `reapExisting` *refusal* under `--no-replace` propagates to the existing `catch` → prints the error + non-zero exit.)
- **On EADDRINUSE from `start()`** (untracked holder): the existing `catch (err)` already prints `error: <message>` and sets a non-zero exit — make the message actionable for `EADDRINUSE` (e.g. `port <port> is already in use by another process (not a tracked dashboard); free it or use --port`). Map by `err.code === 'EADDRINUSE'`.
- **Cleanup:** after the SIGINT/SIGTERM `await` (and in a `finally`), `removePidfile(pidfile)` so a clean exit doesn't leave a stale pidfile.

No change to `createDashboardServer` itself — this is purely launch-lifecycle in the CLI.

## Data flow & error handling
launch → reap prior (graceful then forceful) → record our pid → bind → serve → on exit remove pidfile. Failure modes: a pidfile that's missing/corrupt/stale → treated as "nothing to reap" (we just overwrite it). A `signalKill` error (e.g. permission) → logged, not fatal (we proceed to bind; if the old one truly still holds the port, the EADDRINUSE error surfaces). `--no-replace` with a live instance → refuse with a clear message + non-zero exit. The reap is **fail-open for the launch** (logging never blocks startup) except the deliberate `--no-replace` refusal.

## Invariants
- **Single-instance per port:** at most one dashboard per port after a launch completes; a relaunch reaps the prior one.
- **Never kill an unknown process:** only a PID this tool recorded in the port's pidfile is signalled; an untracked port-holder yields an error, not a kill.
- **Reap is graceful-first:** SIGTERM + grace before SIGKILL — the old instance gets to close cleanly.
- **Launch never blocked by logging/pidfile I/O:** all pidfile reads/writes are best-effort; only the explicit `--no-replace` refusal stops a launch.
- **PID-reuse window is bounded:** we only signal a *live* recorded PID; the residual risk (old crashed uncleanly, OS reused its PID, and we SIGTERM the reuser) is tiny and graceful — acceptable for a dev dashboard.

## Testing (hermetic, `node --test`)
- `test/dashboard-single-instance.test.js`:
  - `pidfilePath` is port-scoped + deterministic.
  - `reapExisting`: no pidfile → `none`; stale pid (signalKill(pid,0) throws ESRCH) → `stale`, no SIGTERM; live pid → SIGTERM then SIGKILL after grace (assert the signal sequence via a fake `signalKill` recording calls, with a fake `sleep`/`now` advancing past `graceMs`); live pid + a SIGTERM that *does* exit within grace → `reaped` with NO SIGKILL; `replace:false` + live pid → throws the refusal.
  - `writePidfile`/`removePidfile`: round-trip via an in-memory fs; best-effort (write to an un-writable dir → no throw).
- A CLI-wiring lint (regex on `src/cli.js`) that `reapExisting`/`writePidfile`/`removePidfile`/`--no-replace`/`pidfilePath` are wired into the `dashboard` command and EADDRINUSE has an actionable message.

## Deferred
- Reaping **untracked** stale instances (no pidfile) via `lsof`/`netstat` — the pidfile solves it going forward (every instance writes one); a one-time `kill -9` clears today's pre-pidfile stragglers. Not worth platform-specific port-scan code.
- A `dashboard --status`/`--stop` subcommand — out of scope.
