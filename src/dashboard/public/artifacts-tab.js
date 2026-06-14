// src/dashboard/public/artifacts-tab.js — workspace Artifacts tab (spec §3.5).
// Shows ONLY what the user explicitly saved (↓ save in Files); each card
// carries its captured task context and offers ⬆ promote (→ workflows) and
// 🗑 delete. Promotion is a MANUAL authoring step: the ⬆ button opens a form
// prefilled from the artifact (name / purpose / inputs / frame) that the user
// edits before the workflow is created — never a silent auto-clone.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const EMPTY_HTML = '<p class="stub">no saved artifacts yet — use ↓ save in Files (canvas save comes in a later phase)</p>';

export async function renderArtifactsTab(body, agent, mesh, switchTab) {
  body.innerHTML = '<div class="wstab-pad"><div class="loading">Loading…</div></div>';
  const r = await fetch(`/api/agent/${encodeURIComponent(agent)}/artifacts`);
  if (!r.ok) {
    body.innerHTML = `<div class="wstab-pad"><p class="stub">listing failed (${r.status})</p></div>`;
    return;
  }
  const { artifacts } = await r.json();
  body.innerHTML =
    `<div class="wstab-pad">` +
    `<h3 style="font:600 15px Georgia,serif;margin-bottom:4px">${esc(agent)} — saved artifacts</h3>` +
    `<p style="font-size:12px;color:var(--ink2);margin-bottom:12px">Only what YOU saved — each save carries its task context, ready to promote into a workflow.</p>` +
    `<div class="artgrid" id="artgrid">${artifacts.map(cardHtml).join('') || EMPTY_HTML}</div></div>`;

  const grid = body.querySelector('#artgrid');
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.artcard');
    if (!card) return;
    const id = card.dataset.id;

    if (e.target.closest('.promote')) {
      // Manual authoring: toggle the prefilled form instead of auto-creating.
      const open = card.querySelector('.wf-form');
      if (open) { open.remove(); return; }
      const a = byId.get(id);
      card.insertAdjacentHTML('beforeend', promoteFormHtml(a));
      return;
    }

    if (e.target.closest('.wf-create')) {
      const form = card.querySelector('.wf-form');
      const err = form.querySelector('.wf-err');
      err.textContent = '';
      const title = form.querySelector('.wf-name').value.trim();
      const purpose = form.querySelector('.wf-purpose').value.trim();
      if (!title) { err.textContent = 'name is required'; return; }
      if (!purpose) { err.textContent = 'purpose is required — say what this workflow is for'; return; }
      const inputs = form.querySelector('.wf-inputs').value.split(',').map((s) => s.trim()).filter(Boolean);
      const frame = form.querySelector('.wf-frame').value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!frame.length) { err.textContent = 'decision frame needs at least one step'; return; }
      const pr = await fetch(`/api/agent/${encodeURIComponent(agent)}/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromArtifact: id, title, purpose, inputs, frame })
      });
      if (pr.status === 201) { switchTab('workflows'); }
      else { err.textContent = `✗ create failed (${pr.status})`; }
      return;
    }

    if (e.target.closest('.del')) {
      const btn = e.target.closest('.del');
      if (!confirm(`Delete artifact "${card.dataset.title}"?`)) return;
      const dr = await fetch(`/api/agent/${encodeURIComponent(agent)}/artifact/${encodeURIComponent(id)}`,
        { method: 'DELETE' });
      if (dr.ok) {
        card.remove();
        if (!grid.querySelector('.artcard')) grid.innerHTML = EMPTY_HTML;
      } else {
        btn.textContent = `✗ ${dr.status}`;
      }
    }
  });
}

// Promote form: prefilled from the artifact's captured context, fully
// editable. Purpose is REQUIRED — a workflow without a stated purpose is the
// unidentifiable-card problem this form exists to prevent.
function promoteFormHtml(a) {
  const frame = (a.frame?.length ? a.frame : [a.task]).filter(Boolean).join('\n');
  return `<div class="wf-form" style="display:flex;flex-direction:column;gap:6px;margin-top:8px;border-top:1px dashed var(--line);padding-top:8px">
    <input class="wf-name" placeholder="workflow name" value="${esc(a.title)}">
    <input class="wf-purpose" placeholder="purpose — what is this workflow FOR? (required)">
    <input class="wf-inputs" placeholder="inputs, comma-separated (e.g. SN, run)" value="${esc((a.inputs ?? []).join(', '))}">
    <textarea class="wf-frame" rows="4" placeholder="decision frame — one step per line">${esc(frame)}</textarea>
    <button class="wf-create" style="background:var(--teal);color:#fff;border:none;border-radius:7px;padding:6px;font-weight:600;cursor:pointer">⬆ create workflow</button>
    <span class="wf-err" style="font-size:11.5px;color:#b91c1c"></span>
  </div>`;
}

function cardHtml(a) {
  const saved = a.savedAt ? new Date(a.savedAt).toLocaleString() : '';
  const src = a.source?.kind === 'file' && a.source.path ? a.source.path : 'text';
  const ctx = [a.task ? `task: "${a.task}"` : null, `source: ${src}`].filter(Boolean).join(' · ');
  const wfTag = a.promotedTo
    ? ` <span class="kind" style="font:600 10px var(--mono)">wf: ${esc(a.promotedTo)}</span>`
    : '';
  return `<div class="artcard" data-id="${esc(a.id)}" data-title="${esc(a.title)}">
    <div class="at"><span class="kind">${esc(String(a.type || '').toUpperCase())}</span><span>saved ${esc(saved)}</span></div>
    <h4>${esc(a.title)}</h4>
    <p>${esc(a.task || '')}${wfTag}</p>
    <div class="ctx">${esc(ctx)}</div>
    <div class="acts2"><button class="promote">⬆ promote to workflow</button><button class="del">🗑 delete</button></div>
  </div>`;
}
