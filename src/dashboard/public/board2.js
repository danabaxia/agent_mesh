// src/dashboard/public/board2.js
// Renderer for the redesigned board (spec 2026-06-10 §2). Pure transforms live
// in board2-model.js; this file does fetch + DOM only.
import { agentColor, buildKpis, buildCards, buildLane, buildTimeline } from '/board2-model.js';
import { openWorkspace, closeWorkspace, selectTab, setWorkspaceMesh, launchTerminal } from '/workspace.js';
import { createNetGraph } from '/net-graph.js';
import { renderGraphView } from '/graph-view.js';

// ── top-level Graph view (live mesh activity + tokens + issues/PRs) ──────────
function openGraphView() {
  document.querySelector('#view-board').classList.remove('on');
  document.querySelector('#view-ws').classList.remove('on');
  document.querySelector('#view-graph').classList.add('on');
  window.__openAgent = (n) => { closeGraphView(); openWorkspace(n); };  // node click → agent workspace
  renderGraphView(document.querySelector('#view-graph'));
}
function closeGraphView() {
  document.querySelector('#view-graph').classList.remove('on');
  document.querySelector('#view-board').classList.add('on');
}

const $ = (s, r = document) => r.querySelector(s);
let MESH = null, RESOURCES = null, ACTIVITY = null, COLLAB = null, USAGE = null;

async function getJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export async function refresh() {
  // /api/collab is best-effort: a failure must never break the board, it only
  // costs the network view its edge weights / pair stats.
  const collabP = getJson('/api/collab?days=30').catch(() => null);
  const usageP = getJson('/api/usage').catch(() => null);   // sizes graph dots; best-effort
  [MESH, RESOURCES, ACTIVITY] = await Promise.all([
    getJson('/api/mesh'), getJson('/api/resources'), getJson('/api/activity')
  ]);
  COLLAB = await collabP;
  USAGE = await usageP;
  setWorkspaceMesh(MESH);
  renderPills(); renderKpis(); renderCards(); renderLane(); renderTimeline(); renderNetwork();
}

function renderPills() {
  const k = buildKpis(MESH, RESOURCES, ACTIVITY);
  $('#pill-agents').textContent = `${k.agents.total}`;
  $('#pill-deleg').textContent = `${(ACTIVITY.edges ?? []).filter((e) => e.active).length}`;
  $('#pill-sessions').textContent = `${(ACTIVITY.agents ?? []).filter((a) => a.state === 'working').length}`;
}

function renderKpis() {
  const k = buildKpis(MESH, RESOURCES, ACTIVITY);
  setKpi('#kpi-agents', k.agents.total, `${k.agents.served} served`);
  setKpi('#kpi-skills', k.skills, '');
  setKpi('#kpi-mcps', k.mcps.total, `${k.mcps.mesh} mesh`);
  setKpi('#kpi-sessions', k.sessions, '');
  setKpi('#kpi-a2a', k.a2a.total, '');
}

function setKpi(sel, value, sub) {
  const tile = $(sel);
  if (!tile) return;
  tile.querySelector('b').childNodes[0].textContent = `${value} `;
  tile.querySelector('.sub').textContent = sub;
}

function renderCards() {
  const main = $('#cards-main');
  main.innerHTML = '';
  for (const c of buildCards(MESH, RESOURCES, ACTIVITY)) main.appendChild(cardEl(c));
}

function cardEl(c) {
  const el = document.createElement('section');
  el.className = 'agent-col';
  el.dataset.agent = c.name;
  el.innerHTML = `
    <div class="acol-head">
      <span class="dot ${c.state === 'idle' ? '' : c.state}"></span>
      <h2 style="color:${agentColor(c.name)}" data-open>${esc(c.name)}</h2>
      <div class="modes">${c.modes.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
      <div class="stats">
        <span data-lens="skills" class="${c.skillCount ? '' : 'zero'}">⚡ ${c.skillCount} skills</span>
        <span data-lens="mcps">⛭ ${c.mcpCount} MCP</span>
      </div>
      <div class="acts"><button class="abtn primary" data-open>⌗ workspace</button></div>
    </div>
    <div class="now" data-lens="activity"><span class="nlab">NOW</span><span class="ntext">${esc(nowText(c))}</span></div>
    ${identityHtml(c)}`;
  return el;
}

