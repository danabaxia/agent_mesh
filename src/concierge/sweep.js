/**
 * Over-the-loop monitor sweep — read-only. Gathers mesh-health signals, builds
 * findings, and upserts the alerts store. Used by the daemon builtin
 * `concierge-monitor-sweep`. `health` is injected so this is hermetically testable.
 *
 * Spec: docs/superpowers/specs/2026-06-21-concierge-mesh-agent-design.md
 */
import { buildFindings } from './monitor.js';
import { syncAlerts } from './alerts-store.js';

const safe = async (fn) => { try { return await fn(); } catch { return undefined; } };

/**
 * @param {object} a
 * @param {string} a.meshRoot
 * @param {object} a.health  mesh-health verbs (checkConformance/triageLogs/listStaleTasks)
 * @param {string} a.now     ISO timestamp
 * @returns {Promise<{status:'ok'|'fail', output?:string, error?:string}>} builtin contract
 */
export async function runSweep({ meshRoot, health, now }) {
  try {
    const [conformance, triage, staleTasks] = await Promise.all([
      safe(() => health.checkConformance?.()),
      safe(() => health.triageLogs?.({ since_hours: 24 })),
      safe(() => health.listStaleTasks?.({})),
    ]);
    const findings = buildFindings({ conformance, triage, staleTasks });
    await syncAlerts(meshRoot, findings, now);
    return { status: 'ok', output: `concierge sweep: ${findings.length} alert(s)` };
  } catch (err) {
    return { status: 'fail', error: String(err?.message ?? err) };
  }
}
