// src/mesh-improvement/policy.js — pure tiered fileable gate.
import { isRegression } from './metrics.js';

export function gate(mir, { noiseBandPct }) {
  const findings = mir.findings.map((f) => {
    if (f.tier === 'hard') return { ...f, fileable: true, severity: 'error' };
    const fileable = f.metric.baseline != null &&
      isRegression(f.metric.name, f.metric.deltaPct, noiseBandPct);
    return { ...f, fileable, severity: 'warning' };
  });
  return { ...mir, findings };
}
