// src/mesh-health/health-alert.js — pure heart of the health-alert sweep.
//
// Given a health report (from buildHealthReport) and prior alert state,
// returns the set of GitHub issues to open and to close, plus the new state
// to persist. No I/O — the daemon shell owns all file reads/writes and gh calls.
//
// State schema (mesh/health-alert-state.json):
//   { open: { [key]: number } }   — key → open GitHub issue number
//
// Keys:
//   "overall:critical"            — overall verdict is critical
//   "organ:<name>:<status>"       — specific organ transitioned to critical
//
// Spec: GitHub issue #361

// Organs we alert on individually when they hit critical.
const ALERT_ORGANS = ['agents', 'jobs', 'board', 'pipeline', 'cognition'];

// The set of organ statuses that trigger an alert.
const ALERT_STATUSES = new Set(['critical']);

/**
 * Derive the alert key set for a given health report.
 * Returns a Set<string> of keys that are currently "alert-worthy".
 */
export function alertKeysFor(report) {
  const keys = new Set();
  if (!report || typeof report !== 'object') return keys;
  if (report.overall === 'critical') keys.add('overall:critical');
  const organs = report.organs || {};
  for (const name of ALERT_ORGANS) {
    const organ = organs[name];
    if (organ && ALERT_STATUSES.has(organ.status)) {
      keys.add(`organ:${name}:${organ.status}`);
    }
  }
  return keys;
}

/**
 * Build a GitHub issue title for an alert key.
 */
export function alertTitle(key) {
  if (key === 'overall:critical') {
    return '[mesh-health] Overall mesh health is CRITICAL';
  }
  const m = key.match(/^organ:(\w+):(\w+)$/);
  if (m) {
    const labels = { agents: 'Agents', jobs: 'Jobs & Daemon', board: 'Task Board', pipeline: 'Pipeline & Conformance', cognition: 'Cognition' };
    return `[mesh-health] ${labels[m[1]] || m[1]} organ is ${m[2].toUpperCase()}`;
  }
  return `[mesh-health] ${key}`;
}

/**
 * Build a GitHub issue body for an alert key, including the rendered health report.
 */
export function alertBody(key, report) {
  const reportMd = (report && report.report && report.report.markdown) ? report.report.markdown : '_no health report available_';
  const ts = (report && report.generatedAt) ? report.generatedAt : new Date().toISOString();
  return [
    `**Mesh health alert**: \`${key}\` — detected at ${ts}`,
    '',
    'The health sweep found a critical condition. See the rendered report below.',
    '',
    `<!-- mesh-health-alert-key: ${key} -->`,
    '',
    reportMd,
  ].join('\n');
}

/**
 * Build a GitHub issue close comment for a recovered key.
 */
export function recoveryComment(key, report) {
  const ts = (report && report.generatedAt) ? report.generatedAt : new Date().toISOString();
  return `**Mesh health recovered**: \`${key}\` resolved at ${ts}. Overall verdict: ${report && report.overall ? report.overall : 'unknown'}.`;
}

/**
 * computeAlertActions(report, priorState) → { toOpen, toClose, nextState }
 *
 * Pure: given the current health report and the persisted state,
 * returns what actions the shell should take and the new state to write.
 *
 * toOpen:  [{ key, title, body }]        — new issues to file
 * toClose: [{ key, number, comment }]    — existing issues to close
 * nextState: { open: { [key]: number } } — to persist after gh calls succeed
 *
 * The shell MUST update nextState.open[key] with the real issue number after
 * opening (toOpen entries carry no number yet).
 */
export function computeAlertActions(report, priorState) {
  const prior = (priorState && priorState.open != null && typeof priorState.open === 'object') ? priorState.open : {};
  const activeKeys = alertKeysFor(report);

  const toOpen = [];
  const toClose = [];
  const nextOpen = { ...prior };

  // Keys that are now critical but not yet open → open.
  for (const key of activeKeys) {
    if (!(key in nextOpen)) {
      toOpen.push({ key, title: alertTitle(key), body: alertBody(key, report) });
      // Shell fills in the issue number after creating; mark pending with null.
      nextOpen[key] = null;
    }
    // else: already open, nothing to do (dedup).
  }

  // Keys that were open but are no longer critical → close.
  for (const [key, number] of Object.entries(prior)) {
    if (!activeKeys.has(key)) {
      toClose.push({ key, number, comment: recoveryComment(key, report) });
      delete nextOpen[key];
    }
  }

  return { toOpen, toClose, nextState: { open: nextOpen } };
}
