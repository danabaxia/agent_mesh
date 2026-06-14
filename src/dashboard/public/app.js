/**
 * agent_mesh dashboard — app.js
 * Wired to live /api/* endpoints. No mock data.
 * No inline scripts; all logic here (external, CSP-safe).
 */

'use strict';

// ---------------------------------------------------------------------------
// Sanitization helpers (XSS prevention)
// ---------------------------------------------------------------------------

/** Escape HTML entities — used for all untrusted text content. */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitize a URL: only allow http:// and https:// schemes.
 * Returns null for anything else (data:, javascript:, etc.)
 */
function safeUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

// ---------------------------------------------------------------------------
// Markdown canvas renderer (safe subset — no raw HTML passthrough)
// ---------------------------------------------------------------------------

/**
 * Render inline markdown: bold, italic, inline code, links (http(s) only).
 * Remote images are NOT rendered as <img> (see spec §6 / CSP img-src 'self').
 */
function inlineMd(raw) {
  // First escape HTML in the text
  let s = esc(raw);
  // Bold
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  // Italic
  s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  // Inline code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Links — only http(s)
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, txt, url) => {
    const safe = safeUrl(url);
    if (!safe) return esc(txt);
    return `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  });
  return s;
}

/**
 * TSV formula-injection escape: cells starting with =, +, -, @ → prefix with '
 * so they paste as text in Excel, not as formulas.
 */
function escapeTsvCell(val) {
  const s = String(val);
  if (/^[=+\-@]/.test(s)) return "'" + s;
  return s;
}

/**
 * Convert a <table> element to TSV string.
 * @param {HTMLTableElement} table
 * @returns {string}
 */
function tableToTsv(table) {
  return Array.from(table.rows)
    .map(row => Array.from(row.cells).map(c => escapeTsvCell(c.innerText.trim())).join('\t'))
    .join('\n');
}

/**
 * Full markdown → safe HTML renderer.
 * Handles: fenced code blocks, headings, blockquotes, tables, lists, paragraphs.
 * Remote images (https?:) → inert click-to-load link (not <img>).
 * No raw HTML passthrough.
 */
function renderMarkdown(src) {
  // 1. Extract fenced code blocks first (before any other processing)
  const blocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = blocks.length;
    // Escape HTML in code block content
    blocks.push('<pre class="cb">' + esc(code) + '</pre>');
    return `@@CB${idx}@@`;
  });

  // 2. Handle remote images: ![alt](https://...) → inert click-to-load
  src = src.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const idx = blocks.length;
    const safe = safeUrl(url);
    if (safe) {
      // Render as inert click-to-load link (CSP disallows remote images)
      blocks.push(
        `<a class="img-placeholder" href="${esc(safe)}" target="_blank" rel="noopener noreferrer">` +
        `🖼 ${esc(alt || 'image')} <span style="opacity:.55">(click to open)</span></a>`
      );
    } else {
      blocks.push(`<span>[image: ${esc(alt)}]</span>`);
    }
    return `@@CB${idx}@@`;
  });

  const lines = src.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block placeholder
    const ph = line.trim().match(/^@@CB(\d+)@@$/);
    if (ph) {
      out.push(blocks[+ph[1]]);
      i++;
      continue;
    }

    // Headings
    if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      const text = line.replace(/^#+\s+/, '');
      out.push(`<h${level}>${inlineMd(text)}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`);
      i++;
      continue;
    }

    // Table (GFM: | ... | followed by | --- | separator)
    if (/^\|.*\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      const headerCells = line.split('|').slice(1, -1);
      const head = headerCells.map(s => `<th>${inlineMd(s.trim())}</th>`).join('');
      i += 2; // skip header + separator
      let rows = '';
      while (i < lines.length && /^\|.*\|/.test(lines[i])) {
        const cells = lines[i].split('|').slice(1, -1);
        rows += '<tr>' + cells.map(s => `<td>${inlineMd(s.trim())}</td>`).join('') + '</tr>';
        i++;
      }
      out.push(
        `<div class="tblwrap">` +
        `<button class="tcopy" data-copy-table>⧉ copy</button>` +
        `<table class="md"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` +
        `</div>`
      );
      continue;
    }

    // Unordered list
    if (/^[-*]\s/.test(line)) {
      let items = '';
      while (i < lines.length && /^[-*]\s/.test(lines[i])) {
        items += `<li>${inlineMd(lines[i].replace(/^[-*]\s/, ''))}</li>`;
        i++;
      }
      out.push('<ul>' + items + '</ul>');
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      let items = '';
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items += `<li>${inlineMd(lines[i].replace(/^\d+\.\s/, ''))}</li>`;
        i++;
      }
      out.push('<ol>' + items + '</ol>');
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Default: paragraph
    out.push('<p>' + inlineMd(line) + '</p>');
    i++;
  }

  return out.join('');
}

// ---------------------------------------------------------------------------
// API fetch helpers
// ---------------------------------------------------------------------------

async function apiFetch(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${path}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let meshData = null;        // /api/mesh response
let resourceData = null;    // /api/resources response
let boardType = 'agent';    // 'agent' | 'skill' | 'mcp'
let boardView = 'kanban';   // 'kanban' | 'graph'
let resourceBoardView = 'cards'; // 'cards' | 'list'
let currentScope = 'mesh';  // scope for explorer
let treeData = [];          // flat tree entries from /api/tree
let agentNames = [];        // ordered list of agent names
let _scopeSeq = 0;          // ignores stale async scope refreshes
let activity = { agents: [], edges: [], events: [] }; // /api/activity (live)
let shellEnabled = false;   // /api/mesh shellEnabled — gates the native-CLI launcher
let sessionLogEnabled = false; // /api/mesh sessionLogEnabled — gates the dashboard-native session view
let mirrorEnabled = false;  // /api/mesh mirrorEnabled — gates the read-only iTerm-session mirror
let chatEnabled = false;    // /api/mesh chatEnabled — gates the in-dashboard chat composer (off by default)

/** Quick lookup: agent name → live activity record. */
function activityFor(name) {
  return (activity.agents || []).find(a => a.name === name) || null;
}

function livebarHtmlForActivity(act) {
  const phase = act && act.route === 'tool' ? 'tool' : act && act.route === 'orchestrate' ? 'routing' : '';
  if (act && act.state === 'working') {
    return `<div class="livebar working"><span class="lspin"></span> working${phase ? ' · ' + phase : ''}</div>`;
  }
  if (act && act.state === 'done') {
    return `<div class="livebar done">✓ done${phase ? ' · ' + phase : ''}</div>`;
  }
  return '';
}

function updateAgentActivityCards() {
  const cardsEl = document.getElementById('cards');
  if (!cardsEl) return;
  cardsEl.querySelectorAll('.card[data-agent]').forEach((card) => {
    const name = card.getAttribute('data-agent');
    if (!name || name === 'mesh') return;
    const act = activityFor(name);
    card.classList.toggle('pulse', !!(act && act.state === 'working'));
    const existing = card.querySelector('.livebar');
    if (existing) existing.remove();
    const live = livebarHtmlForActivity(act);
    if (live) card.insertAdjacentHTML('beforeend', live);
  });
}

async function getResources() {
  if (!resourceData) resourceData = await apiFetch('/api/resources');
  return resourceData;
}

function resourceGroup(resources, id) {
  return (resources?.groups || []).find(g => g.id === id) || {
    id,
    label: id,
    kind: id === 'mesh' ? 'mesh' : 'agent',
    counts: { skills: 0, mcps: 0 },
    skills: [],
    mcps: []
  };
}

function mcpCommand(mcp) {
  if (!mcp?.config?.command) return '';
  return `${mcp.config.command} ${(mcp.config.args || []).join(' ')}`.trim();
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function statusPill(status, isolated) {
  if (status === 'served' && isolated) {
    return '<span class="pill alone">○ isolated</span>';
  }
  if (status === 'served') return '<span class="pill served">● served</span>';
  if (status === 'drift')  return '<span class="pill warn">⚠ drift</span>';
  if (status === 'disabled') return '<span class="pill alone">○ disabled</span>';
  return '<span class="pill alone">○ unknown</span>';
}

function cardClass(status) {
  if (status === 'drift') return 'drift';
  if (status === 'disabled') return 'disabled';
  return '';
}

// ---------------------------------------------------------------------------
// Scope selector
// ---------------------------------------------------------------------------

function buildScopeOptions(agents) {
  const sel = document.getElementById('scope');
  if (!sel) return;
  // Clear and repopulate
  sel.innerHTML = '<option value="mesh">Mesh</option>';
  for (const a of agents) {
    const opt = document.createElement('option');
    opt.value = esc(a.name);
    opt.textContent = `agent: ${a.name}`;
    sel.appendChild(opt);
  }
  sel.value = currentScope;
}

// ---------------------------------------------------------------------------
// Scope orchestration — the top scope select filters ALL three panes
// (Files / Board / Chat). 'mesh' = full multi-agent view (default).
// ---------------------------------------------------------------------------

/** Filter the board (kanban cards / graph) to a single agent, or show all. */
let boardAgentFilter = null; // null = show all (mesh); else agent name
let explorerShowFiles = false; // invisible by default


function applyBoardFilter() {
  // Per-agent filtering only applies to the agents board; skill/mcp boards are
  // mesh-wide (their card titles aren't agent names), so never hide them.
  const filterCards = boardType === 'agent' ? boardAgentFilter : null;
  const cardsEl = document.getElementById('cards');
  if (cardsEl) {
    cardsEl.querySelectorAll('.card').forEach((card) => {
      const h = card.querySelector('h3');
      const name = card.getAttribute('data-agent') || (h ? h.textContent : '');
      const hide = filterCards && name !== filterCards;
      card.classList.toggle('scope-hidden', !!hide);
    });
  }
  // Graph: dim/hide non-matching nodes, edges, and overlays.
  document.querySelectorAll('#graphSvg .gnode').forEach((g) => {
    const id = g.getAttribute('data-agent');
    const hide = boardAgentFilter && id !== boardAgentFilter;
    g.classList.toggle('scope-dim', !!hide);
  });
  document.querySelectorAll('#graphSvg .edge, #graphSvg .edge-live, #graphSvg .bub, #graphSvg .bubtext').forEach((el) => {
    const from = el.getAttribute('data-from');
    const to = el.getAttribute('data-to');
    const hide = boardAgentFilter && (from !== boardAgentFilter && to !== boardAgentFilter);
    el.classList.toggle('scope-dim', !!hide);
  });
}

/**
 * Apply a scope selection across Files, Board and Chat.
 * Keeps the scope <select> value in sync (so callers like a card click can set it).
 *  - scope === 'mesh'  → full multi-agent view in all panes.
 *  - scope === <name>  → Files scoped to the agent's root, Board filtered to that
 *                        agent, Chat/Session wired to that agent.
 */
async function applyScope(scope) {
  const seq = ++_scopeSeq;
  const sel = document.getElementById('scope');
  if (sel && sel.value !== scope) sel.value = scope;
  closeCardDetail();

  let boardPromise = null;
  if (scope === 'mesh') {
    // Restore the full multi-agent board and clear the single-agent session.
    boardAgentFilter = null;
    if (boardType === 'agent') applyBoardFilter();
    else boardPromise = renderKanban();   // re-render skill/mcp cards unfiltered
    resetChatPane();
  } else {
    // Single-agent scope: update the visible board and wire the session pane
    // immediately; the explorer tree can finish loading afterward.
    boardAgentFilter = scope;
    if (boardType === 'agent') applyBoardFilter();
    else boardPromise = renderKanban();
    setScopedAgentSession(scope);
  }

  await Promise.all([loadExplorer(scope, seq), boardPromise].filter(Boolean));
  if (seq !== _scopeSeq) return;
}

// ---------------------------------------------------------------------------
// Explorer (left pane)
// ---------------------------------------------------------------------------

/**
 * Fetch and render the file tree for the given scope.
 */
async function loadExplorer(scope, seq = null) {
  currentScope = scope;
  const el = document.getElementById('explorer');
  const ph = document.getElementById('exph');
  if (!el) return;

  if (ph) {
    ph.innerHTML = `Explorer · ${scope === 'mesh' ? 'Mesh' : scope} <button id="ex-toggle-files" class="ex-btn ${explorerShowFiles ? 'on' : ''}" title="Toggle files visibility">${explorerShowFiles ? 'Hide Files' : 'Show Files'}</button>`;
    const btn = ph.querySelector('#ex-toggle-files');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        explorerShowFiles = !explorerShowFiles;
        btn.classList.toggle('on', explorerShowFiles);
        btn.textContent = explorerShowFiles ? 'Hide Files' : 'Show Files';
        if (treeData) {
          el.innerHTML = '';
          el.appendChild(buildTreeDom(treeData, scope));
        }
      });
    }
  }

  el.innerHTML = '<div class="loading">Loading tree…</div>';

  try {
    const tree = await apiFetch(`/api/tree?scope=${encodeURIComponent(scope)}`);
    if (seq !== null && seq !== _scopeSeq) return;
    treeData = tree;
    el.innerHTML = '';
    el.appendChild(buildTreeDom(tree, scope));
  } catch (e) {
    if (seq !== null && seq !== _scopeSeq) return;
    el.innerHTML = `<div class="err-panel">Error loading tree: ${esc(e.message)}</div>`;
  }
}

/**
 * Build a DOM tree from flat { path, kind } entries.
 * Groups entries by directory structure.
 */
function buildTreeDom(entries, scope) {
  // Build a hierarchical structure
  const root = { children: new Map(), files: [] };

  for (const entry of entries) {
    const parts = entry.path.replace(/\/$/, '').split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.children.has(part)) {
        node.children.set(part, { children: new Map(), files: [], name: part });
      }
      node = node.children.get(part);
    }
    const name = parts[parts.length - 1];
    if (entry.kind === 'dir') {
      if (!node.children.has(name)) {
        node.children.set(name, { children: new Map(), files: [], name });
      }
    } else {
      node.files.push({ name, fullPath: entry.path });
    }
  }

  const ul = document.createElement('ul');
  appendTreeChildren(ul, root, 1);
  return ul;
}

function appendTreeChildren(ul, node, depth) {
  // Render sorted directories alphabetically first
  const sortedDirs = Array.from(node.children.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [dirName, child] of sortedDirs) {
    const li = document.createElement('li');
    // Collapse all folders by default except root level (depth 1)
    if (depth === 1) {
      li.classList.add('open');
    }

    const row = document.createElement('div');
    row.className = 'row';
    // Dynamic visual depth level visual indentation (removes depth-5 cap)
    row.style.paddingLeft = (16 + (depth - 1) * 14) + 'px';
    row.innerHTML =
      `<span class="chev">›</span>` +
      `<span class="ic">📁</span>` +
      `<span class="nm dir">${esc(dirName)}/</span>`;
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      li.classList.toggle('open');
    });

    const kids = document.createElement('div');
    kids.className = 'kids';
    const subUl = document.createElement('ul');
    appendTreeChildren(subUl, child, depth + 1);
    kids.appendChild(subUl);

    li.appendChild(row);
    li.appendChild(kids);
    ul.appendChild(li);
  }

  // Render sorted files alphabetically if toggled visible
  if (explorerShowFiles) {
    const sortedFiles = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const file of sortedFiles) {
      const li = document.createElement('li');
      li.dataset.leaf = '1';

      const row = document.createElement('div');
      row.className = 'row';
      row.style.paddingLeft = (16 + (depth - 1) * 14) + 'px';
      row.dataset.filePath = file.fullPath;
      row.innerHTML =
        `<span class="chev">›</span>` +
        `<span class="ic">📄</span>` +
        `<span class="nm">${esc(file.name)}</span>`;
      row.addEventListener('click', () => showFile(file.fullPath, row));

      li.appendChild(row);
      ul.appendChild(li);
    }
  }
}

function selectRow(rowEl) {
  document.querySelectorAll('#explorer .row.sel').forEach(r => r.classList.remove('sel'));
  if (rowEl) rowEl.classList.add('sel');
}

// ---------------------------------------------------------------------------
// Board: Kanban
// ---------------------------------------------------------------------------

async function renderKanban() {
  const cardsEl = document.getElementById('cards');
  if (!cardsEl) return;

  cardsEl.innerHTML = '<div class="loading">Loading…</div>';

  try {
    if (boardType === 'agent') {
      await renderAgentCards(cardsEl);
    } else if (boardType === 'skill') {
      await renderSkillCards(cardsEl);
    } else {
      await renderMcpCards(cardsEl);
    }
  } catch (e) {
    cardsEl.innerHTML = `<div class="err-panel">Error: ${esc(e.message)}</div>`;
  }
}

async function renderAgentCards(cardsEl) {
  const data = meshData || (meshData = await apiFetch('/api/mesh'));
  const resources = await getResources();
  const agents = data.agents || [];
  const meshGroup = resourceGroup(resources, 'mesh');

  if (agents.length === 0) {
    cardsEl.innerHTML = '<div class="info-panel">No agents found in mesh.json.</div>';
    return;
  }

  cardsEl.className = 'cards';
  cardsEl.innerHTML = '';
  cardsEl.appendChild(buildMeshOverviewCard(agents, resources));

  agents.forEach((a, i) => {
    const cls = cardClass(a.status);
    const group = resourceGroup(resources, a.name);
    const div = document.createElement('div');
    div.className = 'card ' + cls + ' reveal';
    div.setAttribute('data-agent', a.name);
    div.style.animationDelay = ((i + 1) * 60) + 'ms';

    const peersList = Array.isArray(a.peers) ? a.peers.map(p => esc(p)).join(', ') : '';
    const modeChips = Array.isArray(a.modes)
      ? a.modes.map(m => `<span class="chipm">${esc(m)}</span>`).join('')
      : '';
    
    const localSkillSnippets = group.skills.length > 0
      ? `<div style="font-size:10px;font-family:var(--mono);color:var(--faint);margin-top:8px;text-transform:uppercase;">Local Skills</div>` +
        `<div class="agent-skill-list">` +
        group.skills.slice(0, 3).map(s =>
          `<div class="agent-skill"><b>${esc(s.name)}</b><span>${esc(s.summary || '')}</span></div>`
        ).join('') +
        (group.skills.length > 3 ? `<div class="agent-skill more">+${group.skills.length - 3} more skills</div>` : '') +
        `</div>`
      : `<div style="font-size:10px;font-family:var(--mono);color:var(--faint);margin-top:8px;text-transform:uppercase;">Local Skills</div>` +
        `<div class="agent-skill-list empty">No local skills</div>`;

    const localMcpSnippets = group.mcps.length > 0
      ? `<div style="font-size:10px;font-family:var(--mono);color:var(--faint);margin-top:8px;text-transform:uppercase;">LOCAL MCP (created local MCP inside mesh)</div>` +
        `<div class="agent-mcp-list">` +
        group.mcps.slice(0, 2).map(m =>
          `<div class="agent-mcp">🔌 <b>${esc(m.name)}</b></div>`
        ).join('') +
        (group.mcps.length > 2 ? `<div class="agent-mcp more">+${group.mcps.length - 2} more MCP</div>` : '') +
        `</div>`
      : '';

    const globalMcpSnippets = meshGroup.mcps.length > 0
      ? `<div style="font-size:10px;font-family:var(--mono);color:var(--faint);margin-top:8px;text-transform:uppercase;">GLOBAL MCP (INHERITED FROM CLAUDE MCP)</div>` +
        `<div class="agent-mcp-list">` +
        meshGroup.mcps.slice(0, 2).map(m =>
          `<div class="agent-mcp">🔌 <b>${esc(m.name)}</b></div>`
        ).join('') +
        (meshGroup.mcps.length > 2 ? `<div class="agent-mcp more">+${meshGroup.mcps.length - 2} more MCP</div>` : '') +
        `</div>`
      : '';

    // Board shows STATUS ONLY — no task text or result data (that's chat-only).
    const act = activityFor(a.name);
    const live = livebarHtmlForActivity(act);
    if (act && act.state === 'working') div.classList.add('pulse');

    const totalWiredAgents = Array.isArray(a.peers) ? a.peers.length : 0;

    div.innerHTML =
      `<div class="accent"></div>` +
      `<div style="display:flex;justify-content:space-between;align-items:flex-start">` +
        `<h3>${esc(a.name)}</h3>${statusPill(a.status, a.isolated)}` +
      `</div>` +
      `<div class="meta">${modeChips}</div>` +
      `<div class="resource-metrics">` +
        `<span><b>${totalWiredAgents}</b> wired agents</span>` +
        `<span><b>${meshGroup.counts.skills}</b> global skills</span>` +
        `<span><b>${group.counts.skills}</b> local skills</span>` +
      `</div>` +
      localSkillSnippets +
      globalMcpSnippets +
      localMcpSnippets +
      live +
      `<div class="foot">` +
        `<span class="peers">${peersList ? '→ ' + peersList : 'no peers'}</span>` +
        `<span class="talk">💬 talk</span>` +
      `</div>`;

    div.addEventListener('click', () => {
      // Card click === choosing that agent in the scope filter (keep in sync).
      applyScope(a.name);
    });
    cardsEl.appendChild(div);
  });
  // Re-apply any active single-agent scope filter to the freshly rendered cards.
  applyBoardFilter();
}

function buildMeshOverviewCard(agents, resources) {
  const meshGroup = resourceGroup(resources, 'mesh');
  const div = document.createElement('div');
  div.className = 'card mesh-overview reveal';
  div.setAttribute('data-agent', 'mesh');
  div.style.animationDelay = '0ms';
  const agentRows = agents.map((agent) => {
    const group = resourceGroup(resources, agent.name);
    return `<li><b>${esc(agent.name)}</b><span>${group.counts.skills} skills · ${group.counts.mcps} MCP</span></li>`;
  }).join('');
  
  let totalLocalSkills = 0;
  const localMcpsSet = new Set();
  agents.forEach(a => {
    const group = resourceGroup(resources, a.name);
    totalLocalSkills += group.counts.skills;
    group.mcps.forEach(m => localMcpsSet.add(m.name));
  });

  const globalSkillsRows = meshGroup.skills.length > 0
    ? meshGroup.skills.map(s =>
        `<div class="card-item-row"><span class="icon">✨</span><div class="info"><b>${esc(s.name)}</b><span>${esc(s.summary || 'Global skill')}</span></div></div>`
      ).join('')
    : `<div class="card-item-row"><div class="info"><span class="muted">None</span></div></div>`;

  const globalMcpsRows = meshGroup.mcps.length > 0
    ? meshGroup.mcps.map(m =>
        `<div class="card-item-row"><span class="icon">🔌</span><div class="info"><b>${esc(m.name)}</b><span>${esc(mcpCommand(m) || 'Inherited from Claude MCP')}</span></div><span class="badge-tag">inherited</span></div>`
      ).join('')
    : `<div class="card-item-row"><div class="info"><span class="muted">None</span></div></div>`;

  const localMcpsRows = Array.from(localMcpsSet).length > 0
    ? Array.from(localMcpsSet).map(mName => {
        let cmd = '';
        agents.forEach(a => {
          const group = resourceGroup(resources, a.name);
          const found = group.mcps.find(x => x.name === mName);
          if (found) cmd = mcpCommand(found);
        });
        return `<div class="card-item-row"><span class="icon">🔌</span><div class="info"><b>${esc(mName)}</b><span>${esc(cmd || 'Local MCP')}</span></div><span class="badge-tag">created local</span></div>`;
      }).join('')
    : `<div class="card-item-row"><div class="info"><span class="muted">None</span></div></div>`;

  div.innerHTML =
    `<div class="accent" style="background:var(--slate)"></div>` +
    `<div style="display:flex;justify-content:space-between;align-items:flex-start">` +
      `<h3>Mesh Overview</h3><span class="pill served">global</span>` +
    `</div>` +
    `<div class="resource-metrics">` +
      `<span><b>${agents.length}</b> wired agents</span>` +
      `<span><b>${meshGroup.counts.skills}</b> global skills</span>` +
      `<span><b>${totalLocalSkills}</b> local skills</span>` +
      `<span><b>${meshGroup.counts.mcps}</b> global MCP</span>` +
    `</div>` +
    `<div class="card-section-title">Global Skills</div>` +
    `<div class="card-item-list">${globalSkillsRows}</div>` +
    `<div class="card-section-title">GLOBAL MCP (INHERITED FROM CLAUDE MCP)</div>` +
    `<div class="card-item-list">${globalMcpsRows}</div>` +
    `<div class="card-section-title">LOCAL MCP (created local MCP inside mesh)</div>` +
    `<div class="card-item-list">${localMcpsRows}</div>` +
    `<ul class="mesh-agent-list" style="margin-top:12px">${agentRows}</ul>`;
  div.addEventListener('click', () => showMeshResourceDetail(resources));
  return div;
}

async function renderSkillCards(cardsEl) {
  await renderResourceBoard(cardsEl, 'skills');
}

async function renderMcpCards(cardsEl) {
  await renderResourceBoard(cardsEl, 'mcps');
}

/**
 * Render the skill/MCP board from the grouped /api/resources view-model.
 * Groups (mesh-global + one per agent) are shown as cards or as a list, each
 * group holding its own clickable resource items. When scoped to a single
 * agent we show that agent's group plus the shared mesh-global group — its
 * effective set, NOT every other agent's resources.
 */
async function renderResourceBoard(cardsEl, kind) {
  const resources = await getResources();
  let groups = resources.groups || [];

  if (boardAgentFilter) {
    groups = groups.filter(g => g.id === boardAgentFilter);
  }
  // Only render groups that actually have items of this kind.
  groups = groups.filter(g => itemsForKind(g, kind).length > 0);

  if (groups.length === 0) {
    const noun = kind === 'skills' ? 'skills' : 'MCP servers';
    const where = boardAgentFilter ? `for "${esc(boardAgentFilter)}"` : 'in this mesh';
    cardsEl.innerHTML = `<div class="info-panel">No ${noun} found ${where}.</div>`;
    return;
  }

  cardsEl.className = resourceBoardView === 'list' ? 'cards resource-list-mode' : 'cards resource-card-mode';
  cardsEl.innerHTML = '';

  if (resourceBoardView === 'list') {
    const board = document.createElement('div');
    board.className = 'resource-list-board reveal';
    board.innerHTML = groups.map(group => resourceListGroupHtml(group, kind)).join('');
    cardsEl.appendChild(board);
  } else {
    groups.forEach((group, i) => {
      const div = document.createElement('div');
      div.className = 'card resource-group-card reveal';
      div.style.animationDelay = (i * 45) + 'ms';
      div.innerHTML = resourceGroupCardHtml(group, kind);
      cardsEl.appendChild(div);
    });
  }

  wireResourceItemClicks(cardsEl, resources, kind);
}

function resourceGroupCountLabel(group, kind) {
  const count = itemsForKind(group, kind).length;
  const noun = kind === 'skills' ? 'skill' : 'MCP';
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function resourceGroupCardHtml(group, kind) {
  const pill = group.kind === 'mesh'
    ? '<span class="pill served">global</span>'
    : '<span class="pill alone">agent</span>';
  return `<div class="resource-group-head">` +
      `<div><h3>${esc(group.label)}</h3><span>${resourceGroupCountLabel(group, kind)}</span></div>` +
      pill +
    `</div>` +
    `<div class="resource-items">${resourceBoardItemsHtml(group, kind, 'card')}</div>`;
}

function resourceListGroupHtml(group, kind) {
  return `<div class="resource-list-group">` +
      `<div class="rl-head"><b>${esc(group.label)}</b><span>${resourceGroupCountLabel(group, kind)}</span></div>` +
      `<div class="rl-rows">${resourceBoardItemsHtml(group, kind, 'list')}</div>` +
    `</div>`;
}

function resourceBoardItemsHtml(group, kind, mode) {
  const items = itemsForKind(group, kind);
  if (!items.length) return `<span class="resource-empty">—</span>`;
  return items.map(item => {
    const summary = kind === 'skills' ? item.summary || '' : mcpCommand(item);
    const badge = kind === 'skills'
      ? '<span class="pill alone">skill</span>'
      : grantPill(item.grant);
    return `<button class="resource-item ${mode === 'list' ? 'list' : ''}" type="button" data-resource-source="${esc(group.id)}" data-resource-name="${esc(item.name)}">` +
      `<span class="ri-main"><b>${esc(item.name)}</b>${badge}</span>` +
      `<span class="ri-desc ${kind === 'mcps' ? 'mono' : ''}">${esc(summary || '')}</span>` +
    `</button>`;
  }).join('');
}

function grantPill(grant) {
  if (grant === 'declared-only') return '<span class="pill alone">declared</span>';
  if (grant === 'readOnly') return '<span class="pill served">readOnly</span>';
  return '<span class="pill warn">granted</span>';
}

function wireResourceItemClicks(root, resources, kind) {
  root.querySelectorAll('[data-resource-name]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const group = resourceGroup(resources, btn.dataset.resourceSource);
      const item = itemsForKind(group, kind).find(x => x.name === btn.dataset.resourceName);
      if (!item) return;
      if (kind === 'skills') showSkillDetail(item);
      else showMcpDetail(item);
    });
  });
}

// ---------------------------------------------------------------------------
// Board: Graph
// ---------------------------------------------------------------------------

async function renderGraph() {
  const graphEl = document.getElementById('graphSvg');
  if (!graphEl || !meshData) return;

  const resources = await getResources();
  const agents = meshData.agents || [];

  // Clear existing dynamic content
  while (graphEl.firstChild) graphEl.removeChild(graphEl.firstChild);

  const W = 700, H = 460;

  // Add markers
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML =
    `<marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">` +
    `<path d="M0,0 L0,6 L8,3 z" fill="rgba(15,122,107,.65)"/>` +
    `</marker>` +
    `<marker id="arr-dangle" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">` +
    `<path d="M0,0 L0,6 L8,3 z" fill="rgba(184,116,42,.65)"/>` +
    `</marker>` +
    `<marker id="card-arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">` +
    `<path d="M0,0 L0,6 L6,3 z" fill="var(--teal)"/>` +
    `</marker>`;
  graphEl.appendChild(defs);

  if (agents.length === 0) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', String(W / 2));
    t.setAttribute('y', String(H / 2));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('font-family', 'var(--mono)');
    t.setAttribute('font-size', '12');
    t.setAttribute('fill', 'var(--faint)');
    t.textContent = 'No agents in mesh';
    graphEl.appendChild(t);
    return;
  }

  // 1. Gather all nodes (tripartite)
  const agentNodes = [];
  const skillNodes = [];
  const mcpNodes = [];

  const skillSet = new Set();
  const mcpSet = new Set();

  agents.forEach(a => {
    agentNodes.push({ id: a.name, type: 'agent', label: a.name, status: a.status, isolated: a.isolated, agent: a.name });
    const group = resourceGroup(resources, a.name);
    group.skills.forEach(s => {
      const sId = 'skill:' + s.name;
      if (!skillSet.has(sId)) {
        skillSet.add(sId);
        skillNodes.push({ id: sId, type: 'skill', label: s.name, agent: a.name });
      }
    });
    group.mcps.forEach(m => {
      const mId = 'mcp:' + m.name;
      if (!mcpSet.has(mId)) {
        mcpSet.add(mId);
        mcpNodes.push({ id: mId, type: 'mcp', label: m.name, agent: a.name });
      }
    });
  });

  // Global mesh group
  const meshGroup = resourceGroup(resources, 'mesh');
  meshGroup.skills.forEach(s => {
    const sId = 'skill:' + s.name;
    if (!skillSet.has(sId)) {
      skillSet.add(sId);
      skillNodes.push({ id: sId, type: 'skill', label: s.name, agent: 'mesh' });
    }
  });
  meshGroup.mcps.forEach(m => {
    const mId = 'mcp:' + m.name;
    if (!mcpSet.has(mId)) {
      mcpSet.add(mId);
      mcpNodes.push({ id: mId, type: 'mcp', label: m.name, agent: 'mesh' });
    }
  });

  // 2. Positions calculation
  const positions = new Map();

  // Column X positions
  const agentX = 100;
  const skillX = 350;
  const mcpX = 600;

  agentNodes.forEach((node, i) => {
    const y = (H / 2) + (i - (agentNodes.length - 1) / 2) * 90;
    positions.set(node.id, { x: agentX, y });
  });

  skillNodes.forEach((node, i) => {
    const y = (H / 2) + (i - (skillNodes.length - 1) / 2) * 50;
    positions.set(node.id, { x: skillX, y });
  });

  mcpNodes.forEach((node, i) => {
    const y = (H / 2) + (i - (mcpNodes.length - 1) / 2) * 55;
    positions.set(node.id, { x: mcpX, y });
  });

  // 3. Draw Edges
  // A. Agent -> Agent delegation edges from meshData.graph
  const meshEdges = meshData.graph?.edges || [];
  for (const edge of meshEdges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;

    // Direct delegation link between agent circles
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const pathData = `M ${from.x} ${from.y} C ${(from.x + to.x)/2} ${(from.y + to.y)/2 - 40}, ${(from.x + to.x)/2} ${(from.y + to.y)/2 - 40}, ${to.x} ${to.y}`;
    line.setAttribute('d', pathData);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'var(--teal)');
    line.setAttribute('stroke-width', '1.8');
    line.setAttribute('opacity', '0.4');
    line.setAttribute('class', 'edge');
    line.setAttribute('data-from', edge.from);
    line.setAttribute('data-to', edge.to);
    // Draw dangling with arr-dangle
    line.setAttribute('marker-end', edge.kind === 'dangling' ? 'url(#arr-dangle)' : 'url(#arr)');
    graphEl.appendChild(line);
  }

  // B. Agent -> Skill edges
  skillNodes.forEach(sNode => {
    const from = positions.get(sNode.agent);
    const to = positions.get(sNode.id);
    if (from && to) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(from.x));
      line.setAttribute('y1', String(from.y));
      line.setAttribute('x2', String(to.x - 55));
      line.setAttribute('y2', String(to.y));
      line.setAttribute('stroke', '#a0c0b8');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('class', 'edge');
      line.setAttribute('data-from', sNode.agent);
      line.setAttribute('data-to', sNode.id);
      graphEl.appendChild(line);
    }
  });

  // C. Agent -> MCP edges
  mcpNodes.forEach(mNode => {
    const from = positions.get(mNode.agent);
    const to = positions.get(mNode.id);
    if (from && to) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(from.x));
      line.setAttribute('y1', String(from.y));
      line.setAttribute('x2', String(to.x - 55));
      line.setAttribute('y2', String(to.y));
      line.setAttribute('stroke', '#ccd5db');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('class', 'edge');
      line.setAttribute('data-from', mNode.agent);
      line.setAttribute('data-to', mNode.id);
      graphEl.appendChild(line);
    }
  });

  // D. Skill -> MCP edges (heuristic relations)
  skillNodes.forEach(sNode => {
    mcpNodes.forEach(mNode => {
      // Check heuristic relation
      let relates = false;
      const sName = sNode.label.toLowerCase();
      const mName = mNode.label.toLowerCase();
      const sAgent = sNode.agent;
      const mAgent = mNode.agent;

      // Only relate within same agent or global scope
      if (sAgent === mAgent || sAgent === 'mesh' || mAgent === 'mesh') {
        if (sName.includes('deploy') || sName.includes('git') || sName.includes('file')) {
          if (mName.includes('git') || mName.includes('file') || mName.includes('fs')) relates = true;
        }
        if (sName.includes('shell') || sName.includes('exec') || sName.includes('validation')) {
          if (mName.includes('shell') || mName.includes('cmd') || mName.includes('exec')) relates = true;
        }
        // Fallback: if single skill/mcp for agent, connect them
        if (sAgent !== 'mesh' && mAgent !== 'mesh') {
          const sCount = skillNodes.filter(s => s.agent === sAgent).length;
          const mCount = mcpNodes.filter(m => m.agent === mAgent).length;
          if (sCount === 1 || mCount === 1) relates = true;
        }
      }

      if (relates) {
        const from = positions.get(sNode.id);
        const to = positions.get(mNode.id);
        if (from && to) {
          const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          line.setAttribute('x1', String(from.x + 55));
          line.setAttribute('y1', String(from.y));
          line.setAttribute('x2', String(to.x - 55));
          line.setAttribute('y2', String(to.y));
          line.setAttribute('stroke', 'var(--teal)');
          line.setAttribute('stroke-width', '1.2');
          line.setAttribute('stroke-dasharray', '2 2');
          line.setAttribute('class', 'edge');
          line.setAttribute('data-from', sNode.id);
          line.setAttribute('data-to', mNode.id);
          line.setAttribute('marker-end', 'url(#card-arr)');
          graphEl.appendChild(line);
        }
      }
    });
  });

  // 4. Draw Nodes
  // A. Agent Nodes
  for (const node of agentNodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;

    const statusColor = node.status === 'served' ? '#0f7a6b' : node.status === 'drift' ? '#faf2e7' : '#f0f0f0';
    const textColor = node.status === 'served' ? '#fff' : 'var(--ink)';

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'gnode');
    g.setAttribute('data-agent', node.id);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(pos.x));
    circle.setAttribute('cy', String(pos.y));
    circle.setAttribute('r', '32');
    circle.setAttribute('fill', statusColor);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(pos.x));
    label.setAttribute('y', String(pos.y + 4));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', textColor);
    label.setAttribute('class', 'label');
    label.setAttribute('font-size', '10px');
    label.textContent = node.id;

    g.appendChild(circle);
    g.appendChild(label);

    // Hover tooltip
    g.addEventListener('mousemove', (e) => showGraphTooltip(e, node));
    g.addEventListener('mouseleave', hideGraphTooltip);
    g.addEventListener('click', () => applyScope(node.id));
    graphEl.appendChild(g);
  }

  // B. Skill Nodes (Rounded Rects)
  for (const node of skillNodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'gnode');
    g.setAttribute('data-agent', node.agent);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(pos.x - 50));
    rect.setAttribute('y', String(pos.y - 10));
    rect.setAttribute('width', '100');
    rect.setAttribute('height', '20');
    rect.setAttribute('rx', '6');
    rect.setAttribute('fill', 'var(--teal-soft)');
    rect.setAttribute('stroke', 'var(--teal)');
    rect.setAttribute('stroke-width', '1');

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(pos.x));
    label.setAttribute('y', String(pos.y + 4));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', 'var(--teal)');
    label.setAttribute('class', 'label');
    label.setAttribute('font-size', '9.5px');
    label.textContent = node.label.length > 14 ? node.label.slice(0, 13) + '…' : node.label;

    g.appendChild(rect);
    g.appendChild(label);
    graphEl.appendChild(g);
  }

  // C. MCP Nodes (Rounded Rects)
  for (const node of mcpNodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'gnode');
    g.setAttribute('data-agent', node.agent);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(pos.x - 50));
    rect.setAttribute('y', String(pos.y - 10));
    rect.setAttribute('width', '100');
    rect.setAttribute('height', '20');
    rect.setAttribute('rx', '6');
    rect.setAttribute('fill', 'var(--slate-soft)');
    rect.setAttribute('stroke', 'var(--slate)');
    rect.setAttribute('stroke-width', '1');

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(pos.x));
    label.setAttribute('y', String(pos.y + 4));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('fill', 'var(--slate)');
    label.setAttribute('class', 'label');
    label.setAttribute('font-size', '9px');
    label.textContent = '🔌 ' + (node.label.length > 11 ? node.label.slice(0, 10) + '…' : node.label);

    g.appendChild(rect);
    g.appendChild(label);
    graphEl.appendChild(g);
  }

  // 5. Live active delegation animations
  const SVGNS = 'http://www.w3.org/2000/svg';
  for (const e of (activity.edges || [])) {
    const from = positions.get(e.from);
    const to = positions.get(e.to);
    if (!from || !to) continue;

    const line = document.createElementNS(SVGNS, 'path');
    const pathData = `M ${from.x} ${from.y} C ${(from.x + to.x)/2} ${(from.y + to.y)/2 - 40}, ${(from.x + to.x)/2} ${(from.y + to.y)/2 - 40}, ${to.x} ${to.y}`;
    line.setAttribute('d', pathData);
    line.setAttribute('fill', 'none');
    line.setAttribute('class', e.active ? 'edge-live active' : 'edge-live done');
    line.setAttribute('data-from', e.from);
    line.setAttribute('data-to', e.to);
    graphEl.appendChild(line);

    // Live overlay bubble
    const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2 - 20;
    const text = e.active ? 'working' : '✓';
    const padW = Math.max(34, text.length * 6 + 14);

    const bub = document.createElementNS(SVGNS, 'rect');
    bub.setAttribute('x', String(mx - padW / 2));
    bub.setAttribute('y', String(my - 9));
    bub.setAttribute('width', String(padW));
    bub.setAttribute('height', '17');
    bub.setAttribute('rx', '8.5');
    bub.setAttribute('class', e.active ? 'bub active' : 'bub done');
    bub.setAttribute('data-from', e.from);
    bub.setAttribute('data-to', e.to);
    graphEl.appendChild(bub);

    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', String(mx));
    t.setAttribute('y', String(my + 3));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'bubtext');
    t.setAttribute('data-from', e.from);
    t.setAttribute('data-to', e.to);
    t.textContent = text;
    graphEl.appendChild(t);
  }

  // Apply scope filter styling immediately
  applyBoardFilter();
}

