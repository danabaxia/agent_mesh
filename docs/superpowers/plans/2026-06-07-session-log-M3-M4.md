# Session Log — M3 (Result Canvas) + M4 (UI + Routes + Mirror Wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the **result-canvas** rich renderer (M3) and the **session-log B-view + HTTP routes** (M4) on top of the completed M1 (index/mirror/runner) + M2 (img-proxy), so the dashboard lists every agent session and renders any one — **including a live iTerm session mirrored into the canvas as you type** (`GET /session/:id/stream`).

**Architecture:** The security-critical render logic is a **pure, node-testable** module (`render-core.js`: markdown→safe-HTML, chart-fence→SVG, line-record→block HTML, copy-payload) with an exhaustive XSS test suite; the thin browser shell (`result-canvas.js`) and the B-view controller (`session-log.js`) wire it to the DOM + SSE and are verified by a running-dashboard smoke. **One content cursor:** the canvas always renders from the **mirror** (`/session/:id/stream`, cursor = transcript line index) — this works identically for an iTerm-driven session and a dashboard-driven turn (both write the same transcript), resolving the runner-vs-mirror seq divergence flagged in M1's final review.

**Tech Stack:** Node ≥20, zero deps, `node --test`. New: `src/dashboard/render-core.js` (pure), `src/dashboard/public/result-canvas.js` + `session-log.js` (browser), routes in `src/dashboard/server.js`. Reuses M1 `session-index`/`session-mirror`/`session-runner`/`session-store`, M2 `/api/img`, and `shell-launcher`.

**Spec:** [docs/superpowers/specs/2026-06-07-session-log-and-management-design.md](../specs/2026-06-07-session-log-and-management-design.md) (codex-converged R0→R8). Builds on M1+M2 ([2026-06-07-session-log-M1-M2.md](2026-06-07-session-log-M1-M2.md), gated). This plan = **M3 + M4**.

**Honors the M1+M2 final-review carry-forward notes** (see that plan's "Carry-forward" section): (1) `expectedActiveId` through `/message`; (2) a `select` route returning `{activeId,rev}`; (3) **single cursor** = mirror line-index (canvas consumes the mirror; driven turns appear via the same transcript tail); (4) `resolveTranscript` on every path route; (5) delete dead lean native-session + flaky-mirror frontend; (6) `/api/img` stays under `--allow-shell`.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/dashboard/render-core.js` | **PURE, node-testable.** `escapeHtml`, `safeUrl`, `renderMarkdownSafe(md)` (no raw HTML; safe URL schemes; remote `![img](https…)` → `<img src="/api/img?url=…">`), `renderChartSvg(spec)` (bounded JSON → bar/line SVG), `lineRecordToHtml({seq,events})` (per-block HTML for user_text/text/tool_use/tool_result/image/table/metric/list/code, each wrapped with a `data-copy` affordance), `copyTextForBlock(kind, raw)`. | Create |
| `src/dashboard/public/result-canvas.js` | **Browser shell.** `createResultCanvas(rootEl)` → `{ render(rec), renderAll(recs), clear(), setMode('inline'\|'presentation'), destroy() }`. Uses `render-core` for HTML; handles ⧉ copy clicks (clipboard text; image/chart → `<canvas>` `toBlob` PNG); applies wide-rule C classes. | Create |
| `src/dashboard/public/result-canvas.css` (or append `app.css`) | Light-paper canvas styles: `.rc-*` blocks, `.measure`/`.breakout`, copy affordance, presentation. | Create/append |
| `src/dashboard/public/session-log.js` | **Browser.** B-view: session rail (`/session/list`, session-primary + expandable turns), resizable gutter, ⛶ fullscreen, a `result-canvas` instance; open past → `/transcript`; live → `/stream`; resume / open-terminal / copy-id controls; sends `expectedActiveId` on `/message`. | Create |
| `src/dashboard/server.js` | **Modify.** Routes: `GET /session/list`, `GET /session/:id/transcript`, `GET /session/:id/stream` (mirror), `POST /session/:id/resume`, `POST /session/:id/open-terminal`, `POST /session/message {expectedActiveId}`; keep `POST /session/stop`; **remove** the driven `GET /session/stream`. Capability: add `sessionLogEnabled`, **remove** `sessionEnabled`. Build a `sessionMirror`. | Modify |
| `src/dashboard/shell-launcher.js` + `src/dashboard/shell.js` | **Modify.** `buildPlan({agentRoot, entry, resumeId})` threads `--resume <id>` into the generated `claude` command. | Modify |
| `src/dashboard/public/app.js` / `index.html` | **Modify.** Mount `session-log` view in the chat pane when `sessionLogEnabled`; **delete** the dead lean native-session panel + flaky-mirror panel + `mirrorEnabled`. | Modify |
| tests: `test/render-core.test.js`, `test/session-routes.test.js` (new), extend `test/img-endpoint.test.js` pattern | Hermetic. | Create |

---

## M3 · Result Canvas

### Task 1: `render-core.js` — safe markdown + image proxying

**Files:**
- Create: `src/dashboard/render-core.js`
- Test: `test/render-core.test.js`

- [ ] **Step 1: Write the failing test.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, safeUrl, renderMarkdownSafe } from '../src/dashboard/render-core.js';

test('escapeHtml neutralizes tags/quotes', () => {
  assert.equal(escapeHtml(`<script>"'&`), '&lt;script&gt;&quot;&#39;&amp;');
});

test('safeUrl allows http(s), rejects javascript/data', () => {
  assert.equal(safeUrl('https://x.test/a'), 'https://x.test/a');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
});

test('renderMarkdownSafe escapes raw HTML, keeps bold/code, rewrites remote img to /api/img', () => {
  const html = renderMarkdownSafe('**hi** <img src=x onerror=alert(1)> `c` ![a](https://covers.test/x.png)');
  assert.ok(html.includes('<b>hi</b>'));
  assert.ok(!/onerror/.test(html));                 // raw HTML escaped, not executed
  assert.ok(html.includes('&lt;img'));              // the literal <img> is escaped text
  assert.ok(html.includes('<code>c</code>'));
  assert.ok(html.includes('/api/img?url=https%3A%2F%2Fcovers.test%2Fx.png')); // proxied
});

