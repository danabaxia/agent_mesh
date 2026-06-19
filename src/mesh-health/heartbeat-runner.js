// Impure: gather the mesh-wide schedule list, assess (pure), apply the safe
// heals, write the snapshot the dashboard reads, then route escalations to a
// de-duped GitHub issue. Snapshot is written BEFORE issues so a gh failure
// still leaves the dashboard an accurate health view; issue routing is
// idempotent (dedup) and retries next tick.
import { assessMeshHealth } from './heartbeat.js';

/**
 * @param {object} deps  injected I/O (all async):
 *   listSchedules(meshRoot) → jobs[]   (listAllSchedules)
 *   readSnapshot()          → prev snapshot | null
 *   writeSnapshot(snap)     → void
 *   applyHeal({agent,jobId,action,cadence,now}) → void   (mutates schedule-state)
 *   openIssue({key,action,title?,body}) → void           (gh create/comment/close)
 * @returns {{status:'ok'|'fail', summary?, error?}}
 */
export async function runHeartbeat({ meshRoot, now = new Date(), thresholds, listSchedules, readSnapshot, writeSnapshot, applyHeal, openIssue }) {
  try {
    const prev = await readSnapshot().catch(() => null);
    const jobs = await listSchedules(meshRoot);
    const { findings, heals, escalations, openEscalations, summary } = assessMeshHealth({ jobs, now, thresholds, prev });

    const byKey = new Map(jobs.map((j) => [`${j.agent}/${j.id}`, j]));
    for (const h of heals) {
      const job = byKey.get(`${h.agent}/${h.jobId}`);
      await applyHeal({ ...h, cadence: job?.cadence, now });
    }

    await writeSnapshot({ generatedAt: now.toISOString(), summary, findings, openEscalations });

    for (const e of escalations) await openIssue(e);

    return { status: 'ok', summary };
  } catch (err) {
    return { status: 'fail', error: err?.message || String(err) };
  }
}
