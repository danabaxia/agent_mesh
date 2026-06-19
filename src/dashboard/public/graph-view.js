// src/dashboard/public/graph-view.js — the top-level "Graph" view.
// Live mesh activity (constellation + event ticker) from /api/activity + the
// /api/events SSE, token consumption per range from /api/tokens, and the
// issues/PRs progress table from /api/daily. Visual language = board2.css.
import { agentColor } from '/board2-model.js';

const SVG = 'http://www.w3.org/2000/svg';
const mk = (t, a = {}) => { const e = document.createElementNS(SVG, t); for (const k in a) e.setAttribute(k, a[k]); return e; };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fmt = (n) => { n = +n || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : '' + Math.round(n); };
const tagName = (n) => `<b class="an" style="color:${agentColor(n)}">${esc(n)}</b>`;
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toTimeString().slice(0, 8); };

let started = false, es = null, root = null, range = 'today';
let agents = [], byName = {}, nodeEls = {}, peerEls = [], field = null, gArc = null;
let cx = 410, cy = 230, R = 158;
const seen = new Set();
let tip, clockTimer;

const TEMPLATE = `
<div class="gv-head">
  <span class="logo">agent_mesh</span>
  <span class="bview"><span data-topview="board">▦ board</span><span class="on" data-topview="graph">✦ graph</span></span>
  <span class="spacer" style="flex:1"></span>
  <span class="pill alive">● <b id="gv-live">live</b> · mesh</span>
  <span class="pill clock" id="gv-clock">--:--:--</span>
</div>
<div class="mesh-kpis">
  <div class="mkpi"><b id="gv-k-pr">—</b><div class="kl">PRs today</div><div class="sub" id="gv-k-prs">—</div></div>
  <div class="mkpi"><b id="gv-k-iss">—</b><div class="kl">Issues open / closed</div><div class="sub" id="gv-k-isss">—</div></div>
  <div class="mkpi"><b id="gv-k-a2a">—</b><div class="kl">A2A delegations today</div><div class="sub" id="gv-k-a2as">—</div></div>
  <div class="mkpi am"><b id="gv-k-tok">—</b><div class="kl">Tokens today</div><div class="sub" id="gv-k-toks">—</div></div>
</div>
<div class="lower">
  <div class="sec band" id="sec-tok">
    <div class="shead" data-fold>
      <span class="caret">▾</span><span>▦ TOKEN CONSUMPTION</span>
      <span class="ranges" id="gv-ranges"><span class="on" data-r="today">today</span><span data-r="week">this week</span><span data-r="month">this month</span></span>
      <span class="maxbtn" data-max title="full size">⤢</span>
    </div>
    <div class="secbody tokbody">
      <div class="tk tk-tot"><span class="lab">total tokens</span><span class="big" id="tk-big">—</span><span class="sub" id="tk-sub">—</span>
        <div class="kv"><div><b id="tk-in">—</b><small>INPUT</small></div><div><b id="tk-out">—</b><small>OUTPUT</small></div><div><b id="tk-turns">—</b><small>TURNS</small></div><div><b id="tk-runs">—</b><small>RUNS</small></div></div></div>
      <div class="tk split"><span class="lab">local vs ci</span>
        <div class="splitbar"><div class="lo" id="sp-lo"></div><div class="ci" id="sp-ci"></div></div>
        <div class="splitleg"><span><span class="d" style="background:var(--busy)"></span>local <b id="sp-lov">—</b> <span class="am" id="sp-cost">$—</span></span><span><span class="d" style="background:var(--teal2)"></span>ci <b id="sp-civ">—</b> $0*</span></div>
        <div class="splitleg" style="margin-top:4px;color:var(--idle)"><span>local = host daemon (real $)</span><span>ci = github-actions</span></div></div>
      <div class="tk top"><span class="lab">top consumers</span><div id="tk-top"></div></div>
      <div class="tk trend"><span class="lab" id="tk-trend-lab">trend</span><div class="tbars" id="tk-trend"></div><div class="tl" id="tk-trend-l"></div></div>
    </div>
  </div>
  <div class="sec" id="sec-graph">
    <div class="shead" data-fold><span class="caret">▾</span><span>◉ LIVE DELEGATION GRAPH</span><span class="live-ind">● live</span><span class="meta" id="gv-agc">—</span><span class="maxbtn" data-max title="full size">⤢</span></div>
    <div class="secbody"><div class="split2">
      <svg id="gv-field"></svg>
      <div class="ev-col"><div class="col-h">⇄ LIVE EVENTS</div><div class="gv-events" id="gv-log"></div></div>
    </div></div>
  </div>
  <div class="sec" id="sec-issues">
    <div class="shead" data-fold><span class="caret">▾</span><span>▤ ISSUES &amp; PRS · PROGRESS</span><span class="meta">idea→spec→approved→in-progress→review→done</span><span class="maxbtn" data-max title="full size">⤢</span></div>
    <div class="secbody"><div class="tscroll" id="gv-issues"></div></div>
  </div>
  <div class="sec" id="sec-sched">
    <div class="shead" data-fold><span class="caret">▾</span><span>⏱ SCHEDULES</span><span class="meta" id="gv-sched-owner">—</span><span class="maxbtn" data-max title="full size">⤢</span></div>
    <div class="secbody"><div class="tscroll" id="gv-sched"></div></div>
  </div>
  <div class="sec" id="sec-health">
    <div class="shead" data-fold><span class="caret">▾</span><span>♥ HEALTH</span><span class="meta" id="gv-health-pill">—</span><span class="maxbtn" data-max title="full size">⤢</span></div>
    <div class="secbody"><div class="tscroll" id="gv-health"></div></div>
  </div>
  <div class="sec" id="sec-activity">
    <div class="shead" data-fold><span class="caret">▾</span><span>📋 ACTIVITY LOG</span><span class="meta" id="gv-activity-meta">—</span><span class="maxbtn" data-max title="full size">⤢</span></div>
    <div class="secbody"><div class="tscroll" id="gv-activity-log"></div></div>
  </div>
</div>`;

