// src/dashboard/public/daily-tab.js — workspace Daily tab (P3). Mesh-wide
// PR/Issue/Token digest. Reads the cached report model from GET /api/daily
// (written by scripts/daily-report.mjs each run) — never shells gh on load.
// `{ available:false }` → an empty state pointing at how to generate one.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const fmt = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(v);
};
const usd = (n) => '$' + (Number(n) || 0).toFixed(2);

function tokenRows(t) {
  if (!t) return '';
  const unc = t.ci && t.ci.uncaptured ? `, ${t.ci.uncaptured} uncaptured` : '';
  const row = (label, u, cost, runs) =>
    `<tr><td>${label}</td><td>${fmt(u.input)}</td><td>${fmt(u.output)}</td><td>${u.turns ?? 0}</td><td>${cost}</td></tr>`;
  return (
    row('local', t.local || {}, `${usd((t.local || {}).costUsd)} (${(t.local || {}).runs ?? 0} runs)`) +
    row('ci', t.ci || {}, `$0* (${(t.ci || {}).runs ?? 0} runs${unc})`) +
    row('total', t.total || {}, '')
  );
}

function prList(prs) {
  const items = (prs && prs.opened ? prs.opened : []).slice(0, 12);
  if (!items.length) return '';
  return '<ul class="daily-prs">' + items.map((p) =>
    `<li>#${esc(p.number)} ${esc(p.title || '')}</li>`).join('') + '</ul>';
}

function labelChips(byLabel) {
  const entries = Object.entries(byLabel || {});
  if (!entries.length) return '—';
  return entries.map(([k, v]) => `${esc(k)} ${esc(v)}`).join(', ');
}

export async function renderDailyTab(body) {
  body.innerHTML = '<div class="wstab-pad"><div class="loading">Loading…</div></div>';
  let data;
  try {
    const r = await fetch('/api/daily');
    if (!r.ok) throw new Error(String(r.status));
    data = await r.json();
  } catch (e) {
    body.innerHTML = `<div class="wstab-pad"><p class="stub">Daily report failed to load (${esc(e.message)}).</p></div>`;
    return;
  }

  if (!data.available) {
    body.innerHTML =
      '<div class="wstab-pad"><h3>Daily Mesh Report</h3>' +
      '<p class="stub">No report generated yet. Run <code>node scripts/daily-report.mjs --post</code> ' +
      '(or install the schedule with <code>scripts/dev-society-install.sh install-report</code>) to populate this view.</p></div>';
    return;
  }

  const r = data.report || {};
  const prs = r.prs || {};
  const issues = r.issues || {};
  const gen = r.generatedAt ? new Date(r.generatedAt).toLocaleString() : '—';

  body.innerHTML =
    '<div class="wstab-pad">' +
    `<h3>📊 Daily Mesh Report — ${esc(r.date || '')}</h3>` +
    `<p><strong>PRs</strong> · opened ${prs.opened ? prs.opened.length : 0} · ` +
    `merged ${prs.merged ? prs.merged.length : 0} · closed ${prs.closed ? prs.closed.length : 0} · ` +
    `open now ${prs.openNow ?? 0}</p>` +
    prList(prs) +
    `<p><strong>Issues</strong> · opened ${issues.opened ? issues.opened.length : 0} · ` +
    `closed ${issues.closed ? issues.closed.length : 0} · open: ${labelChips(issues.openByLabel)}</p>` +
    '<p><strong>Tokens</strong></p>' +
    '<table class="daily-tokens"><thead><tr><th>stream</th><th>input</th><th>output</th><th>turns</th><th>cost</th></tr></thead>' +
    `<tbody>${tokenRows(r.tokens)}</tbody></table>` +
    '<p class="stub">*subscription auth reports $0 · generated ' + esc(gen) + '</p>' +
    '</div>';
}
