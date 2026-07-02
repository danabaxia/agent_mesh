// src/mesh-improvement/metrics.js — pure metric registry + direction-aware deltas.
//
// `noiseBandPct` (optional) overrides the global DEFAULT_MIR_NOISE_BAND_PCT for a
// single metric. Wall-clock latency and per-task cost are high-variance signals on an
// LLM-driven cell — they swing run-to-run with API/machine load far more than the
// deterministic ratio/count metrics — so the generic 10% band false-positives on them
// (e.g. a ~16-19% swing is normal LLM-latency noise, not a code regression).
// A wider band requires a genuinely large move before filing.
//
// precision/recall on a `confusable`-overlap routing cell are the same class of
// noisy signal: each is a mean over a small, fixed sample of real-LLM routing
// decisions (peers×trials — e.g. 15 for 6x-confusable, 20 for 12x-confusable), so a
// SINGLE stochastic near-miss between two genuinely overlapping domains (the whole
// point of the `confusable` pool) already swings the ratio by 1/N — 5-13% just from
// one wrong pick. Issues #743/#744/#746 each filed on exactly one such swing (-13.3%,
// -13.3%, -15%) despite the router already following the task-first-delegate and
// no-hedging fixes. Widened to match cost_usd/latency_ms: tolerate a couple of
// misroutes as normal variance, still flag a genuinely larger drift.
export const METRICS = {
  passRate:              { tier: 'soft', direction: 'higher_is_better', unit: 'ratio' },
  precision:             { tier: 'soft', direction: 'higher_is_better', unit: 'ratio', noiseBandPct: 20 },
  recall:                { tier: 'soft', direction: 'higher_is_better', unit: 'ratio', noiseBandPct: 20 },
  quality_per_1k_tokens: { tier: 'soft', direction: 'higher_is_better', unit: 'score' },
  cost_usd:              { tier: 'soft', direction: 'lower_is_better',  unit: 'usd', noiseBandPct: 20 },
  latency_ms:            { tier: 'soft', direction: 'lower_is_better',  unit: 'ms', noiseBandPct: 20 },
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

/**
 * A regression is a negative signed delta whose magnitude exceeds the band. A metric
 * may carry its own `noiseBandPct` (high-variance signals like latency/cost); when
 * present it overrides the caller's global `bandPct`. Metrics without an override use
 * the global `bandPct` unchanged.
 */
export function isRegression(name, dPct, bandPct) {
  const band = METRICS[name]?.noiseBandPct ?? bandPct;
  return typeof dPct === 'number' && dPct < 0 && Math.abs(dPct) > band;
}

/** Median of a numeric array; null for empty/non-array input. */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Descriptive stats for a numeric array (Phase 0 evidence collection).
 * Returns { mean, sigma, cv, n } or null for empty input.
 * cv (coefficient of variation) = sigma / |mean|; null when mean === 0.
 */
export function computeStats(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const sigma = Math.sqrt(variance);
  const cv = mean !== 0 ? sigma / Math.abs(mean) : null;
  return { mean: Math.round(mean * 1e6) / 1e6, sigma: Math.round(sigma * 1e6) / 1e6, cv: cv !== null ? Math.round(cv * 1e6) / 1e6 : null, n };
}
