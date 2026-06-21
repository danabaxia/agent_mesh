// src/dashboard/public/health-view.js — the top-level "Health / Vital Signs" view.
// Passive mesh-health: per-agent liveness grid, activity-history sparklines, a
// cognitive vital-signs table, and a rendered human-readable health report.
// All data from GET /api/health (the pure health-model). Visual language = board2.css.
import { agentColor } from '/board2-model.js';
import { mdToHtml } from '/md-lite.js';

const SVG = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fmtBytes = (n) => { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : '' + n; };

function relTime(iso) {
  if (!iso) return '—';
  const d = Date.parse(iso); if (isNaN(d)) return '—';
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 60) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

// Liveness → visual class + glyph. dead/stuck = critical(red), failing/overdue = warn(amber).
const LIVENESS_META = {
  alive:   { cls: 'lv-ok',   dot: '●', label: 'alive' },
  idle:    { cls: 'lv-idle', dot: '○', label: 'idle' },
  overdue: { cls: 'lv-warn', dot: '◐', label: 'overdue' },
  failing: { cls: 'lv-warn', dot: '◑', label: 'failing' },
  stuck:   { cls: 'lv-crit', dot: '◼', label: 'stuck' },
  dead:    { cls: 'lv-crit', dot: '✖', label: 'dead' },
  unknown: { cls: 'lv-idle', dot: '?', label: 'unknown' },
};
const ORGAN_META = [
  ['agents', 'Agents'], ['jobs', 'Jobs & Daemon'], ['board', 'Task Board'],
  ['pipeline', 'Pipeline'], ['cognition', 'Cognition'],
];
const STATUS_CLS = { ok: 'hpill-ok', warn: 'hpill-warn', critical: 'hpill-err', unknown: 'hpill' };

// Inline-SVG sparkline (zero-dep) from an array of daily counts.
function sparkline(values, w = 120, h = 22) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.setAttribute('width', w); svg.setAttribute('height', h);
  svg.setAttribute('class', 'spark');
  const max = Math.max(1, ...values);
  const n = values.length || 1;
  const bw = w / n;
  values.forEach((v, i) => {
    const bh = Math.max(v > 0 ? 2 : 0, (v / max) * (h - 2));
    const rect = document.createElementNS(SVG, 'rect');
    rect.setAttribute('x', (i * bw + 0.5).toFixed(1));
    rect.setAttribute('y', (h - bh).toFixed(1));
    rect.setAttribute('width', Math.max(1, bw - 1).toFixed(1));
    rect.setAttribute('height', bh.toFixed(1));
    rect.setAttribute('class', v > 0 ? 'sb on' : 'sb');
    svg.appendChild(rect);
  });
  return svg;
}

const TEMPLATE = `
<div class="hv-head">
  <span class="logo">agent_mesh</span>
  <span class="bview"><span data-topview="board">▦ board</span><span data-topview="graph">✦ graph</span><span class="on" data-topview="health">✚ health</span></span>
  <span class="spacer" style="flex:1"></span>
  <span class="pill" id="hv-verdict">checking…</span>
  <span class="pill rfx" id="hv-refresh" style="cursor:pointer" title="re-read health">↻ refresh</span>
  <span class="pill upd" id="hv-updated"></span>
</div>
<div class="hv-organs" id="hv-organs"></div>
<div class="hv-lower">
  <section class="hsec"><div class="hhead"><span>♥ LIVENESS</span><span class="meta" id="hv-live-meta"></span></div><div class="hbody" id="hv-liveness"></div></section>
  <section class="hsec"><div class="hhead"><span>▦ ACTIVITY HISTORY</span><span class="meta" id="hv-hist-meta"></span></div><div class="hbody" id="hv-history"></div></section>
  <section class="hsec"><div class="hhead"><span>🧠 COGNITIVE VITAL SIGNS</span><span class="meta">prompt / memory / headroom</span></div><div class="hbody" id="hv-cognition"></div></section>
  <section class="hsec"><div class="hhead"><span>🩺 HEALTH REPORT</span></div><div class="hbody hv-report" id="hv-report"></div></section>
  <section class="hsec"><div class="hhead"><span>⌁ RECENT EVENTS</span><span class="meta" id="hv-events-meta"></span></div><div class="hbody" id="hv-events"></div></section>
</div>`;

