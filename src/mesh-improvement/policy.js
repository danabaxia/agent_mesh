// src/mesh-improvement/policy.js — pure tiered fileable gate.
import { isRegression } from './metrics.js';

export function gate(mir, { noiseBandPct }) {
  const findings = mir.findings.map((f) => {
    if (f.tier === 'hard') return { ...f, fileable: true, severity: 'error' };
    const { deltaPct, baseline } = f.metric;
    if (baseline == null || deltaPct == null) {
      // cold-start: no baseline to compare against
      return { ...f, fileable: false, severity: null };
    }
    if (deltaPct > 0) {
      // favorable-direction move — never a regression
      return { ...f, cluster: 'perf-improvement', fileable: false, severity: 'info' };
    }
    const fileable = isRegression(f.metric.name, deltaPct, noiseBandPct);
    if (!fileable) {
      // within noise band — neither improvement nor fileable regression
      return { ...f, fileable: false, severity: null };
    }
    return { ...f, cluster: 'perf-regression', fileable: true, severity: 'warning' };
  });
  return { ...mir, findings };
}
