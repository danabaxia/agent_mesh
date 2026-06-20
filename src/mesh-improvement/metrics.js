// src/mesh-improvement/metrics.js — pure metric registry + direction-aware deltas.
export const METRICS = {
  passRate:              { tier: 'soft', direction: 'higher_is_better', unit: 'ratio' },
  precision:             { tier: 'soft', direction: 'higher_is_better', unit: 'ratio' },
  recall:                { tier: 'soft', direction: 'higher_is_better', unit: 'ratio' },
  quality_per_1k_tokens: { tier: 'soft', direction: 'higher_is_better', unit: 'score' },
  cost_usd:              { tier: 'soft', direction: 'lower_is_better',  unit: 'usd' },
  latency_ms:            { tier: 'soft', direction: 'lower_is_better',  unit: 'ms' },
  wasted_hops:           { tier: 'soft', direction: 'lower_is_better',  unit: 'count' },
};

/** Signed percent toward "better" per the metric's direction; null if undefined. */
export function deltaPct(name, value, baseline) {
  if (typeof value !== 'number' || typeof baseline !== 'number') return null;
  if (baseline === 0) return null;
  const raw = ((value - baseline) / Math.abs(baseline)) * 100;
  const signed = METRICS[name]?.direction === 'lower_is_better' ? -raw : raw;
  return Math.round(signed * 10) / 10;
}

/** A regression is a negative signed delta whose magnitude exceeds the band. */
export function isRegression(name, dPct, bandPct) {
  return typeof dPct === 'number' && dPct < 0 && Math.abs(dPct) > bandPct;
}