let root = null, timer = null;

function renderOrgans(model) {
  const el = root.querySelector('#hv-organs');
  el.innerHTML = ORGAN_META.map(([key, label]) => {
    const o = model.organs?.[key] || { status: 'unknown' };
    let sub = '';
    if (key === 'agents') { const c = o.counts || {}; sub = `${c.alive || 0} alive · ${c.idle || 0} idle${c.dead ? ` · ${c.dead} dead` : ''}${c.stuck ? ` · ${c.stuck} stuck` : ''}`; }
    else if (key === 'jobs') sub = o.daemonAlive === false ? 'daemon stopped' : (o.daemonAlive ? 'daemon beating' : 'no daemon');
    else if (key === 'board') sub = `${(o.staleTasks || []).length} stuck`;
    else if (key === 'pipeline') sub = o.openIssues != null ? `${o.openIssues} issues · ${o.openPRs ?? 0} PRs` : 'no digest';
    else if (key === 'cognition') sub = `${(o.flagged || []).length} flagged`;
    return `<div class="organ ${o.status}"><div class="ohead"><span class="hpill ${STATUS_CLS[o.status] || 'hpill'}">${esc(o.status)}</span><b>${esc(label)}</b></div><div class="osub">${esc(sub)}</div></div>`;
  }).join('');
}

