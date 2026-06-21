// src/mesh-improvement/baseline.js — pure: add deltas, trend, and the carried ledger.
import { deltaPct, median } from './metrics.js';

const TREND_KEYS = ['passRate', 'quality_per_1k_tokens'];

// Minimum prior values needed before switching from single-previous-value to
// rolling-window median. Matches the Phase-0 evidence threshold (≥3 runs).
const MEDIAN_WINDOW_MIN = 3;

export function applyBaseline(current, previous, { at, trendN }) {
  const day = at.slice(0, 10);
  const prevFindings = new Map((previous?.findings ?? []).map((f) => [f.id, f]));
  const prevLedger = previous?.ledger ?? {};
  // Per-finding value history, carried forward across runs (bounded by trendN).
  const prevHistory = previous?.history ?? {};

  // Per-finding baseline + signed delta.
  // When ≥ MEDIAN_WINDOW_MIN prior values exist, use a rolling-window median
  // baseline (robust against single-run outliers for high-variance ratio metrics).
  // Cold start (< MEDIAN_WINDOW_MIN values): fall back to §10 single-previous-value.
  const newHistory = {};
  const findings = current.findings.map((f) => {
    const priorValues = prevHistory[f.id] ?? [];
    const base = priorValues.length >= MEDIAN_WINDOW_MIN
      ? median(priorValues.slice(-trendN))
      : (prevFindings.get(f.id)?.metric?.value ?? null);
    if (typeof f.metric.value === 'number') {
      newHistory[f.id] = [...priorValues, f.metric.value].slice(-trendN);
    }
    const dPct = deltaPct(f.metric.name, f.metric.value, base);
    return { ...f, metric: { ...f.metric, baseline: base, deltaPct: dPct } };
  });

  // Summary deltas (numeric headline fields only).
  const summary = structuredClone(current.summary);
  summary.behavior.delta = subtract(summary.behavior.passRate, previous?.summary?.behavior?.passRate);
  summary.perf.delta = subtract(summary.perf.quality_per_1k_tokens_p50, previous?.summary?.perf?.quality_per_1k_tokens_p50);
  summary.tests.delta = subtract(summary.tests.red, previous?.summary?.tests?.red);

  // Ledger: union of previous ids and this run's finding ids.
  const presentIds = new Set(findings.map((f) => f.id));
  const ledger = {};
  for (const f of findings) {
    const p = prevLedger[f.id];
    ledger[f.id] = {
      firstSeen: p?.firstSeen ?? day, lastSeen: day,
      occurrences: (p?.occurrences ?? 0) + 1, cleanRuns: 0,
      issueNumber: p?.issueNumber ?? null,
    };
  }
  for (const [id, p] of Object.entries(prevLedger)) {
    if (presentIds.has(id)) continue;
    const cleanRuns = (p.cleanRuns ?? 0) + 1;
    // GC: drop entries that were never filed and have been clean for trendN runs.
    if (p.issueNumber == null && cleanRuns >= trendN) continue;
    ledger[id] = { ...p, cleanRuns };
  }

  // Trend: append this run's headline values, keep last trendN.
  const trend = {};
  for (const k of TREND_KEYS) {
    const v = k === 'passRate' ? summary.behavior.passRate : summary.perf.quality_per_1k_tokens_p50;
    const prior = previous?.trend?.[k] ?? [];
    trend[k] = [...prior, v].filter((x) => typeof x === 'number').slice(-trendN);
  }

  return { ...current, baseline: previous?.ref ?? null, summary, findings, ledger, trend, history: newHistory };
}

function subtract(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? Math.round((a - b) * 1000) / 1000 : null;
}