export function renderGraphView(rootEl) {
  root = rootEl;
  if (!started) { build(); started = true; }
  loadAll();
}

function build() {
  root.innerHTML = TEMPLATE;
  tip = document.querySelector('.gv-tip') || document.body.appendChild(Object.assign(document.createElement('div'), { className: 'gv-tip' }));
  // fold (ignore range chips + max button)
  root.querySelectorAll('[data-fold]').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('.ranges') || e.target.closest('.maxbtn')) return;
    h.closest('.sec').classList.toggle('folded');
  }));
  // maximize
  root.querySelectorAll('[data-max]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const sec = b.closest('.sec'), lower = sec.closest('.lower'), willMax = !sec.classList.contains('max');
    lower.querySelectorAll('.sec').forEach((s) => s.classList.remove('max'));
    lower.querySelectorAll('.maxbtn').forEach((x) => { x.textContent = '⤢'; x.title = 'full size'; });
    sec.classList.toggle('max', willMax); lower.classList.toggle('has-max', willMax);
    if (willMax) { sec.classList.remove('folded'); b.textContent = '⤡'; b.title = 'restore'; }
  }));
  // ranges
  root.querySelector('#gv-ranges').addEventListener('click', (e) => {
    const s = e.target.closest('[data-r]'); if (!s) return;
    root.querySelectorAll('#gv-ranges span').forEach((x) => x.classList.toggle('on', x === s));
    range = s.dataset.r; loadTokens();
  });
  // chart hover
  const trendEl = root.querySelector('#tk-trend'), topEl = root.querySelector('#tk-top');
  trendEl.addEventListener('mousemove', (e) => { const b = e.target.closest('.tb'); if (!b) return hideTip(); showTip(`${b.dataset.l} · <span class="v">${b.dataset.v}</span> tokens`, e.clientX, e.clientY); });
  trendEl.addEventListener('mouseleave', hideTip);
  topEl.addEventListener('mousemove', (e) => { const r = e.target.closest('.crow'); if (!r) return hideTip(); showTip(`<span style="color:${r.dataset.c}">${esc(r.dataset.n)}</span> · <span class="v">${r.dataset.v}</span> · ${r.dataset.p}%`, e.clientX, e.clientY); });
  topEl.addEventListener('mouseleave', hideTip);
}

const showTip = (html, x, y) => { tip.innerHTML = html; tip.style.display = 'block'; const w = tip.offsetWidth; tip.style.left = Math.min(x + 14, innerWidth - w - 8) + 'px'; tip.style.top = (y + 14) + 'px'; };
const hideTip = () => { tip.style.display = 'none'; };

