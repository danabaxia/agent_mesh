/**
 * src/dashboard/public/session-view.js — board2 Session tab (Phase 7).
 *
 * Self-contained TURN-BASED session view fed by transcript RECORDS (not the
 * legacy session-log component's DOM). Three columns, layout/classes
 * organized as scv2-*:
 *
 *   chat (30%, turn cards + filter chips + composer)
 *   │ canvas (tab strip: LAST 8 + '‹ N older ▾' select; ONE artifact card)
 *   │ meta panel (id/agent/started/last/turns/artifacts + rename/delete/⌘)
 *
 * Data protocol (recon of session-log.js + server.js session routes — mirrored,
 * not guessed):
 *   GET  /session/list                → { ok, sessions, canonicalId } — open the
 *        canonical id ONLY (one-session-per-agent), never newest-by-mtime.
 *   GET  /session/:id/transcript?beforeSeq=&limit=  (limit cap 500) →
 *        { ok, records:[{seq, events:[…]}], hasMore, nextCursor } — REVERSE
 *        paged: newest `limit` records with seq < beforeSeq. seq = 1-based
 *        transcript line index, shared with the stream cursor.
 *   GET  /session/:id/stream?fromSeq=N (SSE) → `event: record` with id:=seq and
 *        data:=JSON record; `event: gap` = replay gap → full reload. Browser
 *        auto-reconnect threads Last-Event-ID, which the server prefers.
 *   POST /session/message {text}      → 202 { turnId }   (composer)
 *   POST /session/:id/rename {name}   → 200 { ok, label }
 *   POST /session/:id/delete {}       → 200 { ok }
 *   POST /api/agent/:name/artifacts   → 201 { ok, id }   (↓ save)
 *
 * IMPORTANT envelope note: the records are NOT raw claude JSONL — the server
 * normalizes + REDACTS each line into events (user_text/text/tool_use/
 * tool_result), now carrying `ts` (record timestamp ISO) and `sidechain`
 * (sub-agent flag). rawFromRecords() below rebuilds minimal raw-shaped records
 * from those events so the pure groupTurns() model applies unchanged.
 *
 * Copy resume command: uses the /session/resume-command GET route (2026-06-13 spec §5).
 * session-log.js is still imported for transcriptWindowUrl/streamUrl (ES import;
 * that module's only import-time side effects are defining window.mountSessionLog
 * and pulling result-canvas.js — both benign, and board2.html already loads it).
 */
import { groupTurns, extractImageRefs } from '/session-model.js';
import { circ, preview, capUtf8, rawFromRecords } from '/session-view-model.js';
import { mdToHtml } from '/md-lite.js';
import { transcriptWindowUrl, streamUrl } from '/session-log.js';
import { followTarget, isUserOrigin } from '/follow-policy.js';
import { createTimeline } from '/timeline-model.js';

const PAGE_LIMIT = 500;       // server max — fewest 'load older' clicks per page
const CHAT_PREVIEW = 260;     // chars per chat card (reference value)
const Q_PREVIEW = 400;        // chars in the Q callout (reference value)
const TAB_KEEP = 8;           // visible tabs; older collapse into the dropdown
const SAVE_TASK_CHARS = 200;  // task prefill = first 200 chars of the question
const SAVE_CAP_BYTES = 64 * 1024;

// ── pure helpers ────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

// circ/preview/capUtf8/rawFromRecords now live in /session-view-model.js (pure,
// unit-tested); imported above. Date/locale formatters stay here (non-pure).

