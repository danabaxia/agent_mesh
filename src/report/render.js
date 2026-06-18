// src/report/render.js
// Pure renderers for a DailyReport. renderMarkdown → the GitHub issue comment
// body (carries a date marker for idempotent upsert); renderModel → a plain
// object for the (future) dashboard route.

export function dailyMarker(date) { return `<!-- daily-report:${date} -->`; }

export function findDatedCommentId(comments, date) {
  const marker = dailyMarker(date);
  const hit = (comments || []).find((c) => typeof c.body === 'string' && c.body.includes(marker));
  return hit ? hit.id : null;
}

const fmt = (n) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(n);
};
const usd = (n) => `$${n.toFixed(2)}`;
const prLine = (p) => `  #${p.number} ${p.title}`;

export function renderMarkdown(r) {
  const t = r.tokens;
  const lines = [];
  lines.push(dailyMarker(r.date));
  lines.push(`### 📊 Daily Mesh Report — ${r.date}`);
  lines.push('');
  lines.push(`**PRs** · opened ${r.prs.opened.length} · merged ${r.prs.merged.length} · closed ${r.prs.closed.length} · open now ${r.prs.openNow}`);
  for (const p of r.prs.opened.slice(0, 10)) lines.push(prLine(p));
  lines.push('');
  const labels = Object.entries(r.issues.openByLabel).map(([k, v]) => `${k} ${v}`).join(', ') || '—';
  lines.push(`**Issues** · opened ${r.issues.opened.length} · closed ${r.issues.closed.length} · open: ${labels}`);
  lines.push('');
  lines.push('**Tokens**');
  lines.push('| stream | input | output | turns | cost |');
  lines.push('|---|---|---|---|---|');
  lines.push(`| local | ${fmt(t.local.input)} | ${fmt(t.local.output)} | ${t.local.turns} | ${usd(t.local.costUsd)} (${t.local.runs} runs) |`);
  const unc = t.ci.uncaptured ? `, ${t.ci.uncaptured} uncaptured` : '';
  lines.push(`| ci | ${fmt(t.ci.input)} | ${fmt(t.ci.output)} | ${t.ci.turns} | $0* (${t.ci.runs} runs${unc}) |`);
  lines.push(`| total | ${fmt(t.total.input)} | ${fmt(t.total.output)} | ${t.total.turns} | |`);
  lines.push('');
  lines.push('_*subscription auth reports $0_');
  return lines.join('\n');
}

export function renderModel(r) { return JSON.parse(JSON.stringify(r)); }
