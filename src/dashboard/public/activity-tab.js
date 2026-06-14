// src/dashboard/public/activity-tab.js — workspace Activity tab (spec §3.2).
// Statistical work report: range chips (today/week/month), 7 KPI tiles,
// tool-usage bars, a newest-first work log, and a pure client-side
// ⤓ Export work report (markdown Blob download). Data comes from
// GET /api/agent/:name/activity-stats?range= (reducer contract in
// src/dashboard/activity-stats.js — kpis, toolUsage, worklog,
// sessionsAvailable, toolUsageTruncated, from, to).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const RANGES = [
  { key: 'today', label: () => 'Today · ' + new Date().toLocaleDateString([], { month: 'short', day: 'numeric' }) },
  { key: 'week', label: () => 'This week' },
  { key: 'month', label: () => 'This month' }
];

const TOOL_BAR_CAP = 12;

// status → flag span (✓ green / ✗ amber via existing .ok/.warn classes)
const STATUS_FLAG = {
  ok: '<span class="ok">✓</span>',
  fail: '<span class="warn">✗</span>',
  running: '<span>▶</span>',
  saved: '<span>💾</span>'
};

// channel → tag class/style: a2a amber-ish (.warn), session teal (.ok),
// artifact-save grey, delegate default — existing palette only.
function channelTag(channel) {
  if (channel === 'a2a-out' || channel === 'a2a-served') return `<span class="warn">${esc(channel)}</span>`;
  if (channel === 'session') return `<span class="ok">${esc(channel)}</span>`;
  if (channel === 'artifact-save') return `<span style="color:var(--ink2)">${esc(channel)}</span>`;
  return `<span>${esc(channel)}</span>`;
}

function humanMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  return `${(s / 60).toFixed(1)}m`;
}