function fmtFull(ts) {  // 'Jun 11, 3:27 PM'
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return '—'; }
}
function fmtClock(ts) { // '3:27 PM'
  if (!ts) return '';
  try { return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}
function dur(qts, ats) {
  const s = Math.round((new Date(ats) - new Date(qts)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '?';
  return s < 90 ? `${s}s` : `${Math.floor(s / 60)}m`;
}
// rawFromRecords is re-exported (was a public export of this module before the
// extraction; nothing imports it externally today, but the surface is kept).
export { rawFromRecords };

// ── view ────────────────────────────────────────────────────────────────────

export function renderSessionView(body, agent, mesh) {
  let destroyed = false;
  let openId = null;          // LIVE session whose stream is open (last segment)
  let sessionMeta = null;     // /session/list row for openId
  let records = [];           // LIVE segment's envelope records, sorted by seq
  const seqSet = new Set();   // LIVE segment's seqs (seq is per-session — reset on switch)
  let turns = [];             // groupTurns output, concatenated across segments
  let artifacts = [];         // turns with a non-empty answer, ordinal = idx+1
  let selected = 0;           // selected artifact ordinal (0 = none)
  let pinnedArt = false;      // user pinned an older ARTIFACT tab (stop follow-latest)
  let hasMore = false;        // scroll-up can still load older content (live pages OR older sessions)
  let oldestCursor = null;    // nextCursor for the LIVE session's deeper pages (used until history is loaded)
  let stream = null;
  let firstChatRender = true;

  // ── stitched cross-session model + follow-policy state (2026-06-13 §4/§7) ──
  let timeline = createTimeline();     // ordered segments; live = last, sealed = static history
  let lastSeen = {};          // id → endedAt at the previous poll (growth detection)
  let pinnedId = null;        // pinned SESSION id (seam click / pin toggle) — drives followTarget
  let rowsById = {};          // latest poll's rows, by id, for divider metadata + history lazy-load

  const api = (p, o) =>
    fetch(`/api/agent/${encodeURIComponent(agent)}${p}`, { credentials: 'same-origin', ...o });
  const jsonHeaders = { 'Content-Type': 'application/json' };

  body.innerHTML = '<div class="scv2-root"><div class="scv2-loading">Loading session…</div></div>';
  const root = body.querySelector('.scv2-root');

  // ── follow resolution (poll @4s like session-log, so a fresh `claude`
  //    started in the user's own terminal surfaces here promptly). The pure
  //    followTarget() policy (2026-06-13 §4) picks which session the canvas
  //    tracks: pin > grown live USER session > sticky-active current >
  //    canonical > newest — never an auto-followed peer:*/worker:* spawn. ────
  async function loadFollow() {
    let j;
    try { j = await (await api('/session/list')).json(); } catch { j = { sessions: [] }; }
    if (destroyed) return;
    const rows = j.sessions || [];
    rowsById = Object.fromEntries(rows.map((r) => [r.id, r]));
    const target = followTarget(rows, {
      currentId: openId, pinnedId, canonicalId: j.canonicalId || null, lastSeen
    });
    // record this poll's growth watermark AFTER the decision (next poll compares)
    for (const r of rows) lastSeen[r.id] = r.endedAt;
    if (!target) { if (openId || firstChatRender) renderEmpty(); return; }
    const row = rowsById[target];
    if (j.digesting) row.digesting = true;
    if (j.projectsDir) row.projectsDir = j.projectsDir;
    if (target !== openId) { sessionMeta = row; await openSegmentFor(row); }
    else { sessionMeta = row; renderMeta(); }
  }

  function renderEmpty() {
    closeStream();
    openId = null; sessionMeta = null; records = []; seqSet.clear();
    timeline = createTimeline();   // drop stale segments — nothing is followed now
    turns = []; artifacts = []; selected = 0; pinnedArt = false; firstChatRender = false;
    root.innerHTML =
      `<div class="scv2-empty">` +
        `<p>No session yet for <b>${esc(agent)}</b>.</p>` +
        `<p>No session yet. Copy the command below and run it in your terminal — the session surfaces here within a few seconds.</p>` +
        `<button id="sv-term" class="scv2-btn scv2-amber" title="Copy a command that starts a new session in YOUR terminal (nothing is launched)">⧉ Copy resume command</button>` +
        `<div class="scv2-flash" id="sv-flash"></div>` +
      `</div>`;
    root.querySelector('#sv-term').onclick = () => copyResume('new');
  }

  // ── follow switch: seal the prior segment, open a NEW live segment for `row`,
  //    load its newest transcript window, stream it. NOTHING is cleared — the
  //    sealed segments stay as static history above the new live stream (§7).
  //    Stream open/close mechanics and the windowed /transcript fetch are
  //    unchanged from the single-session path; only the records destination
  //    moves from the flat buffer to the timeline's live segment. ────────────
  async function openSegmentFor(row) {
    closeStream();
    openId = row.id;
    // seq is PER-SESSION → the live working buffer resets on every switch; the
    // timeline keeps the prior segment's records (sealed) untouched.
    records = []; seqSet.clear(); selected = 0; pinnedArt = false; firstChatRender = true;
    timeline.openSegment({ id: row.id, originSource: row.originSource, startedAt: row.startedAt });
    let t;
    try { t = await (await fetch(transcriptWindowUrl(agent, openId, { limit: PAGE_LIMIT }), { credentials: 'same-origin' })).json(); }
    catch { t = { records: [] }; }
    if (destroyed || openId !== row.id) return;
    ingest(t.records || []);          // dedups into the buffer + seeds the live segment
    hasMore = !!t.hasMore;
    oldestCursor = t.nextCursor ?? null;
    buildShell();
    regroupAndRender('init');
    openStream();
  }

  // ingest LIVE-session records: dedup by per-session seq, keep the sorted live
  // buffer, then mirror it into the timeline's live segment via seedLive (a
  // wholesale sorted replace — order-correct whether records arrive newest
  // (stream), older (scroll-up live pages), or as a gap reload).
  function ingest(recs) {
    let added = false;
    for (const r of recs) {
      if (!r || seqSet.has(r.seq)) continue;
      seqSet.add(r.seq);
      records.push(r);
      added = true;
    }
    if (added) { records.sort((a, b) => a.seq - b.seq); timeline.seedLive(openId, records); }
    return added;
  }

  function buildShell() {
    const composer = mesh?.shellEnabled
      ? `<div class="scv2-composer">` +
          `<input class="scv2-input" id="sv-input" placeholder="Message ${esc(agent)}…">` +
          `<button class="scv2-send" id="sv-send">Send</button>` +
        `</div>`
      : '';
    root.innerHTML =
      `<div class="scv2-chat">` +
        `<div class="scv2-clabel">CHAT — canonical session` +
          `<span class="scv2-chips">` +
            `<span class="scv2-chip on" data-fil="user" title="Hide user prompts">user</span>` +
            `<span class="scv2-chip on" data-fil="reply" title="Hide replies">reply</span>` +
            `<span class="scv2-chip on" data-fil="tool" title="Hide tool calls">tool</span>` +
          `</span>` +
        `</div>` +
        `<div class="scv2-chatlog" id="sv-chatlog"></div>` +
        composer +
      `</div>` +
      `<div class="scv2-canvas">` +
        `<div class="scv2-atabs" id="sv-atabs"></div>` +
        `<div class="scv2-cwrap" id="sv-cwrap"></div>` +
      `</div>` +
      `<div class="scv2-meta" id="sv-meta"></div>` +
      `<div class="scv2-flash" id="sv-flash"></div>`;

    // filter chips → hide-<kind> classes on the chatlog
    for (const chip of root.querySelectorAll('[data-fil]')) {
      chip.addEventListener('click', () => {
        const hidden = root.querySelector('#sv-chatlog').classList.toggle(`hide-${chip.dataset.fil}`);
        chip.classList.toggle('on', !hidden);
      });
    }
    // chat: select artifact from answer cards / → canvas links; load older;
    // pin a session by clicking its seam divider.
    root.querySelector('#sv-chatlog').addEventListener('click', (e) => {
      if (e.target.closest('#sv-older')) { loadOlder(); return; }
      const seam = e.target.closest('.scv2-seam');
      if (seam && seam.dataset.sid) { pinnedId = seam.dataset.sid; loadFollow(); return; }
      const t = e.target.closest('[data-art]');
      if (t && t.dataset.art) select(Number(t.dataset.art), true);
    });
    // canvas tabs: clicks + older dropdown
    root.querySelector('#sv-atabs').addEventListener('click', (e) => {
      const t = e.target.closest('.scv2-atab');
      if (t && t.dataset.art) select(Number(t.dataset.art), true);
    });
    root.querySelector('#sv-atabs').addEventListener('change', (e) => {
      const sel = e.target.closest('.scv2-aolder');
      if (sel && sel.value) select(Number(sel.value), true);
    });
    // composer
    const send = root.querySelector('#sv-send');
    if (send) {
      const input = root.querySelector('#sv-input');
      const submit = async () => {
        const text = input.value.trim();
        if (!text) return;
        send.disabled = true;
        try {
          const r = await api('/session/message', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ text }) });
          const j = await r.json().catch(() => ({}));
          if (r.status === 202 && j.ok) { input.value = ''; flash('✓ queued'); }
          else flash('Send failed: ' + (j.error?.code || r.status));
        } catch (e2) { flash('Send failed: ' + e2.message); }
        send.disabled = false;
      };
      send.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    }
  }

  // ── grouping + render pipeline ─────────────────────────────────────────────
  // Group EACH segment's records independently, then concatenate. Per-segment
  // grouping is sound: a turn boundary is a genuine user prompt and every
  // segment is a distinct session whose first record is its own prompt, so no
  // cross-session turn can bleed. Each turn is tagged with its segment so
  // renderChat can lay a seam at session boundaries; artifact ordinals run
  // continuously across the whole stitched history (one tab strip).
  function regroupAndRender(mode) {
    const segs = timeline.segments();
    turns = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const segTurns = groupTurns(rawFromRecords(seg.records));
      for (let k = 0; k < segTurns.length; k++) {
        // seam goes before the FIRST turn of every segment except the oldest
        // (a divider marks a session boundary BETWEEN two segments, §7).
        segTurns[k].sid = seg.sessionId;
        // truncated: sealed history segment loaded as a single PAGE_LIMIT window
        // (Phase B of loadOlder) — the full session may be longer.
        const truncated = seg.sealed && seg.records.length === PAGE_LIMIT;
        segTurns[k].seam = (i > 0 && k === 0)
          ? { sid: seg.sessionId, label: seg.label, truncated }
          : null;
      }
      turns.push(...segTurns);
    }
    artifacts = turns.filter((t) => t.answer);
    if (!pinnedArt || selected > artifacts.length || selected < 1) selected = artifacts.length; // follow latest
    renderChat(mode);
    renderTabs();
    renderCanvas(mode);
    renderMeta();
  }

  function renderChat(mode) {
    const log = root.querySelector('#sv-chatlog');
    if (!log) return;
    const prevTop = log.scrollTop, prevH = log.scrollHeight;
    const atBottom = firstChatRender || (prevTop + log.clientHeight >= prevH - 40);
    let art = 0;
    const cards = [];
    if (canLoadOlder()) cards.push(`<button class="scv2-olderbtn" id="sv-older">↑ load older transcript</button>`);
    for (const t of turns) {
      if (t.seam) {
        const seamExtra = t.seam.truncated ? ' · latest window only' : '';
        cards.push(
          `<div class="scv2-seam" data-sid="${esc(t.seam.sid)}" title="click to pin this session">` +
          `— ${esc(t.seam.label)} · ${esc(String(t.seam.sid).slice(0, 8))}${seamExtra} —</div>`
        );
      }
      const isArt = !!t.answer;
      if (isArt) art += 1;
      cards.push(
        `<div class="scv2-turn user"><div class="who">USER · ⌘ <span class="when">${esc(fmtClock(t.qts))}</span></div>${esc(preview(t.q, CHAT_PREVIEW))}</div>`
      );
      for (const ev of t.internals) {
        if (ev.kind === 'tool') {
          cards.push(`<div class="scv2-turn tool"><div class="who">TOOL <span class="when">${esc(fmtClock(ev.ts))}</span></div>${esc(preview(ev.text, 110))}</div>`);
        } else {
          cards.push(`<div class="scv2-turn reply"><div class="who">REPLY <span class="when">${esc(fmtClock(ev.ts))}</span></div>${esc(preview(ev.text, CHAT_PREVIEW))}</div>`);
        }
      }
      if (isArt) {
        cards.push(
          `<div class="scv2-turn reply scv2-ans" data-art="${art}"><div class="who">REPLY <span class="when">${esc(fmtClock(t.ats))}</span></div>` +
          `${esc(preview(t.answer, CHAT_PREVIEW))} <span class="scv2-artlink" data-art="${art}">→ canvas ${circ(art)}</span></div>`
        );
      }
    }
    if (!turns.length) cards.push('<div class="scv2-blank">No conversation records yet.</div>');
    log.innerHTML = cards.join('');
    // scroll preservation: prepend keeps the viewport anchored; otherwise
    // stick-to-bottom when the user was at (or near) the bottom.
    if (mode === 'prepend') log.scrollTop = log.scrollHeight - prevH + prevTop;
    else if (atBottom) log.scrollTop = log.scrollHeight;
    else log.scrollTop = prevTop;
    firstChatRender = false;
  }

  function renderTabs() {
    const host = root.querySelector('#sv-atabs');
    if (!host) return;
    const n = artifacts.length;
    if (!n) { host.innerHTML = '<span class="scv2-tabs-empty">No artifacts yet — answers will appear here as tabs.</span>'; return; }
    const parts = [];
    const olderCount = Math.max(0, n - TAB_KEEP);
    if (olderCount > 0) {
      const opts = [`<option value="">‹ ${olderCount} older ▾</option>`];
      for (let i = 1; i <= olderCount; i++) {
        const a = artifacts[i - 1];
        opts.push(`<option value="${i}"${i === selected ? ' selected' : ''}>${circ(i)} ${esc(a.type)} · ${esc(fmtClock(a.ats))} — ${esc(a.title.slice(0, 60))}</option>`);
      }
      parts.push(`<select class="scv2-aolder" title="older artifacts">${opts.join('')}</select>`);
    }
    for (let i = olderCount + 1; i <= n; i++) {
      const a = artifacts[i - 1];
      parts.push(`<span class="scv2-atab${i === selected ? ' on' : ''}" data-art="${i}" title="${esc(a.title)}">${circ(i)} ${esc(a.type)} · ${esc(fmtClock(a.ats))}</span>`);
    }
    host.innerHTML = parts.join('');
  }

  function renderCanvas(mode) {
    const wrap = root.querySelector('#sv-cwrap');
    if (!wrap) return;
    const keepScroll = mode === 'live' && wrap.dataset.sel === String(selected);
    const prevTop = wrap.scrollTop;
    const a = artifacts[selected - 1];
    if (!a) { wrap.innerHTML = '<div class="scv2-blank">No artifact selected.</div>'; wrap.dataset.sel = '0'; return; }
    // an artifact carries its source session (.sid) — older ones come from
    // stitched history, not the live session, so stamp the artifact's own id.
    const artSid = a.sid || openId;
    const sid8 = artSid ? String(artSid).slice(0, 8) : '—';
    wrap.innerHTML =
      `<div class="scv2-cv">` +
        `<div class="scv2-ahead">` +
          `<span class="scv2-abadge">${esc(String(a.type).toUpperCase())}</span>` +
          `<h3>${esc(a.title)}</h3>` +
          `<span class="scv2-ameta">asked ${esc(fmtFull(a.qts))} → answered ${esc(fmtClock(a.ats))} (${esc(dur(a.qts, a.ats))}) · ${a.tools} tool calls · ${esc(agent)} · ${esc(sid8)}</span>` +
          `<span class="scv2-aacts">` +
            `<button id="sv-copy" title="Copy the answer text">⧉</button>` +
            `<button id="sv-save" title="Save this Q→A as an artifact">↓ save</button>` +
          `</span>` +
        `</div>` +
        `<div class="scv2-aq"><b>Q</b> ${esc(preview(a.q, Q_PREVIEW))}</div>` +
        `<div class="scv2-abody">${mdToHtml(a.answer)}</div>` +
        `<div class="scv2-gallery" id="sv-gallery"></div>` +
        `<div id="sv-saveform"></div>` +
      `</div>`;
    // Stamp the selection BEFORE the async gallery render: the gallery's
    // stale-check compares against the CURRENT selection snapshot — stamping
    // after the call made every tab switch look stale and killed the gallery
    // (the "plot never renders when I click a tab" bug).
    wrap.dataset.sel = String(selected);
    renderImageGallery(a, selected);
    wrap.scrollTop = keepScroll ? prevTop : 0;
    wrap.querySelector('#sv-copy').onclick = async () => {
      const btn = wrap.querySelector('#sv-copy');
      try { await navigator.clipboard.writeText(a.answer); btn.textContent = '✓'; }
      catch { btn.textContent = '⚠'; }
      setTimeout(() => { btn.textContent = '⧉'; }, 1200);
    };
    wrap.querySelector('#sv-save').onclick = () => toggleSaveForm(a);
  }

  // ── image gallery: render images the answer references (Phase-7 fix) ──────
  // Only files under the agent's deliverables/ tree are servable (the
  // deliverable endpoint with proper MIME + containment). Bare filenames are
  // resolved against the deliverables LISTING by basename — this also heals
  // older replies written before the deliverables convention, after the file
  // is moved into place. Unresolvable refs render an honest note instead.
  let deliverablesIndex = null;   // basename → deliverables-relative path
  async function getDeliverablesIndex() {
    if (deliverablesIndex) return deliverablesIndex;
    const idx = new Map();
    try {
      const r = await fetch(`/api/agent/${encodeURIComponent(agent)}/deliverables`, { credentials: 'same-origin' });
      if (r.ok) {
        for (const e of (await r.json()).entries ?? []) {
          const base = e.path.split('/').pop();
          if (!idx.has(base)) idx.set(base, e.path);
        }
      }
    } catch { /* listing unavailable → all refs unresolved */ }
    deliverablesIndex = idx;
    return idx;
  }

  async function renderImageGallery(a, mySel) {
    const host = root.querySelector('#sv-gallery');
    if (!host) return;
    const refs = extractImageRefs(a.answer);
    if (!refs.length) { host.innerHTML = ''; return; }
    let idx = await getDeliverablesIndex();
    // user may have switched artifacts while the listing loaded — compare the
    // live selection against the snapshot WE were rendered for.
    if (selected !== mySel) return;
    // a freshly-produced plot may postdate the cached listing: on any
    // basename miss, refresh the index once before declaring it unviewable.
    if (refs.some((r) => !r.deliverablesRel && !idx.has(r.basename))) {
      deliverablesIndex = null;
      idx = await getDeliverablesIndex();
      if (selected !== mySel) return;
    }
    const parts = [];
    for (const ref of refs) {
      const rel = ref.deliverablesRel ?? idx.get(ref.basename) ?? null;
      if (rel) {
        const url = `/api/agent/${encodeURIComponent(agent)}/deliverable?path=${encodeURIComponent(rel)}`;
        parts.push(
          `<figure class="scv2-fig">` +
          `<img src="${esc(url)}" loading="lazy" alt="${esc(ref.basename)}">` +
          `<figcaption>${esc(ref.basename)} · deliverables/${esc(rel)}</figcaption></figure>`);
      } else {
        parts.push(
          `<div class="scv2-imgnote">🖼 ${esc(ref.basename)} — saved outside deliverables/, not viewable. ` +
          `Agents must save user-facing files under deliverables/YYYY-MM-DD/&lt;task&gt;/.</div>`);
      }
    }
    host.innerHTML = parts.join('');
  }

  // ── ↓ save: inline mini-form → POST /api/agent/:name/artifacts ────────────
  function toggleSaveForm(a) {
    const host = root.querySelector('#sv-saveform');
    if (!host) return;
    if (host.firstChild) { host.innerHTML = ''; return; }
    host.innerHTML =
      `<div class="scv2-form">` +
        `<input id="sv-f-title" placeholder="title">` +
        `<input id="sv-f-task" placeholder="task (what was asked)">` +
        `<textarea id="sv-f-frame" rows="2" placeholder="frame lines (optional, one per line)"></textarea>` +
        `<div class="scv2-form-row"><button id="sv-f-go">Save artifact</button><span class="scv2-ferr" id="sv-f-msg"></span></div>` +
      `</div>`;
    host.querySelector('#sv-f-title').value = a.title;
    host.querySelector('#sv-f-task').value = a.q.slice(0, SAVE_TASK_CHARS);
    host.querySelector('#sv-f-go').onclick = async () => {
      const btn = host.querySelector('#sv-f-go');
      const msg = host.querySelector('#sv-f-msg');
      btn.disabled = true; msg.textContent = '';
      const payload = {
        title: host.querySelector('#sv-f-title').value.trim(),
        type: a.type,
        task: host.querySelector('#sv-f-task').value.trim(),
        frame: host.querySelector('#sv-f-frame').value.split('\n').map((s) => s.trim()).filter(Boolean),
        inputs: [],
        source: { kind: 'text', content: capUtf8(`Q: ${a.q}\n\nA: ${a.answer}`, SAVE_CAP_BYTES) },
        sessionId: a.sid || openId
      };
      try {
        const r = await api('/artifacts', { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 201 && j.ok) {
          host.innerHTML = `<div class="scv2-form"><span class="scv2-saved">✓ saved ${esc(j.id)}</span></div>`;
        } else { msg.textContent = 'Save failed: ' + (j.error?.code || r.status); btn.disabled = false; }
      } catch (e) { msg.textContent = 'Save failed: ' + e.message; btn.disabled = false; }
    };
  }

  // ── meta panel ─────────────────────────────────────────────────────────────
  function renderMeta() {
    const host = root.querySelector('#sv-meta');
    if (!host) return;
    const s = sessionMeta || {};
    const sid8 = openId ? openId.slice(0, 8) + '…' : '—';
    const started = turns.length ? fmtFull(turns[0].qts) : fmtFull(s.startedAt ? new Date(s.startedAt).toISOString() : '');
    const last = turns.length ? fmtFull(turns[turns.length - 1].ats) : fmtFull(s.endedAt ? new Date(s.endedAt).toISOString() : '');
    // follow-mode badge: pinned (click to release) | following live CLI | quiet
    let badge = '';
    if (pinnedId) badge = `<div class="scv2-follow pinned" id="sv-pin" title="click to unpin and resume auto-follow">📌 pinned — click to unpin</div>`;
    else if (s.originSource === 'cli' && s.active) badge = `<div class="scv2-follow live">● following live CLI session</div>`;
    if (s.digesting) badge += `<div class="scv2-follow digest">⟳ digesting…</div>`;
    host.innerHTML =
      `<div class="scv2-shead">SESSION</div>` + badge + `<table>` +
        `<tr><td>ID</td><td title="${esc(openId || '')}">${esc(sid8)}</td></tr>` +
        (s.label ? `<tr><td>LABEL</td><td>${esc(s.label)}</td></tr>` : '') +
        `<tr><td>AGENT</td><td>${esc(agent)}</td></tr>` +
        `<tr><td>STARTED</td><td>${esc(started)}</td></tr>` +
        `<tr><td>LAST</td><td>${esc(last)}</td></tr>` +
        `<tr><td>TURNS</td><td id="sv-mturns">${turns.length}${canLoadOlder() ? '+' : ''}</td></tr>` +
        `<tr><td>ARTIFACTS</td><td>${artifacts.length}</td></tr>` +
      `</table>` +
      `<div class="scv2-mbtns">` +
        `<button id="sv-rename" title="Rename this session">✎ Rename</button>` +
        `<button id="sv-delete" title="Permanently delete this session transcript">🗑 Delete</button>` +
        `<button id="sv-term" class="scv2-amber" title="Copy a command that resumes this session in YOUR terminal (nothing is launched)">⧉ Copy resume command</button>` +
      `</div>`;
    host.querySelector('#sv-rename').onclick = onRename;
    host.querySelector('#sv-delete').onclick = onDelete;
    host.querySelector('#sv-term').onclick = () => copyResume(openId);
    const pin = host.querySelector('#sv-pin');
    if (pin) pin.onclick = () => { pinnedId = null; loadFollow(); };
  }

  async function onRename() {
    if (!openId) return;
    const s = sessionMeta || {};
    const name = prompt('Rename session', s.label || s.firstPrompt || '');
    if (name == null) return;
    try {
      const r = await api(`/session/${openId}/rename`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ name }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) loadFollow();
      else flash('Rename failed: ' + (j.error?.code || r.status));
    } catch (e) { flash('Rename failed: ' + e.message); }
  }

  async function onDelete() {
    if (!openId) return;
    if (!confirm('Permanently delete this session transcript?\n\nThis removes Claude Code\'s OWN history for this session (~/.claude/projects) and cannot be undone.')) return;
    try {
      const r = await api(`/session/${openId}/delete`, { method: 'POST', headers: jsonHeaders, body: '{}' });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) renderEmpty();
      else flash('Delete failed: ' + (j.error?.code || r.status));
    } catch (e) { flash('Delete failed: ' + e.message); }
  }

  // Copy resume command — EDR-proof replacement for ⌘ Terminal spawn (2026-06-13 spec §5).
  async function copyResume(idOrKeyword) {
    let j;
    try { j = await (await api(`/session/resume-command?id=${encodeURIComponent(idOrKeyword)}`)).json(); }
    catch { flash('Could not build the resume command'); return; }
    if (!j.ok) { flash(`No command: ${j.error?.code || 'unknown'}`); return; }
    try { await navigator.clipboard.writeText(j.command); flash('Copied — paste in your terminal'); }
    catch { flash(j.command); } // clipboard blocked → show it for manual copy
  }

  // ── selection / paging / live ──────────────────────────────────────────────
  function select(i, pin) {
    if (i < 1 || i > artifacts.length) return;
    selected = i;
    pinnedArt = pin && i !== artifacts.length; // re-selecting the latest resumes follow-latest
    renderTabs();
    renderCanvas('select');
  }

  // The next-older USER session to stitch above the loaded history: a
  // user-origin row (peer:*/worker:* are never stitched, §7), not already a
  // segment, with the greatest startedAt strictly older than the oldest loaded
  // segment. Returns null when nothing older remains.
  function nextOlderSessionRow() {
    const segs = timeline.segments();
    if (!segs.length) return null;
    const loaded = new Set(segs.map((s) => s.sessionId));
    const oldestStart = Number(segs[0].startedAt) || 0;
    let best = null;
    for (const r of Object.values(rowsById)) {
      if (loaded.has(r.id) || !isUserOrigin(r.originSource)) continue;
      const st = Number(r.startedAt) || 0;
      if (st >= oldestStart) continue;               // only strictly-older sessions
      if (!best || st > (Number(best.startedAt) || 0)) best = r;
    }
    return best;
  }

  // Scroll-up can load more iff the live session has deeper pages OR an older
  // user session is still unstitched.
  function canLoadOlder() { return hasMore || !!nextOlderSessionRow(); }

  let loadingOlder = false;
  async function loadOlder() {
    if (loadingOlder || !openId) return;
    // Phase A: page the LIVE session deeper (per-session seq cursor) until
    // exhausted — this grows the live segment in place via ingest/seedLive.
    if (hasMore && oldestCursor != null) {
      loadingOlder = true;
      const btn = root.querySelector('#sv-older');
      if (btn) { btn.disabled = true; btn.textContent = 'loading…'; }
      let t;
      try { t = await (await fetch(transcriptWindowUrl(agent, openId, { beforeSeq: oldestCursor, limit: PAGE_LIMIT }), { credentials: 'same-origin' })).json(); }
      catch { t = { records: [] }; }
      loadingOlder = false;
      if (destroyed) return;
      ingest(t.records || []);
      hasMore = !!t.hasMore;
      oldestCursor = t.nextCursor ?? oldestCursor;
      regroupAndRender('prepend');
      return;
    }
    // Phase B: live session fully paged → stitch the next-older user session as
    // ONE prepended history segment (its newest PAGE_LIMIT window). Deep paging
    // WITHIN a sealed history segment is out of scope (the pure model has no
    // grow-sealed op); very long older sessions surface their latest window.
    const older = nextOlderSessionRow();
    if (!older) return;                              // nothing older remains
    loadingOlder = true;
    const btn = root.querySelector('#sv-older');
    if (btn) { btn.disabled = true; btn.textContent = 'loading…'; }
    let t;
    try { t = await (await fetch(transcriptWindowUrl(agent, older.id, { limit: PAGE_LIMIT }), { credentials: 'same-origin' })).json(); }
    catch { t = { records: [] }; }
    loadingOlder = false;
    if (destroyed) return;
    timeline.prependHistory(
      { id: older.id, originSource: older.originSource, startedAt: older.startedAt },
      t.records || []
    );
    regroupAndRender('prepend');
  }

  function openStream() {
    if (typeof EventSource === 'undefined' || !openId) return;
    // fromSeq reads the flat live-buffer (mirror of the live segment via seedLive); if these ever diverge, derive from timeline.segments().at(-1) instead.
    const fromSeq = records.length ? records[records.length - 1].seq : 0;
    stream = new EventSource(streamUrl(agent, openId, fromSeq));
    const id = openId;
    stream.addEventListener('record', (e) => {
      if (destroyed || openId !== id) return;
      let rec;
      try { rec = JSON.parse(e.data); } catch { return; }
      if (ingest([rec])) regroupAndRender('live');
    });
    stream.addEventListener('gap', () => {
      // replay gap → reload the newest window from scratch (cheap + correct).
      // Same id → timeline.openSegment is a no-op; ingest re-seeds the live
      // segment, so sealed history above is preserved.
      if (!destroyed && openId === id && sessionMeta) openSegmentFor(sessionMeta);
    });
    stream.addEventListener('error', () => { /* EventSource auto-reconnects with Last-Event-ID */ });
  }

  function closeStream() { if (stream) { stream.close(); stream = null; } }

  // ── ephemeral toast ────────────────────────────────────────────────────────
  let flashTimer = null;
  function flash(msg) {
    const el = root.querySelector('#sv-flash');
    if (!el) return;
    el.textContent = msg; el.classList.add('on');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => el.classList.remove('on'), 2600);
  }

  // ── kickoff ────────────────────────────────────────────────────────────────
  // The live-session surface (/session/list, transcript stream) needs a backend
  // that only exists with --allow-shell; without it the endpoint 403s. Don't
  // poll a known-disabled capability every 4s — show a disabled state instead.
  let refreshTimer = null;
  if (mesh && mesh.sessionLogEnabled) {
    loadFollow();
    refreshTimer = setInterval(() => { if (!destroyed) loadFollow(); }, 4000);
  } else {
    root.innerHTML =
      `<div class="scv2-empty">` +
        `<p>Live session view is off for <b>${esc(agent)}</b>.</p>` +
        `<p>Start the dashboard with <code>--allow-shell</code> to follow live <code>claude</code> sessions here.</p>` +
      `</div>`;
  }

  return {
    destroy() {
      destroyed = true;
      closeStream();
      clearInterval(refreshTimer);
      clearTimeout(flashTimer);
      body.innerHTML = '';
    }
  };
}
