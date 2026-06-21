// src/mesh-improvement/baseline.js — pure: add deltas, trend, and the carried ledger.
import { deltaPct } from './metrics.js';

const TREND_KEYS = ['passRate', 'quality_per_1k_tokens'];

/** Median of a non-empty array of finite numbers; null if empty. */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The finding's recent value history from PRIOR runs (the rolling window the baseline
 * is taken from). Reads `ledger[id].history`; for a finding whose ledger predates the
 * history field (migration) or whose first comparison this is, it degrades to the
 * single previous run's value — preserving the old single-value behavior until a window
 * accumulates.
 */
function priorHistory(ledgerEntry, prevFinding) {
  const h = ledgerEntry?.history;
  if (Array.isArray(h) && h.length) return h.filter((v) => typeof v === 'number');
  const v = prevFinding?.metric?.value;
  return typeof v === 'number' ? [v] : [];
}

export function applyBaseline(current, previous, { at, trendN }) {
  const day = at.slice(0, 10);
  const prevFindings = new Map((previous?.findings ?? []).map((f) => [f.id, f]));
  const prevLedger = previous?.ledger ?? {};

  // Per-finding baseline = MEDIAN of the finding's recent value history (rolling-window
  // baseline; design §11). Robust to a single noisy prior run — the failure mode where one
  // lucky-high previous value made an ordinary run look like a regression and filed a
  // false-positive perf issue (acute for the high-variance ratio metric quality_per_1k_tokens).
  // The signed delta is then current-value vs that robust baseline.
  const findings = current.findings.map((f) => {
    const base = median(priorHistory(prevLedger[f.id], prevFindings.get(f.id)));
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
    // Append this run's value to the rolling window (kept last trendN) so the NEXT run's
    // median baseline sees it. Pre-existing finding values carry forward via priorHistory.
    const prior = priorHistory(p, prevFindings.get(f.id));
    const v = f.metric.value;
    const history = (typeof v === 'number' ? [...prior, v] : [...prior]).slice(-trendN);
    ledger[f.id] = {
      firstSeen: p?.firstSeen ?? day, lastSeen: day,
      occurrences: (p?.occurrences ?? 0) + 1, cleanRuns: 0,
      issueNumber: p?.issueNumber ?? null,
      history,
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

  return { ...current, baseline: previous?.ref ?? null, summary, findings, ledger, trend };
}

function subtract(a, b) {
  return typeof a === 'number' && typeof b === 'number' ? Math.round((a - b) * 1000) / 1000 : null;
}
