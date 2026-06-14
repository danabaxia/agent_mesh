// src/dashboard/public/workflows-tab.js — workspace Workflows tab (spec §3.6).
// Promoted decision frames: each card shows the frame + declared inputs and
// offers ▶ run with new inputs — the run is composed into a templated user
// turn and submitted to the agent's canonical session via
// POST /api/agent/:name/session/message (mirrors the chat composer's
// { text } body). When the shell gate is off the prompt is copied to the
// clipboard instead (honest fallback).
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

const EMPTY_HTML = '<p class="stub">no workflows yet — promote a saved artifact from the Artifacts tab, or use ＋ new workflow above</p>';

export async function renderWorkflowsTab(body, agent, mesh, switchTab) {
  body.innerHTML = '<div class="wstab-pad"><div class="loading">Loading…</div></div>';
  const r = await fetch(`/api/agent/${encodeURIComponent(agent)}/workflows`);
  if (!r.ok) {
    body.innerHTML = `<div class="wstab-pad"><p class="stub">listing failed (${r.status})</p></div>`;
    return;
  }
  const { workflows } = await r.json();
  const bySlug = new Map(workflows.map((w) => [w.slug, w]));
  body.innerHTML =
    `<div class="wstab-pad">` +
    `<h3 style="font:600 15px Georgia,serif;margin-bottom:4px">${esc(agent)} — workflows</h3>` +
    `<p style="font-size:12px;color:var(--ink2);margin-bottom:8px">Promoted decision frames — run them with new inputs; the run lands in the agent's session as a normal user turn.</p>` +
    `<button id="wf-new" class="rbtn" style="margin-bottom:12px">＋ new workflow</button>` +
    `<div id="wf-new-form"></div>` +
    `<div class="artgrid" id="wfgrid">${workflows.map(cardHtml).join('') || EMPTY_HTML}</div></div>`;

  // ＋ new workflow: direct manual creation (no artifact needed) — same fields
  // and same required-purpose rule as the promote form.
  body.querySelector('#wf-new').addEventListener('click', () => {
    const host = body.querySelector('#wf-new-form');
    if (host.firstChild) { host.innerHTML = ''; return; }
    host.innerHTML = `<div class="wf-form" style="display:flex;flex-direction:column;gap:6px;max-width:420px;margin-bottom:14px;border:1px solid var(--line);border-radius:10px;padding:12px;background:#fff">
      <input class="wf-name" placeholder="workflow name">
      <input class="wf-purpose" placeholder="purpose — what is this workflow FOR? (required)">
      <input class="wf-inputs" placeholder="inputs, comma-separated (e.g. SN, run)">
      <textarea class="wf-frame" rows="4" placeholder="decision frame — one step per line"></textarea>
      <button class="wf-create" style="background:var(--teal);color:#fff;border:none;border-radius:7px;padding:6px;font-weight:600;cursor:pointer">＋ create workflow</button>
      <span class="wf-err" style="font-size:11.5px;color:#b91c1c"></span>
    </div>`;
    host.querySelector('.wf-create').addEventListener('click', async () => {
      const err = host.querySelector('.wf-err');
      err.textContent = '';
      const title = host.querySelector('.wf-name').value.trim();
      const purpose = host.querySelector('.wf-purpose').value.trim();
      const frame = host.querySelector('.wf-frame').value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (!title) { err.textContent = 'name is required'; return; }
      if (!purpose) { err.textContent = 'purpose is required — say what this workflow is for'; return; }
      if (!frame.length) { err.textContent = 'decision frame needs at least one step'; return; }
      const inputs = host.querySelector('.wf-inputs').value.split(',').map((s) => s.trim()).filter(Boolean);
      const pr = await fetch(`/api/agent/${encodeURIComponent(agent)}/workflows`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, purpose, inputs, frame })
      });
      if (pr.status === 201) renderWorkflowsTab(body, agent, mesh, switchTab);
      else err.textContent = `✗ create failed (${pr.status})`;
    });
  });

  const grid = body.querySelector('#wfgrid');
  grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.wfcard');
    if (!card) return;
    const wf = bySlug.get(card.dataset.slug);

    if (e.target.closest('.run')) {
      const open = card.querySelector('.runform');
      if (open) { open.remove(); return; }
      card.appendChild(runFormEl(wf));
      return;
    }

    if (e.target.closest('.go')) {
      await startRun(e.target.closest('.go'), card, wf, agent, mesh, switchTab);
      return;
    }

    if (e.target.closest('.del')) {
      const btn = e.target.closest('.del');
      if (!confirm(`Delete workflow "${wf?.title ?? card.dataset.slug}"?`)) return;
      const dr = await fetch(`/api/agent/${encodeURIComponent(agent)}/workflow/${encodeURIComponent(card.dataset.slug)}`,
        { method: 'DELETE' });
      if (dr.ok) {
        card.remove();
        if (!grid.querySelector('.wfcard')) grid.innerHTML = EMPTY_HTML;
      } else {
        btn.textContent = `✗ ${dr.status}`;
      }
    }
  });
}

