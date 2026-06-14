/**
 * src/dashboard/public/session-log.js — B-layout, one-session-per-agent.
 *
 * Layout:
 *   ┌ toolbar: sid · ⧉ id · ⌘ Terminal ································ Session | Activity
 *   ├ board (chat, polished cards) ───────────────── overlay: User · Reply · Tool · ⛶
 *   ├ side panel: Session  (meta summary + transcript outline + rename/copy/delete)
 *   └ Activity view: loaded/live tool-use statistics
 *
 * The rail's session-LIST is gone — each agent owns a single canonical session;
 * we open the canonical id the server reports (j.canonicalId from /session/list,
 * backed by the per-agent session-store), NOT newest-by-mtime. Tools appear as
 * cards in the chat board; Activity is a statistics view for loaded/live records.
 * The transcript outline in Session is derived from rendered blocks (data-seq).
 */
import { createResultCanvas } from './result-canvas.js';

export const HISTORY_PAGE_LIMIT = 80;

export function sessionStartSeq(session) {
  const seq = Number(session?.lineCount || 0);
  return Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
}

/**
 * Decide how the ⌘ Terminal action should launch for the current pane state.
 * With an open session, resume that exact id; with none (empty state), seed the
 * agent's canonical session through the agent-level shell plan/launch endpoints
 * — the empty-state copy tells the operator to use this button, so it must
 * never be a silent no-op. Pure and exported for unit tests.
 */
export function terminalLaunchRequest(openId) {
  if (openId) {
    return { kind: 'resume', path: `/session/${encodeURIComponent(openId)}/open-terminal` };
  }
  return { kind: 'seed', planPath: '/shell/plan', launchPath: '/shell/launch' };
}

export function toolStatsFromRecords(records) {
  const stats = createToolStatsStore();
  for (const rec of records || []) addRecordToToolStats(stats, rec, 'history');
  return summarizeToolStats(stats);
}

function createToolStatsStore() {
  return {
    seenSeq: new Set(),
    loadedRecords: 0,
    historyRecords: 0,
    liveRecords: 0,
    toolCalls: 0,
    toolResults: 0,
    byName: new Map()
  };
}

function resetToolStats(stats) {
  stats.seenSeq.clear();
  stats.loadedRecords = 0;
  stats.historyRecords = 0;
  stats.liveRecords = 0;
  stats.toolCalls = 0;
  stats.toolResults = 0;
  stats.byName.clear();
}

function addRecordToToolStats(stats, rec, source = 'history') {
  if (!rec || !Array.isArray(rec.events)) return;
  const seq = Number(rec.seq);
  const key = Number.isFinite(seq) ? `seq:${seq}` : `obj:${stats.loadedRecords}:${stats.toolCalls}:${stats.toolResults}`;
  if (stats.seenSeq.has(key)) return;
  stats.seenSeq.add(key);
  stats.loadedRecords += 1;
  if (source === 'live') stats.liveRecords += 1;
  else stats.historyRecords += 1;
  for (const ev of rec.events) {
    if (ev?.type === 'tool_use') {
      const name = String(ev.name || 'tool');
      stats.toolCalls += 1;
      stats.byName.set(name, (stats.byName.get(name) || 0) + 1);
    } else if (ev?.type === 'tool_result') {
      stats.toolResults += 1;
    }
  }
}