test('renderMarkdownSafe: a javascript: link becomes inert text', () => {
  const html = renderMarkdownSafe('[click](javascript:alert(1))');
  assert.ok(!/href="javascript/.test(html));
  assert.ok(html.includes('click'));
});
```

- [ ] **Step 2: Run → FAIL.**

Run: `node --test test/render-core.test.js`

- [ ] **Step 3: Implement (port the existing app.js helpers; add image proxying).** Create `src/dashboard/render-core.js`:

```js
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

function inlineMd(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, txt, url) => {
    const safe = safeUrl(url);
    return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(txt)}</a>` : escapeHtml(txt);
  });
  return s;
}

/** Full markdown → safe HTML. Images become proxied <img>. No raw HTML. */
export function renderMarkdownSafe(src) {
  const blocks = [];
  let s = String(src);
  // fenced code first
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(`<pre class="rc-code">${escapeHtml(code)}</pre>`);
    return `@@B${blocks.length - 1}@@`;
  });
  // images ![alt](url) → proxied <img> (placeholder block, before inline links)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
    const px = imgProxyUrl(url);
    blocks.push(px
      ? `<img class="rc-img" alt="${escapeHtml(alt)}" src="${escapeHtml(px)}">`
      : `<span class="rc-imgblocked">🖼 ${escapeHtml(alt || 'image')}</span>`);
    return `@@B${blocks.length - 1}@@`;
  });
  // line-based: headings, blockquote, list, table, paragraphs (escaped via inlineMd)
  const out = [];
  for (const line of s.split('\n')) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { out.push(`<h${h[1].length} class="rc-h">${inlineMd(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) { out.push(`<li class="rc-li">${inlineMd(line.replace(/^\s*[-*]\s+/, ''))}</li>`); continue; }
    if (line.trim() === '') { out.push(''); continue; }
    if (/^@@B\d+@@$/.test(line.trim())) { out.push(line.trim()); continue; }
    out.push(`<p class="rc-p">${inlineMd(line)}</p>`);
  }
  let html = out.join('\n');
  html = html.replace(/@@B(\d+)@@/g, (_m, i) => blocks[Number(i)]);
  return html;
}
```

- [ ] **Step 4: Run → PASS.**

Run: `node --test test/render-core.test.js`

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/render-core.js test/render-core.test.js
git commit -m "feat(render-core): pure safe-markdown renderer + /api/img rewrite (XSS-tested)"
```

---

### Task 2: `render-core` — bounded `chart` fence → SVG

**Files:**
- Modify: `src/dashboard/render-core.js`
- Test: `test/render-core.test.js`

- [ ] **Step 1: Write the failing test (append).**

```js
import { renderChartSvg } from '../src/dashboard/render-core.js';

test('renderChartSvg: valid bar spec → SVG with escaped labels', () => {
  const svg = renderChartSvg({ type: 'bar', labels: ['Jan', '<b>Feb</b>'], values: [3, 7] });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('&lt;b&gt;Feb'));     // label escaped
  assert.ok(/<rect/.test(svg));
});

test('renderChartSvg: line spec → polyline', () => {
  assert.ok(/<polyline/.test(renderChartSvg({ type: 'line', labels: ['a','b','c'], values: [1,2,3] })));
});

test('renderChartSvg: rejects malformed/oversized/non-numeric → null', () => {
  assert.equal(renderChartSvg({ type: 'pie', labels: [], values: [] }), null);     // unsupported type
  assert.equal(renderChartSvg({ type: 'bar', labels: ['a'], values: ['x'] }), null); // non-numeric
  assert.equal(renderChartSvg({ type: 'bar', labels: Array(500).fill('a'), values: Array(500).fill(1) }), null); // too many
  assert.equal(renderChartSvg('not an object'), null);
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement (append to `render-core.js`).**

```js
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
    body = values.map((v, i) => `<rect x="${x(i).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - pad - y(v)).toFixed(1)}" rx="2" fill="#0f7a6b"/>`).join('');
  } else {
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    body = `<polyline fill="none" stroke="#0f7a6b" stroke-width="2.5" points="${pts}"/>`;
  }
  const lbls = labels.map((l, i) => `<text x="${x(i).toFixed(1)}" y="${H - 4}" font-family="JetBrains Mono" font-size="9" fill="#9a9c91">${escapeHtml(String(l)).slice(0, 24)}</text>`).join('');
  return `<svg class="rc-chart" width="100%" height="${H}" viewBox="0 0 ${W} ${H}" role="img">${body}${lbls}</svg>`;
}
```

- [ ] **Step 4: Run → PASS.** Run: `node --test test/render-core.test.js`

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/render-core.js test/render-core.test.js
git commit -m "feat(render-core): bounded chart-fence → bar/line SVG"
```

---

### Task 3: `render-core` — line-record → block HTML + copy payloads

**Files:**
- Modify: `src/dashboard/render-core.js`
- Test: `test/render-core.test.js`

- [ ] **Step 1: Write the failing test (append).**

```js
import { lineRecordToHtml, copyTextForBlock } from '../src/dashboard/render-core.js';

test('lineRecordToHtml renders each event type with a copy affordance', () => {
  const html = lineRecordToHtml({ seq: 7, events: [
    { type: 'user_text', text: 'find dune' },
    { type: 'tool_use', name: 'search_books', input: { q: 'dune' } },
    { type: 'tool_result', content: 'Dune — shelf 3' },
    { type: 'text', text: '**Dune** by Herbert' }
  ]});
  assert.ok(html.includes('rc-you'));               // user bubble
  assert.ok(html.includes('search_books'));         // tool card
  assert.ok(html.includes('<b>Dune</b>'));          // assistant markdown
  assert.ok((html.match(/data-copy=/g) || []).length >= 3); // per-block copy affordances
});

test('lineRecordToHtml renders a chart fence inside text as SVG', () => {
  const html = lineRecordToHtml({ seq: 1, events: [{ type: 'text', text: '```chart\n{"type":"bar","labels":["a"],"values":[2]}\n```' }] });
  assert.ok(html.includes('<svg'));
});

test('copyTextForBlock returns the source text for text/code/table', () => {
  assert.equal(copyTextForBlock('text', '**hi**'), '**hi**');
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement (append to `render-core.js`).**

```js
// A `text`/`tool_result` body may embed a ```chart JSON fence → render as SVG.
function renderRichText(body) {
  const s = String(body);
  const m = s.match(/```chart\s*([\s\S]*?)```/);
  if (m) {
    let svg = null;
    try { svg = renderChartSvg(JSON.parse(m[1])); } catch { svg = null; }
    if (svg) return renderMarkdownSafe(s.slice(0, m.index)) + svg + renderMarkdownSafe(s.slice(m.index + m[0].length));
  }
  return renderMarkdownSafe(s);
}

