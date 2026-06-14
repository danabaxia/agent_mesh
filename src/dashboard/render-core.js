/**
 * src/dashboard/render-core.js — PURE rendering core (no DOM, no I/O), so the
 * security-critical sanitizer is fully node-testable. The browser result-canvas
 * shell consumes these HTML strings. No raw HTML passthrough; only http(s) URL
 * schemes; remote images are rewritten through the same-origin /api/img proxy.
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function safeUrl(url) {
  if (typeof url !== 'string') return null;
  const t = url.trim();
  return /^https?:\/\//i.test(t) ? t : null;
}

/** Remote image → same-origin proxy URL (img-src 'self' stays intact). */
export function imgProxyUrl(remote) {
  const safe = safeUrl(remote);
  return safe ? `/api/img?url=${encodeURIComponent(safe)}` : null;
}

/** Bold/italic/inline-code on ALREADY-ESCAPED text (adds only safe <b>/<i>/<code>). */
function applyInlineMarkup(escaped) {
  return String(escaped)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Full markdown → safe HTML. NO raw HTML passthrough (escapeHtml is the XSS
 * boundary). Fenced code, images (→ proxied <img>), and links are extracted from
 * the RAW source into pre-built safe blocks BEFORE the line-level escape pass —
 * so a link URL's `&` isn't double-encoded, and the per-call random nonce in the
 * placeholder token makes it unforgeable by user text.
 */
export function renderMarkdownSafe(src) {
  const nonce = Math.random().toString(36).slice(2, 10);
  const ph = (i) => `@@RC_${nonce}_${i}@@`;
  const blocks = [];
  const stash = (html) => { blocks.push(html); return ph(blocks.length - 1); };
  let s = String(src);
  // fenced code (escaped content)
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => stash(`<pre class="rc-code">${escapeHtml(code.replace(/\n$/, ''))}</pre>`));
  // GFM pipe tables (header row + separator row + 1+ body rows) → safe <table>.
  // Pre-extracted into the stash before the line-pass so the | chars don't end
  // up rendered as literal pipes inside <p> blocks. Header alignment from the
  // separator row is honoured (`:---:`, `---:`, `:---`).
  s = s.replace(
    /(?:^|\n)([^\n|]*\|[^\n]*)\n[\t ]*(\|?[\t ]*:?-{2,}:?[\t ]*(?:\|[\t ]*:?-{2,}:?[\t ]*)+\|?)\n((?:[^\n|]*\|[^\n]*(?:\n|$))+)/g,
    (_m, headRow, sepRow, bodyRows) => {
      const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const aligns = cells(sepRow).map(c => /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : 'left');
      const aClass = (i) => aligns[i] === 'center' ? ' class="c"' : aligns[i] === 'right' ? ' class="r"' : '';
      const th = cells(headRow).map((c, i) => `<th${aClass(i)}>${applyInlineMarkup(escapeHtml(c))}</th>`).join('');
      const tr = bodyRows.trim().split('\n').map(row => {
        const tds = cells(row).map((c, i) => `<td${aClass(i)}>${applyInlineMarkup(escapeHtml(c))}</td>`).join('');
        return `<tr>${tds}</tr>`;
      }).join('');
      return '\n' + stash(`<div class="rc-table-wrap"><table class="rc-table"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`) + '\n';
    }
  );
  // images ![alt](url) → proxied <img> (from RAW url)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const px = imgProxyUrl(url);
    return stash(px
      ? `<img class="rc-img" alt="${escapeHtml(alt)}" src="${escapeHtml(px)}">`
      : `<span class="rc-imgblocked">🖼 ${escapeHtml(alt || 'image')}</span>`);
  });
  // links [txt](url) → safe <a> (from RAW url; single escape, no double-encoding)
  s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_m, txt, url) => {
    const safe = safeUrl(url);
    return stash(safe
      ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(txt)}</a>`
      : escapeHtml(txt));
  });
  // line-based: headings, lists, paragraphs — escape text, then safe inline markup.
  // Consecutive `- `/`* ` lines are gathered into a single <ul> so list
  // semantics, indentation and bullet styling all behave (bare <li>s without
  // a <ul> parent miss list-style markers in many browsers).
  const out = [];
  let inUl = false;
  const closeUl = () => { if (inUl) { out.push('</ul>'); inUl = false; } };
  for (const line of s.split('\n')) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeUl(); out.push(`<h${h[1].length} class="rc-h">${applyInlineMarkup(escapeHtml(h[2]))}</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inUl) { out.push('<ul class="rc-ul">'); inUl = true; }
      out.push(`<li class="rc-li">${applyInlineMarkup(escapeHtml(line.replace(/^\s*[-*]\s+/, '')))}</li>`);
      continue;
    }
    if (line.trim() === '') { closeUl(); out.push(''); continue; }
    closeUl();
    out.push(`<p class="rc-p">${applyInlineMarkup(escapeHtml(line))}</p>`);
  }
  closeUl();
  // Reinject pre-built safe blocks. Placeholders are alnum/underscore so they
  // survive escapeHtml unchanged; the nonce makes user-forged tokens infeasible.
  return out.join('\n').replace(new RegExp(`@@RC_${nonce}_(\\d+)@@`, 'g'), (_m, i) => blocks[Number(i)] ?? '');
}