function showGraphTooltip(e, node) {
  const tip = document.getElementById('gtip');
  if (!tip) return;
  // Find agent data
  const agentData = meshData?.agents?.find(a => a.name === node.id);
  const modes = agentData?.modes?.join(', ') || '—';
  const peers = agentData?.peers?.join(', ') || '—';
  const status = node.status + (node.isolated ? ' · isolated' : '');

  tip.innerHTML =
    `<b>${esc(node.id)}</b> &nbsp;<span class="s">${esc(status)}</span><br>` +
    `modes: ${esc(modes)}<br>` +
    `peers: ${esc(peers)}<br>` +
    `<span style="opacity:.55">click → open detail</span>`;
  tip.style.display = 'block';
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 244) + 'px';
  tip.style.top = (e.clientY + 14) + 'px';
}

function hideGraphTooltip() {
  const tip = document.getElementById('gtip');
  if (tip) tip.style.display = 'none';
}

// ---------------------------------------------------------------------------
// File content (inline, in the board section's card-detail area)
// ---------------------------------------------------------------------------

async function showFile(filePath, rowEl) {
  selectRow(rowEl || null);
  const desk = openCardDetail(
    `<span class="ic">📄</span><span class="t mono">${esc(filePath)}</span><span class="badge">read-only</span>`,
    `<div class="filebody reveal"><div class="loading">Loading…</div></div>`
  );
  if (!desk) return;

  try {
    const data = await apiFetch(`/api/file?path=${encodeURIComponent(filePath)}&scope=${encodeURIComponent(currentScope)}`);
    const body = desk.querySelector('.filebody');

    if (data.kind === 'text') {
      const ext = filePath.split('.').pop().toLowerCase();
      if (ext === 'md') {
        body.innerHTML = `<div class="canvas reveal">${renderMarkdown(data.content)}</div>`;
        // Wire copy-table buttons
        body.querySelectorAll('[data-copy-table]').forEach(btn => {
          btn.addEventListener('click', () => {
            const table = btn.parentElement.querySelector('table');
            if (!table) return;
            const tsv = tableToTsv(table);
            navigator.clipboard.writeText(tsv).then(() => {
              const orig = btn.textContent;
              btn.textContent = '✓ copied';
              setTimeout(() => { btn.textContent = orig; }, 1200);
            });
          });
        });
      } else {
        body.innerHTML = `<pre>${esc(data.content)}</pre>`;
      }
    } else if (data.kind === 'metadata') {
      body.innerHTML =
        `<div class="info-panel">` +
          `${data.reason === 'file_too_large' ? '⚠ File too large to display' : '⚠ Binary file'}` +
          `<br>Path: ${esc(data.path)}<br>Size: ${data.size} bytes` +
        `</div>`;
    } else {
      body.innerHTML = `<div class="err-panel">Unexpected response from server.</div>`;
    }
  } catch (e) {
    const body = desk.querySelector('.filebody');
    if (body) body.innerHTML = `<div class="err-panel">Error loading file: ${esc(e.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Inline card detail (lives in the board section, below the cards)
// ---------------------------------------------------------------------------

/**
 * Open the inline card-detail panel under the board cards.
 * Replaces the previous "render into the right desk" behavior for board clicks,
 * keeping the desk free for explorer-driven file content (showFile).
 *
 * @param {string} headInner  innerHTML for the head row (icon + title + badge)
 * @param {string} bodyHtml   initial body HTML (e.g. loading placeholder)
 * @returns {HTMLElement|null}  the populated container, or null if absent
 */
function openCardDetail(headInner, bodyHtml) {
  const el = document.getElementById('card-detail');
  if (!el) return null;
  el.innerHTML =
    `<div class="insp-head">${headInner}` +
      `<button class="cd-close" type="button" title="Close" data-close>×</button>` +
    `</div>` +
    bodyHtml;
  el.classList.remove('hidden');
  el.querySelector('[data-close]')?.addEventListener('click', () => {
    el.classList.add('hidden');
    el.innerHTML = '';
  });
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return el;
}

function closeCardDetail() {
  const el = document.getElementById('card-detail');
  if (!el) return;
  el.classList.add('hidden');
  el.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Agent detail (inline, in the board section)
// ---------------------------------------------------------------------------

function showMeshResourceDetail(resources) {
  const meshGroup = resourceGroup(resources, 'mesh');
  const agentGroups = (resources.groups || []).filter(g => g.kind === 'agent');
  const desk = openCardDetail(
    `<span class="ic">◆</span><span class="t">Mesh resources</span><span class="badge">overview</span>`,
    `<div class="adetail reveal">` +
      `<div class="aname">Mesh</div>` +
      `<div class="adesc">Global resources and per-agent local resources.</div>` +
      `<div class="resource-metrics detail">` +
        `<span><b>${agentGroups.length}</b> wired agents</span>` +
        `<span><b>${meshGroup.counts.skills}</b> global skills</span>` +
        `<span><b>${meshGroup.counts.mcps}</b> global MCP</span>` +
      `</div>` +
      resourceDetailSection(meshGroup, 'skills') +
      `<div class="detail-resource-section">` +
        `<div class="dr-title">GLOBAL MCP (INHERITED FROM CLAUDE MCP)</div>` +
        `<div class="resource-items compact">${resourceItemsHtml(meshGroup, 'mcps', 'list')}</div>` +
      `</div>` +
      `<div class="detail-resource-stack">` +
        agentGroups.map(group =>
          `<div class="detail-resource-group">` +
            `<div class="dr-head"><b>${esc(group.label)}</b><span>${group.counts.skills} skills · ${group.counts.mcps} MCP</span></div>` +
            resourceDetailSection(group, 'skills') +
            `<div class="detail-resource-section">` +
              `<div class="dr-title">LOCAL MCP (created local MCP inside mesh)</div>` +
              `<div class="resource-items compact">${resourceItemsHtml(group, 'mcps', 'list')}</div>` +
            `</div>` +
          `</div>`
        ).join('') +
      `</div>` +
    `</div>`
  );
  if (desk) {
    wireResourceItemClicks(desk, resources, 'skills');
    wireResourceItemClicks(desk, resources, 'mcps');
  }
}

// Items of a given kind ('skills' | 'mcps') within a resource group.
function itemsForKind(group, kind) {
  return (kind === 'skills' ? group?.skills : group?.mcps) || [];
}

// Render a resource group's items as clickable chips that open the skill/MCP
// detail. data-resource-name / data-resource-source are consumed by
// wireResourceItemClicks. (Reconstructed: the merged "group resources" feature
// referenced this helper but never defined it.)
function resourceItemsHtml(group, kind, mode) {
  const items = itemsForKind(group, kind);
  if (!items.length) return `<span class="resource-empty">—</span>`;
  const cls = mode === 'list' ? 'resource-item as-list' : 'resource-item';
  return items.map(it =>
    `<button class="${cls}" data-resource-name="${esc(it.name)}" ` +
    `data-resource-source="${esc(it.source || group.id)}" ` +
    `title="${esc(it.summary || it.name)}">${esc(it.name)}</button>`
  ).join('');
}

function resourceDetailSection(group, kind) {
  const title = kind === 'skills' ? 'Skills' : 'MCP';
  return `<div class="detail-resource-section">` +
    `<div class="dr-title">${title}</div>` +
    `<div class="resource-items compact">${resourceItemsHtml(group, kind, 'list')}</div>` +
  `</div>`;
}

// ---------------------------------------------------------------------------
// Native CLI entry point ("Open in Claude Code") — privileged, opt-in
// ---------------------------------------------------------------------------

/** The amber "native session" block for the agent detail (Variant A). */
function nativeSessionBlock(name) {
  if (!shellEnabled) {
    return `<div class="block native"><div class="bh"><span class="dotn"></span> native session</div>` +
      `<div class="bb"><div class="ndesc">Launch the <b>native Claude Code CLI</b> in this agent's folder.</div>` +
      `<div class="noff">Disabled — the dashboard is read-only. Enable with ` +
      `<code>agent-mesh dashboard . --allow-shell</code> or <code>AGENT_MESH_DASHBOARD_SHELL=1</code>.</div></div></div>`;
  }
  return `<div class="block native"><div class="bh"><span class="dotn"></span> native session</div>` +
    `<div class="bb">` +
      `<div class="ndesc">Drops you into the <b>real interactive Claude Code CLI</b> in this folder, mesh-aware (peer delegation + mesh tools) — full tools, your own terminal.</div>` +
      `<div class="npriv">⚠ Privileged: a full-tool native session, <b>not</b> path-guarded or ask-only. Opens in your terminal, under your account.</div>` +
      `<button class="openbtn" data-open-cli="${esc(name)}">⌘ Open in Claude Code</button>` +
    `</div></div>`;
}

