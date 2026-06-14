// src/dashboard/public/files-tab.js — workspace Files tab (spec §3.4).
// Folding deliverables tree (left) + per-type preview with actions (right).
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const FIC = { html: 'html', htm: 'html', csv: 'csv', png: 'png', jpg: 'png', jpeg: 'png', gif: 'png', svg: 'png', md: 'md', txt: 'md', log: 'md', pptx: 'pptx', docx: 'pptx', xlsx: 'pptx' };
const fmtKB = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export async function renderFilesTab(body, agent, mesh) {
  body.innerHTML = '<div class="files-body"><div class="flist" id="flist"><div class="loading">Loading…</div></div>' +
    '<div class="fpreview"><div class="phead"><span id="pname">select a file</span><span class="pacts" id="pacts"></span></div>' +
    '<div class="pbody" id="pbody"><div class="stub">Files the agent produced for you land in deliverables/&lt;date&gt;/&lt;task&gt;/.</div></div></div></div>';
  const r = await fetch(`/api/agent/${encodeURIComponent(agent)}/deliverables`);
  if (!r.ok) { $('#flist').innerHTML = `<div class="stub">listing failed (${r.status})</div>`; return; }
  const { entries } = await r.json();
  $('#flist').innerHTML = treeHtml(buildTree(entries), agent) ||
    '<div class="stub">empty — nothing under deliverables/ yet</div>';
  $('#flist').addEventListener('click', (e) => {
    const dir = e.target.closest('.tdir');
    if (dir) { dir.classList.toggle('open'); return; }
    const row = e.target.closest('.frow');
    if (row) selectFile(agent, row, mesh);
  });
}

function buildTree(entries) {
  const root = { dirs: new Map(), files: [] };
  for (const en of entries) {
    const parts = en.path.split('/');
    if (parts.at(-1) === '.gitkeep') continue; // hide placeholder files (server still lists them)
    let node = root;
    for (const p of parts.slice(0, -1)) {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
      node = node.dirs.get(p);
    }
    node.files.push({ ...en, name: parts.at(-1) });
  }
  return root;
}

function countFiles(node) {
  return node.files.length + [...node.dirs.values()].reduce((s, d) => s + countFiles(d), 0);
}

function treeHtml(node, agent, open = true) {
  let s = '';
  for (const [name, child] of [...node.dirs.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    s += `<div class="tdir ${open ? 'open' : ''}"><span class="caret">▶</span><span class="fold-ic">📁</span>${esc(name)}<span class="cnt">${countFiles(child)}</span></div>
          <div class="tchildren">${treeHtml(child, agent, false)}</div>`;
  }
  for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
    const ext = f.name.split('.').at(-1).toLowerCase();
    s += `<div class="frow" data-path="${esc(f.path)}" data-ext="${esc(ext)}" data-size="${f.size}">
            <span class="fic ${FIC[ext] ?? 'md'}">${esc(ext.toUpperCase().slice(0, 4))}</span>${esc(f.name)}<span class="fs">${fmtKB(f.size)}</span></div>`;
  }
  return s;
}