const MAX_CHART_POINTS = 64;
/** Bounded numeric chart spec → inline SVG (bar|line). Returns null if invalid. */
export function renderChartSvg(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const { type, labels, values } = spec;
  if (type !== 'bar' && type !== 'line') return null;
  if (!Array.isArray(labels) || !Array.isArray(values)) return null;
  if (values.length === 0 || values.length > MAX_CHART_POINTS || labels.length !== values.length) return null;
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const W = 320, H = 120, pad = 18, max = Math.max(1, ...values);
  const x = (i) => pad + (i * (W - 2 * pad)) / Math.max(1, values.length - (type === 'bar' ? 0 : 1));
  const y = (v) => H - pad - (v / max) * (H - 2 * pad);
  let body;
  if (type === 'bar') {
    const bw = Math.max(2, (W - 2 * pad) / values.length - 4);
    body = values.map((v, i) => `<rect x="${x(i).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, H - pad - y(v)).toFixed(1)}" rx="2" fill="#0f7a6b"/>`).join('');
  } else {
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    body = `<polyline fill="none" stroke="#0f7a6b" stroke-width="2.5" points="${pts}"/>`;
  }
  const lbls = labels.map((l, i) => `<text x="${x(i).toFixed(1)}" y="${H - 4}" font-family="JetBrains Mono" font-size="9" fill="#9a9c91">${escapeHtml(String(l).slice(0, 24))}</text>`).join('');
  return `<svg class="rc-chart" width="100%" height="${H}" viewBox="0 0 ${W} ${H}" role="img">${body}${lbls}</svg>`;
}

// ── Task 3: line-record → block HTML + copy payloads ─────────────────────────

/**
 * A `text`/`tool_result` body may embed a ```chart JSON fence → render as SVG.
 * Malformed JSON falls back to markdown — never throws.
 */
function renderRichText(body) {
  const s = String(body);
  // Only the FIRST ```chart fence is promoted to SVG; surrounding text is plain
  // markdown. A chart fence whose JSON itself contains ``` truncates → JSON.parse
  // fails → safe markdown fallback (never throws).
  const m = s.match(/```chart\s*([\s\S]*?)```/);
  if (m) {
    let svg = null;
    try { svg = renderChartSvg(JSON.parse(m[1])); } catch { svg = null; }
    if (svg) return renderMarkdownSafe(s.slice(0, m.index)) + svg + renderMarkdownSafe(s.slice(m.index + m[0].length));
  }
  return renderMarkdownSafe(s);
}

/**
 * Wrap inner HTML in a `.rc-blk` div. copyRaw == null → no copy affordance.
 * The exact source is stored (escaped) in `data-raw` so the canvas copies the
 * original markdown/JSON, not the rendered (markdown-stripped) innerText.
 */
function block(kind, inner, copyRaw) {
  if (copyRaw == null) return `<div class="rc-blk rc-${kind}">${inner}</div>`;
  return `<div class="rc-blk rc-${kind}" data-copy="${kind}" data-raw="${escapeHtml(String(copyRaw))}"><button class="rc-copy" title="copy">⧉</button>${inner}</div>`;
}