/** plan → confirm (shows exact command) → launch. */
async function openNativeCli(name) {
  let plan;
  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(name)}/shell/plan`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    plan = await res.json();
    if (!plan.ok) { showToast(`Cannot launch: ${esc(plan.error?.code || 'error')}`); return; }
  } catch (e) { showToast(`Network error: ${esc(e.message)}`); return; }

  confirmNativeLaunch(name, plan, async () => {
    if (!plan.supported) { showToast('No terminal opener on this OS — command copied? paste it manually.'); return; }
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(name)}/shell/launch`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan.planId })
      });
      const out = await res.json();
      showToast(out.ok ? `Opened Claude Code in your terminal · ${esc(name)}` : `Could not open (${esc(out.reason || 'error')}) — copy the command`);
    } catch (e) { showToast(`Network error: ${esc(e.message)}`); }
  });
}

/** Confirm dialog showing the EXACT command that will run. */
function confirmNativeLaunch(name, plan, onConfirm) {
  const scrim = document.createElement('div');
  scrim.className = 'scrim on';
  scrim.innerHTML =
    `<div class="modal">` +
      `<div class="mh">Open native Claude Code?</div>` +
      `<div class="mb">Opens your terminal running interactive <b>claude</b> in <b>${esc(name)}</b>'s folder, as a mesh-aware session.` +
        `<div class="mwarn">Full-tool session (Bash/Write/Edit), <b>not</b> path-guarded or ask-only. Runs under your account.</div>` +
        `<div class="mcmd"><button class="mcopy" data-copy-cmd>⧉ copy</button><pre>${esc(plan.command || '')}</pre></div>` +
      `</div>` +
      `<div class="mf"><button class="btn ghost" data-cancel>Cancel</button>` +
      `<button class="btn primary" data-go ${plan.supported ? '' : 'disabled'}>Open Terminal</button></div>` +
    `</div>`;
  document.body.appendChild(scrim);
  const close = () => scrim.remove();
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  scrim.querySelector('[data-cancel]').addEventListener('click', close);
  scrim.querySelector('[data-copy-cmd]').addEventListener('click', () => {
    navigator.clipboard.writeText(plan.command || '').then(() => { const b = scrim.querySelector('[data-copy-cmd]'); b.textContent = '✓ copied'; });
  });
  scrim.querySelector('[data-go]').addEventListener('click', () => { close(); onConfirm(); });
  document.addEventListener('keydown', function esc2(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); } });
}

