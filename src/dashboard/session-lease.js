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
 * @param {object} ctx { now, force, launchGraceMs, probe }
 *   probe(pid) → { alive:boolean, procStartedAt:number|null }
 *   (callers may carry their own `self` identity in ctx for building leases;
 *    evaluateLease itself does not reference it.)
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

/**
 * Impure: OS start-time (epoch ms) + liveness for a pid.
 * Accepts an optional `io` second argument for injection in tests:
 *   io.platform      — override process.platform (default: process.platform)
 *   io.execFileSync  — override the execFileSync call (default: the real one)
 * Callers that pass only pid get the real platform + real exec (backward compat).
 */
export function probePid(pid, io = {}) {
  const platform = io.platform ?? process.platform;
  const exec = io.execFileSync || execFileSync;
  try {
    if (platform === 'win32') {
      // PowerShell returns .NET ticks (100-ns intervals since 0001-01-01 UTC).
      // Convert: ticks / 10000n gives MILLISECONDS since that epoch; subtract
      // 62135596800000n (ms from 0001-01-01 to the Unix epoch) to get epoch-ms.
      const out = exec(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.Ticks`],
        { encoding: 'utf8', windowsHide: true }
      ).trim();
      if (!out) return { alive: false, procStartedAt: null };
      // If the process exists but the output isn't a clean integer (localized
      // text / a warning leaking into stdout), treat start-time as INDETERMINATE
      // rather than dead — `matches()` then reads it as busy. Marking a live
      // process dead would let the lease be reclaimed → double-resume hazard.
      if (!/^\d+$/.test(out)) return { alive: true, procStartedAt: null };
      const ms = Number(BigInt(out) / 10000n - 62135596800000n);
      return { alive: true, procStartedAt: Number.isFinite(ms) ? ms : null };
    }
    // darwin / linux
    // `ps -o lstart=` → e.g. "Sat Jun  7 12:00:00 2026". Force the C locale so
    // the month/day names are English and Date.parse stays stable (a non-C
    // locale would yield NaN → indeterminate start-time → degraded PID-reuse
    // detection).
    const out = exec('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    }).trim();
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