/**
 * One transcript EVENT → its block HTML. The shared per-event renderer used by
 * both `lineRecordToHtml` (all events joined) and `lineRecordToChannels` (split
 * board/activity). Escaping/security is unchanged — every dynamic value still
 * flows through escapeHtml / renderMarkdownSafe / renderRichText.
 * Handles: user_text / text / tool_use / tool_result / init / turn_done / error / raw.
 */
export function eventToHtml(ev) {
  if (!ev || typeof ev !== 'object') return '';
  switch (ev.type) {
    case 'user_text':
      return block('you', renderMarkdownSafe(ev.text || ''), ev.text || '');
    case 'text':
      return block('text', renderRichText(ev.text || ''), ev.text || '');
    case 'tool_use':
      return block(
        'tool',
        `<b class="rc-toolname">⚙ ${escapeHtml(ev.name || 'tool')}</b><pre class="rc-code">${escapeHtml(JSON.stringify(ev.input ?? {}, null, 2))}</pre>`,
        JSON.stringify(ev.input ?? {}, null, 2)
      );
    case 'tool_result': {
      // copy payload (`raw`) matches the displayed pretty-printed JSON for
      // non-string content, so "copy" yields what the user sees.
      const pretty = typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content, null, 2);
      const content = typeof ev.content === 'string' ? ev.content : '```\n' + pretty + '\n```';
      return block('result', renderRichText(content), pretty);
    }
    case 'init':
      return `<div class="rc-meta">session ${escapeHtml(String(ev.sessionId || '').slice(0, 8))} · ${escapeHtml(ev.model || '')}</div>`;
    case 'turn_done':
      if (String(ev.result || '').trim()) {
        return block(ev.isError ? 'err' : 'text', renderRichText(ev.result || ''), ev.result || '');
      }
      return '<div class="rc-meta rc-done">— end of turn —</div>';
    case 'error':
      return `<div class="rc-err">⚠ ${escapeHtml(ev.code || 'error')}: ${escapeHtml(ev.message || '')}</div>`;
    default:
      return block('raw', `<pre class="rc-code">${escapeHtml(ev.raw ?? JSON.stringify(ev))}</pre>`, ev.raw ?? JSON.stringify(ev));
  }
}

/**
 * Channel routing — three buckets:
 *   - 'board'    : the clean reading conversation (user prompts + agent text)
 *   - 'activity' : pure process noise (init/turn_done/error/raw/etc.)
 *   - 'both'     : tool calls/results — rendered as a polished card in the
 *                  board AND as a compact event in the Activity side panel,
 *                  so the chat tells a complete story while the process panel
 *                  remains the canonical operations log.
 */
export function eventChannel(type, ev = null) {
  if (type === 'user_text' || type === 'text') return 'board';
  if (type === 'turn_done' && String(ev?.result || '').trim()) return 'board';
  if (type === 'tool_use' || type === 'tool_result') return 'both';
  return 'activity';
}

/**
 * One transcript line record { seq, events:[…] } → HTML (one .rc-blk per event).
 * All events joined, for back-compat with consumers/tests that render a single
 * combined stream. New split rendering lives in `lineRecordToChannels`.
 */
export function lineRecordToHtml(rec) {
  if (!rec || !Array.isArray(rec.events)) return '';
  return rec.events.map(eventToHtml).join('');
}

/**
 * Split a line record into the two canvas channels:
 *   { board: <conversation html>, activity: <process html> }
 * Each event's HTML (from eventToHtml) is routed by eventChannel(ev.type).
 * Empty/invalid rec → { board:'', activity:'' }.
 */
export function lineRecordToChannels(rec) {
  if (!rec || !Array.isArray(rec.events)) return { board: '', activity: '' };
  let board = '', activity = '';
  for (const ev of rec.events) {
    const html = eventToHtml(ev);
    if (!html) continue;
    const ch = eventChannel(ev && ev.type, ev);
    if (ch === 'board') board += html;
    else if (ch === 'activity') activity += html;
    else { board += html; activity += html; }    // 'both' — tool cards live in both lanes
  }
  return { board, activity };
}

/**
 * Copy-payload normalizer used by the canvas: given a block kind + its `data-raw`
 * value, returns the clipboard text. Trivial today (passthrough) but is the
 * documented boundary the DOM shell calls; image/chart copy is DOM-side PNG.
 */
export function copyTextForBlock(kind, raw) { return String(raw ?? ''); }
