// eval/perf/perfcard.mjs — composite PerfCard scoring + render (spec §8).
// Pure: takes per-scenario samples (one per task-drive per trial), aggregates as
// distributions, computes the efficiency-normalized anti-gaming headline, renders
// markdown, and decides the (optional, off-by-default) gated exit code.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A sample = flat metrics from one task-drive. Add the anti-gaming derived pair. */
export function deriveSample(s) {
  const q = num(s.judge_score);
  const tok = num(s.tokens_total);
  const hops = num(s.hops);
  return {
    ...s,
    quality_per_1k_tokens: q != null && tok ? q / (tok / 1000) : null,
    quality_per_hop: q != null ? q / Math.max(1, hops ?? 0) : null
  };
}

function percentile(arr, p) {
  const xs = arr.filter((x) => num(x) != null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil(p * xs.length) - 1));
  return xs[idx];
}
function mean(arr) {
  const xs = arr.filter((x) => num(x) != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** {p50,p95,mean,n} for every numeric key present across the samples. */
export function summarize(samples) {
  const keys = new Set();
  for (const s of samples) for (const k of Object.keys(s)) if (num(s[k]) != null) keys.add(k);
  const out = {};
  for (const k of keys) {
    const col = samples.map((s) => s[k]);
    out[k] = { p50: percentile(col, 0.5), p95: percentile(col, 0.95), mean: mean(col), n: col.filter((x) => num(x) != null).length };
  }
  return out;
}

/** scenarioReports: [{ name, cell, samples: [rawMetrics] }] → full report. */
export function aggregate(scenarioReports) {
  const scenarios = scenarioReports.map((s) => {
    const samples = (s.samples || []).map(deriveSample);
    return {
      name: s.name,
      cell: s.cell || null,
      n: samples.length,
      summary: summarize(samples),
      // Pareto scatter: one point per sample (quality vs cost).
      scatter: samples.map((x) => ({
        quality: num(x.judge_score), cost_usd: num(x.cost_usd),
        tokens_total: num(x.tokens_total), hops: num(x.hops),
        precision: num(x.precision), recall: num(x.recall)
      })),
      samples
    };
  });
  return { at: new Date().toISOString(), scenarios };
}

const f = (v, d = 2) => (num(v) == null ? '—' : Number(v).toFixed(d));
const pct = (v) => (num(v) == null ? '—' : `${Math.round(v * 100)}%`);

export function renderMarkdown(report) {
  const lines = [`# Mesh PerfCard — ${report.at}`, '',
    '| scenario | n | quality p50 | routing P/R | wasted-hops p50 | latency p50/p95 ms | tokens p50 | $ p50 | **q/1k-tok** | **q/hop** |',
    '|---|---|---|---|---|---|---|---|---|---|'];
  for (const s of report.scenarios) {
    const g = (k, stat = 'p50') => s.summary[k]?.[stat];
    lines.push('| ' + [
      s.cell ? `${s.name} (${s.cell.peers}×${s.cell.overlap})` : s.name,
      s.n,
      f(g('judge_score')),
      `${pct(g('precision', 'mean'))}/${pct(g('recall', 'mean'))}`,
      f(g('wasted_hops'), 1),
      `${f(g('latency_ms'), 0)}/${f(g('latency_ms', 'p95'), 0)}`,
      f(g('tokens_total'), 0),
      f(g('cost_usd'), 4),
      `**${f(g('quality_per_1k_tokens'))}**`,
      `**${f(g('quality_per_hop'))}**`
    ].join(' | ') + ' |');
  }
  lines.push('', '_Headline is the (quality, routing, cost) triple read together; **q/1k-tok** and **q/hop** are the gaming-resistant numbers — a broadcaster\'s quality is divided by its bloated cost._');
  return lines.join('\n') + '\n';
}

export async function writePerfCard(outDir, report) {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'perfcard.json'), JSON.stringify(report, null, 2));
  await writeFile(join(outDir, 'perfcard.md'), renderMarkdown(report));
  return { json: join(outDir, 'perfcard.json'), md: join(outDir, 'perfcard.md') };
}

/**
 * 0 always, unless an explicit gate is set and the aggregate violates it.
 * gates: { minQuality, maxCostUsd, minPrecision } (any subset).
 */
export function exitCode(report, gates = {}) {
  const has = (v) => v !== undefined && v !== null;
  if (!has(gates.minQuality) && !has(gates.maxCostUsd) && !has(gates.minPrecision)) return 0;
  for (const s of report.scenarios) {
    const q = s.summary.judge_score?.p50;
    const cost = s.summary.cost_usd?.p50;
    const prec = s.summary.precision?.mean;
    if (has(gates.minQuality) && num(q) != null && q < Number(gates.minQuality)) return 1;
    if (has(gates.maxCostUsd) && num(cost) != null && cost > Number(gates.maxCostUsd)) return 1;
    if (has(gates.minPrecision) && num(prec) != null && prec < Number(gates.minPrecision)) return 1;
  }
  return 0;
}
