/**
 * src/dashboard/watcher.js
 *
 * Mesh-root change watcher (shell) feeding the SSE `/api/events` stream.
 *
 * `fs.watch` is not reliably recursive or atomic across platforms, so this uses
 * a **polling mtime/size scan** as the authoritative signal, with `fs.watch`
 * (best-effort, recursive where supported) layered on top purely to *trigger an
 * earlier poll* for low latency. Either way the safe diff runs through the
 * polling path.
 *
 * Events are **coarse and secret-safe**: the payload carries a changed *scope*
 * (an agent directory name, or `mesh`) — never a file path. A change to a
 * sensitive file (`.env`, `*.pem`, …) is detected (so the client refetches) but
 * its scope collapses to `mesh`, so the secret filename never leaks (spec §6).
 */

import { watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { isSensitivePath } from './data.js';

const IGNORED_DIRS = new Set(['node_modules', '.git']);

/**
 * @param {object} opts
 *   @param {string}   opts.meshRoot
 *   @param {string[]} [opts.agentDirs]   top-level agent directory names (for scope)
 *   @param {Function} opts.onChange      ({ kind:'change', scopes:string[] }) => void
 *   @param {number}   [opts.debounceMs]  coalesce window (default 150)
 *   @param {number}   [opts.pollMs]      poll interval (default 1000)
 * @returns {{ ready: Promise<void>, close(): void, poll(): Promise<void> }}
 */
export function createMeshWatcher({
  meshRoot,
  agentDirs = [],
  onChange,
  debounceMs = 150,
  pollMs = 1000
}) {
  let closed = false;
  let flushTimer = null;
  let pollTimer = null;
  let fsWatcher = null;
  let pending = new Set();
  let prev = new Map(); // relPath → "mtimeMs:size"

  const deriveScope = (relPath) => {
    if (isSensitivePath(relPath)) return 'mesh';
    const seg = relPath.split(sep)[0];
    if (seg && agentDirs.includes(seg)) return seg;
    return 'mesh';
  };

  const flush = () => {
    flushTimer = null;
    if (closed || pending.size === 0) return;
    const scopes = [...pending];
    pending = new Set();
    try { onChange({ kind: 'change', scopes }); } catch { /* listener errors are not fatal */ }
  };

  const schedule = (scope) => {
    if (closed) return;
    pending.add(scope);
    if (!flushTimer) {
      flushTimer = setTimeout(flush, debounceMs);
      flushTimer.unref?.();
    }
  };

  async function walk(dir, map) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(meshRoot, abs);
      if (entry.isDirectory()) {
        // Never descend into ignored or sensitive directories (churny / secret).
        if (IGNORED_DIRS.has(entry.name) || isSensitivePath(rel + '/')) continue;
        await walk(abs, map);
      } else if (entry.isFile()) {
        // Track every file (including sensitive ones) for change detection; the
        // path is used only for diffing, never emitted — scope hides the name.
        try {
          const s = await stat(abs);
          map.set(rel, `${s.mtimeMs}:${s.size}`);
        } catch { /* vanished mid-scan */ }
      }
    }
  }

  async function scan() {
    const map = new Map();
    await walk(meshRoot, map);
    return map;
  }

  function diff(before, after) {
    const scopes = new Set();
    for (const [k, v] of after) {
      if (before.get(k) !== v) scopes.add(deriveScope(k));
    }
    for (const k of before.keys()) {
      if (!after.has(k)) scopes.add(deriveScope(k));
    }
    return scopes;
  }

  // In-flight guard: a single scan of a large agent folder can take longer than
  // pollMs. Without this, setInterval (or fs.watch bursts) would launch
  // overlapping scans that each allocate a full mtime/size Map of every file —
  // they pile up unboundedly and OOM the process. We allow at most one scan at a
  // time and coalesce any requests that arrive while one is running into a single
  // follow-up scan.
  let scanning = false;
  let rescanQueued = false;

  async function poll() {
    if (closed) return;
    if (scanning) { rescanQueued = true; return; }
    scanning = true;
    try {
      const next = await scan();
      const scopes = diff(prev, next);
      prev = next;
      for (const s of scopes) schedule(s);
    } finally {
      scanning = false;
      if (rescanQueued && !closed) {
        rescanQueued = false;
        queueMicrotask(() => poll().catch(() => {}));
      }
    }
  }

  const ready = (async () => {
    prev = await scan();
    if (closed) return;
    // Self-scheduling tick: schedule the NEXT poll only after the current one
    // settles, so scans never overlap regardless of how long a scan takes.
    const tick = () => {
      if (closed) return;
      poll()
        .catch(() => {})
        .finally(() => {
          if (closed) return;
          pollTimer = setTimeout(tick, pollMs);
          pollTimer.unref?.();
        });
    };
    pollTimer = setTimeout(tick, pollMs);
    pollTimer.unref?.();
    try {
      fsWatcher = watch(meshRoot, { recursive: true }, (_ev, filename) => {
        if (closed || !filename) return;
        // fs.watch only triggers an early poll; the poll's diff is authoritative
        // and applies the same secret-safe scope derivation.
        poll().catch(() => {});
      });
      fsWatcher.on?.('error', () => {});
    } catch {
      // recursive watch unsupported on this platform → polling-only (still correct)
      fsWatcher = null;
    }
  })();

  function close() {
    closed = true;
    if (flushTimer) clearTimeout(flushTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (fsWatcher) { try { fsWatcher.close(); } catch { /* already closed */ } }
  }

  return { ready, close, poll };
}