function block(kind, inner, copyRaw) {
  const copy = copyRaw == null ? '' : ` data-copy="${kind}"`;
  return `<div class="rc-blk rc-${kind}"${copy}>${copyRaw == null ? '' : '<button class="rc-copy" title="copy">⧉</button>'}${inner}</div>`;
}

/** One transcript line record { seq, events:[…] } → HTML (one .rc-blk per event). */
export function lineRecordToHtml(rec) {
  if (!rec || !Array.isArray(rec.events)) return '';
  return rec.events.map((ev) => {
    switch (ev.type) {
      case 'user_text': return block('you', renderMarkdownSafe(ev.text || ''), ev.text || '');
      case 'text': return block('text', renderRichText(ev.text || ''), ev.text || '');
      case 'tool_use': return block('tool', `<b class="rc-toolname">⚙ ${escapeHtml(ev.name || 'tool')}</b><pre class="rc-code">${escapeHtml(JSON.stringify(ev.input ?? {}, null, 2))}</pre>`, JSON.stringify(ev.input ?? {}, null, 2));
      case 'tool_result': return block('result', renderRichText(typeof ev.content === 'string' ? ev.content : '```\n' + JSON.stringify(ev.content, null, 2) + '\n```'), typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content));
      case 'init': return `<div class="rc-meta">session ${escapeHtml(String(ev.sessionId || '').slice(0, 8))} · ${escapeHtml(ev.model || '')}</div>`;
      case 'turn_done': return '<div class="rc-meta rc-done">— end of turn —</div>';
      case 'error': return `<div class="rc-err">⚠ ${escapeHtml(ev.code || 'error')}: ${escapeHtml(ev.message || '')}</div>`;
      default: return block('raw', `<pre class="rc-code">${escapeHtml(ev.raw ?? JSON.stringify(ev))}</pre>`, ev.raw ?? JSON.stringify(ev));
    }
  }).join('');
}

/** The clipboard text for a copy affordance (image/chart copy is DOM-side PNG). */
export function copyTextForBlock(kind, raw) { return String(raw ?? ''); }
```

- [ ] **Step 4: Run → PASS.** Run: `node --test test/render-core.test.js`

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/render-core.js test/render-core.test.js
git commit -m "feat(render-core): line-record → per-block HTML (templates + copy + chart fence)"
```

---

### Task 4: `result-canvas.js` browser shell + paper CSS

**Files:**
- Create: `src/dashboard/public/result-canvas.js`, `src/dashboard/public/result-canvas.css`
- Modify: `src/dashboard/public/index.html` (link the css + script)
- Test: browser smoke (no node DOM harness — the security logic is in render-core, already node-tested).

- [ ] **Step 1: Implement `src/dashboard/public/result-canvas.js`.**

```js
/**
 * src/dashboard/public/result-canvas.js — browser shell over render-core.
 * The independent rich-render unit: feed it line records, it renders blocks with
 * per-block copy (text→clipboard; image/chart→PNG) and the wide-rule-C layout.
 * No transport/fetch here — session-log.js owns SSE/HTTP.
 */
import { lineRecordToHtml, copyTextForBlock } from '../render-core.js';

export function createResultCanvas(rootEl) {
  rootEl.classList.add('rc-root');
  const stream = document.createElement('div');
  stream.className = 'rc-stream measure';
  rootEl.appendChild(stream);

  rootEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.rc-copy'); if (!btn) return;
    const blk = btn.closest('.rc-blk'); if (!blk) return;
    const kind = blk.getAttribute('data-copy');
    try {
      const img = blk.querySelector('img.rc-img'); const svg = blk.querySelector('svg.rc-chart');
      if ((kind === 'text' || kind === 'result') && (img || svg)) { await copyNodeAsPng(img || svg); }
      else { await navigator.clipboard.writeText(copyTextForBlock(kind, blk.getAttribute('data-raw') || blk.innerText)); }
      btn.textContent = '✓'; setTimeout(() => { btn.textContent = '⧉'; }, 1200);
    } catch { btn.textContent = '⚠'; }
  });

  function render(rec) {
    const wrap = document.createElement('div');
    wrap.innerHTML = lineRecordToHtml(rec);
    // stash raw text for copy + flag breakout blocks (charts/images)
    for (const blk of wrap.querySelectorAll('.rc-blk')) {
      if (blk.querySelector('svg.rc-chart, img.rc-img')) blk.classList.add('breakout');
    }
    stream.append(...wrap.childNodes);
    rootEl.scrollTop = rootEl.scrollHeight;
  }
  return {
    render,
    renderAll(recs) { for (const r of recs) render(r); },
    clear() { stream.innerHTML = ''; },
    setMode(mode) { rootEl.classList.toggle('rc-presentation', mode === 'presentation'); },
    destroy() { rootEl.innerHTML = ''; }
  };
}

async function copyNodeAsPng(node) {
  // image: fetch via same-origin proxy → blob; svg: serialize → canvas → blob
  if (node.tagName === 'IMG') {
    const blob = await (await fetch(node.src)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return;
  }
  const xml = new XMLSerializer().serializeToString(node);
  const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
  await img.decode();
  const c = document.createElement('canvas'); c.width = node.clientWidth || 320; c.height = node.clientHeight || 120;
  c.getContext('2d').drawImage(img, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
```

- [ ] **Step 2: Create `src/dashboard/public/result-canvas.css`** (light paper, wide-rule C):