function cardHtml(w) {
  const inputs = (w.inputs ?? []).length
    ? `inputs: ${w.inputs.map((i) => `<code>${esc(i)}</code>`).join(' ')}`
    : 'no declared inputs';
  const from = w.promoted_from ? ` · from ${esc(w.promoted_from)}` : '';
  const steps = (w.frame ?? []).map((s) => `<li>${esc(s)}</li>`).join('');
  return `<div class="wfcard" data-slug="${esc(w.slug)}">
    <div class="at"><span style="color:#7c3aed">WORKFLOW</span><span>created ${esc(w.created || '')}${from}</span></div>
    <h4>${esc(w.title)}</h4>
    ${w.purpose ? `<p style="font-size:12px;color:var(--ink2);font-style:italic;margin:2px 0 4px">${esc(w.purpose)}</p>` : ''}
    <div class="inputs">${inputs}</div>
    <div class="frame"><b>DECISION FRAME</b><ol>${steps}</ol></div>
    <div class="acts2"><button class="run">▶ run with new inputs</button><button class="del">🗑</button></div>
  </div>`;
}

function runFormEl(wf) {
  const form = document.createElement('div');
  form.className = 'runform';
  const names = wf?.inputs ?? [];
  form.innerHTML = (names.length
    ? names.map((n) => `<label>${esc(n.toUpperCase())}</label><input data-in="${esc(n)}" placeholder="${esc(n)}">`).join('')
    : `<textarea data-in="notes" rows="2" placeholder="optional notes / parameters"></textarea>`) +
    `<button class="go">▶ start in session</button>`;
  return form;
}

/** Compose the templated user turn (locked shape — see the Phase-3 plan). */
function composePrompt(wf, form) {
  const pairs = [...form.querySelectorAll('[data-in]')]
    .map((el) => [el.dataset.in, el.value.trim()])
    .filter(([, v]) => v);
  const lines = [`Run the saved workflow "${wf.title}" using its decision frame.`];
  if (wf.purpose) lines.push(`Purpose: ${wf.purpose}`);
  if (pairs.length) lines.push(`Inputs: ${pairs.map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  lines.push('DECISION FRAME:');
  (wf.frame ?? []).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('Follow the frame steps in order; produce the same artifact type as the original.');
  return lines.join('\n');
}

async function startRun(btn, card, wf, agent, mesh, switchTab) {
  if (!wf) return;
  const prompt = composePrompt(wf, card.querySelector('.runform'));
  if (mesh?.shellEnabled) {
    // Mirror the chat composer's POST shape (app.js wireConsole): { text }.
    const r = await fetch(`/api/agent/${encodeURIComponent(agent)}/session/message`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: prompt })
    }).catch(() => null);
    if (r && r.status === 202) {
      btn.textContent = '✓ queued — watch the session';
      switchTab('session');
    } else {
      btn.textContent = `✗ ${r ? r.status : 'network error'}`;
    }
  } else {
    await navigator.clipboard.writeText(prompt).catch(() => {});
    btn.textContent = '⧉ copied — paste into ⌘ CLI';
  }
}