// Default card body: WHO this agent is (spec phase-8 — identity first, no feed).
function identityHtml(c) {
  const desc = c.description
    ? esc(c.description)
    : '<span class="empty">no description — add one to agent.json</span>';
  const peers = (c.peers ?? []).length
    ? `<div class="aident-meta">peers: ${c.peers.map(esc).join(' · ')}</div>`
    : '';
  return `<div class="aident">${desc}${peers}</div>`;
}

function nowText(c) {
  if (c.state === 'working') return `working — ${c.route ?? 'task'} since ${fmtTime(c.since)}`;
  if (c.state === 'live') return `last run done (${c.route ?? '—'})`;
  return 'idle';
}

const fmtTime = (s) => s ? new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// ── lenses: skills / MCP / activity (NOW strip) lists swap the card body;
//    rows expand to descriptions; closing a lens returns to the identity panel
document.addEventListener('click', (e) => {
  // ── foldable mesh timeline dock (preference persisted) ────────────────────
  if (e.target.closest('#dock-toggle')) {
    const folded = $('#dock').classList.toggle('folded');
    try { localStorage.setItem('b2.dockFolded', folded ? '1' : ''); } catch { /* private mode */ }
    return;
  }
  // ── network: the force graph (net-graph.js) handles its own node/link/bg
  //    clicks via callbacks; only the panel close button is wired here.
  if (e.target.closest('[data-netclose]')) { netClose(); return; }
  // ── workspace: open (agent name / ⌗ workspace buttons) ────────────────────
  const opener = e.target.closest('[data-open]');
  if (opener) {
    const name = opener.closest('[data-agent]')?.dataset.agent;
    if (name) { openWorkspace(name); return; }
  }
  if (e.target.closest('#ws-back')) { closeWorkspace(); return; }
  if (e.target.closest('#ws-terminal')) { launchTerminal(); return; }
  const tv = e.target.closest('[data-topview]');
  if (tv) { tv.dataset.topview === 'graph' ? openGraphView() : closeGraphView(); return; }
  const wstab = e.target.closest('[data-wstab]');
  if (wstab) { selectTab(wstab.dataset.wstab); return; }
  const bv = e.target.closest('[data-bv]');
  if (bv) {
    document.querySelectorAll('[data-bv]').forEach((s) => s.classList.toggle('on', s === bv));
    const net = bv.dataset.bv === 'net';
    $('#cards-main').style.display = net ? 'none' : '';
    $('#netview').classList.toggle('on', net);
    if (!net) netClose(); // leaving the network view dismisses the detail panel
    return;
  }
  const chip = e.target.closest('[data-lens]');
  if (chip) { toggleLens(chip); return; }
  const item = e.target.closest('.pl[data-desc]');
  if (item) {
    const open = item.querySelector('.pdesc');
    if (open) { open.remove(); return; }
    const text = item.dataset.desc ||
      'No description found — add one to the SKILL.md frontmatter / mcp.json "description".';
    const div = document.createElement('div');
    div.className = 'pdesc';
    div.textContent = text;
    item.appendChild(div);
  }
});

function toggleLens(chip) {
  const col = chip.closest('.agent-col');
  const card = buildCards(MESH, RESOURCES, ACTIVITY).find((c) => c.name === col.dataset.agent);
  if (!card) return;
  // Toggling the active lens OFF (or any close path) returns to the IDENTITY
  // panel — the default body — never to a feed.
  const lens = col.dataset.lens === chip.dataset.lens ? '' : chip.dataset.lens;
  renderCardBody(col, card, lens);
}

