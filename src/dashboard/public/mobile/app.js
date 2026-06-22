/**
 * Mesh Concierge — mobile PWA client.
 *
 * Pure helpers (exported for zero-dep node tests) + DOM wiring that only runs in a
 * browser. Talks to the dashboard's concierge + status endpoints (same origin,
 * cookie auth already set by the /m?t=<token> bootstrap).
 */

const CONFIRM_LABELS = ['idea', 'approved', 'route:a2a'];

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Toggle a label in a selection, preserving allowlist order. */
export function toggleLabel(selected, label) {
  if (!CONFIRM_LABELS.includes(label)) return selected.slice();
  const set = new Set(selected);
  if (set.has(label)) set.delete(label); else set.add(label);
  return CONFIRM_LABELS.filter((l) => set.has(l));
}

/**
 * Build a normalized status model from the dashboard's read endpoints. Tolerant of
 * missing fields so a partly-populated mesh still renders.
 * @returns {Array<{title:string, rows:Array<{label:string,value:string,cls?:string}>}>}
 */
export function summarizeStatus({ health, daily } = {}) {
  const cards = [];

  if (health && typeof health === 'object') {
    const status = health.status ?? health.state ?? 'unknown';
    const cls = /ok|healthy|green/i.test(String(status)) ? 'ok'
      : /fail|red|stuck|overdue/i.test(String(status)) ? 'bad' : 'warn';
    const rows = [{ label: 'Mesh health', value: String(status), cls }];
    const findings = Array.isArray(health.findings) ? health.findings : (Array.isArray(health.escalations) ? health.escalations : []);
    rows.push({ label: 'Open findings', value: String(findings.length), cls: findings.length ? 'warn' : 'ok' });
    cards.push({ title: 'Health', rows });
  }

  if (daily && typeof daily === 'object') {
    const s = daily.summary ?? daily.report ?? daily;
    const rows = [];
    const num = (n) => typeof n === 'number' ? n.toLocaleString() : null;
    const add = (label, val) => { if (val != null && val !== '') rows.push({ label, value: String(val) }); };
    // Real daily-report shape: prs/issues are {opened[],merged[],closed[],openNow},
    // tokens is {total:{input,output,costUsd,...}} — render scalars, never an object
    // (the old code String()'d the tokens object → "[object Object]").
    if (s.prs && typeof s.prs === 'object') {
      add('PRs merged', Array.isArray(s.prs.merged) ? s.prs.merged.length : num(s.prs.merged));
      add('PRs open', num(s.prs.openNow));
    }
    if (s.issues && typeof s.issues === 'object') add('Issues open', num(s.issues.openNow));
    const tot = s.tokens && typeof s.tokens === 'object' ? (s.tokens.total ?? s.tokens) : null;
    if (tot && typeof tot === 'object') {
      if (typeof tot.costUsd === 'number') add('Cost (24h)', '$' + tot.costUsd.toFixed(2));
      const io = (typeof tot.input === 'number' || typeof tot.output === 'number') ? (tot.input || 0) + (tot.output || 0) : null;
      add('Tokens in+out', num(io));
    }
    // Tolerate simpler/flat report shapes (scalars only — never stringify an object).
    if (!rows.length) {
      const flat = (k, label) => { if (typeof s[k] === 'number' || typeof s[k] === 'string') add(label, s[k]); };
      flat('openPrs', 'Open PRs'); flat('mergedToday', 'Merged today'); flat('openIssues', 'Open issues');
    }
    if (rows.length) cards.push({ title: 'Daily report', rows });
  }

  if (!cards.length) cards.push({ title: 'Status', rows: [{ label: 'No status yet', value: '—', cls: 'muted' }] });
  return cards;
}

/** Compact relative-time label ("3m", "2h", "1d") from an ISO timestamp. */
export function relTime(ts, now = Date.now()) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/**
 * Build a recent-activity card model from /api/activity-log events (newest-first).
 * Each row: what happened + which agent + how long ago, colored by level.
 * @returns {{title:string, rows:Array<{label:string,value:string,cls?:string}>}}
 */
export function summarizeActivity(events, { max = 12, now = Date.now() } = {}) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return { title: 'Recent activity', rows: [{ label: 'No recent activity', value: '—', cls: 'muted' }] };
  const rows = list.slice(0, max).map((e) => {
    const what = e.summary ? String(e.summary) : String(e.type || 'event');
    const who = e.agent ? ` · ${e.agent}` : '';
    const cls = e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : '';
    return { label: `${what}${who}`, value: relTime(e.ts, now), cls };
  });
  return { title: 'Recent activity', rows };
}

/**
 * Build the over-the-loop Alerts card from /api/concierge/alerts, ranked by severity.
 * @returns {{title:string, rows:Array<{label:string,value:string,cls?:string}>}}
 */