let _toastTimer = null;
function showToast(html) {
  let t = document.getElementById('am-toast');
  if (!t) { t = document.createElement('div'); t.id = 'am-toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.innerHTML = html;
  t.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('on'), 3200);
}

async function showAgentDetail(name) {
  // Variant A: a compact native-CLI action in the header (only when enabled).
  const headerAction = shellEnabled
    ? `<button class="openbtn sm" data-open-cli="${esc(name)}">⌘ Open in Claude Code</button>`
    : '';
  const desk = openCardDetail(
    `<span class="ic">◆</span><span class="t">${esc(name)}</span><span class="badge">agent</span>${headerAction}`,
    `<div class="adetail reveal"><div class="loading">Loading agent detail…</div></div>`
  );
  if (!desk) return;
  const hdrBtn = desk.querySelector('[data-open-cli]');
  if (hdrBtn) hdrBtn.addEventListener('click', () => openNativeCli(name));

  try {
    const data = await apiFetch(`/api/agent/${encodeURIComponent(name)}`);
    const detail = desk.querySelector('.adetail');
    const entry = data.entry || {};
    const card = data.card || {};
    const structure = data.structure || {};
    const resources = await getResources();
    const group = resourceGroup(resources, name);

    // Modes, peers, skills from entry + structure
    const modes = Array.isArray(entry.enabledModes) ? entry.enabledModes : [];
    const peers = Array.isArray(entry.peers) ? entry.peers : [];
    const desc = card.description || structure.description || entry.description || '';

    // Find status from meshData
    const agentInfo = meshData?.agents?.find(a => a.name === name);
    const status = agentInfo?.status || 'unknown';
    const isolated = agentInfo?.isolated || false;

    detail.innerHTML =
      `<div class="aname">${esc(name)}</div>` +
      `<div class="adesc">${esc(desc)}</div>` +
      `<div class="kv">` +
        `<span class="k">status</span><span class="v">${statusPill(status, isolated)}</span>` +
        `<span class="k">modes</span><span class="v">${modes.map(m => `<span class="mch">${esc(m)}</span>`).join('')}</span>` +
        `<span class="k">peers</span><span class="v">${peers.map(p => esc(p)).join(', ') || '—'}</span>` +
        `<span class="k">skills</span><span class="v">${group.counts.skills}</span>` +
        `<span class="k">mcp</span><span class="v">${group.counts.mcps}</span>` +
        `<span class="k">root</span><span class="v mono" style="font-size:10px">${esc(entry.root || '')}</span>` +
      `</div>` +
      resourceDetailSection(group, 'skills') +
      `<div class="detail-resource-section">` +
        `<div class="dr-title">GLOBAL MCP (INHERITED FROM CLAUDE MCP)</div>` +
        `<div class="resource-items compact">${resourceItemsHtml(meshGroup, 'mcps', 'list')}</div>` +
      `</div>` +
      `<div class="detail-resource-section">` +
        `<div class="dr-title">LOCAL MCP (created local MCP inside mesh)</div>` +
        `<div class="resource-items compact">${resourceItemsHtml(group, 'mcps', 'list')}</div>` +
      `</div>` +
      nativeSessionBlock(name);
    wireResourceItemClicks(detail, resources, 'skills');
    wireResourceItemClicks(detail, resources, 'mcps');
    const blockBtn = detail.querySelector('[data-open-cli]');
    if (blockBtn) blockBtn.addEventListener('click', () => openNativeCli(name));
    // Chat lives in a separate pane (#inspect) — rewire it to this agent.
    setChatAgent(name, status, modes);
  } catch (e) {
    const detail = desk.querySelector('.adetail');
    if (detail) {
      detail.innerHTML = `<div class="err-panel">Error loading agent detail: ${esc(e.message)}</div>`;
    }
  }
}