function renderCardBody(col, card, lens) {
  col.dataset.lens = lens;
  col.querySelectorAll('.stats [data-lens]').forEach((s) => s.classList.toggle('active', s.dataset.lens === lens));
  col.querySelector('.panel-head')?.remove();
  col.querySelector('.plist')?.remove();
  col.querySelector('.aident')?.remove();
  if (!lens) { col.insertAdjacentHTML('beforeend', identityHtml(card)); return; }
  let rows, hint;
  if (lens === 'activity') {
    rows = buildTimeline(ACTIVITY)
      .filter((t) => (t.names ?? []).includes(card.name)).slice(0, 30)
      .map((t) => `<div class="pl ev"><span class="et">${fmtTime(t.at)}</span><span>${esc(t.text)}</span></div>`)
      .join('') || '<div class="empty">no recent activity</div>';
    hint = 'recent runs & delegations';
  } else {
    const items = lens === 'skills' ? card.skills : card.mcps;
    rows = items.map((i) => {
      const desc = i.summary ?? i.config?.description ?? '';
      const tag = i.grant ?? i.source ?? '';
      return `<div class="pl" data-desc="${esc(desc)}">${esc(i.name)}<span class="src">${esc(tag)}</span></div>`;
    }).join('') || '<div class="empty">none yet</div>';
    hint = 'click an item for its purpose';
  }
  const head = document.createElement('div');
  head.className = 'panel-head';
  head.textContent = `${card.name.toUpperCase()} — ${lens.toUpperCase()} — ${hint}`;
  const list = document.createElement('div');
  list.className = 'plist';
  list.innerHTML = rows;
  col.append(head, list);
}

function renderLane() {
  const lane = $('#lane');
  const edges = buildLane(ACTIVITY);
  lane.innerHTML = edges.length ? '' : '<span class="lane-empty">no delegations yet</span>';
  for (const e of edges.slice(0, 6)) {
    lane.insertAdjacentHTML('beforeend',
      `<span class="edge ${e.active ? '' : 'done'}">
         <b style="color:${agentColor(e.from)}">${esc(e.from)}</b>
         <span class="arrow">${e.active ? '⇄→' : '→'}</span>
         <b style="color:${agentColor(e.to)}">${esc(e.to)}</b>
         <span class="mode">${esc(e.kind ?? '')}</span></span>`);
  }
}

function renderTimeline() {
  const ev = $('#events');
  ev.innerHTML = '';
  for (const t of buildTimeline(ACTIVITY).slice(0, 30)) {
    const span = document.createElement('span');
    span.textContent = t.text;
    let html = span.innerHTML;
    for (const n of t.names ?? []) {
      html = html.replace(n, `<b class="an" style="color:${agentColor(n)}">${n}</b>`);
    }
    ev.insertAdjacentHTML('beforeend',
      `<div class="ev"><span class="et">${fmtTime(t.at)}</span>
        <span class="ek ${t.kind === 'a2a' ? 'a2a' : 'session'}">${esc(t.kind.toUpperCase())}</span><span>${html}</span></div>`);
  }
}

// ── Obsidian-style force graph (net-graph.js): floating dots, click an agent
//    dot to split it into its skill/MCP dots (MCPs are SHARED dots), drag
//    everything; collaboration frequency = node size + link weight, no numbers.
let NETGRAPH = null;