function loadAll() {
  if (!clockTimer) { const c = root.querySelector('#gv-clock'); clockTimer = setInterval(() => { c.textContent = new Date().toTimeString().slice(0, 8); }, 250); }
  ensureGraph().then(loadActivity);
  loadTokens();
  loadDaily();
  loadSchedules();
  loadHealth();
  loadActivityLog();
  if (!es) {
    try { es = new EventSource('/api/events'); es.addEventListener('activity', () => loadActivity()); es.onerror = () => {}; } catch { /* no SSE */ }
  }
}

// ── constellation ──
async function ensureGraph() {
  if (agents.length) return;
  field = root.querySelector('#gv-field');
  let names = [], pairs = [];
  try {
    const m = await (await fetch('/api/mesh')).json();
    names = (m.agents || []).map((a) => a.name).filter(Boolean);
    for (const a of m.agents || []) for (const p of a.peers || []) if (a.name && names.includes(p)) pairs.push([a.name, p]);
  } catch { /* empty */ }
  if (!names.length) names = ['mesh'];
  agents = names.map((n) => ({ name: n, c: agentColor(n) }));
  byName = Object.fromEntries(agents.map((a) => [a.name, a]));
  const gPeer = mk('g'), ga = mk('g'), gNode = mk('g'); field.append(gPeer, ga, gNode); gArc = ga;
  peerEls = pairs.map(([u, v]) => ({ u, v, el: gPeer.appendChild(mk('path', { class: 'peer' })) }));
  nodeEls = {};
  for (const a of agents) {
    const g = mk('g', { class: 'node' });
    g.append(mk('circle', { class: 'halo', r: 17 }), mk('circle', { class: 'nbody', r: 15, stroke: a.c }), mk('circle', { r: 11, fill: a.c }));
    const ini = mk('text', { class: 'ini' }); ini.textContent = (a.name[0] || '?').toUpperCase();
    const nm = mk('text', { class: 'nm2', y: 32 }); nm.textContent = a.name;
    const rt = mk('text', { class: 'rtx', y: 44 });
    g.append(ini, nm, rt); gNode.appendChild(g); nodeEls[a.name] = { g, rt, el: g };
    g.addEventListener('mousemove', (e) => { const route = nodeEls[a.name].rt.textContent; showTip(`<span style="color:${a.c}">${esc(a.name)}</span> · ${route ? `<span class="am">${esc(route)}</span> · working` : 'idle'}`, e.clientX, e.clientY); });
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', () => { if (window.__openAgent) window.__openAgent(a.name); });
  }
  layout(); new ResizeObserver(layout).observe(field);
}

function curve(a, b) { const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = mx - cx, dy = my - cy, d = Math.hypot(dx, dy) || 1; return `M${a.x},${a.y} Q${mx + dx / d * 26},${my + dy / d * 26} ${b.x},${b.y}`; }
function layout() {
  if (!field) return;
  const w = Math.max(320, field.clientWidth || 820), h = Math.max(220, field.clientHeight || 460);
  field.setAttribute('viewBox', `0 0 ${w} ${h}`); cx = w / 2; cy = h / 2; R = Math.max(70, Math.min(w, h) / 2 - 66);
  agents.forEach((a, i) => { const ang = -Math.PI / 2 + i * 2 * Math.PI / agents.length; a.x = cx + R * Math.cos(ang); a.y = cy + R * Math.sin(ang); nodeEls[a.name].el.setAttribute('transform', `translate(${a.x},${a.y})`); });
  for (const p of peerEls) if (byName[p.u] && byName[p.v]) p.el.setAttribute('d', curve(byName[p.u], byName[p.v]));
}

function travel(a, b) {
  if (!byName[a] || !byName[b]) return;
  const path = mk('path', { d: curve(byName[a], byName[b]), class: 'arc' }); gArc.appendChild(path);
  const dot = mk('circle', { class: 'gpulse', r: 3.4 }); gArc.appendChild(dot);
  const len = path.getTotalLength(), t0 = performance.now(), dur = 1150;
  (function step(t) { const k = Math.min(1, (t - t0) / dur), e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2, p = path.getPointAtLength(e * len); dot.setAttribute('cx', p.x); dot.setAttribute('cy', p.y); if (k < 1) requestAnimationFrame(step); else { dot.remove(); path.remove(); } })(t0);
}

