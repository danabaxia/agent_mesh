// md-lite.js — tiny PURE markdown→HTML renderer, ported 1:1 from the approved
// generator's md()/inline() (tmp_browser_test/gen_real_demo.py).
//
// Supports: headings #..#### (rendered h3..h5, capped), **bold**, `inline
// code`, ``` fenced blocks (<pre class="cb"><code>), pipe tables (header +
// :--- separator), -/* and 1. lists, --- hr; everything else → <p>.
// ESCAPE-FIRST: all source text is HTML-escaped before any markup is applied,
// so hostile input (e.g. <script>) can never reach the DOM unescaped.

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function inline(s) {
  s = esc(s);
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

const TABLE_SEP = /^\s*\|?[\s:|-]*-{2,}[\s:|-]*\|?/;

function splitRow(ln) {
  return ln.trim().replace(/^\|+/, '').replace(/\|+$/, '').split('|').map((c) => c.trim());
}

/** Render markdown text to an HTML string. */
export function mdToHtml(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  let i = 0;
  let inCode = false;
  let inList = null;   // null | 'ul' | 'ol'
  const closeList = () => {
    if (inList) { out.push(`</${inList}>`); inList = null; }
  };

  while (i < lines.length) {
    const ln = lines[i];
    // fenced code block toggle
    if (ln.trim().startsWith('```')) {
      closeList();
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { out.push('<pre class="cb"><code>'); inCode = true; }
      i += 1; continue;
    }
    if (inCode) { out.push(esc(ln)); i += 1; continue; }
    // pipe table block (header line + :--- separator line)
    if (ln.includes('|') && i + 1 < lines.length &&
        TABLE_SEP.test(lines[i + 1] || '') && (lines[i + 1] || '').includes('|')) {
      closeList();
      out.push('<table><tr>' + splitRow(ln).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>');
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        out.push('<tr>' + splitRow(lines[i]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
        i += 1;
      }
      out.push('</table>'); continue;
    }
    // headings #..#### → h3..h5 (capped)
    const m = /^(#{1,4})\s+(.*)/.exec(ln);
    if (m) {
      closeList();
      const lvl = Math.min(m[1].length + 2, 5);
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
      i += 1; continue;
    }
    // bullet list
    if (/^\s*[-*]\s+/.test(ln)) {
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
      out.push(`<li>${inline(ln.replace(/^\s*[-*]\s+/, ''))}</li>`);
      i += 1; continue;
    }
    // numbered list
    if (/^\s*\d+\.\s+/.test(ln)) {
      if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
      out.push(`<li>${inline(ln.replace(/^\s*\d+\.\s+/, ''))}</li>`);
      i += 1; continue;
    }
    // horizontal rule
    if (/^\s*(---+|\*\*\*+)\s*$/.test(ln)) {
      closeList(); out.push('<hr>'); i += 1; continue;
    }
    closeList();
    if (ln.trim()) out.push(`<p>${inline(ln)}</p>`);
    i += 1;
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}
