// src/dashboard/public/workspace.js
// Agent workspace view (board2 view 2). Toggles #view-board ⇄ #view-ws and
// drives the six workspace tabs. The Session tab dynamic-imports the
// turn-based session view (/session-view.js — Phase 7); Activity/Schedule/
// Files/Artifacts/Workflows dynamic-import their own tab modules. The legacy
// session-log component (window.mountSessionLog) is NO LONGER mounted here —
// it remains untouched for the legacy '/' dashboard.
import { agentColor } from '/board2-model.js';

const $ = (s, r = document) => r.querySelector(s);

const TAB_TITLES = {
  activity: 'Activity',
  schedule: 'Schedule',
  files: 'Files',
  artifacts: 'Artifacts',
  workflows: 'Workflows'
};

let MESH = null;          // latest /api/mesh view, threaded in from board2.js
let currentName = null;   // agent whose workspace is open (null = board view)
let _svHandle = null;     // mounted session-view instance (has .destroy())

/** Thread the latest /api/mesh payload in (shellEnabled gates ⌘ Terminal). */
export function setWorkspaceMesh(mesh) {
  MESH = mesh;
  updateTerminalButton();
}

export function openWorkspace(name) {
  currentName = name;
  $('#view-board').classList.remove('on');
  $('#view-ws').classList.add('on');
  const nameEl = $('#ws-name');
  nameEl.textContent = name;
  nameEl.style.color = agentColor(name);
  updateHeader(name);
  location.hash = '#/agent/' + encodeURIComponent(name);
  selectTab('session', name);
}

export function closeWorkspace() {
  destroySessionView();
  currentName = null;
  $('#view-ws').classList.remove('on');
  $('#view-board').classList.add('on');
  // Clear the deep-link hash without adding a history entry.
  history.replaceState(null, '', location.pathname + location.search);
}

export function selectTab(tab, name = currentName) {
  if (!name) return;
  for (const t of document.querySelectorAll('[data-wstab]')) {
    t.classList.toggle('on', t.dataset.wstab === tab);
  }
  const body = $('#ws-body');
  // #ws-body is a PERSISTENT element (innerHTML-swapped, never disconnected),
  // so async tab code cannot use isConnected to detect "my tab was switched
  // away". Stamp the active tab instead: any later async work (a resolved
  // dynamic import, a poll, a post-action refetch) must check this stamp and
  // bail when it no longer matches its own tab.
  body.dataset.activeTab = tab;
  destroySessionView();
  if (tab === 'session') {
    // Turn-based session view (Phase 7). The import resolves async — guard
    // with the active-tab stamp so a stale resolution (user already switched
    // tab) never mounts over another tab's body.
    body.innerHTML = '<div class="loading">Loading…</div>';
    import('/session-view.js')
      .then(({ renderSessionView }) => {
        if (body.dataset.activeTab === 'session') _svHandle = renderSessionView(body, name, MESH);
      })
      .catch(() => {
        body.innerHTML = '<div class="wstab-pad"><p class="stub">session-view.js failed to load — the Session view is unavailable.</p></div>';
      });
  } else if (tab === 'activity') {
    body.innerHTML = '<div class="loading">Loading…</div>';
    import('/activity-tab.js')
      .then(({ renderActivityTab }) => { if (body.dataset.activeTab === 'activity') renderActivityTab(body, name, MESH); })
      .catch(() => {
        body.innerHTML = '<div class="wstab-pad"><p class="stub">activity-tab.js failed to load — the Activity view is unavailable.</p></div>';
      });
  } else if (tab === 'schedule') {
    body.innerHTML = '<div class="loading">Loading…</div>';
    import('/schedule-tab.js')
      .then(({ renderScheduleTab }) => { if (body.dataset.activeTab === 'schedule') renderScheduleTab(body, name, MESH); })
      .catch(() => {
        body.innerHTML = '<div class="wstab-pad"><p class="stub">schedule-tab.js failed to load — the Schedule view is unavailable.</p></div>';
      });
  } else if (tab === 'files') {
    body.innerHTML = '<div class="loading">Loading…</div>';
    import('/files-tab.js')
      .then(({ renderFilesTab }) => { if (body.dataset.activeTab === 'files') renderFilesTab(body, name, MESH); })
      .catch(() => {
        body.innerHTML = '<div class="wstab-pad"><p class="stub">files-tab.js failed to load — the Files view is unavailable.</p></div>';
      });
  } else if (tab === 'artifacts') {
    body.innerHTML = '<div class="loading">Loading…</div>';
    import('/artifacts-tab.js')
      .then(({ renderArtifactsTab }) => { if (body.dataset.activeTab === 'artifacts') renderArtifactsTab(body, name, MESH, (t) => selectTab(t, name)); })
      .catch(() => {
        body.innerHTML = '<div class="wstab-pad"><p class="stub">artifacts-tab.js failed to load — the Artifacts view is unavailable.</p></div>';
      });
  } else if (tab === 'workflows') {
    body.innerHTML = '<div class="loading">Loading…</div>';
    import('/workflows-tab.js')
      .then(({ renderWorkflowsTab }) => { if (body.dataset.activeTab === 'workflows') renderWorkflowsTab(body, name, MESH, (t) => selectTab(t, name)); })
      .catch(() => {
        body.innerHTML = '<div class="wstab-pad"><p class="stub">workflows-tab.js failed to load — the Workflows view is unavailable.</p></div>';
      });
  } else {
    const title = TAB_TITLES[tab] || tab;
    body.innerHTML =
      `<div class="wstab-pad"><h3>${title}</h3>` +
      `<p class="stub">Coming in a later phase.</p></div>`;
  }
}

/** ⌘ Terminal in the workspace header: shown only when the server allows shell
 *  launch (--allow-shell); clicking delegates to the session view's own
 *  #sv-term button, which already implements resume-or-seed correctly. */
export function launchTerminal() {
  const inner = $('#ws-body #sv-term');
  if (inner) inner.click();
}

function updateTerminalButton() {
  const btn = $('#ws-terminal');
  if (btn) btn.style.display = MESH?.shellEnabled ? '' : 'none';
}

function updateHeader(name) {
  const node = (MESH?.graph?.nodes ?? []).find((n) => n.id === name);
  const pill = $('#ws-pill');
  if (pill) pill.textContent = `▤ ${node?.status ?? '—'}`;
  updateTerminalButton();
}

function destroySessionView() {
  if (_svHandle) {
    try { _svHandle.destroy(); } catch { /* ignore */ }
    _svHandle = null;
  }
}