async function loadActivity() {
  let act; try { act = await (await fetch('/api/activity')).json(); } catch { return; }
  const working = new Set((act.agents || []).filter((a) => a.state === 'working').map((a) => a.name));
  for (const a of agents) {
    const w = working.has(a.name); nodeEls[a.name].g.classList.toggle('work', w);
    const live = (act.agents || []).find((x) => x.name === a.name);
    nodeEls[a.name].rt.textContent = w && live ? (live.route || '') : '';
  }
  for (const e of (act.edges || [])) if (e.active) travel(e.from, e.to);
  // events ticker: prepend only unseen
  const log = root.querySelector('#gv-log');
  const evs = (act.events || []).slice().sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0)); // asc → prepend makes newest top
  for (const e of evs) {
    const key = `${e.kind}|${e.at}|${e.agent || e.from || ''}|${e.to || ''}`;
    if (seen.has(key)) continue; seen.add(key);
    const r = evRow(e); if (!r) continue;
    const row = document.createElement('div'); row.className = 'gv-ev fresh';
    row.innerHTML = `<span class="et">${fmtTime(e.at)}</span><span class="ek ${r[1]}">${r[0]}</span><span class="ex">${r[2]}</span>`;
    log.prepend(row); setTimeout(() => row.classList.remove('fresh'), 1200);
    while (log.children.length > 50) log.lastChild.remove();
  }
  const a2aToday = (act.events || []).filter((e) => e.kind === 'a2a').length;
  setText('gv-k-a2a', a2aToday); setText('gv-k-a2as', `${agents.length} agents · ${working.size} working`);
  setText('gv-agc', `${agents.length} agents · ${working.size} working`);
}

function evRow(e) {
  if (e.kind === 'a2a') return ['A2A', 'a2a', `${tagName(e.from)} <span style="color:#5d7a73">→</span> ${tagName(e.to)} <span style="color:#5d7a73">· ${esc(e.mode || '?')}</span>${e.status ? ` <span style="color:#5d7a73">· ${esc(e.status)}</span>` : ''}`];
  if (e.kind === 'start') return ['RUN', 'run', `${tagName(e.agent)} · ${esc(e.route || '')}`];
  if (e.kind === 'done') return ['OK', 'ok', `${tagName(e.agent)} · ${esc(e.route || '')}`];
  return null;
}

// ── token panel ──
async function loadTokens() {
  let m; try { m = (await (await fetch(`/api/tokens?range=${range}`)).json()).model; } catch { return; }
  const total = m.total || 0, local = m.local || 0, ci = m.ci || 0;
  setText('tk-big', fmt(total));
  root.querySelector('#tk-sub').innerHTML = `<span class="am">$${(m.cost || 0).toFixed(2)}</span> spend · ${m.runs || 0} runs · ${m.days || 0}d`;
  setText('tk-in', fmt(m.input)); setText('tk-out', fmt(m.output)); setText('tk-turns', m.turns || 0); setText('tk-runs', m.runs || 0);
  const hasSplit = local + ci > 0;            // empty bar when there's no usage (don't imply 100% CI)
  const loPct = hasSplit ? local / (local + ci) * 100 : 0;
  root.querySelector('#sp-lo').style.width = loPct + '%'; root.querySelector('#sp-ci').style.width = (hasSplit ? 100 - loPct : 0) + '%';
  setText('sp-lov', fmt(local)); setText('sp-civ', fmt(ci)); setText('sp-cost', '$' + (m.cost || 0).toFixed(2));
  // Only show consumers that actually used tokens; guard cmax against div-by-zero.
  const cons = (m.byConsumer || []).filter((c) => (c.tokens || 0) > 0).slice(0, 8);
  const cmax = Math.max(1, cons[0] ? cons[0].tokens : 1);
  root.querySelector('#tk-top').innerHTML = cons.length ? cons.map((c) => {
    const col = c.kind === 'ci' ? 'var(--teal2)' : agentColor(c.name), p = total ? (c.tokens / total * 100).toFixed(0) : 0;
    return `<div class="crow" data-n="${esc(c.name)}" data-c="${col}" data-v="${fmt(c.tokens)}" data-p="${p}"><span class="nm" style="color:${col}">${esc(c.name)}</span><span class="tr"><span class="fl" style="width:${(c.tokens / cmax * 100).toFixed(0)}%;background:${col}"></span></span><span class="vv">${fmt(c.tokens)}</span></div>`;
  }).join('') : '<div class="gv-empty">no token data for this range yet</div>';
  const tr = m.trend || [], tmax = Math.max(1, ...tr.map((t) => t.tokens || 0));
  root.querySelector('#tk-trend').innerHTML = tr.map((t) => `<div class="tb" data-l="${esc((t.date || '').slice(5) || 'day')}" data-v="${fmt(t.tokens)}" style="height:${((t.tokens || 0) / tmax * 100).toFixed(0)}%"></div>`).join('');
  setText('tk-trend-lab', 'trend · ' + range);
  root.querySelector('#tk-trend-l').innerHTML = tr.length ? `<span>${esc((tr[0].date || '').slice(5))}</span><span>${esc((tr[tr.length - 1].date || '').slice(5))}</span>` : '';
}

