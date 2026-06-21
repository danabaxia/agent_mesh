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
    const pick = (k, label) => { if (s && s[k] != null) rows.push({ label, value: String(s[k]) }); };
    pick('openPrs', 'Open PRs'); pick('open_prs', 'Open PRs');
    pick('mergedToday', 'Merged today'); pick('merged_today', 'Merged today');
    pick('openIssues', 'Open issues'); pick('open_issues', 'Open issues');
    pick('tokens', 'Tokens'); pick('totalTokens', 'Tokens');
    if (rows.length) cards.push({ title: 'Daily report', rows });
  }

  if (!cards.length) cards.push({ title: 'Status', rows: [{ label: 'No status yet', value: '—', cls: 'muted' }] });
  return cards;
}

// --------------------------------------------------------------------------
// DOM wiring (browser only)
// --------------------------------------------------------------------------

function mount() {
  const $ = (id) => document.getElementById(id);
  const thread = $('thread');
  const input = $('input');
  const composer = $('composer');
  const send = $('send');
  const history = [];   // {role, text}

  const post = async (path, body) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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

  // Tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      const view = tab.dataset.view;
      $('view-chat').classList.toggle('active', view === 'chat');
      $('view-status').classList.toggle('active', view === 'status');
      if (view === 'status') loadStatus();
    };
  });

  const loadStatus = async () => {
    const box = $('status');
    box.innerHTML = '<div class="card muted">Loading…</div>';
    const get = async (p) => { try { const r = await fetch(p); return r.ok ? await r.json() : null; } catch { return null; } };
    const [health, daily] = await Promise.all([get('/api/health'), get('/api/daily')]);
    const cards = summarizeStatus({ health, daily: daily?.report ?? daily });
    box.innerHTML = cards.map((c) => `
      <div class="card"><h3>${escapeHtml(c.title)}</h3>
        ${c.rows.map((r) => `<div class="metric"><span>${escapeHtml(r.label)}</span><span class="v ${r.cls || ''}">${escapeHtml(r.value)}</span></div>`).join('')}
      </div>`).join('');
  };

  $('refresh').onclick = loadStatus;

  addBubble('assistant', 'Hi — I\'m your mesh concierge. Tell me an idea to discuss, an instruction to relay, or ask what the mesh is up to. I\'ll only file something when you tap Confirm.');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