function renderNetwork() {
  const svg = $('#netsvg');
  if (!svg || !MESH) return;
  if (!NETGRAPH) {
    NETGRAPH = createNetGraph(svg, {
      onOpenAgent: (name) => openWorkspace(name),
      onEdgeClick: (a, b) => netShowPair(a, b),
      onNodeInfo: (n) => netShowNodeInfo(n),
      onBackground: () => netClose()
    });
    const legend = $('#netview .netlegend');
    if (legend) {
      legend.innerHTML = 'click an agent <b>dot</b> to split it into its skills &amp; MCPs (shared MCPs merge) · ' +
        'click its <b>name</b> to open the workspace · click a <b>link</b> for collaboration details · ' +
        'drag any dot — size &amp; link weight = how much they work together';
    }
  }
  const collabMap = new Map((COLLAB?.edges ?? []).map((e) => [`${e.from}|${e.to}`, e]));
  const activeSet = new Set((ACTIVITY?.edges ?? []).filter((e) => e.active).map((e) => `${e.from}|${e.to}`));
  const liveAgents = new Map((ACTIVITY?.agents ?? []).map((x) => [x.name, x.state]));
  const cards = buildCards(MESH, RESOURCES, ACTIVITY);

  const agents = cards.map((c) => {
    let volume = 0;
    for (const e of COLLAB?.edges ?? []) {
      if (e.from === c.name || e.to === c.name) volume += e.count;
    }
    return {
      name: c.name,
      color: agentColor(c.name),
      state: liveAgents.get(c.name) === 'working' ? 'working' : liveAgents.has(c.name) ? 'live' : 'idle',
      volume,
      skills: c.skills.map((s) => ({
        name: s.name, summary: s.summary ?? '',
        count: USAGE?.agents?.[c.name]?.skills?.[s.name] ?? 0
      })),
      mcps: c.mcps.map((m) => ({
        name: m.name, grant: m.grant ?? m.source ?? '', summary: m.config?.description ?? '',
        count: USAGE?.agents?.[c.name]?.mcps?.[m.name] ?? 0
      }))
    };
  });

  const seen = new Set();
  const links = [];
  for (const e of MESH.graph?.edges ?? []) {
    const key = [e.from, e.to].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const w = (collabMap.get(`${e.from}|${e.to}`)?.count ?? 0) + (collabMap.get(`${e.to}|${e.from}`)?.count ?? 0);
    const active = activeSet.has(`${e.from}|${e.to}`) || activeSet.has(`${e.to}|${e.from}`);
    links.push({ a: e.from, b: e.to, w, active });
  }
  NETGRAPH.update({ agents, links });
}

// small info panel for a skill/MCP dot
function netShowNodeInfo(n) {
  const el = netPanel();
  delete el.dataset.agent;
  const kind = n.kind === 'mcp' ? 'MCP server' : 'skill';
  const owner = n.id.startsWith('skill:') ? n.id.slice(6).split('/')[0] : null;
  el.innerHTML = `
    <div class="nd-head"><b style="color:${n.kind === 'mcp' ? 'var(--teal)' : esc(n.color)}">${esc(n.label)}</b>
      <span class="nd-sub">${esc(kind)}${owner ? ` · ${esc(owner)}` : ' · shared'}</span></div>
    <div class="nd-desc">${n.meta?.summary ? esc(n.meta.summary) : '<span class="empty">no description recorded</span>'}</div>
    ${n.meta?.grant ? `<div class="nd-note">grant: ${esc(n.meta.grant)}</div>` : ''}
    <div class="nd-note">${n.meta?.count ? `used ${n.meta.count}× in recent sessions — dot size reflects this` : (USAGE?.available ? 'no recent use recorded' : 'usage sizing needs --allow-shell')}</div>
    <div class="nd-foot"><button class="abtn" data-netclose>× close</button></div>`;
}

// ── phase-8: network detail panel — expandable nodes + collab pair stats ────
function netPanel() {
  const wrap = $('#netview .netwrap');
  let el = wrap.querySelector('.netdetail');
  if (!el) {
    el = document.createElement('div');
    el.className = 'netdetail';
    wrap.appendChild(el);
  }
  return el;
}

function netClose() {
  $('#netview .netdetail')?.remove();
}

// (the former netShowAgent detail panel was superseded by in-graph expansion:
// clicking an agent dot splits it into skill/MCP dots — net-graph.js)