// ── issues & prs + digest ──
const STAGES = ['idea', 'spec', 'approved', 'in-progress', 'review', 'done'];
function stageOf(labels) {
  const L = new Set(labels || []);
  if (L.has('blocked')) return { stage: 3, state: 'blocked', cls: 'block' };
  if (L.has('done')) return { stage: 6, state: 'done', cls: 'done' };
  if (L.has('pr:in-review')) return { stage: 5, state: 'pr:in-review', cls: 'review' };
  if (L.has('in-progress')) return { stage: 4, state: 'in-progress', cls: 'prog' };
  if (L.has('approved')) return { stage: 3, state: 'approved', cls: 'open' };
  if (L.has('spec:in-review') || L.has('spec:draft')) return { stage: 2, state: 'spec', cls: 'review' };
  if (L.has('discussing') || L.has('idea')) return { stage: 1, state: 'idea', cls: 'open' };
  return { stage: 1, state: (labels && labels[0]) || 'open', cls: 'open' };
}
function rowHtml(it) {
  const segs = STAGES.map((_, i) => `<span class="seg ${i < it.stage ? (it.cls === 'done' ? 'done' : (i >= 3 || it.cls === 'block' ? 'amber' : 'on')) : ''}"></span>`).join('');
  const numCell = it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">#${it.number}</a>` : `#${it.number}`;
  return `<tr><td class="num">${numCell}</td><td><span class="kind ${it.kind}">${it.kind.toUpperCase()}</span></td><td class="title"><span class="tt">${esc(it.title || '')}</span></td><td><span class="state ${it.cls}">${esc(it.state)}</span></td><td><div class="prog">${segs}<span class="pl">${it.stage}/6 ${STAGES[Math.min(it.stage, 6) - 1]}</span></div></td><td class="age"></td></tr>`;
}
async function loadDaily() {
  let d; try { d = await (await fetch('/api/daily')).json(); } catch { return; }
  const issuesEl = root.querySelector('#gv-issues');
  if (!d.available) {
    issuesEl.innerHTML = '<div class="gv-empty">No report yet — run <code>node scripts/daily-report.mjs --post</code> (or install the schedule) to populate this view.</div>';
    return;
  }
  const r = d.report || {}, prs = r.prs || {}, iss = r.issues || {};
  // digest
  setText('gv-k-pr', (prs.opened || []).length);
  setText('gv-k-prs', `${(prs.merged || []).length} merged · ${prs.openNow ?? 0} open total`);
  setText('gv-k-iss', `${(iss.opened || []).length} / ${(iss.closed || []).length}`);
  const labels = Object.entries(iss.openByLabel || {}).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(' · ') || '—';
  setText('gv-k-isss', `${iss.openNow ?? 0} open total · ${labels}`);
  const t = r.tokens && r.tokens.total ? (r.tokens.total.input || 0) + (r.tokens.total.output || 0) : 0;
  setText('gv-k-tok', fmt(t));
  setText('gv-k-toks', `$${(r.tokens?.local?.costUsd || 0).toFixed(2)} — detail below ↓`);
  // table rows: issues (label→stage), open PRs (review), merged PRs (done)
  const rows = [];
  for (const i of (iss.opened || [])) rows.push({ kind: 'issue', number: i.number, title: i.title, url: i.url, ...stageOf(i.labels) });
  for (const p of (prs.opened || [])) rows.push({ kind: 'pr', number: p.number, title: p.title, url: p.url, stage: 5, state: 'open', cls: 'review' });
  for (const p of (prs.merged || [])) rows.push({ kind: 'pr', number: p.number, title: p.title, url: p.url, stage: 6, state: 'merged', cls: 'done' });
  issuesEl.innerHTML = rows.length
    ? `<table><thead><tr><th>#</th><th>kind</th><th>title</th><th>state</th><th>progress</th><th>age</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`
    : '<div class="gv-empty">No open issues or PRs in the latest report.</div>';
}