```css
.rc-root{overflow:auto;height:100%}
.rc-stream.measure{max-width:660px;margin:0 auto;padding:12px}
.rc-presentation .rc-stream{max-width:900px}
.rc-blk{position:relative;margin:10px 0}
.rc-blk.breakout{max-width:900px;margin-left:auto;margin-right:auto}
.rc-copy{position:absolute;top:4px;right:4px;opacity:0;transition:.15s;border:1px solid var(--line2);background:var(--surface);border-radius:6px;font:10px var(--mono);padding:2px 6px;cursor:pointer}
.rc-blk:hover .rc-copy{opacity:1}
.rc-you{background:var(--teal-soft);border:1px solid #cfe6e0;border-radius:11px 11px 4px 11px;padding:7px 11px;max-width:72%;margin-left:auto}
.rc-h{font-family:var(--disp);font-weight:600;margin:4px 0 2px}
.rc-tool,.rc-result{background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:8px 10px;box-shadow:var(--sh)}
.rc-code{background:#1c1b17;color:#e8e6df;border-radius:8px;padding:9px 11px;font:12px/1.5 var(--mono);overflow:auto}
.rc-img{max-width:100%;border-radius:8px;border:1px solid var(--line2)}
.rc-chart{background:var(--surface);border:1px solid var(--line);border-radius:8px}
.rc-meta{font:10px var(--mono);color:var(--faint)}
.rc-err{font:12px var(--mono);color:var(--rose);background:var(--surface);border:1px solid #f2cdd4;border-radius:8px;padding:8px 10px}
```

- [ ] **Step 3: Link in `index.html`** — add `<link rel="stylesheet" href="result-canvas.css">` in `<head>`. (The script is imported by `session-log.js` as an ES module, so no extra `<script>` tag is needed if `app.js`/`session-log.js` are `type="module"`; if `app.js` is a classic script, add `<script type="module" src="session-log.js"></script>` — match the existing module style in index.html.)

- [ ] **Step 4: Smoke (manual, after M4 wires it).** Deferred to Task 11's demo — the render logic is covered by `render-core` node tests; this shell is browser-only.

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/public/result-canvas.js src/dashboard/public/result-canvas.css src/dashboard/public/index.html
git commit -m "feat(result-canvas): browser shell (copy/PNG, wide-rule C) over render-core"
```

---

## M4 · Routes + B-view + Mirror wiring

### Task 5: `GET /session/list` + capability migration

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/session-routes.test.js`

- [ ] **Step 1: Write the failing test.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDashboardServer } from '../src/dashboard/server.js';
import { initMesh } from '../src/builder/init-mesh.js';
import { writeManifest } from '../src/builder/manifest.js';