function summarizeToolStats(stats) {
  const topTools = Array.from(stats.byName.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const uniqueTools = topTools.length;
  const reuseCount = Math.max(0, stats.toolCalls - uniqueTools);
  const reuseRate = stats.toolCalls ? reuseCount / stats.toolCalls : 0;
  return {
    loadedRecords: stats.loadedRecords,
    historyRecords: stats.historyRecords,
    liveRecords: stats.liveRecords,
    toolCalls: stats.toolCalls,
    toolResults: stats.toolResults,
    uniqueTools,
    reuseCount,
    reuseRate,
    topTools
  };
}

export function mountSessionLog(rootEl, agentName) {
  rootEl.classList.add('sl-root');
  rootEl.innerHTML = `
    <div class="sl-bar">
      <span id="sl-sid" class="sl-sid" title="active session id">—</span>
      <button id="sl-copyid" class="sl-btn" title="Copy session id">⧉ id</button>
      <button id="sl-term" class="sl-btn sl-amber" title="Copy a command that resumes this session in YOUR terminal (nothing is launched)">⧉ Copy resume command</button>
      <span class="sl-spacer"></span>
      <button id="sl-view-session"  class="sl-btn on" data-view="session"  title="Show chat and session">Session</button>
      <button id="sl-view-activity" class="sl-btn" data-view="activity" title="Show tool statistics">Activity</button>
    </div>

    <div class="sl-canvas" id="sl-canvas">

      <div class="sl-board-frame">
        <div class="sl-overlay-tr">
          <div class="sl-filters" role="group" aria-label="Hide card types">
            <button class="sl-filter on" data-fil="you"  title="Hide user prompts">💬 User</button>
            <button class="sl-filter on" data-fil="text" title="Hide Claude replies">✦ Reply</button>
            <button class="sl-filter on" data-fil="tool" title="Hide tool cards">⚙ Tool</button>
          </div>
          <button id="sl-full" class="sl-fullbtn" title="Presentation view (full chat)">⛶</button>
        </div>
        <div class="sl-board" id="sl-board"></div>
      </div>

      <aside class="sl-side sl-session" id="sl-session">
        <div class="sl-side-head">
          <div class="sl-side-title"><span>Session</span><span id="sl-session-pill" class="sl-pill"></span></div>
        </div>
        <div class="sl-side-body">
          <div class="sm" id="sl-session-meta"><div class="sl-empty">Loading…</div></div>
          <div class="sm-history">
            <div class="sm-history-actions">
              <button id="sl-history-latest" class="sl-btn" title="Render the newest hidden transcript page in the canvas">Show recent history</button>
              <button id="sl-history-older" class="sl-btn" title="Render the next older transcript page in the canvas">Show older history</button>
            </div>
            <div id="sl-history-status" class="sm-history-status">History is hidden until opened.</div>
          </div>
          <div class="sm-outline-head">
            <span>Transcript</span>
            <span class="sm-outline-count" id="sl-outline-count">0 turns</span>
          </div>
          <div class="sm-outline" id="sl-outline"></div>
          <div class="sm-actions">
            <button id="sl-rename"   class="sl-btn" title="Rename this session">✎ Rename</button>
            <button id="sl-copymeta" class="sl-btn" title="Copy session meta">📋 Copy meta</button>
            <button id="sl-delete"   class="sl-btn" title="Permanently delete this session transcript">🗑 Delete</button>
          </div>
        </div>
      </aside>

      <aside class="sl-side sl-activity" id="sl-activity">
        <div class="sl-side-head">
          <div class="sl-side-title"><span>Activity</span><span class="sl-pill">tool stats</span></div>
          <button class="sl-side-x" data-view="session" title="Back to session">Session</button>
        </div>
        <div class="sl-side-body" id="sl-activity-body"></div>
      </aside>

    </div>`;
    // No inline compose — the dashboard chat composer above (#composer in app.js
    // via wireConsole) already POSTs to /session/message, and ⌘ Terminal is the
    // canonical entry point into the Claude CLI for free-form interaction.

  const boardEl        = rootEl.querySelector('#sl-board');
  const activityBodyEl = rootEl.querySelector('#sl-activity-body');
  const sidEl          = rootEl.querySelector('#sl-sid');
  const sessPillEl     = rootEl.querySelector('#sl-session-pill');
  const sessMetaEl     = rootEl.querySelector('#sl-session-meta');
  const outlineEl      = rootEl.querySelector('#sl-outline');
  const outlineCountEl = rootEl.querySelector('#sl-outline-count');
  const historyLatestBtn = rootEl.querySelector('#sl-history-latest');
  const historyOlderBtn  = rootEl.querySelector('#sl-history-older');
  const historyStatusEl  = rootEl.querySelector('#sl-history-status');

  const canvas = createResultCanvas(boardEl, null, { activityFallback: false });
  const blankEl = document.createElement('div');
  blankEl.className = 'sl-history-blank';
  const toolStats = createToolStatsStore();

  // openId = the session whose transcript is currently shown. (No activeId /
  // expectedActiveId tracking — the outer chat composer owns send semantics.)
  let openId = null;
  let openSessionMeta = null;
  let stream = null;
  let oldestSeq = null, loadingOlder = false, exhausted = false;
  let liveStartSeq = 0, historyVisible = false;
  let destroyed = false;

  const api = (p, o) =>
    fetch(`/api/agent/${encodeURIComponent(agentName)}${p}`, { credentials: 'same-origin', ...o });
  const jsonHeaders = { 'Content-Type': 'application/json' };

  // ── view switch: default chat + Session panel; Activity covers that surface ─
  function setView(name) {
    const activity = name === 'activity';
    rootEl.classList.toggle('sl-view-activity', activity);
    rootEl.classList.toggle('sl-view-session', !activity);
    for (const btn of rootEl.querySelectorAll('[data-view]')) {
      btn.classList.toggle('on', btn.dataset.view === name);
    }
    if (activity) renderActivityStats();
  }
  for (const el of rootEl.querySelectorAll('[data-view]')) {
    el.addEventListener('click', () => setView(el.dataset.view));
  }
  setView('session');

  // ── sidebar panel collapse/toggle ─────────────────────────────────────────
  // ── chat filter chips ────────────────────────────────────────────────────
  // Each chip toggles `hide-<kind>` on .sl-board; CSS hides matching .rc-<kind>.
  for (const chip of rootEl.querySelectorAll('[data-fil]')) {
    chip.addEventListener('click', () => {
      const k = chip.dataset.fil;
      const hidden = boardEl.classList.toggle(`hide-${k}`);
      chip.classList.toggle('on', !hidden);
    });
  }

  // ── one canonical session per agent ──────────────────────────────────────
  // /session/list is newest-first; we pin sessions[0]. Auto-refreshes every 4s
  // so a fresh `claude --resume` started in iTerm surfaces here promptly.
  async function loadCanonicalSession() {
    let j;
    try { j = await (await api('/session/list')).json(); } catch { j = { sessions: [] }; }
    if (destroyed) return;
    const sessions = j.sessions || [];
    // Strict one-session-per-agent: the agent owns exactly the canonical id from
    // the session-store (server exposes it as j.canonicalId). Display and tail
    // THAT session only — never "newest by mtime". A stray transcript (e.g. a
    // session started outside the dashboard) is deliberately ignored so the canvas
    // and the CLI launch button always agree on one id.
    const canonicalId = j.canonicalId || null;
    const primary = canonicalId ? sessions.find((s) => s.id === canonicalId) : null;
    if (primary && j.digesting) primary.digesting = true;
    if (primary && j.projectsDir) primary.projectsDir = j.projectsDir;
    if (!primary) {
      // No owned session yet, or its transcript hasn't been created — show the
      // empty state. Launching via ⌘ Terminal / "Open in Claude Code" seeds the
      // canonical id, after which this resolves to that one session.
      renderEmptySession();
      return;
    }
    openSessionMeta = primary;
    renderSessionMeta(primary);
    if (primary.id !== openId) {
      await openSession(primary.id, primary);
    } else {
      openSessionMeta = primary;
      updateHistoryControls();
    }
  }

  function renderEmptySession() {
    sidEl.textContent = '—'; sidEl.title = '';
    sessPillEl.textContent = '';
    sessMetaEl.innerHTML = '<div class="sl-empty">No session yet. Copy the command below and run it in your terminal — the session surfaces here within a few seconds.</div>';
    outlineEl.innerHTML = '';
    outlineCountEl.textContent = '0 turns';
    if (openId) {
      if (stream) { stream.close(); stream = null; }
      canvas.clear();
      openId = null;
    }
    showBlank('No session is open yet.');
    liveStartSeq = 0; historyVisible = false; oldestSeq = null; exhausted = true;
    resetToolStats(toolStats);
    renderActivityStats();
    updateHistoryControls();
  }

  function renderSessionMeta(s) {
    const shortId = s.id ? s.id.slice(0, 8) : '—';
    sidEl.textContent = shortId + (s.label || s.firstPrompt ? ' · ' + truncate(s.label || s.firstPrompt, 36) : '');
    sidEl.title = s.id || '';
    sessPillEl.textContent = s.originSource === 'cli' ? '⌘ CLI' : '💬 dash';
    const turns = (s.turns ?? 0) + (s.turnsApprox ? '+' : '');
    const rows = [
      ['id',         s.id || '—'],
      ['origin',     s.originSource || 'cli'],
      ['started',    fmtTime(s.startedAt)],
      ['last',       fmtTime(s.endedAt || s.startedAt)],
      ['turns',      String(turns)],
      ...(s.headroomPct != null ? [['headroom', `${s.headroomPct}%`]] : []),
    ];
    if (s.label)       rows.push(['label', s.label]);
    if (s.firstPrompt) rows.push(['prompt', truncate(s.firstPrompt, 80)]);
    if (s.active)      rows.push(['status', 'live']);
    if (s.digesting)   rows.push(['status', 'digesting…']);
    const storedIn = s.projectsDir || null;
    const storedInDisplay = storedIn && storedIn.length > 58 ? '…' + storedIn.slice(-57) : storedIn;
    sessMetaEl.innerHTML = rows.map(([k, v]) =>
      `<div class="sm-row"><span class="sm-k">${escapeText(k)}</span><span class="sm-v ${k === 'prompt' || k === 'label' ? '' : 'muted'}">${escapeText(v)}</span></div>`
    ).join('') + (storedIn ? `<div class="sm-row sm-stored-in" data-full-path="${escapeText(storedIn).replace(/"/g, '&quot;')}" style="cursor:pointer" title="Click to copy full path"><span class="sm-k">stored in</span><span class="sm-v muted">${escapeText(storedInDisplay)}</span></div>` : '');
  }

  function showBlank(message) {
    blankEl.textContent = message;
    if (!blankEl.parentNode) boardEl.appendChild(blankEl);
  }

  function hideBlank() {
    if (blankEl.parentNode) blankEl.parentNode.removeChild(blankEl);
  }

  function updateHistoryControls() {
    const hasSession = !!openId;
    const hasHiddenTranscript = liveStartSeq > 0;
    historyLatestBtn.disabled = !hasSession || loadingOlder || historyVisible || !hasHiddenTranscript || exhausted;
    historyOlderBtn.disabled = !hasSession || loadingOlder || !historyVisible || exhausted;
    if (!hasSession) {
      historyStatusEl.textContent = 'No session is open.';
    } else if (loadingOlder) {
      historyStatusEl.textContent = 'Loading history page…';
    } else if (!historyVisible && hasHiddenTranscript) {
      historyStatusEl.textContent = `${liveStartSeq} transcript lines hidden.`;
    } else if (!historyVisible) {
      historyStatusEl.textContent = 'No checkpointed history yet.';
    } else if (exhausted) {
      historyStatusEl.textContent = 'Oldest history is now shown.';
    } else {
      historyStatusEl.textContent = `Showing history from #${oldestSeq}; older pages are hidden.`;
    }
  }

  function renderActivityStats() {
    const summary = summarizeToolStats(toolStats);
    const rate = Math.round(summary.reuseRate * 100);
    const top = summary.topTools.slice(0, 12);
    activityBodyEl.innerHTML =
      `<div class="toolstats">` +
        `<div class="ts-grid">` +
          statCard('tool calls', summary.toolCalls) +
          statCard('unique tools', summary.uniqueTools) +
          statCard('reuse rate', `${rate}%`) +
          statCard('results', summary.toolResults) +
        `</div>` +
        `<div class="ts-scope">` +
          `<span>${summary.loadedRecords} records loaded</span>` +
          `<span>${summary.liveRecords} live</span>` +
          `<span>${summary.historyRecords} history</span>` +
        `</div>` +
        `<div class="ts-section">` +
          `<div class="ts-title">Top Tools</div>` +
          (top.length ? top.map((t) => toolRow(t, summary.toolCalls)).join('') : `<div class="ts-empty">No tool calls loaded yet.</div>`) +
        `</div>` +
      `</div>`;
  }

  function statCard(label, value) {
    return `<div class="ts-card"><span>${escapeText(label)}</span><b>${escapeText(value)}</b></div>`;
  }

  function toolRow(tool, total) {
    const pct = total ? Math.round((tool.count / total) * 100) : 0;
    return `<div class="ts-tool">` +
      `<div class="ts-tool-head"><b>${escapeText(tool.name)}</b><span>${tool.count} · ${pct}%</span></div>` +
      `<div class="ts-bar"><i style="width:${Math.max(3, pct)}%"></i></div>` +
    `</div>`;
  }

  // ── open the canonical session: blank canvas + live tail ────────────────
  async function openSession(id, meta = null) {
    openId = id;
    canvas.clear();
    showBlank('History is hidden. New live output will appear here; use the Session panel to unfold older history.');
    outlineEl.innerHTML = '';
    outlineCountEl.textContent = '0 turns';
    oldestSeq = null; exhausted = false; loadingOlder = false; historyVisible = false;
    liveStartSeq = sessionStartSeq(meta || openSessionMeta);
    resetToolStats(toolStats);
    renderActivityStats();
    updateHistoryControls();
    if (stream) { stream.close(); stream = null; }

    if (typeof EventSource !== 'undefined') {
      // Start at the known EOF cursor from /session/list. That avoids loading
      // and replaying a huge transcript on open while still allowing future
      // transcript appends (and dashboard-owned live stdout) to stream in.
      stream = new EventSource(streamUrl(agentName, id, liveStartSeq, { tailOnly: true }));
      stream.addEventListener('record', (e) => {
        try {
          const rec = JSON.parse(e.data);
          hideBlank();
          addRecordToToolStats(toolStats, rec, 'live');
          renderActivityStats();
          canvas.render(rec);
          appendOutlineFor(rec);
        } catch { /* ignore malformed */ }
      });
      stream.addEventListener('gap', () => openSession(id));
      stream.addEventListener('error', () => { if (openId === id) flash('Live stream disconnected — reconnecting…'); });
    }
  }

  // Reverse-pagination: explicit Session-panel buttons fetch hidden transcript
  // pages. We deliberately avoid scroll-to-top auto-loading so opening a large
  // session stays cheap until the user unfolds history.
  async function loadOlder() {
    if (loadingOlder || exhausted || openId == null) return;
    loadingOlder = true;
    updateHistoryControls();
    const before = oldestSeq ?? (liveStartSeq > 0 ? liveStartSeq + 1 : null);
    let t;
    try { t = await (await fetch(transcriptWindowUrl(agentName, openId, { beforeSeq: before }), { credentials: 'same-origin' })).json(); }
    catch { t = { records: [] }; }
    if (destroyed) { loadingOlder = false; return; }
    const older = t.records || [];
    if (older.length) {
      hideBlank();
      for (const rec of older) addRecordToToolStats(toolStats, rec, 'history');
      renderActivityStats();
      const prevH = boardEl.scrollHeight;
      canvas.prepend(older);
      boardEl.scrollTop += boardEl.scrollHeight - prevH;
      oldestSeq = older[0].seq;
      historyVisible = true;
      prependOutlineFor(older);
    }
    exhausted = !t.hasMore;
    loadingOlder = false;
    updateHistoryControls();
  }
  historyLatestBtn.addEventListener('click', () => loadOlder());
  historyOlderBtn.addEventListener('click', () => loadOlder());

  // ── transcript outline (derived from rendered .rc-blk[data-seq] in board) ─
  // The board is the source of truth — outline scans new blocks after each
  // render and reuses jumpTo() to scroll + flash on click. Tools are in both
  // lanes (render-core 'both'), but we list the board copy only.
  function rebuildOutline() {
    outlineEl.innerHTML = '';
    const blks = boardEl.querySelectorAll('.rc-blk[data-seq]');
    for (const b of blks) outlineEl.appendChild(outlineRowFor(b));
    outlineCountEl.textContent = `${blks.length} turns shown`;
  }
  function appendOutlineFor(/* rec */) {
    // Find the new block(s) at the tail that aren't yet in the outline.
    const blks = boardEl.querySelectorAll('.rc-blk[data-seq]:not([data-outlined])');
    for (const b of blks) outlineEl.appendChild(outlineRowFor(b));
    outlineCountEl.textContent = `${boardEl.querySelectorAll('.rc-blk[data-seq]').length} turns shown`;
  }
  function prependOutlineFor(/* recs */) {
    // Walk new blocks at the head and prepend their rows in document order.
    const blks = Array.from(boardEl.querySelectorAll('.rc-blk[data-seq]:not([data-outlined])'));
    for (let i = blks.length - 1; i >= 0; i--) outlineEl.insertBefore(outlineRowFor(blks[i]), outlineEl.firstChild);
    outlineCountEl.textContent = `${boardEl.querySelectorAll('.rc-blk[data-seq]').length} turns shown`;
  }
  function outlineRowFor(blk) {
    blk.setAttribute('data-outlined', '1');
    const seq = blk.dataset.seq || '0';
    const kind = inferKind(blk);
    const preview = truncate((blk.innerText || '').replace(/\s+/g, ' ').trim().replace(/^⧉\s*/, ''), 80);
    const row = document.createElement('div');
    row.className = 'ol';
    row.dataset.jump = seq + ':' + blk.dataset.seqIndex;
    row.innerHTML =
      `<span class="ol-t">#${escapeText(seq)}</span>` +
      `<span class="ol-r r-${escapeText(kind)}">${escapeText(kindLabel(kind))}</span>` +
      `<span class="ol-x">${escapeText(preview || '(empty)')}</span>`;
    row.addEventListener('click', () => jumpTo(blk));
    return row;
  }
  function inferKind(blk) {
    for (const c of blk.classList) {
      if (c === 'rc-blk') continue;
      if (c.startsWith('rc-')) return c.slice(3);
    }
    return 'raw';
  }
  function kindLabel(kind) {
    return ({ you: 'user', text: 'reply', tool: 'tool', result: 'result', raw: 'raw' })[kind] || kind;
  }
  function jumpTo(blk) {
    blk.scrollIntoView({ behavior: 'smooth', block: 'center' });
    blk.classList.remove('flash');
    void blk.offsetWidth;            // restart animation
    blk.classList.add('flash');
  }

  // ── toolbar actions ──────────────────────────────────────────────────────
  rootEl.querySelector('#sl-copyid').onclick = async () => {
    if (!openId) return;
    const btn = rootEl.querySelector('#sl-copyid');
    try { await navigator.clipboard.writeText(openId); btn.textContent = '✓ id'; }
    catch { btn.textContent = '⚠ id'; }
    setTimeout(() => { btn.textContent = '⧉ id'; }, 1200);
  };
  async function copyResume(idOrKeyword) {
    let j;
    try { j = await (await api(`/session/resume-command?id=${encodeURIComponent(idOrKeyword)}`)).json(); }
    catch { flash('Could not build the resume command'); return; }
    if (!j.ok) { flash(`No command: ${j.error?.code || 'unknown'}`); return; }
    try { await navigator.clipboard.writeText(j.command); flash('Copied — paste in your terminal'); }
    catch { flash(j.command); } // clipboard blocked → show it for manual copy
  }
  rootEl.querySelector('#sl-term').onclick = () => copyResume(openId || 'latest');
  rootEl.querySelector('#sl-full').onclick = () => {
    const on = rootEl.classList.toggle('sl-presentation');
    canvas.setMode(on ? 'presentation' : 'inline');
  };

  // Delegated click on "stored in" row — copies the full path to clipboard.
  sessMetaEl.addEventListener('click', async (e) => {
    const row = e.target.closest('.sm-stored-in');
    if (!row) return;
    const fullPath = row.dataset.fullPath;
    if (!fullPath) return;
    try { await navigator.clipboard.writeText(fullPath); flash('Path copied'); }
    catch { flash(fullPath); } // clipboard blocked → show it for manual copy
  });

  // Per-session actions (Session panel footer): rename / copy meta / delete
  rootEl.querySelector('#sl-rename').onclick = async () => {
    if (!openSessionMeta) return;
    const s = openSessionMeta;
    const name = prompt('Rename session', s.label || s.firstPrompt || '');
    if (name == null) return;
    try {
      const r = await api(`/session/${s.id}/rename`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) loadCanonicalSession();
      else flash('Rename failed: ' + (j.error?.code || r.status));
    } catch (e) { flash('Rename failed: ' + e.message); }
  };
  rootEl.querySelector('#sl-copymeta').onclick = async () => {
    if (!openSessionMeta) return;
    const s = openSessionMeta;
    const md = [
      `# Session ${s.id || ''}`,
      `- origin: ${s.originSource || 'cli'}`,
      `- started: ${fmtTime(s.startedAt)}`,
      `- last: ${fmtTime(s.endedAt || s.startedAt)}`,
      `- turns: ${s.turns ?? 0}${s.turnsApprox ? '+' : ''}`,
      s.label       ? `- label: ${s.label}` : null,
      s.firstPrompt ? `- first prompt: ${s.firstPrompt}` : null
    ].filter(Boolean).join('\n');
    try { await navigator.clipboard.writeText(md); flash('Meta copied'); }
    catch { flash('Copy blocked by browser'); }
  };
  rootEl.querySelector('#sl-delete').onclick = async () => {
    if (!openSessionMeta) return;
    const s = openSessionMeta;
    if (!confirm('Permanently delete this session transcript?\n\nThis removes Claude Code\'s OWN history for this session (~/.claude/projects) and cannot be undone.')) return;
    try {
      const r = await api(`/session/${s.id}/delete`, { method: 'POST', headers: jsonHeaders, body: '{}' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        if (stream) { stream.close(); stream = null; }
        canvas.clear();
        openId = null; openSessionMeta = null;
        loadCanonicalSession();
      } else flash('Delete failed: ' + (j.error?.code || r.status));
    } catch (e) { flash('Delete failed: ' + e.message); }
  };

  // ── ephemeral status toast ───────────────────────────────────────────────
  let flashTimer = null;
  function flash(msg) {
    let el = rootEl.querySelector('.sl-flash');
    if (!el) { el = document.createElement('div'); el.className = 'sl-flash'; rootEl.appendChild(el); }
    el.textContent = msg; el.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('on'), 2600);
  }

  // ── kickoff + refresh ────────────────────────────────────────────────────
  loadCanonicalSession();
  renderActivityStats();
  const refreshTimer = setInterval(() => {
    if (destroyed) return;
    loadCanonicalSession();   // surfaces a fresh CLI session promptly
  }, 4000);

  return {
    destroy() {
      destroyed = true;
      if (stream) { stream.close(); stream = null; }
      clearInterval(refreshTimer);
      clearTimeout(flashTimer);
      canvas.destroy();
      rootEl.innerHTML = '';
      rootEl.classList.remove('sl-root', 'sl-presentation', 'sl-view-session', 'sl-view-activity');
    }
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the live-mirror EventSource URL, threading the transcript cursor as the
 * initial resume point. Exported so the past→live handoff is unit-testable.
 */
export function streamUrl(agentName, id, fromSeq, { tailOnly = false } = {}) {
  const seq = Math.max(0, Math.floor(Number(fromSeq) || 0));
  const qs = new URLSearchParams({ fromSeq: String(seq) });
  if (tailOnly) qs.set('tail', '1');
  return `/api/agent/${encodeURIComponent(agentName)}/session/${encodeURIComponent(id)}/stream?${qs}`;
}

export function transcriptWindowUrl(agentName, id, { beforeSeq = null, limit = HISTORY_PAGE_LIMIT } = {}) {
  const qs = new URLSearchParams();
  const cap = Math.max(1, Math.min(500, Math.floor(Number(limit) || HISTORY_PAGE_LIMIT)));
  qs.set('limit', String(cap));
  const before = Math.floor(Number(beforeSeq) || 0);
  if (before > 0) qs.set('beforeSeq', String(before));
  return `/api/agent/${encodeURIComponent(agentName)}/session/${encodeURIComponent(id)}/transcript?${qs}`;
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = String(s == null ? '' : s);
  return d.innerHTML;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function fmtTime(ms) {
  if (!ms) return '—';
  try { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
}

// app.js is a classic script and can't `import`; expose the mount on window so
// it can call it. Loaded via <script type="module" src="/session-log.js">.
if (typeof window !== 'undefined') window.mountSessionLog = mountSessionLog;