// ---------------------------------------------------------------------------
// Chat pane (right side, persistent — separate from the board card detail)
// ---------------------------------------------------------------------------

/** Wire the chat pane (#inspect) to a specific agent. Called when a card / graph node is clicked. */
function setChatAgent(name, status, modes) {
  const pane = document.getElementById('inspect');
  if (!pane) return;
  // In-dashboard chat is off by default — the dashboard is a read-only monitor and
  // Claude is driven from the external CLI. In that mode, mount only the session
  // mirror so the top scope selector can switch agents without a stale header.
  if (!chatEnabled) {
    // Read-only: NO chat composer (drive the agent from the external Claude CLI),
    // but still MOUNT the session-log B-view so the dashboard displays live output
    // (transcript + result canvas: tables, charts, summaries).
    pane.innerHTML = sessionLogEnabled ? `<div class="sl-mount" id="sl-mount"></div>` : '';
    pane.classList.toggle('has-sl', sessionLogEnabled);
    if (sessionLogEnabled) mountSessionLogPane(pane, name);
    return;
  }
  pane.innerHTML =
    `<div class="console" data-agent="${esc(name)}">` +
      `<div class="ch"><span class="dotg"></span> chat — talk to ${esc(name)} <span class="ask-tag">ask-only</span></div>` +
      `<div class="console-log" id="clog"></div>` +
      consoleComposerHtml(name, status, modes) +
    `</div>` +
    (sessionLogEnabled ? `<div class="sl-mount" id="sl-mount"></div>` : '');
  wireConsole(pane, name, status, modes);
  // Widen + flex the pane so the session-log B-view (rail + result canvas) is
  // visible and usable; removed in resetChatPane. Layout presets still override.
  pane.classList.toggle('has-sl', sessionLogEnabled);
  if (sessionLogEnabled) mountSessionLogPane(pane, name);
}