function netShowPair(a, b) {
  const el = netPanel();
  delete el.dataset.agent; // pair mode — no workspace target
  const edges = COLLAB?.edges ?? [];
  const dir = (f, t) => edges.find((x) => x.from === f && x.to === t);
  const block = (f, t) => {
    const d = dir(f, t);
    const head = `<b style="color:${agentColor(f)}">${esc(f)}</b> → <b style="color:${agentColor(t)}">${esc(t)}</b>`;
    if (!d) return `<div class="nd-dir">${head}: <span class="nd-note">no requests</span></div>`;
    const modes = Object.entries(d.modes ?? {}).filter(([, n]) => n > 0)
      .map(([m, n]) => `${m} ${n}`).join(' / ') || '—';
    return `<div class="nd-dir">${head}: ${d.count} request${d.count === 1 ? '' : 's'} ·
      <span class="ok">✓${d.ok}</span> <span class="fail">✗${d.fail}</span>${d.running ? ` · ${d.running} running` : ''}
      · modes ${esc(modes)} · last ${fmtTime(d.lastAt)}</div>`;
  };
  let topics;
  if (COLLAB?.topicsAvailable) {
    topics = [...(dir(a, b)?.topics ?? []), ...(dir(b, a)?.topics ?? [])]
      .sort((x, y) => Date.parse(y.at ?? 0) - Date.parse(x.at ?? 0)).slice(0, 8)
      .map((t) => `<div class="nd-topic"><span class="${t.ok ? 'ok' : 'fail'}">${t.ok ? '✓' : '✗'}</span> ${esc(t.text)} <span class="src">${fmtTime(t.at)}</span></div>`)
      .join('') || '<div class="nd-note">no topics recorded</div>';
  } else {
    topics = '<div class="nd-note">task text requires --allow-shell</div>';
  }
  el.innerHTML = `
    <div class="nd-head"><b style="color:${agentColor(a)}">${esc(a)}</b> ⇄ <b style="color:${agentColor(b)}">${esc(b)}</b>
      <span class="nd-sub">collaboration (30d)</span></div>
    ${block(a, b)}${block(b, a)}
    <div class="nd-sec">WHAT HELP WAS NEEDED</div>${topics}
    <div class="nd-foot"><button class="abtn" data-netclose>× close</button></div>`;
}

// restore the timeline fold preference before first paint
try { if (localStorage.getItem('b2.dockFolded')) $('#dock')?.classList.add('folded'); } catch { /* private mode */ }

refresh().then(() => {
  // Deep-link: /board2.html#/agent/<name> opens that agent's workspace.
  if (location.hash.startsWith('#/agent/')) {
    const name = decodeURIComponent(location.hash.slice('#/agent/'.length));
    if (name) openWorkspace(name);
  }
}).catch((err) => {
  document.body.insertAdjacentHTML('beforeend', `<pre class="fatal"></pre>`);
  document.querySelector('.fatal').textContent = String(err);
});

function showSyncToast(msg) {
  try {
    const el = document.createElement('div');
    // textContent (NOT innerHTML): msg embeds the server's sync error string —
    // textContent makes it XSS-safe by construction. Do not switch to innerHTML
    // without HTML-escaping msg first.
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9999;background:#222;color:#eee;padding:8px 12px;border-radius:6px;font:13px system-ui;box-shadow:0 2px 8px rgba(0,0,0,.3);opacity:.97';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  } catch { /* no DOM (non-browser) — ignore */ }
}

// live refresh — /api/events SSE notifies on activity changes; fall back to polling
try {
  const es = new EventSource('/api/events');
  es.addEventListener('activity', () => refresh().catch(() => {}));
  es.addEventListener('sync', (e) => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (d && d.ok === false) { showSyncToast(`Auto-sync failed (${d.error || 'unknown'}) — run \`agent-mesh doctor\``); return; }
    if (d && Array.isArray(d.synced) && d.synced.length) showSyncToast(`Wiring synced: ${d.synced.length} change(s)`);
  });
  es.onerror = () => { /* SSE may be disabled; the interval below still covers us */ };
} catch { /* EventSource unavailable */ }
setInterval(() => refresh().catch(() => {}), 30000);
