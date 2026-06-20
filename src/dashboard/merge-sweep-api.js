import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeSweepReportPath } from '../merge-sweep/report.js';

export function readMergeSweepApi(meshRoot, now) {
  let rep;
  try { rep = JSON.parse(readFileSync(mergeSweepReportPath(meshRoot), 'utf8')); }
  catch { return { available: false }; }
  let remediation = {};
  try { remediation = JSON.parse(readFileSync(join(meshRoot, 'mesh', 'reports', 'merge-sweep-remediation.json'), 'utf8')); } catch { /* none yet */ }
  for (const cp of (rep.checkpoints || [])) {
    for (const it of (cp.items || [])) {
      const r = remediation[`${cp.name}:${it.ref}`];
      if (r) it.remediation = { state: r.state, issueNumber: r.issueNumber ?? null };
    }
  }
  const age = now.getTime() - new Date(rep.ranAt).getTime();
  const stale = !(age >= 0) || age > 2 * (rep.cadenceMinutes || 15) * 60_000;
  return { ...rep, available: true, stale };
}