function setScopedAgentSession(name) {
  const agentInfo = (meshData?.agents || []).find(a => a.name === name) || {};
  const status = agentInfo.status || 'unknown';
  const modes = Array.isArray(agentInfo.modes)
    ? agentInfo.modes
    : Array.isArray(agentInfo.enabledModes) ? agentInfo.enabledModes : [];
  setChatAgent(name, status, modes);
}

// Tear down any previous session-log instance, then mount one for `name` into the
// chat pane's #sl-mount container. session-log.js is an ES module exposing
// mountSessionLog on window (loaded via <script type="module"> in index.html).
let _slInstance = null;
function mountSessionLogPane(pane, name) {
  if (_slInstance) { try { _slInstance.destroy(); } catch { /* ignore */ } _slInstance = null; }
  const mount = pane.querySelector('#sl-mount');
  if (!mount || typeof window.mountSessionLog !== 'function') return;
  _slInstance = window.mountSessionLog(mount, name);
}

/** Reset the chat pane to its empty state. */
function resetChatPane() {
  if (_slInstance) { try { _slInstance.destroy(); } catch { /* ignore */ } _slInstance = null; }
  const pane = document.getElementById('inspect');
  if (!pane) return;
  pane.classList.remove('has-sl');
  pane.innerHTML = `<div class="info-panel">Select an agent card to start chatting.</div>`;
}

// ---------------------------------------------------------------------------
// Desk: console (ask-only A2A entry point)
// ---------------------------------------------------------------------------

/** Whether the console can talk to this agent (served + ask enabled). */
function consoleEnabled(status, modes) {
  return status === 'served' && Array.isArray(modes) && modes.includes('ask');
}

function consoleComposerHtml(name, status, modes) {
  if (!consoleEnabled(status, modes)) {
    const why = status !== 'served'
      ? `Agent is ${esc(status)} — not served, so it can't be reached.`
      : `Agent has no <code>ask</code> mode enabled. The console is ask-only.`;
    return `<div class="console-disabled">${why}</div>`;
  }
  return (
    `<form class="composer" id="composer">` +
      `<textarea id="cinput" rows="2" placeholder="Ask ${esc(name)} something… (Enter to send, Shift+Enter for newline)"></textarea>` +
      `<button type="submit" id="csend">Send</button>` +
    `</form>`
  );
}

