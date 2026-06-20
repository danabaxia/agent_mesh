import { readFileSync } from 'node:fs';
import { mergeSweepReportPath } from '../merge-sweep/report.js';

export function readMergeSweepApi(meshRoot, now) {
  let rep;
  try { rep = JSON.parse(readFileSync(mergeSweepReportPath(meshRoot), 'utf8')); }
  catch { return { available: false }; }
  const age = now.getTime() - new Date(rep.ranAt).getTime();
  const stale = !(age >= 0) || age > 2 * (rep.cadenceMinutes || 15) * 60_000;
  return { ...rep, available: true, stale };
}
