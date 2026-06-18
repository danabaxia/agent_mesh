/**
 * src/mesh-health/core.js — mesh-health verbs (core, no stdio).
 *
 * Read-only health checks over ONE mesh root, exposed to the mesh-manager
 * agent through the mesh-health MCP server (spec
 * docs/superpowers/specs/2026-06-11-mesh-manager-agent-design.md).
 *
 * Every verb resolves to a plain data object — failure is data, never a
 * thrown exception. Agent names are validated against the manifest; the
 * model can never pass a filesystem path.
 *
 * Factory: createMeshHealth({ meshRoot, env, binPath })
 *   Returns: { triageLogs, checkConformance, pingAgent }
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { readManifest } from '../builder/manifest.js';
import { killProcessTree, KILL_ESCALATION_MS } from '../process.js';
import { readRunLogRecords, dedupeRunRecords } from '../log.js';
import { loadSnapshot, checkConformance as runConformance } from '../builder/conformance.js';
import { doctor } from '../builder/doctor.js';

const BIN_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/agent-mesh.js');
const MAX_RECENT_FAILURES = 10;
// delegate logs use 'done'; a2a bridge logs use 'completed' — both are success.
const OK_STATUSES = new Set(['done', 'completed']);

const DEFAULT_PING_TIMEOUT_MS = 10_000;

function readPositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Minimal newline-delimited JSON-RPC requester over a child's stdio (the same
// wire scripts/live-a2a-check.mjs speaks). Rejects Error('timeout') on expiry,
// or a descriptive Error immediately when the child process dies (probe_failed).
function rpcRequester(child, stderrTail) {
  let buf = '';
  const waiters = new Map();           // id → { resolve, reject, timer }
  let dead = null;                     // set once the child can no longer answer
  const failAll = (err) => {
    dead = err;
    for (const [, w] of waiters) { clearTimeout(w.timer); w.reject(err); }
    waiters.clear();
  };
  child.on('error', (err) => failAll(err));
  child.on('close', (code) => failAll(new Error(`exited code=${code}${stderrTail() ? ` — ${stderrTail()}` : ''}`)));
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && waiters.has(msg.id)) {
        const w = waiters.get(msg.id);
        waiters.delete(msg.id);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  let id = 0;
  return (method, params, timeoutMs) => new Promise((resolveP, rejectP) => {
    if (dead) return rejectP(dead);
    const myId = ++id;
    const timer = setTimeout(() => { waiters.delete(myId); rejectP(new Error('timeout')); }, timeoutMs);
    waiters.set(myId, { resolve: resolveP, reject: rejectP, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
}

export function createMeshHealth({ meshRoot, env = process.env, binPath = BIN_PATH } = {}) {
  // binPath and env are used by pingAgent (Task 3).
  const pingTimeoutMs = readPositiveInt(env.AGENT_MESH_HEALTH_PING_TIMEOUT_MS, DEFAULT_PING_TIMEOUT_MS);

  /**
   * triageLogs({ agent?, since_hours? })
   *
   * Scans run logs and schedule state for every agent (or a single named
   * agent) in the mesh. Returns:
   *   { since_hours, agents: [{ name, runs, failures, in_flight,
   *                             recent_failures, schedule }] }
   * or { error: string } on manifest/validation failure.
   *
   * Tolerant of missing log dirs and missing/corrupt schedule-state.json.
   */
  async function triageLogs({ agent, since_hours = 24 } = {}) {
    const n = Number(since_hours);
    if (!Number.isFinite(n) || n <= 0) return { error: 'bad_input: since_hours' };

    let manifest;
    try {
      manifest = await readManifest(meshRoot);
    } catch (err) {
      return { error: `manifest_unreadable: ${err.message}` };
    }

    const entries = (manifest.agents || []).filter((a) => !agent || a.name === agent);
    if (agent && entries.length === 0) return { error: 'unknown_agent' };

    const cutoff = Date.now() - n * 3_600_000;
    const agents = [];

    for (const entry of entries) {
      const agentRoot = resolve(meshRoot, entry.root);
      const logDir = join(agentRoot, '.agent-mesh', 'logs');

      // Collect all .jsonl files in the log dir; tolerate absent dir.
      let files = [];
      try {
        files = (await readdir(logDir)).filter((f) => f.endsWith('.jsonl'));
      } catch { /* no logs yet — healthy emptiness */ }

      // Files are grouped by START date (<prefix>-YYYY-MM-DD.jsonl); skip any
      // whose entire day ends before the window starts (fast path: avoid a
      // full file read for definitely-stale days).
      const records = [];
      for (const f of files) {
        const m = f.match(/(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (!m || new Date(`${m[1]}T23:59:59.999Z`).getTime() < cutoff) continue;
        const path = join(logDir, f);
        for (const r of dedupeRunRecords(await readRunLogRecords(path))) {
          records.push({ ...r, log_file: path });
        }
      }

      // Filter to runs whose start falls inside the requested window.
      const recent = records.filter((r) => r.started_at && Date.parse(r.started_at) >= cutoff);

      // FINAL records: dedupeRunRecords collapses start+final; the final record
      // carries state:'done' and a status field.
      const finals = recent.filter((r) => r.state === 'done');

      // Failures = finals whose status is not an OK_STATUSES member.
      const failures = finals
        .filter((r) => typeof r.status === 'string' && !OK_STATUSES.has(r.status))
        .sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));

      // In-flight = records that have a START but no matching FINAL yet.
      // After dedupeRunRecords the surviving state:'started' records are those
      // whose id never got a final write.
      const inFlight = recent.filter((r) => r.state === 'started');

      // Read schedule-state.json — tolerate absent or corrupt (same policy as
      // src/schedule/scheduler.js).
      const schedule = [];
      try {
        const raw = await readFile(join(agentRoot, '.agent-mesh', 'schedule-state.json'), 'utf8');
        const state = JSON.parse(raw);
        for (const [jobId, s] of Object.entries(state)) {
          if (!s || typeof s !== 'object') continue;
          schedule.push({
            job_id: jobId,
            last_status: s.lastStatus ?? null,
            last_run_at: s.lastRunAt ?? null,
            last_summary: s.lastSummary ?? null
          });
        }
      } catch { /* absent or corrupt → empty */ }

      agents.push({
        name: entry.name,
        runs: finals.length,
        failures: failures.length,
        in_flight: inFlight.length,
        recent_failures: failures.slice(0, MAX_RECENT_FAILURES).map((r) => ({
          id: r.id ?? null,
          status: r.status,
          error_code: r.result?.error?.code ?? r.error_code ?? null,
          route: r.route ?? null,
          started_at: r.started_at ?? null,
          log_file: r.log_file
        })),
        schedule
      });
    }

    return { since_hours: n, agents };
  }

  async function checkConformanceVerb() {
    try {
      const snapshot = await loadSnapshot(meshRoot);
      if (snapshot.manifestError) {
        return { ok: false, error: `mesh.json unreadable: ${snapshot.manifestError}` };
      }
      const report = runConformance(snapshot);
      const dry = await doctor(meshRoot, { apply: false }); // NEVER apply here
      const counts = { pass: 0, warn: 0, fail: 0 };
      for (const r of report.rules) counts[r.level] = (counts[r.level] ?? 0) + 1;
      return {
        ok: report.ok,
        counts,
        problems: report.rules.filter((r) => r.level !== 'pass'),
        doctor_dry_run: dry // what `agent-mesh doctor --apply` WOULD do
      };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  async function pingAgent({ name } = {}) {
    if (typeof name !== 'string' || name.length === 0) {
      return { name: name ?? null, alive: false, error: 'bad_input' };
    }
    let entry;
    try {
      const manifest = await readManifest(meshRoot);
      entry = (manifest.agents || []).find((a) => a.name === name);
    } catch (err) {
      return { name, alive: false, error: `manifest_unreadable: ${err?.message ?? String(err)}` };
    }
    if (!entry) return { name, alive: false, error: 'unknown_agent' };
    if (entry.served === false) return { name, alive: false, error: 'not_served' };
    const agentRoot = resolve(meshRoot, entry.root);

    // process.execPath is node itself — directly spawnable on every platform
    // (no .cmd shim involved), so a raw spawn is safe here.
    let child;
    try {
      child = spawn(process.execPath, [binPath, 'serve-a2a', agentRoot], {
        cwd: agentRoot,
        env: { ...env },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      return { name, alive: false, error: `spawn_failed: ${err?.message ?? String(err)}` };
    }

    // Silence EPIPE: probed server may die before the first write reaches it.
    child.stdin.on('error', () => { /* probed server died first — EPIPE is expected */ });
    let stderrBuf = '';
    child.stderr.on('data', (d) => {
      stderrBuf = (stderrBuf + d.toString()).slice(-2048); // keep last 2KB; also prevents pipe backpressure
    });
    // Cold-start probe RTT: includes server boot + initialize + ping (not steady-state ping).
    const started = Date.now();
    const call = rpcRequester(child, () => stderrBuf.trim().slice(-300));
    // childDone resolves once the process actually exits — awaited in finally so
    // the Windows kernel releases the cwd handle before callers clean up.
    const childDone = new Promise((res) => { child.once('close', res); child.once('error', res); });
    try {
      // "alive" = the wire answered JSON-RPC; protocol-level error replies still count as alive.
      await call('initialize', { protocolVersion: '1.0' }, pingTimeoutMs);
      await call('ping', {}, pingTimeoutMs);
      return { name, alive: true, latency_ms: Date.now() - started };
    } catch (err) {
      return {
        name,
        alive: false,
        error: err.message === 'timeout' ? 'timeout' : `probe_failed: ${err?.message ?? String(err)}`
      };
    } finally {
      try { child.stdin.end(); } catch { /* already gone */ }
      killProcessTree(child); // win32: taskkill /T /F; POSIX: signal escalation
      // Race mirrors spawnFile's "never hang" backstop in src/process.js.
      await Promise.race([
        childDone,
        new Promise((r) => setTimeout(r, KILL_ESCALATION_MS + 3_000).unref())
      ]); // wait for OS to release handles (critical on Windows)
    }
  }

  return { triageLogs, checkConformance: checkConformanceVerb, pingAgent };
}