function wireConsole(desk, name, status, modes) {
  if (!consoleEnabled(status, modes)) return;
  const form = desk.querySelector('#composer');
  const input = desk.querySelector('#cinput');
  const sendBtn = desk.querySelector('#csend');
  const log = desk.querySelector('#clog');
  if (!form || !input || !log) return;

  let inflight = false;

  const submit = async () => {
    const text = input.value.trim();
    if (!text || inflight) return;
    inflight = true;
    sendBtn.disabled = true;
    input.disabled = true;

    appendConsoleMsg(log, 'user', renderMarkdown(text));
    const pending = appendConsoleMsg(log, 'agent pending', '<span class="loading">…thinking</span>');
    input.value = '';

    try {
      const sessionBacked = sessionLogEnabled;
      const endpoint = sessionBacked
        ? `/api/agent/${encodeURIComponent(name)}/session/message`
        : `/api/agent/${encodeURIComponent(name)}/message`;
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text })
      });
      const data = await res.json().catch(() => ({ ok: false, error: { code: 'internal', message: `HTTP ${res.status}` } }));
      pending.remove();
      if (sessionBacked) {
        if (res.ok || res.status === 202 || data.ok) {
          appendConsoleMsg(log, 'agent pending', '<span class="loading">sent to session</span>');
        } else {
          const err = data.error || {};
          appendConsoleMsg(log, 'agent error',
            `<b>${esc(err.code || 'error')}</b> — ${esc(err.message || 'request failed')}`);
        }
        return;
      }
      if (data.ok) {
        renderConsoleTask(log, data.task, data.delegations);
      } else {
        const err = data.error || {};
        appendConsoleMsg(log, 'agent error',
          `<b>${esc(err.code || 'error')}</b> — ${esc(err.message || 'request failed')}`);
      }
    } catch (e) {
      pending.remove();
      appendConsoleMsg(log, 'agent error', `Network error: ${esc(e.message)}`);
    } finally {
      inflight = false;
      sendBtn.disabled = false;
      input.disabled = false;
      input.focus();
    }
  };

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
}

/** Append a console bubble; returns the element (so a pending one can be removed). */
function appendConsoleMsg(log, role, html) {
  const div = document.createElement('div');
  div.className = 'cmsg ' + role;
  div.innerHTML = `<div class="cbody canvas">${html}</div>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

/** Render a returned A2A Task into the console as a markdown canvas bubble. */
/**
 * If the agent output is pure JSON (e.g. a tool's raw result like
 * [{title,author,shelf}]), turn it into readable Markdown (a GFM table for an
 * array of objects, a bullet list otherwise) so the chat renders formatted
 * content instead of a JSON blob. Non-JSON text is returned unchanged.
 */
function jsonToMarkdown(text) {
  const trimmed = (text || '').trim();
  if (!trimmed || (trimmed[0] !== '[' && trimmed[0] !== '{')) return text;
  let data;
  try { data = JSON.parse(trimmed); } catch { return text; }

  const mdCell = (v) => String(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v).replace(/\|/g, '\\|');

  if (Array.isArray(data)) {
    if (data.length === 0) return '_(no results)_';
    const objs = data.filter(x => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length === data.length) {
      const cols = [...new Set(objs.flatMap(o => Object.keys(o)))];
      const head = `| ${cols.join(' | ')} |`;
      const sep = `| ${cols.map(() => '---').join(' | ')} |`;
      const rows = objs.map(o => `| ${cols.map(c => mdCell(o[c])).join(' | ')} |`);
      return [head, sep, ...rows].join('\n');
    }
    return data.map(v => `- ${mdCell(v)}`).join('\n');
  }
  if (data && typeof data === 'object') {
    return Object.entries(data).map(([k, v]) => `- **${k}:** ${mdCell(v)}`).join('\n');
  }
  return text;
}

function renderConsoleTask(log, task, delegations) {
  const state = task?.status?.state || 'unknown';
  const artifacts = Array.isArray(task?.artifacts) ? task.artifacts : [];
  // A2A v1.0 parts are discriminated by member name: text part = { text }.
  const summary = artifacts
    .flatMap(a => Array.isArray(a.parts) ? a.parts : [])
    .filter(p => p && typeof p.text === 'string')
    .map(p => p.text)
    .join('\n\n');
  const statusText = task?.status?.message?.parts?.find(p => typeof p.text === 'string')?.text || '';

  const stateClass = state === 'TASK_STATE_COMPLETED' ? 'ok' : (state === 'TASK_STATE_REJECTED' || state === 'TASK_STATE_FAILED') ? 'bad' : 'warn';
  let html = `<div class="task-state ${stateClass}">${esc(state)}</div>`;

  const bodyMd = summary || statusText;
  if (bodyMd) html += renderMarkdown(jsonToMarkdown(bodyMd));
  else html += `<p class="muted">(no output)</p>`;

  // Post-hoc delegation summary (derived from the Task, not a live stream).
  const d = delegations || {};
  const fc = Array.isArray(d.filesChanged) ? d.filesChanged : null;
  if ((fc && fc.length) || d.logPath) {
    html += `<div class="task-meta">`;
    if (fc && fc.length) {
      html += `<div><b>files changed:</b> ${fc.map(f => `<code>${esc(f)}</code>`).join(', ')}</div>`;
    }
    if (d.logPath) html += `<div><b>log:</b> <code>${esc(d.logPath)}</code></div>`;
    html += `</div>`;
  }

  const div = appendConsoleMsg(log, 'agent', html);
  // Wire any copy-table buttons inside the rendered markdown.
  div.querySelectorAll('[data-copy-table]').forEach(btn => {
    btn.addEventListener('click', () => {
      const table = btn.parentElement.querySelector('table');
      if (!table) return;
      navigator.clipboard.writeText(tableToTsv(table)).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✓ copied';
        setTimeout(() => { btn.textContent = orig; }, 1200);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Desk: skill detail
// ---------------------------------------------------------------------------

function showSkillDetail(skill) {
  openCardDetail(
    `<span class="ic">✦</span><span class="t">${esc(skill.name)}</span><span class="badge">skill</span>`,
    `<div class="adetail reveal">` +
      `<div class="aname" style="font-size:23px">${esc(skill.name)}</div>` +
      `<div class="adesc">${esc(skill.summary || '')}</div>` +
      `<div class="kv">` +
        `<span class="k">source</span><span class="v">${esc(skill.source)}</span>` +
        `<span class="k">file</span><span class="v mono">skills/${esc(skill.name)}/SKILL.md</span>` +
      `</div>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Desk: MCP detail
// ---------------------------------------------------------------------------

function showMcpDetail(mcp) {
  const grantLabel = mcp.grant === 'declared-only'
    ? 'discovery only (not inherited)'
    : mcp.grant === 'readOnly'
      ? 'readOnly — grantable in ask mode'
      : 'granted';

  const cmd = mcp.config?.command
    ? `${esc(mcp.config.command)} ${(mcp.config.args || []).map(a => esc(a)).join(' ')}`
    : '(no command)';

  openCardDetail(
    `<span class="ic">⛁</span><span class="t">${esc(mcp.name)}</span><span class="badge">mcp</span>`,
    `<div class="adetail reveal">` +
      `<div class="aname" style="font-size:23px">${esc(mcp.name)}</div>` +
      `<div class="adesc mono">${cmd}</div>` +
      `<div class="kv">` +
        `<span class="k">source</span><span class="v">${esc(mcp.source)}</span>` +
        `<span class="k">grant</span><span class="v">${esc(grantLabel)}</span>` +
      `</div>` +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Stat bar
// ---------------------------------------------------------------------------

function updateStat(agents) {
  const statEl = document.getElementById('stat');
  if (!statEl || !agents) return;
  const total = agents.length;
  const served = agents.filter(a => a.status === 'served').length;
  const drift = agents.filter(a => a.status === 'drift').length;
  statEl.innerHTML =
    `<span><span class="dotg"></span> <b>${total}</b> agents</span>` +
    `<span><b>${served}</b> served</span>` +
    (drift > 0 ? `<span><b>${drift}</b> drift</span>` : '');
}

// ---------------------------------------------------------------------------
// Pane collapse / resize
// ---------------------------------------------------------------------------

function updateGutters() {
  const vis = id => !document.getElementById(id)?.classList.contains('collapsed');
  const t = vis('pane-tree'), c = vis('pane-center'), i = vis('inspect');

  const gLeft = document.querySelector('.gutter[data-g="tree"]');
  const gRight = document.querySelector('.gutter[data-g="inspect"]');

  if (gLeft)  gLeft.style.display  = (t && c) ? '' : 'none';
  if (gRight) gRight.style.display = (i && (c || t)) ? '' : 'none';

  // Fill logic: when board is hidden, desk fills; if desk also hidden, tree fills
  const desk = document.getElementById('inspect');
  const tree = document.getElementById('pane-tree');
  if (desk) desk.classList.toggle('fill', !c && i);
  if (tree) tree.classList.toggle('fill', !c && !i && t);
}

function togglePane(which) {
  const map = { tree: 'pane-tree', center: 'pane-center', inspect: 'inspect' };
  const el = document.getElementById(map[which]);
  if (!el) return;
  const nowHidden = el.classList.toggle('collapsed');
  const btn = document.getElementById('t-' + which);
  if (btn) btn.classList.toggle('on', !nowHidden);
  updateGutters();
}

/**
 * Apply a layout preset to the three panes. Presets:
 *   'all'        — all three panes visible at default widths
 *   'widechat'   — all three visible, chat stretched to ~50%
 *   'board'      — only the board (files + chat collapsed)
 *   'chat'       — only the chat, full width (files + board collapsed)
 *
 * Resets any drag-resized inline widths so the preset's widths apply cleanly.
 */
function applyLayout(name) {
  const tree = document.getElementById('pane-tree');
  const center = document.getElementById('pane-center');
  const inspect = document.getElementById('inspect');

  // Reset all preset state + drag-resized inline widths.
  [tree, center, inspect].forEach((el) => {
    if (!el) return;
    el.classList.remove('collapsed', 'wide-50', 'wide-100');
    el.style.width = '';
    el.style.flex = '';
  });

  switch (name) {
    case 'all':
      // default widths apply via CSS
      break;
    case 'widechat':
      inspect?.classList.add('wide-50');
      break;
    case 'board':
      tree?.classList.add('collapsed');
      inspect?.classList.add('collapsed');
      break;
    case 'chat':
      tree?.classList.add('collapsed');
      center?.classList.add('collapsed');
      inspect?.classList.add('wide-100');
      break;
  }

  // Sync the per-pane toggle buttons' visual state.
  const visAndSync = (paneId, btnId) => {
    const visible = !document.getElementById(paneId)?.classList.contains('collapsed');
    document.getElementById(btnId)?.classList.toggle('on', visible);
  };
  visAndSync('pane-tree', 't-tree');
  visAndSync('pane-center', 't-center');
  visAndSync('inspect', 't-inspect');

  // Highlight the active preset button.
  document.querySelectorAll('.layoutpre button').forEach((b) => b.classList.remove('on'));
  document.getElementById('lay-' + (name === 'widechat' ? 'widechat' : name))?.classList.add('on');

  updateGutters();
}

function initResizable() {
  document.querySelectorAll('.gutter').forEach(gutter => {
    gutter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const isLeft = gutter.dataset.g === 'tree';
      const leftPane = isLeft
        ? document.getElementById('pane-tree')
        : (!document.getElementById('pane-center')?.classList.contains('collapsed')
            ? document.getElementById('pane-center')
            : document.getElementById('pane-tree'));
      const rightPane = isLeft
        ? document.getElementById('pane-center')
        : document.getElementById('inspect');
      if (!leftPane || !rightPane) return;

      [leftPane, rightPane].forEach((pane) => {
        pane.classList.remove('wide-50', 'wide-100', 'fill');
      });
      document.querySelectorAll('.layoutpre button').forEach((b) => b.classList.remove('on'));

      const sx = e.clientX;
      const leftStart = leftPane.getBoundingClientRect().width;
      const rightStart = rightPane.getBoundingClientRect().width;
      const total = leftStart + rightStart;
      const minLeft = paneMinWidth(leftPane);
      const minRight = paneMinWidth(rightPane);

      const onMove = (ev) => {
        const dx = ev.clientX - sx;
        let nextLeft = leftStart + dx;
        nextLeft = Math.max(minLeft, Math.min(total - minRight, nextLeft));
        const nextRight = total - nextLeft;
        leftPane.style.width = Math.round(nextLeft) + 'px';
        rightPane.style.width = Math.round(nextRight) + 'px';
        leftPane.style.flex = 'none';
        rightPane.style.flex = 'none';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
    });
  });
}

function paneMinWidth(pane) {
  if (!pane) return 180;
  if (pane.id === 'pane-tree') return 170;
  if (pane.id === 'inspect') return 260;
  return 280;
}

// ---------------------------------------------------------------------------
// View: kanban / graph toggle
// ---------------------------------------------------------------------------

function setView(v) {
  if (boardType !== 'agent' && v === 'graph') return;
  boardView = v;
  document.getElementById('kanban')?.classList.toggle('hidden', v !== 'kanban');
  document.getElementById('graphwrap')?.classList.toggle('hidden', v !== 'graph');
  document.getElementById('bk')?.classList.toggle('on', v === 'kanban');
  document.getElementById('bg')?.classList.toggle('on', v === 'graph');
  if (v === 'graph') renderGraph();
}

function setResourceView(v) {
  resourceBoardView = v;
  document.getElementById('rv-cards')?.classList.toggle('on', v === 'cards');
  document.getElementById('rv-list')?.classList.toggle('on', v === 'list');
  if (boardType !== 'agent') renderKanban();
}

function setType(t) {
  boardType = t;
  ['agent', 'skill', 'mcp'].forEach(x => {
    document.getElementById('ty-' + x)?.classList.toggle('on', x === t);
  });
  const resourceMode = t !== 'agent';
  document.getElementById('resource-view-toggle')?.classList.toggle('hidden', !resourceMode);
  document.getElementById('board-view-toggle')?.classList.toggle('hidden', resourceMode);
  if (resourceMode) setView('kanban');
  renderKanban();
}

// ---------------------------------------------------------------------------
// Live updates: SSE /api/events with poll fallback
// ---------------------------------------------------------------------------

let _liveTimer = null;

/** Pull the live activity snapshot and re-render the board overlays only. */
async function refreshActivity() {
  try {
    activity = await apiFetch('/api/activity');
    if (boardType === 'agent') {
      if (boardView === 'graph') renderGraph();
      else updateAgentActivityCards();
    }
    renderActivityFeed();
  } catch { /* transient */ }
}

/** Coalesced refresh of board + explorer (never touches an open Desk console). */
function scheduleRefresh() {
  if (_liveTimer) return;
  _liveTimer = setTimeout(async () => {
    _liveTimer = null;
    try {
      meshData = await apiFetch('/api/mesh');
      resourceData = null;
      const agents = meshData.agents || [];
      agentNames = agents.map(a => a.name);
      buildScopeOptions(agents);
      updateStat(agents);
      if (boardType === 'agent') {
        await renderKanban();
        if (boardView === 'graph') renderGraph();
      } else {
        await renderKanban();
      }
      await loadExplorer(currentScope);
    } catch { /* transient; next event/poll retries */ }
  }, 400);
}

function initLiveUpdates() {
  let pollTimer = null;
  const startPoll = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => { scheduleRefresh(); refreshActivity(); }, 5000);
  };
  if (typeof EventSource === 'undefined') { startPoll(); return; }
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('change', scheduleRefresh);
    // Live board: apply the redacted activity snapshot pushed on every change.
    es.addEventListener('activity', (e) => {
      try { activity = JSON.parse(e.data); } catch { return; }
      if (boardType === 'agent') {
        if (boardView === 'graph') renderGraph();
        else updateAgentActivityCards();
      }
      renderActivityFeed();
    });
    es.addEventListener('sync', (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      if (d && d.ok === false) { showToast(`Auto-sync failed (${esc(d.error || 'unknown')}) — run <code>agent-mesh doctor</code>`); return; }
      if (d && Array.isArray(d.synced) && d.synced.length) showToast(`Wiring synced: ${d.synced.length} change(s)`);
    });
    // EventSource auto-reconnects; arm a poll fallback so updates keep flowing
    // even if the stream is unavailable.
    es.onerror = () => { startPoll(); };
  } catch {
    startPoll();
  }
}

