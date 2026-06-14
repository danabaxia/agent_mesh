// src/dashboard/rotation.js — the generation state machine (spec 2026-06-12 §4).
// IN-MEMORY ONLY by design (D8): a restart loses a pending rotation and the
// next below-threshold turn re-arms it. Control input is the LIVE usage the
// runner captured — never a disk fallback (§3.2).
import { randomUUID } from 'node:crypto';
import { occupancyFromUsage, headroomPctOf } from '../session-transcripts.js';
import { readPositiveInt, DEFAULT_CONTEXT_WINDOW, DEFAULT_ROTATE_HEADROOM_PCT, DEFAULT_ROTATE_IDLE_MS } from '../config.js';

export function createRotationManager({
  meshRoot, runMaintenance, runDigest, writeSessionId, readSessionId, recordEvent,
  env = process.env, schedule = setTimeout, clearSchedule = clearTimeout,
  log = (line) => process.stderr.write(`[agent-mesh] ${line}\n`)
}) {
  const pending = new Map();   // agentName → { timer, token }
  const digesting = new Set(); // agentName
  const lastError = new Map(); // agentName → error code
  const disabled = env.AGENT_MESH_ROTATE_HEADROOM_PCT === '0';
  const thresholdPct = readPositiveInt(env.AGENT_MESH_ROTATE_HEADROOM_PCT, DEFAULT_ROTATE_HEADROOM_PCT);
  const idleMs = readPositiveInt(env.AGENT_MESH_ROTATE_IDLE_MS, DEFAULT_ROTATE_IDLE_MS);
  const contextWindow = readPositiveInt(env.AGENT_MESH_CONTEXT_WINDOW, DEFAULT_CONTEXT_WINDOW);

  function cancel(agentName) {
    const p = pending.get(agentName);
    if (p) { try { clearSchedule(p.timer); } catch { /* fake timers */ } pending.delete(agentName); }
  }

  function arm(agentName, agentRoot, sessionId) {
    cancel(agentName);
    const token = {};  // staleness guard: a fired timer must still be the armed one
    // NOTE: return the rotate promise from the callback so test harnesses (and
    // any awaiting scheduler) can await completion — do not wrap in a void block.
    const timer = schedule(() => rotate(agentName, agentRoot, sessionId, token).catch(() => {}), idleMs);
    timer?.unref?.();
    pending.set(agentName, { timer, token });
  }

  async function rotate(agentName, agentRoot, sessionId, token) {
    const p = pending.get(agentName);
    if (!p || p.token !== token) return; // cancelled/re-armed since scheduling
    pending.delete(agentName);
    try {
      await runMaintenance(agentName, async () => {
        digesting.add(agentName);
        try {
          const r = await runDigest({ agentRoot, sessionId, env });
          if (r.status !== 'done') {
            lastError.set(agentName, r.error?.code || 'digest_failed');
            log(`digest failed for ${agentName}: ${r.error?.code} (no rotation)`);
            return;
          }
          // A user (or anything else) may have re-pointed the canonical session
          // while this rotation was pending/digesting — never clobber a manual
          // selection: rotate only the thread we measured (Task 14 review).
          const current = await readSessionId(meshRoot, agentRoot).catch(() => null);
          if (current !== sessionId) {
            lastError.set(agentName, 'canonical_moved');
            log(`rotation aborted for ${agentName}: canonical id moved (digest applied, no rotation)`);
            return;
          }
          const next = randomUUID();
          await writeSessionId(meshRoot, agentRoot, next);
          await recordEvent(meshRoot, { kind: 'rotate', source: 'headroom', agentRoot, sessionId: next, priorSessionId: sessionId });
          lastError.delete(agentName);
          log(`rotated ${agentName}: ${sessionId} → ${next}`);
        } finally { digesting.delete(agentName); }
      });
    } catch (e) {
      if (e && (e.code === 'session_busy' || e.code === 'session_busy_external')) { arm(agentName, agentRoot, sessionId); return; }
      lastError.set(agentName, 'maintenance_failed');
      log(`rotation maintenance failed for ${agentName}: ${e?.message}`);
    }
  }

  /** Runner hook — called after every completed dashboard turn. */
  function onTurnComplete({ agentName, agentRoot, sessionId, usage }) {
    if (disabled || !agentName || !agentRoot || !sessionId) return;
    const pct = headroomPctOf(occupancyFromUsage(usage), contextWindow);
    if (pct === null) return;                       // no signal → no decision (§3.2)
    if (pct >= thresholdPct) { cancel(agentName); return; }
    arm(agentName, agentRoot, sessionId);
  }

  return {
    onTurnComplete,
    isDigesting: (agentName) => digesting.has(agentName),
    lastErrorFor: (agentName) => lastError.get(agentName) ?? null,
    stop() { for (const name of [...pending.keys()]) cancel(name); }
  };
}