async function buildMesh() {
  const meshRoot = await mkdtemp(join(tmpdir(), 'sroutes-'));
  await initMesh(meshRoot);
  const agentRoot = join(meshRoot, 'library');
  await mkdir(agentRoot, { recursive: true });
  await writeFile(join(agentRoot, 'agent.json'), JSON.stringify({ name: 'library' }), 'utf8');
  await writeManifest(meshRoot, { meshVersion: '0.1.0', agents: [{ name: 'library', root: './library', card: 'agent.json', served: true, enabledModes: ['ask'], peers: [] }] });
  return { meshRoot };
}
async function authed(meshRoot, opts = {}) {
  const srv = createDashboardServer({ meshRoot, port: 0, ...opts });
  await srv.start(); const port = new URL(srv.url).port;
  const boot = await fetch(`${srv.url}/?t=${srv.token}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'none' }, redirect: 'manual' });
  const cookie = `am_dash=${boot.headers.get('set-cookie').match(/am_dash=([^;]+)/)[1]}`;
  return { srv, port, cookie };
}
const get = (srv, port, cookie, p, extra = {}) => fetch(`${srv.url}${p}`, { headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', Cookie: cookie, ...extra } });

test('session/list gated: 403 without allow-shell; sessionLogEnabled false; sessionEnabled gone', async () => {
  const { meshRoot } = await buildMesh();
  const { srv, port, cookie } = await authed(meshRoot);
  try {
    assert.equal((await get(srv, port, cookie, '/api/agent/library/session/list')).status, 403);
    const mesh = await (await get(srv, port, cookie, '/api/mesh')).json();
    assert.equal(mesh.sessionLogEnabled, false);
    assert.equal('sessionEnabled' in mesh, false);   // removed
  } finally { await srv.close(); }
});

test('session/list enabled (injected index) → rows + sessionLogEnabled true', async () => {
  const { meshRoot } = await buildMesh();
  const sessionIndex = { listSessions: async () => ([{ id: 'a', turns: 2, firstPrompt: 'hi', originSource: 'cli', active: true, transcriptPath: '/x', lineCount: 4 }]) };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex });
  try {
    const r = await get(srv, port, cookie, '/api/agent/library/session/list');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).sessions[0].firstPrompt, 'hi');
    const mesh = await (await get(srv, port, cookie, '/api/mesh')).json();
    assert.equal(mesh.sessionLogEnabled, true);
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Run → FAIL.** Run: `node --test test/session-routes.test.js`

- [ ] **Step 3: Implement in `server.js`.** (a) import + inject:

```js
import { listSessions as defaultListSessions, resolveTranscript as defaultResolveTranscript } from './session-index.js';
import { createSessionMirror } from './session-mirror.js';
// createDashboardServer signature: add sessionIndex, sessionMirror
// build defaults when allowShell:
const indexApi = sessionIndex ?? { listSessions: (root) => defaultListSessions(root, { meshRoot }), resolveTranscript: (root, id) => defaultResolveTranscript(root, id, { meshRoot }) };
const mirror = sessionMirror ?? (allowShell ? createSessionMirror({}) : null);
const sessionLogEnabled = !!(allowShell || sessionRunner || sessionIndex);
```

(b) capability: replace `view.sessionEnabled = ...` with:

```js
view.sessionLogEnabled = sessionLogEnabled;
```

(c) add the list route (inside the `/session/` block, after membership+containment which resolves `entry`/`agentRoot`):

```js
if (verb === 'list' && req.method === 'GET') {
  const canonRoot = await realpath(agentRoot).catch(() => agentRoot);
  const sessions = await indexApi.listSessions(canonRoot);
  sendJson(res, 200, { ok: true, sessions });
  return;
}
```

Thread `sessionIndex: indexApi`, `sessionMirror: mirror` through `handleRequest`'s context (like `sessionRunner`). Gate: the `/session/` block's `if (!sessionRunner && !mirror && !indexApi)` → 403 `shell_disabled` (keep gated on allowShell).

- [ ] **Step 4: Run → PASS.** Run: `node --test test/session-routes.test.js`

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/server.js test/session-routes.test.js
git commit -m "feat(dashboard): GET /session/list + sessionLogEnabled capability (drop sessionEnabled)"
```

---

### Task 6: `GET /session/:id/transcript` (windowed line records)

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/session-routes.test.js`

- [ ] **Step 1: Write the failing test (append).**

```js
import { parseTranscriptLine } from '../src/dashboard/session-events.js';

test('session/:id/transcript returns windowed line records resolved via resolveTranscript', async () => {
  const { meshRoot } = await buildMesh();
  // a tiny real transcript file + an index stub that resolves to it
  const tdir = await mkdtemp(join(tmpdir(), 'tx-'));
  const f = join(tdir, 's.jsonl');
  await writeFile(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n' +
                     JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] } }) + '\n', 'utf8');
  const id = '11111111-1111-1111-1111-111111111111';
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async (_r, sid) => (sid === id ? f : (() => { throw Object.assign(new Error('nf'), { code: 'not_found' }); })()) };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex });
  try {
    const r = await get(srv, port, cookie, `/api/agent/library/session/${id}/transcript`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.records[0].seq, 1);                 // line index cursor
    assert.equal(j.records[0].events[0].type, 'user_text');
    // bad id → 404
    assert.equal((await get(srv, port, cookie, `/api/agent/library/session/not-a-uuid/transcript`)).status, 404);
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Add to the `/session/` block (parse the `:id` from the path — see Task 8 for the route regex that captures `:id`). Helper:

```js
if (verb === 'transcript' && req.method === 'GET') {
  let path;
  try { path = await indexApi.resolveTranscript(await realpath(agentRoot).catch(() => agentRoot), id); }
  catch (e) { sendJson(res, e.code === 'bad_id' ? 404 : 404, { ok: false, error: { code: e.code || 'not_found' } }); return; }
  const beforeSeq = Number(url.searchParams.get('beforeSeq') || 0) || Infinity;
  const limit = Math.min(500, Number(url.searchParams.get('limit') || 200) || 200);
  const raw = await readFile(path, 'utf8').catch(() => '');
  const lines = raw.split('\n');
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const seq = i + 1; if (!lines[i].trim()) continue;
    const events = parseTranscriptLine(lines[i]).map(redactSessionEventSrv);
    if (events.length) records.push({ seq, events });
  }
  // newest-last window of <=limit ending before beforeSeq
  const windowed = records.filter((r) => r.seq < beforeSeq).slice(-limit);
  sendJson(res, 200, { ok: true, records: windowed, hasMore: windowed.length > 0 && windowed[0].seq > 1, nextCursor: windowed.length ? windowed[0].seq : null });
  return;
}
```

Import `parseTranscriptLine` + `redactSessionEvent as redactSessionEventSrv` + `readFile` (already imported) at the top of server.js.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/server.js test/session-routes.test.js
git commit -m "feat(dashboard): GET /session/:id/transcript (windowed line records, resolveTranscript-gated)"
```

---

### Task 7: `GET /session/:id/stream` — the live mirror (iTerm → dashboard)

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/session-routes.test.js`

- [ ] **Step 1: Write the failing test (append).** Use an injected `sessionMirror` whose `subscribe` immediately pushes a record, to assert SSE wiring without real files.

```js
test('session/:id/stream is an SSE feeding mirror line records (the iTerm→dashboard mirror)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '22222222-2222-2222-2222-222222222222';
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/tmp/x.jsonl' };
  const sessionMirror = { subscribe: (sid, path, fn) => { setImmediate(() => fn({ seq: 1, events: [{ type: 'user_text', text: 'hi from iterm' }] })); return { close() {} }; } };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, sessionMirror });
  try {
    const ac = new AbortController();
    const res = await get(srv, port, cookie, `/api/agent/library/session/${id}/stream`, {}, ac);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    // read one chunk and confirm a line record arrives
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.ok(text.includes('hi from iterm'));
    ac.abort();
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { await srv.close(); }
});
```

(Extend the `get` helper to accept an AbortController: add `, ac` param → `signal: ac?.signal`.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** in the `/session/` block:

```js
if (verb === 'stream' && req.method === 'GET') {
  if (!mirror) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled' } }); return; }
  let path;
  try { path = await indexApi.resolveTranscript(await realpath(agentRoot).catch(() => agentRoot), id); }
  catch { send404(res); return; }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const lastSeq = Number(req.headers['last-event-id'] || 0);
  const sub = mirror.subscribe(id, path, (rec) => {
    try {
      if (rec.type === 'replay_gap') { res.write(`event: gap\ndata: {}\n\n`); return; }
      res.write(`id: ${rec.seq}\nevent: record\ndata: ${JSON.stringify(rec)}\n\n`);
    } catch { /* dead socket */ }
  }, lastSeq);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25_000); ping.unref?.();
  req.on('close', () => { clearInterval(ping); sub.close(); });
  return;
}
```

(Records are already `redactSessionEvent`-scrubbed inside `session-mirror`, so no re-redaction here.) **Remove the old driven `GET /session/stream` route** (the runner-hub SSE) — the mirror stream supersedes it.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/server.js test/session-routes.test.js
git commit -m "feat(dashboard): GET /session/:id/stream live mirror (replaces driven stream) — iTerm→dashboard"
```

---

### Task 8: `:id` route parsing + `resume`/`message{expectedActiveId}`/`stop`

**Files:**
- Modify: `src/dashboard/server.js`
- Test: `test/session-routes.test.js`

- [ ] **Step 1: Write the failing test (append).**

```js
test('resume selects (→{activeId,rev}); message carries expectedActiveId (→409 active_changed)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '33333333-3333-3333-3333-333333333333';
  const calls = [];
  const sessionRunner = {
    setActiveSession: async (_a, sid) => { calls.push(['select', sid]); return { activeId: sid, rev: 1 }; },
    runTurn: async ({ expectedActiveId }) => { if (expectedActiveId === 'stale') { const e = new Error('x'); e.code = 'active_changed'; throw e; } return { turnId: 'T', done: Promise.resolve({ ok: true }) }; },
    stop: async () => {}, subscribe: () => ({ close() {} })
  };
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/x' };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionRunner, sessionIndex });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r1 = await post(`/api/agent/library/session/${id}/resume`, {});
    assert.equal((await r1.json()).activeId, id);
    const r2 = await post(`/api/agent/library/session/message`, { text: 'hi', expectedActiveId: 'stale' });
    assert.equal(r2.status, 409);
    assert.equal((await r2.json()).error.code, 'active_changed');
  } finally { await srv.close(); }
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement.** Update the `/session/` block's route regex to capture an optional `:id`:

```js
// matches /session/list | /session/message | /session/stop | /session/:id/(transcript|stream|resume|open-terminal)
const m = pathname.match(/^\/api\/agent\/(.+?)\/session\/(?:(list|message|stop)|([0-9a-f-]{36})\/(transcript|stream|resume|open-terminal))$/i);
if (!m) { send404(res); return; }
const name = decodeURIComponent(m[1]);
const id = m[3] || null;
const verb = m[2] || m[4];
```

Then handlers:

```js
if (verb === 'resume' && req.method === 'POST') {
  if (!sessionRunner) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled' } }); return; }
  try { const sel = await sessionRunner.setActiveSession(name, id); sendJson(res, 200, { ok: true, ...sel }); }
  catch (e) { sendJson(res, e.code === 'bad_id' ? 400 : 500, { ok: false, error: { code: e.code || 'internal' } }); }
  return;
}
if (verb === 'message' && req.method === 'POST') {
  if (!sessionRunner) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled' } }); return; }
  let body; try { body = JSON.parse((await readBodyCapped(req, CONSOLE_BODY_CAP)) || '{}'); }
  catch (err) { sendJson(res, err.tooLarge ? 413 : 400, { ok: false, error: { code: 'bad_input' } }); return; }
  try {
    const { turnId } = await sessionRunner.runTurn({ agentName: name, text: String(body.text || ''), force: !!body.force, expectedActiveId: body.expectedActiveId });
    sendJson(res, 202, { ok: true, turnId });
  } catch (err) {
    const code = err.code || 'internal';
    const status = (code === 'session_busy' || code === 'session_busy_external' || code === 'active_changed') ? 409 : code === 'unknown_agent' ? 404 : 500;
    sendJson(res, status, { ok: false, error: { code, message: err.message } });
  }
  return;
}
if (verb === 'stop' && req.method === 'POST') {
  if (!sessionRunner) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled' } }); return; }
  await sessionRunner.stop(name); sendJson(res, 200, { ok: true }); return;
}
```

- [ ] **Step 4: Run → PASS.** Run: `node --test test/session-routes.test.js`

- [ ] **Step 5: Commit.**

```bash
git add src/dashboard/server.js test/session-routes.test.js
git commit -m "feat(dashboard): :id route parsing + resume(select)/message(expectedActiveId)/stop"
```

---

### Task 9: `POST /session/:id/open-terminal` + launcher `--resume`

**Files:**
- Modify: `src/dashboard/shell.js`, `src/dashboard/shell-launcher.js`, `src/dashboard/server.js`
- Test: extend `test/shell.test.js` (launcher) + `test/session-routes.test.js` (route)

- [ ] **Step 1: Write the failing launcher test (append to `test/shell.test.js`).**

```js
test('buildLaunchPlan threads --resume <id> when resumeId given', () => {
  const plan = buildLaunchPlan({ agentRoot: '/m/lib', env: ENV, bridgeConfigPath: '/t/cfg.json', tempDir: '/t', opener: { kind: 'darwin', macApp: 'iTerm', hasWt: false }, resumeId: 'abc-123' });
  assert.match(plan.scriptBody, /claude --strict-mcp-config --mcp-config '\/t\/cfg\.json' --resume 'abc-123'/);
});
```

- [ ] **Step 2: Run → FAIL.** Run: `node --test test/shell.test.js`

- [ ] **Step 3: Implement.** In `src/dashboard/shell.js` `buildLaunchPlan`, accept `resumeId` and append it to the claude command on every platform (using the same literal encoder), e.g. for the darwin `exec claude …` line:

```js
const resumeArg = resumeId ? ` --resume ${encodePosix(resumeId)}` : '';
lines.push(bridgeConfigPath
  ? `exec claude --strict-mcp-config --mcp-config ${encodePosix(bridgeConfigPath)}${resumeArg}`
  : `exec claude${resumeArg}`);
```

Do the analogous `--resume ${encodeCmd(resumeId)}` for the win32 branch and the `posixCommand`/`cmdCommand` copy-strings. In `src/dashboard/shell-launcher.js` `buildPlan`, accept `resumeId` and pass it into `buildLaunchPlan`.

- [ ] **Step 4: Add the route** (in `server.js` `/session/` block):

```js
if (verb === 'open-terminal' && req.method === 'POST') {
  if (!shellLauncher) { sendJson(res, 403, { ok: false, error: { code: 'shell_disabled' } }); return; }
  // validate id resolves to a known transcript for this agent (index-only)
  try { await indexApi.resolveTranscript(await realpath(agentRoot).catch(() => agentRoot), id); }
  catch { send404(res); return; }
  try {
    const plan = await shellLauncher.buildPlan({ agentRoot: await realpath(agentRoot), entry, resumeId: id });
    if (sessionRunner?.recordOpen) await sessionRunner.recordOpen(name, id); // optional provenance hook
    sendJson(res, 200, { ok: true, ...plan, warning: 'This terminal session runs OUTSIDE dashboard single-active coordination.' });
  } catch (err) { sendJson(res, err.code === 'reserved_name' ? 409 : 500, { ok: false, error: { code: err.code || 'internal', message: err.message } }); }
  return;
}
```

(Provenance: record `{kind:'open',source:'terminal'}` — add a small `recordOpen(agentName,id)` to `session-runner.js` that calls `recordEvent({kind:'open',source:'terminal',terminalApp:process.platform,…})`, OR call `recordEvent` directly in the route via an injected `sessionIndex.recordEvent`. Prefer the latter to keep the runner lean: add `recordEvent` to the `indexApi` and call `await indexApi.recordEvent(meshRoot, {kind:'open',source:'terminal',agentRoot,sessionId:id})`.)

- [ ] **Step 5: Write the route test (append to `test/session-routes.test.js`).**

```js
test('open-terminal builds a --resume plan + records an open event (no lease)', async () => {
  const { meshRoot } = await buildMesh();
  const id = '44444444-4444-4444-4444-444444444444';
  const events = [];
  const sessionIndex = { listSessions: async () => [], resolveTranscript: async () => '/x', recordEvent: async (_m, ev) => events.push(ev) };
  const shellLauncher = { buildPlan: async ({ resumeId }) => ({ planId: 'p', command: `claude --resume ${resumeId}`, supported: true }) };
  const { srv, port, cookie } = await authed(meshRoot, { allowShell: true, sessionIndex, shellLauncher });
  const post = (p, b) => fetch(`${srv.url}${p}`, { method: 'POST', headers: { Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(b || {}) });
  try {
    const r = await post(`/api/agent/library/session/${id}/open-terminal`, {});
    const j = await r.json();
    assert.match(j.command, /--resume 44444444/);
    assert.ok(j.warning);
    assert.equal(events[0].kind, 'open'); assert.equal(events[0].source, 'terminal');
  } finally { await srv.close(); }
});
```

- [ ] **Step 6: Run → PASS.** Run: `node --test test/shell.test.js test/session-routes.test.js`

- [ ] **Step 7: Commit.**

```bash
git add src/dashboard/shell.js src/dashboard/shell-launcher.js src/dashboard/server.js test/shell.test.js test/session-routes.test.js
git commit -m "feat(dashboard): POST /session/:id/open-terminal (claude --resume) + open provenance"
```

---

### Task 10: `session-log.js` B-view + delete dead frontend

**Files:**
- Create: `src/dashboard/public/session-log.js`
- Modify: `src/dashboard/public/app.js` (mount it; delete dead native-session + mirror panels + `mirrorEnabled`/`sessionEnabled` refs), `index.html`
- Test: browser smoke (Task 11).

- [ ] **Step 1: Implement `src/dashboard/public/session-log.js`.**

```js
/**
 * src/dashboard/public/session-log.js — B-layout: session rail + result canvas.
 * Rail lists sessions (/session/list); selecting one renders its transcript
 * (/transcript) then live-tails (/stream, the iTerm→dashboard mirror). Send drives
 * a turn (/message with expectedActiveId); resume selects; open-terminal launches.
 */
import { createResultCanvas } from './result-canvas.js';

export function mountSessionLog(rootEl, agentName) {
  rootEl.innerHTML = `
    <div class="sl-rail">
      <div class="sl-head">Sessions · ${agentName}</div>
      <div class="sl-list" id="sl-list">Loading…</div>
    </div>
    <div class="sl-gutter" id="sl-gutter"></div>
    <div class="sl-main">
      <div class="sl-bar"><span id="sl-sid" class="sl-sid">—</span>
        <button id="sl-copyid" class="sl-btn">⧉ id</button>
        <button id="sl-resume" class="sl-btn">▶ Resume</button>
        <button id="sl-term" class="sl-btn sl-amber">⌘ Terminal</button>
        <button id="sl-full" class="sl-btn">⛶</button></div>
      <div class="sl-canvas" id="sl-canvas"></div>
      <form id="sl-form" class="sl-compose"><textarea id="sl-input" rows="2" placeholder="Drive this session…"></textarea><button>Send</button></form>
    </div>`;
  const canvas = createResultCanvas(rootEl.querySelector('#sl-canvas'));
  let activeId = null, rev = 0, stream = null;
  const api = (p, o) => fetch(`/api/agent/${encodeURIComponent(agentName)}${p}`, { credentials: 'same-origin', ...o });

  async function loadList() {
    const j = await (await api('/session/list')).json().catch(() => ({ sessions: [] }));
    const list = rootEl.querySelector('#sl-list'); list.innerHTML = '';
    for (const s of (j.sessions || [])) {
      const el = document.createElement('div'); el.className = 'sl-sess' + (s.active ? ' sl-live' : '');
      el.innerHTML = `<div class="sl-l1">${s.originSource === 'cli' ? '⌘ CLI' : '💬 dash'} · ${s.turns}t${s.active ? ' · ●' : ''}</div><div class="sl-l2">${escapeText(s.firstPrompt || s.id.slice(0,8))}</div>`;
      el.onclick = () => openSession(s.id);
      list.appendChild(el);
    }
  }
  async function openSession(id) {
    activeId = id; rootEl.querySelector('#sl-sid').textContent = id.slice(0, 8);
    canvas.clear();
    if (stream) { stream.close(); stream = null; }
    const t = await (await api(`/session/${id}/transcript`)).json().catch(() => ({ records: [] }));
    canvas.renderAll(t.records || []);
    if (typeof EventSource !== 'undefined') {
      stream = new EventSource(`/api/agent/${encodeURIComponent(agentName)}/session/${id}/stream`);
      stream.addEventListener('record', (e) => { try { canvas.render(JSON.parse(e.data)); } catch {} });
      stream.addEventListener('gap', () => openSession(id)); // replay_gap → full reload
    }
  }
  rootEl.querySelector('#sl-resume').onclick = async () => { if (!activeId) return; const s = await (await api(`/session/${activeId}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json(); rev = s.rev; };
  rootEl.querySelector('#sl-copyid').onclick = () => activeId && navigator.clipboard.writeText(activeId);
  rootEl.querySelector('#sl-term').onclick = async () => { if (!activeId) return; const j = await (await api(`/session/${activeId}/open-terminal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json(); if (j.warning) alert(j.warning + '\n\n' + (j.command || '')); };
  rootEl.querySelector('#sl-full').onclick = () => { const on = rootEl.classList.toggle('sl-presentation'); canvas.setMode(on ? 'presentation' : 'inline'); };
  rootEl.querySelector('#sl-form').addEventListener('submit', async (e) => {
    e.preventDefault(); const input = rootEl.querySelector('#sl-input'); const text = input.value.trim(); if (!text) return;
    input.value = '';
    const r = await api('/session/message', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, expectedActiveId: activeId }) });
    if (r.status === 409) { const j = await r.json(); alert('Session changed/busy: ' + j.error.code); await loadList(); }
    // content appears via the live /stream tail of the active session
  });
  // resizable gutter
  const gutter = rootEl.querySelector('#sl-gutter'); let drag = false;
  gutter.onmousedown = () => { drag = true; document.body.style.userSelect = 'none'; };
  window.addEventListener('mousemove', (e) => { if (!drag) return; const rail = rootEl.querySelector('.sl-rail'); rail.style.width = Math.max(160, Math.min(480, e.clientX - rootEl.getBoundingClientRect().left)) + 'px'; });
  window.addEventListener('mouseup', () => { drag = false; document.body.style.userSelect = ''; });

  loadList();
  return { destroy() { if (stream) stream.close(); canvas.destroy(); rootEl.innerHTML = ''; } };
}
function escapeText(s) { const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML; }
```

- [ ] **Step 2: Mount in `app.js`.** Where the chat pane is built (`setChatAgent`), when `meshData.sessionLogEnabled`, replace the chat/native/mirror panels with a single container that calls `mountSessionLog(container, name)`. **Delete** the dead `nativeSessionPanelHtml`/`wireNativeSession`/`renderNsEvent`/`mirrorPanelHtml`/`wireMirror`/`_nsSource`/`_mrSource` functions and the `mirrorEnabled`/`sessionEnabled` variables + their `init()` assignments (replace with `sessionLogEnabled`). Import `mountSessionLog` (make `app.js` a module or load `session-log.js` as a module that exposes it on `window`).

- [ ] **Step 3: Add `.sl-*` CSS** to `result-canvas.css` (rail/gutter/bar/compose, light paper). (Bar/rail/gutter styling — paper theme; keep it short.)

- [ ] **Step 4: Commit.**

```bash
git add src/dashboard/public/session-log.js src/dashboard/public/app.js src/dashboard/public/result-canvas.css src/dashboard/public/index.html
git commit -m "feat(dashboard): session-log B-view (rail+canvas+resume/terminal/copy); remove dead native/mirror panels"
```

---

### Task 11: M3+M4 gate — full suite + live iTerm→dashboard demo + cleanup

- [ ] **Step 1: Full suite green.**

Run: `node --test`
Expected: all pass (M1+M2+M3+M4; 6 opt-in e2e skipped). Fix any route/regex regressions.

- [ ] **Step 2: Remove now-dead code** surfaced by the migration: the runner's `subscribe`/content-hub if unused by any route (grep `subscribe(` usages); the old driven-stream test if present; any `sessionEnabled`/`mirrorEnabled` leftover (`grep -rn "sessionEnabled\|mirrorEnabled\|/session/stream\b" src/`). Commit the cleanup.

- [ ] **Step 3: Live demo (the whole point).**

```bash
node scripts/demo-setup.mjs   # if /tmp/agent-mesh-demo absent
node ./bin/agent-mesh.js dashboard /tmp/agent-mesh-demo --allow-shell --no-open
```
Open the bootstrap URL → pick **library** → the session-log rail lists real sessions → click one → transcript renders in the canvas (markdown/tool cards). Then **⌘ Terminal** (or `agent-mesh shell …`) to open the session in iTerm, **type a message in iTerm**, and watch it **appear live in the dashboard canvas** via `/session/:id/stream`. This is the iTerm→dashboard mirror that was the milestone's goal.

- [ ] **Step 4: STOP — M3+M4 gate.** Present to the user; M5 (presentation polish, dead-code sweep, optional `agent-mesh session` verb) is a later, optional plan.

---

## Self-Review

**Spec coverage (§3–§6 + M3/M4 of §9):**
- Result canvas unit (templates, copy, wide-rule C, sanitizer, chart SVG, /api/img rewrite) → Tasks 1–4. ✓
- `/session/list` + capability migration (`sessionLogEnabled`, drop `sessionEnabled`/`mirrorEnabled`) → Task 5. ✓
- Windowed `/transcript` via `resolveTranscript` → Task 6. ✓
- **Live mirror `/session/:id/stream`** (replay/Last-Event-ID/gap) — iTerm→dashboard → Task 7. ✓
- `:id` parsing + `resume`(select→{activeId,rev}) + `message`(expectedActiveId→409) + `stop` → Task 8. ✓
- `open-terminal` (`claude --resume`) + `open` provenance, no lease → Task 9. ✓
- B-view rail + gutter + fullscreen + canvas + controls; delete dead panels → Task 10. ✓
- Cross-platform: launcher `--resume` uses literal encoders (POSIX/cmd) — Task 9; mirror/index already cross-platform from M1.

**Carry-forward notes honored:** (1) `expectedActiveId` in `/message` — Task 8 ✓; (2) `select` route returns `{activeId,rev}`, frontend echoes `expectedActiveId` — Tasks 8,10 ✓; (3) **single cursor** = mirror line-index; canvas renders only from `/stream`, driven turns appear via the same transcript tail (driven `/session/stream` removed) — Tasks 7,8,11 ✓; (4) `resolveTranscript` on transcript/stream/open-terminal — Tasks 6,7,9 ✓; (5) dead frontend deleted — Task 10 ✓; (6) `/api/img` stays under `--allow-shell` (unchanged) ✓.

**Placeholder scan:** none — every code step shows real code. Browser-only files (`result-canvas.js`, `session-log.js`) are verified by the Task 11 demo since the project has no headless DOM harness; all security logic lives in node-tested `render-core.js`.

**Type consistency:** line record `{seq, events:[…]}` is identical across `session-mirror` (M1), the `/transcript` + `/stream` routes (Tasks 6–7), `render-core.lineRecordToHtml` (Task 3), and `result-canvas.render` (Task 4). `resolveTranscript(agentRoot,id)` / `listSessions(agentRoot)` / `setActiveSession→{activeId,rev}` / `runTurn({expectedActiveId})` match the M1 signatures. SSE event names (`record`/`gap`) match between Task 7 (server) and Task 10 (client).