async function selectFile(agent, row, mesh) {
  document.querySelectorAll('.frow').forEach((x) => x.classList.toggle('sel', x === row));
  document.querySelector('.saveform')?.remove(); // stale form from a previous file
  const path = row.dataset.path, ext = row.dataset.ext;
  const url = `/api/agent/${encodeURIComponent(agent)}/deliverable?path=${encodeURIComponent(path)}`;
  $('#pname').textContent = `${path.split('/').at(-1)} — ${previewLabel(ext)}`;
  $('#pacts').innerHTML =
    `<button class="dl" data-act="download">⬇ download</button>` +
    (mesh?.shellEnabled ? `<button data-act="locate">📂 locate in Explorer</button>` : '') +
    `<button data-act="save">↓ save as artifact</button>` +
    `<button data-act="copy">⧉ copy path</button>`;
  $('#pacts').onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'download') { location.href = `${url}&download=1`; }
    if (act === 'copy') { await navigator.clipboard.writeText(path).catch(() => {}); e.target.textContent = '✓ copied'; }
    if (act === 'save') { toggleSaveForm(agent, path, ext); }
    if (act === 'locate') {
      const lr = await fetch(`/api/agent/${encodeURIComponent(agent)}/deliverable/locate`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
      e.target.textContent = lr.ok ? '✓ opened' : `✗ ${lr.status}`;
    }
  };
  const body = $('#pbody');
  if (['png', 'jpg', 'jpeg', 'gif', 'svg'].includes(ext)) {
    body.innerHTML = `<img src="${url}" style="max-width:100%;border:1px solid var(--line);border-radius:8px">`;
  } else if (['html', 'htm'].includes(ext)) {
    body.innerHTML = `<iframe class="pframe" sandbox src="${url}"></iframe>`;
  } else if (ext === 'csv') {
    const text = await (await fetch(url)).text();
    body.innerHTML = csvTable(text);
  } else if (['md', 'txt', 'log', 'json'].includes(ext)) {
    const text = await (await fetch(url)).text();
    body.innerHTML = `<pre style="white-space:pre-wrap;font-size:12.5px;background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px"></pre>`;
    body.querySelector('pre').textContent = text;
  } else {
    body.innerHTML = `<div class="stub" style="padding:30px;text-align:center">no inline preview for .${esc(ext)} — use ⬇ download</div>`;
  }
}

const previewLabel = (ext) => ({ html: 'sandboxed preview', csv: 'rendered table' }[ext] ?? 'preview');

// Artifact type from the file extension ('diff'/'file' are reserved for later
// canvas saves — file-preview saves only produce table/chart/report).
const extToType = (ext) =>
  ext === 'csv' ? 'table'
    : ['svg', 'png', 'jpg', 'jpeg', 'gif'].includes(ext) ? 'chart'
      : 'report';

// ↓ save as artifact — inline form under .phead; POSTs the Phase-3 contract
// body to /api/agent/:name/artifacts (spec §3.5). Click again to close.
function toggleSaveForm(agent, path, ext) {
  const prev = document.querySelector('.saveform');
  if (prev) { prev.remove(); return; }
  const form = document.createElement('div');
  form.className = 'saveform';
  form.innerHTML =
    `<input id="sa-title" value="${esc(path.split('/').at(-1))}">` +
    `<input id="sa-task" placeholder="what task produced this?">` +
    `<textarea id="sa-frame" rows="3" placeholder="decision frame — one step per line (optional)"></textarea>` +
    `<button id="sa-save">✓ save</button>`;
  document.querySelector('.phead').after(form);
  form.querySelector('#sa-save').onclick = async () => {
    const frame = form.querySelector('#sa-frame').value
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const r = await fetch(`/api/agent/${encodeURIComponent(agent)}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: form.querySelector('#sa-title').value.trim(),
        type: extToType(ext),
        task: form.querySelector('#sa-task').value.trim(),
        frame,
        inputs: [],
        source: { kind: 'file', path }
      })
    });
    if (r.status === 201) {
      const { id } = await r.json();
      form.innerHTML = `<span>✓ saved as artifact ${esc(id)}</span>`;
    } else {
      form.querySelector('#sa-save').textContent = `✗ save failed (${r.status})`;
    }
  };
}

function csvTable(text, cap = 200) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const row = (cells, tag) => `<tr>${cells.map((c) => `<${tag}>${esc(c)}</${tag}>`).join('')}</tr>`;
  const head = row((lines[0] ?? '').split(','), 'th');
  const rows = lines.slice(1, cap + 1).map((l) => row(l.split(','), 'td')).join('');
  const more = lines.length - 1 > cap ? `<tr><td colspan="99" style="color:var(--ink2)">… ${lines.length - 1 - cap} more rows — download for full data</td></tr>` : '';
  return `<table>${head}${rows}${more}</table>`;
}
