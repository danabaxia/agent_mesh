/**
 * src/dashboard/public/result-canvas.js — browser shell over render-core.
 * The independent rich-render unit: feed it line records and it splits each into
 * two channels — a clean reading "blackboard" (user prompts + the agent's rich
 * answer) and a "process" Activity panel (tool calls/results, thinking, meta,
 * raw). Per-block copy (text→clipboard; image/chart→PNG). No transport/fetch
 * here — session-log.js owns SSE/HTTP.
 *
 * createResultCanvas(boardEl, activityEl):
 *   - boardEl     → the .rc-stream for the conversation blackboard (required).
 *   - activityEl  → the .rc-stream for the process panel (optional). If null,
 *                   activity events fall back into the board so nothing is lost.
 */
import { lineRecordToChannels, copyTextForBlock } from '../render-core.js';

export function createResultCanvas(boardEl, activityEl = null, { activityFallback = true } = {}) {
  boardEl.classList.add('rc-root');
  const boardStream = document.createElement('div');
  boardStream.className = 'rc-stream measure';
  boardEl.appendChild(boardStream);

  let activityStream = null;
  if (activityEl) {
    activityEl.classList.add('rc-root', 'rc-activity-root');
    activityStream = document.createElement('div');
    activityStream.className = 'rc-stream rc-activity-stream';
    activityEl.appendChild(activityStream);
  }

  // The copy handler is identical for both channels: text→clipboard via
  // data-raw, chart/image→PNG. Attach to BOTH container elements.
  const onCopyClick = async (e) => {
    const btn = e.target.closest('.rc-copy'); if (!btn) return;
    const blk = btn.closest('.rc-blk'); if (!blk) return;
    const kind = blk.getAttribute('data-copy');
    try {
      const img = blk.querySelector('img.rc-img');
      const svg = blk.querySelector('svg.rc-chart');
      if ((kind === 'text' || kind === 'result') && (img || svg)) {
        await copyNodeAsPng(img || svg);
      } else {
        await navigator.clipboard.writeText(copyTextForBlock(kind, blk.dataset.raw || blk.innerText));
      }
      btn.textContent = '✓'; setTimeout(() => { btn.textContent = '⧉'; }, 1200);
    } catch { btn.textContent = '⚠'; }
  };
  boardEl.addEventListener('click', onCopyClick);
  if (activityEl) activityEl.addEventListener('click', onCopyClick);

  // Mark breakout blocks (charts/images get extra width) within a freshly
  // rendered fragment.
  function markBreakout(wrap) {
    for (const blk of wrap.querySelectorAll('.rc-blk')) {
      if (blk.querySelector('svg.rc-chart, img.rc-img')) blk.classList.add('breakout');
    }
  }
  // Stamp each top-level .rc-blk with the originating record seq so a separate
  // outline view (session-log's transcript outline) can jump to and flash an
  // individual card by its seq.
  function stampSeq(wrap, seq) {
    if (seq == null) return;
    for (const blk of wrap.querySelectorAll('.rc-blk')) blk.dataset.seq = String(seq);
  }

  // Render one record into the two channels (append). When there is no activity
  // element, route activity HTML into the board so content is never dropped.
  // tool_use/tool_result events appear in BOTH channels (render-core 'both'),
  // giving the chat a complete story while activity stays the canonical log.
  function render(rec) {
    const { board, activity } = lineRecordToChannels(rec);
    if (board) {
      const wrap = document.createElement('div');
      wrap.innerHTML = board;
      markBreakout(wrap); stampSeq(wrap, rec && rec.seq);
      boardStream.append(...wrap.childNodes);
    }
    if (activity) {
      const target = activityStream || (activityFallback ? boardStream : null);
      if (target) {
        const wrap = document.createElement('div');
        wrap.innerHTML = activity;
        markBreakout(wrap); stampSeq(wrap, rec && rec.seq);
        target.append(...wrap.childNodes);
      }
    }
    boardEl.scrollTop = boardEl.scrollHeight;
    if (activityEl) activityEl.scrollTop = activityEl.scrollHeight;
  }

  return {
    render,
    renderAll(recs) { for (const r of recs) render(r); },
    // Prepend older records (reverse-pagination), splitting across channels.
    prepend(recs) {
      // Build the prepend fragments in document order, then insert at the front.
      const boardFrag = document.createDocumentFragment();
      const actFrag = document.createDocumentFragment();
      for (const rec of recs) {
        const { board, activity } = lineRecordToChannels(rec);
        if (board) {
          const wrap = document.createElement('div');
          wrap.innerHTML = board; markBreakout(wrap); stampSeq(wrap, rec && rec.seq);
          while (wrap.firstChild) boardFrag.appendChild(wrap.firstChild);
        }
        if (activity) {
          if (!activityStream && !activityFallback) continue;
          const wrap = document.createElement('div');
          wrap.innerHTML = activity; markBreakout(wrap); stampSeq(wrap, rec && rec.seq);
          const dst = activityStream ? actFrag : boardFrag;
          while (wrap.firstChild) dst.appendChild(wrap.firstChild);
        }
      }
      boardStream.insertBefore(boardFrag, boardStream.firstChild);
      if (activityStream) activityStream.insertBefore(actFrag, activityStream.firstChild);
    },
    clear() { boardStream.innerHTML = ''; if (activityStream) activityStream.innerHTML = ''; },
    setMode(mode) {
      const pres = mode === 'presentation';
      boardEl.classList.toggle('rc-presentation', pres);
      if (activityEl) activityEl.classList.toggle('rc-presentation', pres);
    },
    destroy() {
      boardEl.removeEventListener('click', onCopyClick);
      boardEl.innerHTML = '';
      if (activityEl) { activityEl.removeEventListener('click', onCopyClick); activityEl.innerHTML = ''; }
    }
  };
}

async function copyNodeAsPng(node) {
  // Insecure context (no https/localhost) has no async clipboard — fail fast so
  // the caller's catch shows ⚠ without a wasted proxy round-trip.
  if (!navigator.clipboard?.write) throw new Error('clipboard unavailable');
  // image: fetch via same-origin proxy → blob; svg: serialize → canvas → blob
  if (node.tagName === 'IMG') {
    const blob = await (await fetch(node.src)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return;
  }
  const xml = new XMLSerializer().serializeToString(node);
  const img = new Image();
  img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
  await img.decode();
  const c = document.createElement('canvas');
  c.width = node.clientWidth || 320;
  c.height = node.clientHeight || 120;
  c.getContext('2d').drawImage(img, 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
