// src/report/aggregate.js
// Pure reducer: raw record sets → DailyReport. No I/O, no Date.now() —
// `date` (YYYY-MM-DD) fixes the UTC window; the impure entrypoint picks it.
import { extractUsage, sumUsage } from './usage.js';

export function dayBoundsMs(date) {
  const fromMs = Date.parse(`${date}T00:00:00.000Z`);
  return { fromMs, toMs: fromMs + 24 * 60 * 60 * 1000 };
}

const inWin = (iso, fromMs, toMs) => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= fromMs && t < toMs;
};

function rollup(records, keyOf, tsOf, fromMs, toMs) {
  const byKey = {};
  const all = [];
  let runs = 0;
  for (const rec of records) {
    if (!inWin(tsOf(rec), fromMs, toMs)) continue;
    runs++;
    const u = extractUsage(rec.usage ?? rec);
    all.push(u);
    const k = keyOf(rec) || 'unknown';
    byKey[k] = byKey[k] ? sumUsage([byKey[k], u]) : u;
  }
  return { ...sumUsage(all), runs, byKey };
}

export function aggregate({ date, prs = [], openPrs = [], issues = [], openIssues = [], localRecords = [], ciRecords = [] }) {
  const { fromMs, toMs } = dayBoundsMs(date);
  const slimPr = (p) => ({ number: p.number, title: p.title, author: p.author, url: p.url });
  const slimIssue = (i) => ({ number: i.number, title: i.title, labels: i.labels || [], url: i.url });

  const openByLabel = {};
  for (const i of openIssues) for (const l of (i.labels || [])) openByLabel[l] = (openByLabel[l] || 0) + 1;

  const local = rollup(localRecords, (r) => r.route, (r) => r.finished_at || r.started_at, fromMs, toMs);
  const ci = rollup(ciRecords, (r) => r.workflow, (r) => r.ts, fromMs, toMs);
  ci.costUsd = 0;  // subscription auth reports $0; never claim CI dollars
  ci.uncaptured = ciRecords.filter((r) => inWin(r.ts, fromMs, toMs) && r.uncaptured).length;

  const reshape = (g) => { const { byKey, ...rest } = g; return rest; };
  const total = sumUsage([reshape(local), reshape(ci)]);

  return {
    date,
    window: { fromISO: new Date(fromMs).toISOString(), toISO: new Date(toMs).toISOString() },
    prs: {
      opened: prs.filter((p) => inWin(p.createdAt, fromMs, toMs)).map(slimPr),
      merged: prs.filter((p) => inWin(p.mergedAt, fromMs, toMs)).map(slimPr),
      closed: prs.filter((p) => !p.mergedAt && inWin(p.closedAt, fromMs, toMs)).map(slimPr),
      openNow: openPrs.length,
    },
    issues: {
      opened: issues.filter((i) => inWin(i.createdAt, fromMs, toMs)).map(slimIssue),
      closed: issues.filter((i) => inWin(i.closedAt, fromMs, toMs)).map(slimIssue),
      openByLabel,
      openNow: openIssues.length,
    },
    tokens: {
      local: { ...reshape(local), byRoute: local.byKey },
      ci: { ...reshape(ci), byWorkflow: ci.byKey },
      total: reshape(total),
    },
  };
}