export async function renderActivityTab(body, agent, mesh) {
  let range = 'today';
  let stats = null;

  function rangeRowHtml() {
    const chips = RANGES.map((r) =>
      `<span data-range="${r.key}"${r.key === range ? ' class="on"' : ''}>${esc(r.label())}</span>`).join('');
    return `<div class="arange">${chips}<button class="export">⤓ Export work report</button></div>`;
  }

  function kpiTile(value, label, { sub, title } = {}) {
    const t = title ? ` title="${esc(title)}"` : '';
    const subHtml = sub ? ` <span class="sub">${esc(sub)}</span>` : '';
    return `<div class="kpi"${t}><b>${esc(value)}${subHtml}</b><div class="kl">${esc(label)}</div></div>`;
  }

  function kpisHtml(s) {
    const k = s.kpis;
    return '<div class="kpis">' +
      kpiTile(k.served, 'SERVED') +
      kpiTile(k.a2aOut.total, 'A2A OUT', { sub: `✓${k.a2aOut.ok} ✗${k.a2aOut.fail}` }) +
      kpiTile(k.turns ?? '—', 'TURNS', k.turns == null ? { title: 'needs --allow-shell' } : {}) +
      kpiTile(k.toolCalls ?? '—', 'TOOL CALLS', k.toolCalls == null ? { title: 'needs --allow-shell' } : {}) +
      kpiTile(k.artifactsSaved, 'ARTIFACTS SAVED') +
      kpiTile(humanMs(k.avgRunMs), 'AVG RUN') +
      kpiTile('—', 'SCHEDULED RUNS', { title: 'Phase 5' }) +
      '</div>';
  }

  function toolUsageHtml(s) {
    const list = (s.toolUsage || []).slice(0, TOOL_BAR_CAP);
    if (!list.length) {
      const msg = s.sessionsAvailable ? 'no tool calls in range' : 'not available without --allow-shell';
      return `<p class="stub">${msg}</p>`;
    }
    const max = Math.max(...list.map((t) => Number(t.count) || 0), 1);
    const bars = list.map((t) => {
      const count = Number(t.count) || 0;
      const w = Math.max(2, Math.round(count / max * 100));
      // long MCP tool names: keep the 92px label single-line, ellipsized (full name in title)
      return `<div class="bar"><span class="bn" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.name)}">${esc(t.name)}</span>` +
        `<div class="bt" style="width:${w}%"></div><span class="bv">${count}</span></div>`;
    }).join('');
    const note = s.toolUsageTruncated ? '<p class="stub" style="font-size:11px;margin-top:6px">(truncated)</p>' : '';
    return bars + note;
  }

  function wlTime(w) {
    if (!w.at) return '—';
    const opts = { hour: 'numeric', minute: '2-digit' };
    const d = new Date(w.at);
    let t = d.toLocaleTimeString([], opts);
    if (w.end) t += '–' + new Date(w.end).toLocaleTimeString([], opts);
    if (d.toDateString() !== new Date().toDateString()) {
      t = d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
    }
    return t;
  }

  function worklogHtml(s) {
    const rows = (s.worklog || []).map((w) =>
      `<div class="wl"><div class="wt">${esc(wlTime(w))} · ${channelTag(w.channel)} ` +
      `${STATUS_FLAG[w.status] || esc(w.status ?? '')}</div>${esc(w.summary || '')}</div>`
    ).join('');
    return rows || '<p class="stub">no activity in range</p>';
  }

  function wire() {
    for (const chip of body.querySelectorAll('.arange [data-range]')) {
      chip.addEventListener('click', () => {
        if (chip.dataset.range === range) return;
        range = chip.dataset.range;
        load();
      });
    }
    const btn = body.querySelector('.arange .export');
    if (btn) btn.addEventListener('click', () => { if (stats) exportReport(stats); });
  }

  async function load() {
    body.innerHTML = '<div class="wstab-pad"><div class="loading">Loading…</div></div>';
    const r = await fetch(`/api/agent/${encodeURIComponent(agent)}/activity-stats?range=${encodeURIComponent(range)}`);
    if (!r.ok) {
      stats = null;
      body.innerHTML = `<div class="wstab-pad">${rangeRowHtml()}<p class="stub">activity stats failed (${r.status})</p></div>`;
      wire();
      return;
    }
    stats = await r.json();
    body.innerHTML =
      `<div class="wstab-pad">${rangeRowHtml()}${kpisHtml(stats)}` +
      `<div class="acols">` +
      `<div class="ablock"><h4>TOOL USAGE</h4>${toolUsageHtml(stats)}</div>` +
      `<div class="ablock"><h4>WORK LOG — newest first</h4><div class="wlog">${worklogHtml(stats)}</div></div>` +
      `</div></div>`;
    wire();
  }

  // --- export: markdown report, pure client-side Blob download --------------
  function exportReport(s) {
    const k = s.kpis;
    const lines = [
      `# ${agent} — work report (${s.range})`,
      '',
      `_${s.from} → ${s.to}_`,
      '',
      '## KPIs',
      '',
      '| Metric | Value |',
      '|---|---|',
      `| Served | ${k.served} |`,
      `| A2A out | ${k.a2aOut.total} (✓${k.a2aOut.ok} ✗${k.a2aOut.fail}) |`,
      `| Turns | ${k.turns ?? '—'} |`,
      `| Tool calls | ${k.toolCalls ?? '—'} |`,
      `| Artifacts saved | ${k.artifactsSaved} |`,
      `| Avg run | ${humanMs(k.avgRunMs)} |`,
      '| Scheduled runs | — |',
      '',
      '## Tool usage',
      ''
    ];
    if ((s.toolUsage || []).length) {
      for (const t of s.toolUsage) lines.push(`- ${t.name}: ${t.count}`);
      if (s.toolUsageTruncated) lines.push('- _(truncated)_');
    } else {
      lines.push(s.sessionsAvailable ? '_no tool calls in range_' : '_not available without --allow-shell_');
    }
    lines.push('', '## Work log', '');
    if ((s.worklog || []).length) {
      for (const w of s.worklog) lines.push(`- ${w.at ?? '—'} [${w.channel}] ${w.status}: ${w.summary || ''}`);
    } else {
      lines.push('_no activity in range_');
    }
    const md = lines.join('\n') + '\n';
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${agent}-work-report-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  await load();
}
