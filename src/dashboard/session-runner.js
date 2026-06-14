/**
 * src/dashboard/session-runner.js
 *
 * Orchestrates one ask-only dashboard turn against an agent's canonical claude
 * session: acquire the single-active lease, persist the canonical session id,
 * record `create`/`select` provenance, and run the turn to completion.
 *
 * Dashboard-driven turns also fan out Claude's stream-json stdout to the
 * in-memory live session hub. Transcript tailing still supplies checkpointed
 * history, but recent Claude Code releases may not append transcript lines
 * during a live turn, so stdout is the live source for dashboard-owned input.
 *
 * `runTurn` acquires the single-active lease and spawns the self-registering
 * `session-exec` wrapper, then resolves QUICKLY with `{ turnId, done }`:
 *   - it REJECTS (SessionBusyError) BEFORE spawning if the lease is held, so the
 *     HTTP endpoint can answer 409 synchronously;
 *   - `done` resolves when the turn completes (used by tests / callers that want
 *     to await completion).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { readManifest } from '../builder/manifest.js';
import { enterCallContext } from '../context.js';
import { DEFAULT_DEPTH, DEFAULT_TIMEOUT_MS, readPositiveInt } from '../config.js';
import { buildAskInvocation, buildClaudeEnv } from '../delegate-invocation.js';
import { parseEventLine } from './session-events.js';
import { sessionPaths, readSessionId, writeSessionId } from './session-store.js';
import { recordEvent, resolveTranscript } from './session-index.js';
import {
  evaluateLease, readLease, acquireLaunching, releaseLease, probePid,
  DEFAULT_LAUNCH_GRACE_MS
} from './session-lease.js';
import { killProcessTree, killTreeByPid } from '../process.js';

const BIN_PATH = fileURLToPath(new URL('../../bin/agent-mesh.js', import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SessionBusyError extends Error {
  constructor(code = 'session_busy', info = {}) { super(code); this.name = 'SessionBusyError'; this.code = code; Object.assign(this, info); }
}

export function createSessionRunner({ meshRoot, claudeBin = process.env.AGENT_MESH_CLAUDE || 'claude', sessionLive = null, onTurnComplete = null }) {
  const inFlight = new Map();      // agentName → token (in-memory authoritative lock)
  const active = new Map();        // agentName → { child, token, lockPath }
  const activeByAgent = new Map(); // agentName → { activeId, rev }

  async function resolveAgent(agentName) {
    const manifest = await readManifest(meshRoot);
    const entry = (manifest.agents ?? []).find((a) => a.name === agentName);
    if (!entry) throw new SessionBusyError('unknown_agent');
    const agentRoot = await realpath(resolve(join(meshRoot, entry.root)));
    return { entry, agentRoot };
  }

  /**
   * Record a dashboard-driven active-session selection. No lease, no turn.
   * Writes the canonical id to the session store, records a `select` provenance
   * event, and bumps a per-agent `rev` so stale runTurn callers can detect drift.
   * @returns {Promise<{ activeId: string, rev: number }>}
   */
  async function setActiveSession(agentName, id) {
    if (!UUID_RE.test(String(id))) throw new SessionBusyError('bad_id', { id });
    const { agentRoot } = await resolveAgent(agentName);
    const cur = activeByAgent.get(agentName) || { rev: 0 };
    // `rev` is a selection generation counter returned for the caller's display/
    // book-keeping only. runTurn's race guard compares `activeId` (NOT rev): two
    // selects to the SAME id bump rev but must still let a matching turn run, so
    // rev must never be used as the guard. (Spec §4 returns rev to the HTTP layer.)
    const next = { activeId: id, rev: cur.rev + 1 };
    activeByAgent.set(agentName, next);
    await writeSessionId(meshRoot, agentRoot, id);
    await recordEvent(meshRoot, { kind: 'select', source: 'dashboard', agentRoot, sessionId: id });
    return next;
  }

  /**
   * Run a framework maintenance task (digest/rotate — spec 2026-06-12 §4.1.1)
   * under the SAME single-active lease a turn takes, so maintenance and turns
   * can never overlap. Unlike runTurn there is no force/takeover: any busy or
   * external-owner state throws SessionBusyError and the caller defers.
   *
   * evaluateLease's clean-acquire actions are 'acquire' (no lease) and 'reclaim'
   * (recorded process provably dead / launching-grace expired). Maintenance
   * proceeds only on those two; 'busy', 'takeover-refuse', and 'takeover-kill'
   * all become session_busy (takeover-kill is downgraded to busy — maintenance
   * never kills a peer's live session).
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
    if (decision.action !== 'acquire' && decision.action !== 'reclaim') {
      throw new SessionBusyError('session_busy', { owner: existing?.owner });
    }
    const token = await acquireLaunching(lockPath, { pid: process.pid, procStartedAt: selfProbe.procStartedAt, now: Date.now() });
    inFlight.set(agentName, token);
    try {
      return await fn({ agentRoot });
    } finally {
      inFlight.delete(agentName);
      await releaseLease(lockPath, token).catch(() => {});
    }
  }

  /**
   * @returns {Promise<{ turnId: string, done: Promise<{ok:boolean, code:any, usage:object|null}> }>}
   * Rejects with SessionBusyError before spawning if the session is held.
   */
  async function runTurn({ agentName, text, force = false, expectedActiveId }) {
    if (inFlight.has(agentName)) throw new SessionBusyError('session_busy', { owner: 'dashboard' });
    const { agentRoot } = await resolveAgent(agentName);
    // Validate expectedActiveId against the in-memory active map, then the
    // persisted store, BEFORE acquiring any lease or spawning anything.
    if (expectedActiveId !== undefined) {
      // In-memory map is authoritative within this process; fall back to the
      // persisted store for a selection made before a restart. (A concurrent
      // cross-process setActiveSession could still move the store under us — the
      // same advisory-lock window all entry points share; acceptable for v1.)
      const current = activeByAgent.get(agentName)?.activeId ?? await readSessionId(meshRoot, agentRoot);
      if (expectedActiveId !== current) {
        throw new SessionBusyError('active_changed', { activeId: current });
      }
    }
    const { lockPath } = sessionPaths(meshRoot, agentRoot);

    // Cross-process lease decision (in-memory lock is authoritative for the MVP).
    const existing = await readLease(lockPath);
    const selfProbe = probePid(process.pid);
    const decision = evaluateLease(existing, {
      now: Date.now(), self: { pid: process.pid, procStartedAt: selfProbe.procStartedAt },
      force, launchGraceMs: DEFAULT_LAUNCH_GRACE_MS, probe: probePid
    });
    if (decision.action === 'busy') throw new SessionBusyError('session_busy', { owner: existing?.owner });
    if (decision.action === 'takeover-refuse') throw new SessionBusyError('session_busy_external', { owner: existing?.owner });
    if (decision.action === 'takeover-kill' && existing?.childPgid) {
      // Platform-aware tree kill (POSIX group-kill / win32 taskkill) so a
      // Windows takeover actually terminates the prior session's tree rather
      // than silently no-op'ing a POSIX group-kill → double-resume.
      killTreeByPid(existing.childPgid);
    }

    const token = await acquireLaunching(lockPath, { pid: process.pid, procStartedAt: selfProbe.procStartedAt, now: Date.now() });
    inFlight.set(agentName, token);
    const turnId = randomUUID();

    // Threaded call context so onward delegation stays cycle/depth-safe.
    const env = {
      AGENT_MESH_MESH_ROOT: join(meshRoot, 'mesh'),
      AGENT_MESH_MESH_CEILING: meshRoot,
      AGENT_MESH_LOG_DIR: '.agent-mesh/logs'
    };
    const entered = enterCallContext(agentRoot, env, DEFAULT_DEPTH);
    const callEnv = entered.ok ? entered.env : env;
    const claudeEnv = buildClaudeEnv({ root: agentRoot, env, mode: 'ask', callEnv, runId: token });

    let child;
    try {
      const storedSessionId = await readSessionId(meshRoot, agentRoot);
      const { args } = await buildAskInvocation({ root: agentRoot, env, callEnv, claudeEnv });
      // For brand-new sessions (no existing sessionId), pre-generate a uuid to
      // pass via --session-id. A stored id can also be a first-launch reservation
      // from /shell/plan; until Claude has created the transcript, it must be
      // launched with --session-id <id>, not --resume <id>.
      const isNewSession = !storedSessionId;
      const sessionId = storedSessionId || randomUUID();
      let resumeExistingTranscript = false;
      let transcriptLineCount = 0;
      if (storedSessionId) {
        try {
          const transcriptPath = await resolveTranscript(agentRoot, storedSessionId);
          resumeExistingTranscript = true;
          transcriptLineCount = await countLines(transcriptPath);
        } catch (err) {
          if (err.code !== 'not_found') throw err;
        }
      }
      const sessionArgs = resumeExistingTranscript ? ['--resume', sessionId] : ['--session-id', sessionId];
      const claudeArgs = ['-p', text, '--output-format', 'stream-json', '--verbose',
        ...sessionArgs,
        ...args];
      // capturedSid is the session id we expect claude to confirm via init event.
      // Stored ids are already canonical (whether resumed or first-launched via
      // --session-id). No-store sessions stay null until the init event echoes the
      // generated id. We persist + record `create` on that init event.
      let capturedSid = storedSessionId;
      let lastUsage = null;
      // Persist the reserved id before spawning so the session-log canvas has a
      // canonical id to open even when Claude checkpoints the transcript later.
      if (!storedSessionId) await writeSessionId(meshRoot, agentRoot, sessionId);
      const liveTurn = sessionLive?.start?.(sessionId, { baseSeq: transcriptLineCount });
      liveTurn?.append([{ type: 'user_text', text }]);

      child = spawn(process.execPath, [BIN_PATH, 'session-exec', lockPath, token, claudeBin, '--', ...claudeArgs], {
        cwd: agentRoot, env: { ...process.env, ...claudeEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true
      });

      const timeoutMs = readPositiveInt(env.AGENT_MESH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
      const timer = setTimeout(() => { killProcessTree(child); }, timeoutMs);
      timer.unref?.();

      // Parse Claude's stream-json stdout for both canonical session bookkeeping
      // and live canvas records. Transcript tailing still handles checkpointed
      // history, but Claude Code 2.1.x may not append transcripts during a live
      // turn, so the runner must also fan out stdout directly.
      const rl = createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const events = parseEventLine(line);
        if (events.length) liveTurn?.append(events);
        for (const ev of events) {
          if (ev.type === 'init' && ev.sessionId && !capturedSid) {
            capturedSid = ev.sessionId;
            writeSessionId(meshRoot, agentRoot, ev.sessionId).catch(() => {});
            // Record `create` only now that the session is confirmed (avoids
            // orphaned/compounding create events on a pre-init failure — C1).
            if (isNewSession) recordEvent(meshRoot, { kind: 'create', source: 'dashboard', agentRoot, sessionId: ev.sessionId }).catch(() => {});
          }
          if (ev.type === 'turn_done' && ev.usage) lastUsage = ev.usage;
        }
      });
      child.stderr.on('data', () => { /* surfaced via run log later; ignored in MVP */ });

      active.set(agentName, { child, token, lockPath });
      const done = new Promise((res) => {
        const finish = async (code) => {
          clearTimeout(timer);
          active.delete(agentName);
          inFlight.delete(agentName);
          await releaseLease(lockPath, token).catch(() => {}); // backstop; wrapper normally releases
          res({ ok: code === 0, code, usage: lastUsage });
          // Rotation hook (spec 2026-06-12 §4.1): live usage only; never throws
          // into the turn path.
          try { onTurnComplete?.({ agentName, agentRoot, sessionId: capturedSid, usage: lastUsage, ok: code === 0 }); } catch { /* hook must not break turns */ }
        };
        child.on('close', (c) => finish(c));
        child.on('error', () => finish(1));
      });
      return { turnId, done };
    } catch (err) {
      // Spawn/setup failed before the wrapper could take over the lease.
      active.delete(agentName);
      inFlight.delete(agentName);
      await releaseLease(lockPath, token).catch(() => {});
      return { turnId, done: Promise.resolve({ ok: false, code: 'spawn_failed' }) };
    }
  }

  async function stop(agentName) {
    const a = active.get(agentName);
    if (a) { killProcessTree(a.child); }   // wrapper exit releases the lease + clears inFlight
    else inFlight.delete(agentName);
  }

  return { runTurn, stop, setActiveSession, runMaintenance };
}

async function countLines(path) {
  try {
    const text = await readFile(path, 'utf8');
    if (!text) return 0;
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  } catch {
    return 0;
  }
}