/** Render the compact activity feed (bottom strip of the board). */
function renderActivityFeed() {
  const el = document.getElementById('feed');
  if (!el) return;
  const events = (activity.events || []).slice(-8).reverse();
  if (events.length === 0) { el.innerHTML = ''; return; }
  // Phase indicators only — agent + start/done + route. No task/result text.
  el.innerHTML = events.map(ev => {
    if (ev.kind === 'a2a') {
      const kindLabel = ev.status === 'completed' ? '⇄ a2a ✓'
        : (ev.status === 'rejected' || ev.status === 'failed') ? '⇄ a2a ✗'
        : '⇄ a2a';
      return `<div class="frow a2a"><span class="fag">${esc(ev.from)} → ${esc(ev.to)}</span>` +
        `<span class="fk">${kindLabel}</span>` +
        `<span class="ftxt"></span></div>`;
    }
    return `<div class="frow ${ev.kind}"><span class="fag">${esc(ev.agent)}</span>` +
      `<span class="fk">${ev.kind === 'done' ? '✓ done' : '▸ working'}</span>` +
      `<span class="ftxt">${ev.route ? esc(ev.route) : ''}</span></div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Init: fetch mesh data and populate UI
// ---------------------------------------------------------------------------

async function init() {
  // Fetch mesh data
  try {
    meshData = await apiFetch('/api/mesh');
    shellEnabled = !!meshData.shellEnabled;
    sessionLogEnabled = !!meshData.sessionLogEnabled;
  } catch (e) {
    document.getElementById('cards').innerHTML =
      `<div class="err-panel">Failed to load mesh: ${esc(e.message)}</div>`;
    meshData = { agents: [], graph: { nodes: [], edges: [] } };
  }

  // Initial live activity snapshot (board overlays).
  try { activity = await apiFetch('/api/activity'); } catch { activity = { agents: [], edges: [], events: [] }; }

  const agents = meshData.agents || [];
  agentNames = agents.map(a => a.name);

  // Populate scope selector
  buildScopeOptions(agents);

  // Stat bar
  updateStat(agents);

  // Load explorer
  await loadExplorer('mesh');

  // Initial board
  await renderKanban();

  // Default desk: show the first agent through the same top-scope path the user
  // uses, so the selector, board filter and session pane stay in lockstep.
  if (agents.length > 0) {
    await applyScope(agents[0].name);
  } else {
    resetChatPane();
  }

  // Live change stream (SSE) with poll fallback
  initLiveUpdates();
}

// ---------------------------------------------------------------------------
// DOM ready
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Wire pane toggles
  document.getElementById('t-tree')?.addEventListener('click', () => togglePane('tree'));
  document.getElementById('t-center')?.addEventListener('click', () => togglePane('center'));
  document.getElementById('t-inspect')?.addEventListener('click', () => togglePane('inspect'));
  document.getElementById('t-board2')?.addEventListener('click', () => { location.href = '/board2.html'; });

  // Wire layout presets
  document.getElementById('lay-all')?.addEventListener('click', () => applyLayout('all'));
  document.getElementById('lay-widechat')?.addEventListener('click', () => applyLayout('widechat'));
  document.getElementById('lay-board')?.addEventListener('click', () => applyLayout('board'));
  document.getElementById('lay-chat')?.addEventListener('click', () => applyLayout('chat'));

  // Wire view toggles (kanban / graph)
  document.getElementById('bk')?.addEventListener('click', () => setView('kanban'));
  document.getElementById('bg')?.addEventListener('click', () => setView('graph'));
  document.getElementById('rv-cards')?.addEventListener('click', () => setResourceView('cards'));
  document.getElementById('rv-list')?.addEventListener('click', () => setResourceView('list'));

  // Wire type filter
  document.getElementById('ty-agent')?.addEventListener('click', () => setType('agent'));
  document.getElementById('ty-skill')?.addEventListener('click', () => setType('skill'));
  document.getElementById('ty-mcp')?.addEventListener('click', () => setType('mcp'));

  // Wire scope selector — filters ALL three panes (Files / Board / Chat).
  document.getElementById('scope')?.addEventListener('change', (e) => {
    applyScope(e.target.value);
  });

  // Resizable gutters
  initResizable();

  // Update gutters initial state
  updateGutters();

  // Start loading
  init();
});
