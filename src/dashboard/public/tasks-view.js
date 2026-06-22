// tasks-view.js — read-only A2A task board (kanban by state) for the desktop dashboard.
// Spec: docs/superpowers/specs/2026-06-22-a2a-task-board-view-design.md
import { buildTaskBoard, relAge } from '/tasks-model.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function renderTasksView(el) {
  el.innerHTML = '<div class="tv-loading">Loading tasks…</div>';
  let tasks = [];
  try {
    const r = await fetch('/api/board/tasks');
    if (!r.ok) throw new Error(`${r.status}`);
    tasks = (await r.json()).tasks ?? [];
  } catch {
    el.innerHTML = '<div class="tv-loading">Could not load the board.</div>';
    return;
  }
  const board = buildTaskBoard(tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  el.innerHTML = `
    <div class="tv-head"><h2>🎫 Task board <span class="tv-sub">${board.summary.total} ticket(s)</span></h2></div>
    <div class="tv-cols">
      ${board.columns.map((c) => `
        <div class="tv-col" data-state="${esc(c.state)}">
          <div class="tv-colhead">${esc(c.label)} <span class="tv-count">${c.cards.length}</span></div>
          <div class="tv-cards">
            ${c.cards.map((card) => `
              <div class="tv-card" data-id="${esc(card.id)}">
                <div class="tv-title">${esc(card.title)}</div>
                <div class="tv-meta"><span>${esc(card.from)} → ${esc(card.to)}</span><span>${esc(relAge(card.ageMs))}${card.hasResult ? ' · ✓' : ''}</span></div>
              </div>`).join('') || '<div class="tv-empty">—</div>'}
          </div>
        </div>`).join('')}
    </div>
    <div class="tv-detail" hidden></div>`;
  el.querySelectorAll('.tv-card').forEach((cardEl) => {
    cardEl.onclick = () => showDetail(el.querySelector('.tv-detail'), byId.get(cardEl.dataset.id));
  });
}

function showDetail(panel, task) {
  if (!task) return;
  const hist = (Array.isArray(task.history) ? task.history : [])
    .map((h) => `<li><b>${esc(h.state)}</b> · ${esc(h.at)}${h.by ? ` · ${esc(h.by)}` : ''}</li>`).join('');
  const field = (label, v) => v ? `<div class="tv-field"><span>${esc(label)}</span><p>${esc(v)}</p></div>` : '';
  panel.hidden = false;
  panel.innerHTML = `
    <div class="tv-dhead"><b>${esc(task.title)}</b> <span class="tv-sub">${esc(task.id)} · ${esc(task.from)} → ${esc(task.to)} · ${esc(task.state)}</span>
      <button class="tv-close" type="button">×</button></div>
    ${field('Objective', task.objective)}
    ${field('Requirements', task.requirements)}
    ${field('Context', task.context)}
    ${field('Pointers', task.pointers)}
    ${task.result ? field('Result', task.result) : ''}
    <div class="tv-field"><span>History</span><ul class="tv-hist">${hist || '<li>—</li>'}</ul></div>`;
  panel.querySelector('.tv-close').onclick = () => { panel.hidden = true; };
}
