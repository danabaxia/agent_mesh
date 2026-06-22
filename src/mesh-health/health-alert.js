// src/mesh-health/health-alert.js — PURE planner for the proactive health-alert
// sweep (issue #361). Given a HealthReport (the organ-level model from
// buildHealthReport) plus the prior sweep's state, decide which `needs-human`
// issues to OPEN (an organ just went critical) and which to CLOSE (an organ
// recovered). NO I/O — the daemon shell owns collectHealth + the `gh` calls.
//
// Why per-organ critical and not the bare `overall` verdict: the overall verdict
// is critical iff some organ is critical, so alerting per organ is the same signal
// at finer grain — and a dead/stuck agent already rolls its organ (Agents) to
// critical via livenessStatus(). One issue per organ keeps each alert actionable.
//
// The honesty rule of health-model.js is inherited unchanged: this planner only
// reacts to what the model already classified as critical (it never re-judges), so
// an idle on-demand agent is never alerted on.
//
//   planHealthAlerts({ report, prev, now }) =>
//     { opens:[{key,organ,title,body}], closes:[{key,organ,body}], state:{generatedAt,openAlerts:[key]} }

// Marker prefix embedded in every alert body — the daemon dedups open issues by
// searching for the key, and the planner dedups across sweeps via `prev.openAlerts`.
export const HEALTH_ALERT_PREFIX = 'mesh-health-alert';

// The five organs, worst-status-bearing, in the model's render order.
const ORGAN_LABEL = {
  agents: 'Agents',
  jobs: 'Jobs & Daemon',
  board: 'Task Board',
  pipeline: 'Pipeline & Conformance',
  cognition: 'Cognition',
};

export function organAlertKey(organ) { return `${HEALTH_ALERT_PREFIX}:${organ}/critical`; }

function organOf(key) { return String(key).slice(HEALTH_ALERT_PREFIX.length + 1).split('/')[0]; }

function openBody({ label, key, report }) {
  const md = report?.report?.markdown || '_(health report unavailable)_';
  return [
    `🔴 **${label} transitioned to CRITICAL** — the mesh health model flagged a dead/stuck mechanism in this organ.`,
    '',
    'This issue was filed automatically by the dev-society health-alert sweep so the owner is paged instead of having to open the dashboard. It auto-closes when the organ recovers.',
    '',
    '---',
    '',
    md.trimEnd(),
    '',
    `<!-- ${key} -->`,
  ].join('\n');
}

function closeBody({ label, status, key }) {
  return [
    `🟢 **${label} recovered** — the organ is no longer critical (now \`${status}\`).`,
    '',
    'Auto-closed by the dev-society health-alert sweep.',
    '',
    `<!-- ${key} -->`,
  ].join('\n');
}

/**
 * @param {object}   args
 * @param {object}   args.report  a HealthReport from buildHealthReport (organs + report.markdown)
 * @param {object|null} args.prev  prior state { openAlerts: string[] } (or null on first sweep)
 * @param {Date|number} [args.now]
 */
export function planHealthAlerts({ report, prev = null, now = new Date() } = {}) {
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const organs = (report && report.organs) || {};
  const prevOpen = new Set(Array.isArray(prev?.openAlerts) ? prev.openAlerts : []);

  const opens = [];
  const nextOpen = new Set();

  for (const [organ, label] of Object.entries(ORGAN_LABEL)) {
    const o = organs[organ];
    if (!o || o.status !== 'critical') continue;
    const key = organAlertKey(organ);
    nextOpen.add(key);
    if (!prevOpen.has(key)) {          // dedup: only file once per critical episode
      opens.push({ key, organ, title: `[mesh-health] ${label} is CRITICAL — needs human`, body: openBody({ label, key, report }) });
    }
  }

  // Anything previously open that is no longer critical → recovered → close.
  const closes = [];
  for (const key of prevOpen) {
    if (nextOpen.has(key)) continue;
    const organ = organOf(key);
    const label = ORGAN_LABEL[organ] || organ;
    const status = organs[organ]?.status || 'unknown';
    closes.push({ key, organ, body: closeBody({ label, status, key }) });
  }

  return { opens, closes, state: { generatedAt: nowIso, openAlerts: [...nextOpen] } };
}