function renderLiveness(model) {
  const el = root.querySelector('#hv-liveness');
  const vitals = model.agentVitals || [];
  root.querySelector('#hv-live-meta').textContent = `${vitals.length} agent${vitals.length === 1 ? '' : 's'}`;
  if (!vitals.length) { el.innerHTML = '<div class="hv-empty">No agents in this mesh.</div>'; return; }
  // worst first
  const order = ['dead', 'stuck', 'failing', 'overdue', 'idle', 'unknown', 'alive'];
  const sorted = [...vitals].sort((a, b) => order.indexOf(a.liveness) - order.indexOf(b.liveness));
  el.innerHTML = `<div class="lvgrid">${sorted.map((v) => {
    const m = LIVENESS_META[v.liveness] || LIVENESS_META.unknown;
    return `<div class="lvcard ${m.cls}">
      <div class="lvtop"><span class="lvdot">${m.dot}</span><b class="an" style="color:${agentColor(v.name)}">${esc(v.name)}</b><span class="lvstate">${m.label}</span></div>
      <div class="lvmeta">seen ${esc(relTime(v.lastSeenAt))} · ${v.recentRuns || 0} runs${v.recentFailures ? ` · <span class="lvfail">${v.recentFailures} fail</span>` : ''}${v.expectedCadence ? ' · ⏱ scheduled' : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

function renderHistory(model) {
  const el = root.querySelector('#hv-history');
  const { days = [], perAgent = {} } = model.activityHistory || {};
  const names = Object.keys(perAgent);
  root.querySelector('#hv-hist-meta').textContent = days.length ? `last ${days.length}d` : '';
  if (!names.length) { el.innerHTML = '<div class="hv-empty">No activity history yet.</div>'; return; }
  el.innerHTML = '';
  const table = document.createElement('div'); table.className = 'histgrid';
  for (const name of names) {
    const row = document.createElement('div'); row.className = 'histrow';
    const label = document.createElement('b'); label.className = 'an'; label.style.color = agentColor(name); label.textContent = name;
    const total = (perAgent[name] || []).reduce((a, b) => a + b, 0);
    const cnt = document.createElement('span'); cnt.className = 'histtot'; cnt.textContent = `${total} runs`;
    row.appendChild(label); row.appendChild(sparkline(perAgent[name] || [])); row.appendChild(cnt);
    table.appendChild(row);
  }
  el.appendChild(table);
}

function renderCognition(model) {
  const el = root.querySelector('#hv-cognition');
  const vitals = model.agentVitals || [];
  if (!vitals.length) { el.innerHTML = '<div class="hv-empty">No agents.</div>'; return; }
  const rows = vitals.map((v) => {
    const c = v.cognition || {};
    const flag = (f, lbl) => c.flags?.includes(f) ? `<span class="cflag">${lbl}</span>` : '';
    const headroom = c.headroomPct != null ? `${c.headroomPct}%` : '—';
    const mem = `${fmtBytes(c.memoryShortBytes)} / ${fmtBytes(c.memoryLongBytes)}${c.memorySeparation ? '' : ' ⚠'}`;
    return `<tr>
      <td><b class="an" style="color:${agentColor(v.name)}">${esc(v.name)}</b></td>
      <td class="num">${fmtBytes(c.promptBytes)}${flag('prompt_oversize', 'big')}</td>
      <td class="num">${esc(mem)}${flag('no_memory_separation', 'no-split')}</td>
      <td class="num">${esc(headroom)}${flag('low_headroom', 'low')}</td>
    </tr>`;
  }).join('');
  el.innerHTML = `<table class="ctbl"><thead><tr><th>agent</th><th>prompt</th><th>memory short/long</th><th>headroom</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderReport(model) {
  const el = root.querySelector('#hv-report');
  const md = model.report?.markdown || '';
  el.innerHTML = md ? mdToHtml(md) : '<div class="hv-empty">No report.</div>';
}

function renderEvents(model) {
  const el = root.querySelector('#hv-events');
  const events = model.activityHistory?.events || [];
  root.querySelector('#hv-events-meta').textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;
  if (!events.length) { el.innerHTML = '<div class="hv-empty">No recent events.</div>'; return; }
  const lvl = (l) => `<span class="act-lvl act-lvl-${l === 'error' ? 'error' : l === 'warn' ? 'warn' : 'info'}">${esc(l || 'info')}</span>`;
  el.innerHTML = `<table class="etbl"><tbody>${events.slice(0, 60).map((e) => `<tr>
    <td class="age">${esc(relTime(e.ts))}</td>
    <td>${e.agent ? `<b class="an" style="color:${agentColor(e.agent)}">${esc(e.agent)}</b>` : '<span class="dim">mesh</span>'}</td>
    <td><span class="act-type">${esc(e.type || '')}</span></td>
    <td>${lvl(e.level)}</td>
    <td class="title">${esc(e.summary || '')}</td>
  </tr>`).join('')}</tbody></table>`;
}

function applyVerdict(model) {
  const v = root.querySelector('#hv-verdict');
  const map = {
    nominal: ['hpill-ok', '● All systems nominal'],
    warn: ['hpill-warn', '▲ Attention needed'],
    critical: ['hpill-err', '✖ CRITICAL — dead mechanism'],
    unknown: ['hpill', '… unknown'],
  };
  const [cls, txt] = map[model.overall] || map.unknown;
  v.className = `pill hpill ${cls}`;
  v.textContent = txt;
  root.querySelector('#hv-updated').textContent = model.generatedAt ? new Date(model.generatedAt).toLocaleTimeString() : '';
}

async function load() {
  let model;
  try {
    model = await (await fetch('/api/health', { credentials: 'same-origin' })).json();
  } catch {
    root.querySelector('#hv-verdict').textContent = 'unavailable';
    return;
  }
  applyVerdict(model);
  renderOrgans(model);
  renderLiveness(model);
  renderHistory(model);
  renderCognition(model);
  renderReport(model);
  renderEvents(model);
}

export function renderHealthView(container) {
  root = container;
  container.innerHTML = TEMPLATE;
  container.querySelector('#hv-refresh').addEventListener('click', load);
  load();
  if (timer) clearInterval(timer);
  timer = setInterval(load, 30_000);   // passive re-read; cheap (no spawns)
}

export function stopHealthView() {
  if (timer) { clearInterval(timer); timer = null; }
}