async function loadSchedules() {
  let d; try { d = await (await fetch('/api/schedules')).json(); } catch { return; }
  setText('gv-sched-owner', `engine: ${d.schedulerOwner || '—'} · ${(d.jobs || []).length} jobs`);
  const el = root.querySelector('#gv-sched');
  if (!d.jobs || !d.jobs.length) { el.innerHTML = '<div class="gv-empty">No scheduled jobs. Add one to an agent’s .agent/schedule.json; the daemon runs them 24/7.</div>'; return; }
  const pill = (s) => s === 'ok' ? '<span class="state done">ok</span>' : s === 'fail' ? '<span class="state block">fail</span>' : '<span class="state open">—</span>';
  const rows = d.jobs.map((j) => {
    const desc = j.description ? `<div class="sched-desc" title="${esc(j.description)}">${esc(j.description)}</div>` : '';
    const canRun = j.enabled && !j.running;
    const runBtn = `<button class="sched-run" data-run-agent="${esc(j.agent)}" data-run-id="${esc(j.id)}"${canRun ? '' : ' disabled'} title="${j.enabled ? 'run now (≤30s)' : 'enable the job to run it'}">▶ run</button>`;
    return `<tr><td class="title"><span class="tt"><b class="an" style="color:${agentColor(j.agent)}">${esc(j.agent)}</b> · ${esc(j.name)}</span>${desc}</td><td><span class="kind issue">${esc(j.cadenceLabel || '')}</span></td><td>${j.enabled ? pill(j.lastStatus) : '<span class="state open">off</span>'}</td><td class="age">${esc(j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—')}</td><td class="age">${j.running ? '▶ running' : runBtn}</td></tr>`;
  }).join('');
  el.innerHTML = `<table><thead><tr><th>agent · job</th><th>cadence</th><th>last</th><th>next run</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  el.querySelectorAll('.sched-run').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'queued…';
    try {
      await fetch('/api/schedules/run', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: btn.dataset.runAgent, id: btn.dataset.runId }) });
    } catch { /* transient — next poll reflects state */ }
    setTimeout(loadSchedules, 1500);
  }));
}

async function loadHealth() {
  const pillEl = root.querySelector('#gv-health-pill');
  const el = root.querySelector('#gv-health');
  let data;
  try {
    data = await (await fetch('/api/health', { credentials: 'same-origin' })).json();
  } catch {
    if (pillEl) pillEl.textContent = 'unavailable';
    if (el) el.innerHTML = '<div class="gv-empty">health unavailable</div>';
    return;
  }
  const { summary = {}, findings = [], openEscalations = [] } = data;
  const bad = (summary.failing || 0) + (summary.overdue || 0) + (summary.stuck || 0);
  // header pill
  if (pillEl) {
    if (bad === 0) {
      pillEl.innerHTML = '<span class="hpill hpill-ok">All scheduled jobs healthy</span>';
    } else {
      const haserr = findings.some((f) => f.severity === 'error');
      pillEl.innerHTML = `<span class="hpill ${haserr ? 'hpill-err' : 'hpill-warn'}">${bad} issue${bad === 1 ? '' : 's'}</span>`;
    }
  }
  if (!findings.length) {
    el.innerHTML = '<div class="gv-empty health-ok">All scheduled jobs healthy</div>';
    return;
  }
  const order = { error: 0, warn: 1 };
  const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  const rows = sorted.map((f) => {
    const key = `mesh-heartbeat:${f.agent}/${f.jobId}/${f.condition}`;
    const escalated = openEscalations.includes(key);
    const rel = relTime(f.since);
    const sev = f.severity === 'error' ? 'state block' : 'state prog';
    const escBadge = escalated ? ' <span class="hesc">escalated</span>' : '';
    return `<tr>
      <td class="title"><span class="tt"><b class="an" style="color:${agentColor(f.agent)}">${esc(f.agent)}</b></span></td>
      <td><span class="kind issue">${esc(f.jobId)}</span></td>
      <td><span class="${sev}">${esc(f.condition)}</span></td>
      <td class="age">${esc(rel)}</td>
      <td class="title"><span class="tt">${esc(f.detail || '')}${escBadge}</span></td>
    </tr>`;
  }).join('');
  el.innerHTML = `<table><thead><tr><th>agent</th><th>job</th><th>condition</th><th>since</th><th>detail</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ── activity log panel ──
const actFilters = { agent: '', type: '', range: '24h' };

function rangeSince(r) {
  const nowMs = Date.now();
  if (r === 'today') return new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
  if (r === '24h') return new Date(nowMs - 864e5).toISOString();
  if (r === '7d') return new Date(nowMs - 7 * 864e5).toISOString();
  return ''; // all
}

async function loadActivityLog() {
  const el = root.querySelector('#gv-activity-log');
  const metaEl = root.querySelector('#gv-activity-meta');
  if (!el) return;
  const since = rangeSince(actFilters.range);
  const params = Object.entries({ agent: actFilters.agent, type: actFilters.type, since }).filter(([, v]) => v);
  const qs = params.length ? '?' + new URLSearchParams(params).toString() : '';
  let data;
  try {
    data = await (await fetch('/api/activity-log' + qs, { credentials: 'same-origin' })).json();
  } catch {
    el.innerHTML = '<div class="gv-empty">activity log unavailable</div>';
    if (metaEl) metaEl.textContent = '—';
    return;
  }
  const { events = [], agents: agentList = [], types: typeList = [] } = data;
  if (metaEl) metaEl.textContent = `${events.length} event${events.length === 1 ? '' : 's'}`;

  const agentOpts = ['', ...agentList].map((a) => `<option value="${esc(a)}"${actFilters.agent === a ? ' selected' : ''}>${a ? esc(a) : 'all agents'}</option>`).join('');
  const typeOpts = ['', ...typeList].map((t) => `<option value="${esc(t)}"${actFilters.type === t ? ' selected' : ''}>${t ? esc(t) : 'all types'}</option>`).join('');
  const rangeOpts = [
    { v: 'today', l: 'Today' },
    { v: '24h', l: '24h' },
    { v: '7d', l: '7d' },
    { v: 'all', l: 'All time' },
  ].map(({ v, l }) => `<option value="${v}"${actFilters.range === v ? ' selected' : ''}>${l}</option>`).join('');

  const levelPill = (lvl) => {
    const cls = lvl === 'error' ? 'act-lvl act-lvl-error' : lvl === 'warn' ? 'act-lvl act-lvl-warn' : 'act-lvl act-lvl-info';
    return `<span class="${cls}">${esc(lvl || 'info')}</span>`;
  };

  const rows = events.length ? events.map((e) => {
    const who = e.agent ? tagName(e.agent) : `<span class="act-src">${esc(e.source || '')}</span>`;
    const ref = e.ref ? ` <span class="act-ref">${esc(e.ref)}</span>` : '';
    return `<tr class="act-row act-row-${esc(e.level || 'info')}">
      <td class="age">${esc(relTime(e.ts))}</td>
      <td>${who}</td>
      <td><span class="act-type">${esc(e.type || '')}</span></td>
      <td>${levelPill(e.level)}</td>
      <td class="title"><span class="tt">${esc(e.summary || '')}${ref}</span></td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="gv-empty">No activity yet.</td></tr>`;

  el.innerHTML = `
    <div class="act-filters">
      <select class="act-sel" data-act-filter="agent">${agentOpts}</select>
      <select class="act-sel" data-act-filter="type">${typeOpts}</select>
      <select class="act-sel" data-act-filter="range">${rangeOpts}</select>
    </div>
    <table>
      <thead><tr><th>time</th><th>agent</th><th>type</th><th>level</th><th>summary</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  // bind filter selects
  el.querySelectorAll('.act-sel').forEach((sel) => {
    sel.addEventListener('change', () => {
      actFilters[sel.dataset.actFilter] = sel.value;
      loadActivityLog();
    });
  });
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - Date.parse(iso);
  if (isNaN(diff)) return '';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function setText(id, v) { const el = root.querySelector('#' + id); if (el) el.textContent = v; }
