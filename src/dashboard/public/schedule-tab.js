// src/dashboard/public/schedule-tab.js — workspace Schedule tab (spec §3.3,
// locked-demo alignment). DISPLAY-ONLY job table (job / cadence / last run /
// next run / status chip) with per-row actions: ▶ run once, ⏸/▶ pause-resume
// toggle, 🗑 delete. NO in-UI creation (the demo never had one) — definitions
// live in <agent>/.agent/schedule.json. Data from GET /api/agent/:name/schedule
// (scheduler off → read-only table + banner); mutations are PRIVILEGED (403
// scheduler_disabled without --allow-shell). No periodic poll — only a short,
// guarded self-clearing poll while a job is running.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

let pollTimer = null;   // module-level so the next render (any tab switch back) clears it

function chipHtml(j) {
  if (j.running) return '<span class="schip due">running</span>';
  // paused wins over ok/fail/new — a disabled job must be visibly disabled
  if (!j.enabled) return '<span class="schip off">paused</span>';
  if (j.lastStatus === 'ok') return '<span class="schip ok">ok</span>';
  if (j.lastStatus === 'fail') return '<span class="schip due">fail</span>';
  return '<span class="schip off">new</span>';
}

function lastRunHtml(j) {
  if (!j.lastRunAt) return '—';
  const t = new Date(j.lastRunAt).toLocaleString();
  const flag = j.lastStatus === 'ok' ? '✓' : '✗';
  return `<span title="${esc(j.lastSummary || '')}">${esc(t)} ${flag}</span>`;
}

function rowHtml(j, withActions) {
  const next = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : '—';
  const acts = withActions
    ? `<td><button class="rbtn" data-act="run" data-id="${esc(j.id)}">▶ run now</button>` +
      `<button class="rbtn" data-act="toggle" data-id="${esc(j.id)}" data-enabled="${j.enabled ? '1' : ''}" title="${j.enabled ? 'pause' : 'resume'}">${j.enabled ? '⏸' : '▶'}</button>` +
      `<button class="rbtn" data-act="del" data-id="${esc(j.id)}" title="delete job">🗑</button></td>`
    : '';
  return `<tr data-id="${esc(j.id)}">` +
    `<td title="${esc(j.prompt || '')}">${esc(j.name)}</td>` +
    `<td>${esc(j.cadenceLabel || '')}</td>` +
    `<td>${lastRunHtml(j)}</td>` +
    `<td>${esc(next)}</td>` +
    `<td>${chipHtml(j)}</td>${acts}</tr>`;
}

// NOTE (locked-demo alignment): the tab is a DISPLAY of the agent's jobs with
// per-row actions only — pause/resume, run once, delete. There is NO in-UI
// creation form (the demo never had one): job definitions live in
// <agent>/.agent/schedule.json (hand-edited or written programmatically via
// POST /api/agent/:name/schedule, which remains for tooling).

export async function renderScheduleTab(body, agent, mesh) {
  // The workspace replaces #ws-body content on every tab switch — never let a
  // previous Schedule render keep polling.
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }

  const r = await fetch(`/api/agent/${encodeURIComponent(agent)}/schedule`).catch(() => null);
  if (!body.isConnected || body.dataset.activeTab !== 'schedule') return;
  if (!r || !r.ok) {
    body.innerHTML = `<div class="wstab-pad"><p class="stub">schedule listing failed (${r ? r.status : 'network error'})</p></div>`;
    return;
  }
  const { schedulerEnabled, jobs } = await r.json();
  if (!body.isConnected || body.dataset.activeTab !== 'schedule') return;

  const cols = schedulerEnabled ? 6 : 5;
  const header = '<tr><th>job</th><th>cadence</th><th>last run</th><th>next run</th><th>status</th>' +
    (schedulerEnabled ? '<th></th>' : '') + '</tr>';
  const rows = jobs.map((j) => rowHtml(j, schedulerEnabled)).join('') ||
    `<tr><td colspan="${cols}" style="color:var(--ink2)">no scheduled jobs yet</td></tr>`;
  const banner = schedulerEnabled ? '' :
    '<div class="stub" style="margin-bottom:10px">scheduler off — start the dashboard with --allow-shell to enable runs</div>';

  body.innerHTML =
    `<div class="wstab-pad sched">` +
    `<h3 style="font:600 15px Georgia,serif;margin-bottom:10px">${esc(agent)} — scheduled jobs</h3>` +
    banner +
    `<table>${header}${rows}</table>` +
    `<div class="sched-note">Jobs run as ask-mode delegations (route scheduled:&lt;id&gt;) — results appear in Activity and the mesh timeline. Jobs fire only while the dashboard server is running. Job definitions live in the agent's <code>.agent/schedule.json</code>.</div>` +
    `</div>`;

  // #ws-body is persistent (innerHTML-swapped on tab switch, never detached),
  // so isConnected alone CANNOT detect "user left this tab" — workspace.js
  // stamps body.dataset.activeTab; every deferred refetch must check it or it
  // will paint the schedule table over whichever tab is now active (the
  // session-tab-keeps-switching bug).
  const stillMine = () => body.isConnected && body.dataset.activeTab === 'schedule';
  const rerender = () => { if (stillMine()) renderScheduleTab(body, agent, mesh); };
  const api = (path, init) => fetch(`/api/agent/${encodeURIComponent(agent)}/schedule${path}`, init);

  if (schedulerEnabled) {
    const byId = new Map(jobs.map((j) => [j.id, j]));

    body.querySelector('.sched table').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const id = btn.dataset.id;

      if (btn.dataset.act === 'run') {
        const rr = await api(`/${encodeURIComponent(id)}/run`, { method: 'POST' }).catch(() => null);
        if (rr && rr.status === 202) {
          const chip = btn.closest('tr')?.querySelector('.schip');
          if (chip) chip.outerHTML = '<span class="schip due">running</span>';
          setTimeout(rerender, 2000);
        } else {
          btn.textContent = `✗ ${rr ? rr.status : 'network error'}`;
        }
        return;
      }

      if (btn.dataset.act === 'toggle') {
        const enabled = !btn.dataset.enabled;   // '' (falsy) when currently paused
        const rr = await api(`/${encodeURIComponent(id)}/enable`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        }).catch(() => null);
        if (rr && rr.ok) rerender();
        else btn.textContent = `✗ ${rr ? rr.status : '!'}`;
        return;
      }

      if (btn.dataset.act === 'del') {
        const job = byId.get(id);
        if (!confirm(`Delete scheduled job "${job?.name ?? id}"?`)) return;
        const rr = await api(`/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null);
        if (rr && rr.ok) rerender();
        else btn.textContent = `✗ ${rr ? rr.status : '!'}`;
      }
    });
  }

  // No periodic poll: the scheduler runs server-side regardless of the UI, so
  // the table only needs refreshing on demand (tab open / after an action) —
  // EXCEPT while a job is actually running, where a short-lived 5s poll tracks
  // it until it settles. Guarded by stillMine() so it can never repaint a
  // different tab, and self-clearing once nothing is running.
  if (jobs.some((j) => j.running)) {
    pollTimer = setInterval(() => {
      if (!stillMine()) { clearInterval(pollTimer); pollTimer = null; return; }
      clearInterval(pollTimer); pollTimer = null;
      renderScheduleTab(body, agent, mesh);
    }, 5000);
  }
}