export function summarizeAlerts(alerts) {
  const rank = { critical: 2, warn: 1, info: 0 };
  const sev = { critical: 'bad', warn: 'warn', info: '' };
  const list = Array.isArray(alerts) ? alerts.slice().sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0)) : [];
  if (!list.length) return { title: 'Alerts', rows: [{ label: 'No alerts', value: '—', cls: 'muted' }] };
  return { title: 'Alerts', rows: list.map((a) => ({ label: a.summary || a.kind || a.id, value: a.severity, cls: sev[a.severity] || '' })) };
}

/**
 * Build phone Task Board cards from a built board ({columns}). One card per non-empty
 * state column; each ticket a row. Pure (no import) so the node test can load app.js.
 */
export function summarizeTaskColumns(board) {
  const fmtAge = (ms) => { const s = Math.max(0, Math.round((ms || 0) / 1000));
    return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
  const cols = (board?.columns ?? []).filter((c) => c.cards.length);
  if (!cols.length) return [{ title: 'Tasks', rows: [{ label: 'No tasks yet', value: '—', cls: 'muted' }] }];
  return cols.map((c) => ({
    title: `${c.label} (${c.cards.length})`,
    rows: c.cards.map((card) => ({ label: `${card.title} · ${card.from}→${card.to}`, value: fmtAge(card.ageMs) + (card.hasResult ? ' ✓' : ''), cls: '' })),
  }));
}

const POLLABLE = new Set(['status', 'alerts', 'tasks']);
/**
 * Which data tab to auto-refresh on a poll tick: the active data tab, or null.
 * Chat is never auto-polled; nothing polls while the document is hidden.
 */
export function pickPoll(view, { hidden = false } = {}) {
  if (hidden) return null;
  return POLLABLE.has(view) ? view : null;
}

// --------------------------------------------------------------------------
// DOM wiring (browser only)
// --------------------------------------------------------------------------

/**
 * Pre-hydrate the visible chat thread from server-side history. Returns the
 * loaded entries as the initial history array.
 * @param {Element} thread
 * @param {Function} addBubble
 * @param {number} [limit]
 * @returns {Promise<Array<{role:string,text:string,ts:string}>>}
 */
export async function loadThreadHistory(thread, addBubble, { limit = 40 } = {}) {
  try {
    const res = await fetch(`/api/concierge/history?limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    if (!data.ok || !Array.isArray(data.turns) || data.turns.length === 0) return [];
    for (const turn of data.turns) {
      const cls = turn.role === 'assistant' ? 'assistant' : 'owner';
      addBubble(cls, String(turn.text ?? ''));
    }
    return data.turns;
  } catch { return []; }
}

function mount() {
  const $ = (id) => document.getElementById(id);
  const thread = $('thread');
  const input = $('input');
  const composer = $('composer');
  const send = $('send');
  const history = [];   // {role, text} — pre-populated from server history on load

  // Capture the bootstrap token from ?t= once and persist it, then send it as a
  // header on every API call. This makes auth work even if the device drops the
  // cookie (iOS Safari). The token is the same one the cookie carries.
  try {
    const t = new URLSearchParams(location.search).get('t');
    if (t) localStorage.setItem('mesh_token', t);
  } catch { /* private mode / no storage — fall back to cookie only */ }
  const authToken = (() => { try { return localStorage.getItem('mesh_token') || ''; } catch { return ''; } })();
  const authHeaders = (extra = {}) => authToken ? { ...extra, 'X-Dashboard-Token': authToken } : extra;

  const post = async (path, body) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data?.error?.message || `Request failed (${res.status})`);
    return data;
  };

  const addBubble = (cls, text) => {
    const el = document.createElement('div');
    el.className = `bubble ${cls}`;
    el.textContent = text;
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
    return el;
  };

  const addProposalCard = (proposal) => {
    let labels = (proposal.labels && proposal.labels.length) ? proposal.labels.slice() : ['idea'];
    const card = document.createElement('div');
    card.className = 'proposal';
    const render = () => {
      card.innerHTML = `
        <h4>${escapeHtml(proposal.title)}</h4>
        <div class="body">${escapeHtml(proposal.body || '')}</div>
        <div class="labels">${CONFIRM_LABELS.map((l) =>
          `<span class="chip ${labels.includes(l) ? 'on' : ''}" data-l="${l}">${l}</span>`).join('')}</div>
        <div class="actions">
          <button class="dismiss">Dismiss</button>
          <button class="confirm">Confirm → file</button>
        </div>`;
      card.querySelectorAll('.chip').forEach((chip) => {
        chip.onclick = () => { labels = toggleLabel(labels, chip.dataset.l); if (!labels.length) labels = ['idea']; render(); };
      });
      card.querySelector('.dismiss').onclick = () => card.remove();
      card.querySelector('.confirm').onclick = async () => {
        card.querySelectorAll('button,.chip').forEach((b) => (b.style.pointerEvents = 'none'));
        try {
          const out = await post('/api/concierge/confirm', { title: proposal.title, body: proposal.body, labels });
          card.classList.add('filed');
          card.innerHTML = `<h4>${escapeHtml(proposal.title)}</h4>
            <div class="filed-note">✓ Filed — ${escapeHtml((labels || []).join(', '))}</div>
            ${out.url ? `<a href="${escapeHtml(out.url)}" target="_blank" rel="noopener">${escapeHtml(out.url)}</a>` : ''}`;
        } catch (e) {
          addBubble('error', `Could not file: ${e.message}`);
          card.querySelectorAll('button,.chip').forEach((b) => (b.style.pointerEvents = ''));
        }
      };
    };
    render();
    thread.appendChild(card);
    thread.scrollTop = thread.scrollHeight;
  };

  const submit = async (e) => {
    e?.preventDefault?.();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    addBubble('owner', text);
    history.push({ role: 'user', text });
    send.disabled = true;
    const typing = addBubble('assistant typing', '…');
    try {
      const data = await post('/api/concierge/message', { history: history.slice(0, -1), text });
      typing.remove();
      addBubble('assistant', data.reply || '(no reply)');
      history.push({ role: 'assistant', text: data.reply || '' });
      if (data.proposal) addProposalCard(data.proposal);
    } catch (err) {
      typing.remove();
      addBubble('error', err.message);
    } finally {
      send.disabled = false;
    }
  };

  composer.addEventListener('submit', submit);
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px'; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) submit(e); });

  const get = async (p) => { try { const r = await fetch(p, { headers: authHeaders() }); return r.ok ? await r.json() : null; } catch { return null; } };
  const renderCards = (box, cards) => {
    box.innerHTML = cards.map((c) => `
      <div class="card"><h3>${escapeHtml(c.title)}</h3>
        ${c.rows.map((r) => `<div class="metric"><span>${escapeHtml(r.label)}</span><span class="v ${r.cls || ''}">${escapeHtml(r.value)}</span></div>`).join('')}
      </div>`).join('');
  };

  // Tabs
  let activeView = 'chat';
  const loading = (box) => { if (!box.querySelector('.card')) box.innerHTML = '<div class="card muted">Loading…</div>'; };
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      const view = tab.dataset.view;
      activeView = view;
      $('view-chat').classList.toggle('active', view === 'chat');
      $('view-status').classList.toggle('active', view === 'status');
      $('view-alerts').classList.toggle('active', view === 'alerts');
      $('view-tasks').classList.toggle('active', view === 'tasks');
      if (view === 'status') loadStatus();
      if (view === 'alerts') loadAlerts();
      if (view === 'tasks') loadTasks();
    };
  });

  const loadStatus = async () => {
    const box = $('status'); loading(box);
    const [health, daily, activity] = await Promise.all([get('/api/health'), get('/api/daily'), get('/api/activity-log?limit=20')]);
    const cards = summarizeStatus({ health, daily: daily?.report ?? daily });
    cards.push(summarizeActivity(activity?.events));
    renderCards(box, cards);
  };

  const loadAlerts = async () => {
    const box = $('alerts'); loading(box);
    const data = await get('/api/concierge/alerts');
    renderCards(box, [summarizeAlerts(data?.alerts)]);
  };

  const loadTasks = async () => {
    const box = $('tasks'); loading(box);
    const { buildTaskBoard } = await import('/tasks-model.js');   // browser-only; absolute path served by the dashboard
    const data = await get('/api/board/tasks');
    renderCards(box, summarizeTaskColumns(buildTaskBoard(data?.tasks ?? [])));
  };

  $('refresh').onclick = () => { loadStatus(); loadAlerts(); loadTasks(); };

  // Auto-refresh the active data tab every 15s (paused on chat / when backgrounded),
  // so phone-side status updates appear without a manual refresh.
  const loaders = { status: loadStatus, alerts: loadAlerts, tasks: loadTasks };
  setInterval(() => {
    const v = pickPoll(activeView, { hidden: document.visibilityState === 'hidden' });
    if (v && loaders[v]) loaders[v]();
  }, 15000);

  // Pre-hydrate from server-side history; show greeting only when starting fresh.
  loadThreadHistory(thread, addBubble, { limit: 40 }).then((loaded) => {
    history.push(...loaded.map((e) => ({ role: e.role, text: e.text ?? '' })));
    if (!loaded.length) {
      addBubble('assistant', 'Hi — I\'m your mesh concierge. Tell me an idea to discuss, an instruction to relay, or ask what the mesh is up to. I\'ll only file something when you tap Confirm.');
    }
  }).catch(() => {
    addBubble('assistant', 'Hi — I\'m your mesh concierge. Tell me an idea to discuss, an instruction to relay, or ask what the mesh is up to. I\'ll only file something when you tap Confirm.');
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
