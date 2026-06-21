// src/soft-launch-monitor/core.js — pure functions for the 24h clean-clock watchdog.
// No I/O here. Spec: feat/soft-launch-monitor.

export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ISO timestamp prefix pattern
const ISO_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/;

/**
 * scanDaemonLog(logText, { sinceIso, feature }) → issues[]
 *
 * Split logText into lines. For each line that starts with an ISO timestamp,
 * parse ts; skip if ts < sinceIso. Match (case-insensitive):
 *   `<feature> error:` or `<feature>:` followed by text containing 'error'/'fail'
 *   OR  /advisory #\d+ \((analyst|triager)\) failed/
 * Each match → { severity:'error', signal:'daemon-log', ts, line: line.trim() }
 * Lines without an ISO prefix are ignored. Returns issues[].
 */
export function scanDaemonLog(logText, { sinceIso, feature = 'research-escalation' } = {}) {
  const issues = [];
  const sinceMs = sinceIso ? Date.parse(sinceIso) : -Infinity;
  const featureLower = (feature || 'research-escalation').toLowerCase();

  // Build regexes (case-insensitive) based on feature name
  // Pattern 1: `<feature> error:` → direct error label
  const featureErrorRe = new RegExp(`${escapeRe(featureLower)}\\s+error:`, 'i');
  // Pattern 2: `<feature>:` followed by text containing 'error' or 'fail'
  const featureColonRe = new RegExp(`${escapeRe(featureLower)}:`, 'i');
  // Pattern 3: advisory failed
  const advisoryRe = /advisory #\d+ \((analyst|triager)\) failed/i;

  for (const rawLine of logText.split('\n')) {
    const m = ISO_PREFIX_RE.exec(rawLine);
    if (!m) continue; // no ISO prefix — skip (tester output etc.)

    const ts = m[1];
    const tsMs = Date.parse(ts);
    if (tsMs < sinceMs) continue;

    const rest = rawLine.slice(m[0].length).toLowerCase();

    let matched = false;
    if (featureErrorRe.test(rawLine)) {
      // direct `<feature> error:` pattern
      matched = true;
    } else if (featureColonRe.test(rawLine) && (rest.includes('error') || rest.includes('fail'))) {
      // `<feature>: ... error/fail ...`
      matched = true;
    } else if (advisoryRe.test(rawLine)) {
      matched = true;
    }

    if (matched) {
      issues.push({ severity: 'error', signal: 'daemon-log', ts, line: rawLine.trim() });
    }
  }
  return issues;
}

/**
 * scanErrLog(prevBytes, currBytes) → issues[]
 *
 * If currBytes > prevBytes → [{ severity:'error', signal:'daemon-err', detail:`stderr grew ${prevBytes}->${currBytes} bytes` }]
 * else []
 */
export function scanErrLog(prevBytes, currBytes) {
  if (currBytes > prevBytes) {
    return [{ severity: 'error', signal: 'daemon-err', detail: `stderr grew ${prevBytes}->${currBytes} bytes` }];
  }
  return [];
}

/**
 * scanScheduleState(stateObj, jobId) → issues[]
 *
 * entry = stateObj?.[jobId].
 * If entry?.lastStatus === 'fail' OR (entry?.consecutiveFailures||0) > 0
 *   → [{ severity:'error', signal:'schedule-state', detail:`${jobId} lastStatus=${entry.lastStatus} consecutiveFailures=${entry.consecutiveFailures}` }]
 * else []
 */
export function scanScheduleState(stateObj, jobId = 'research-escalation') {
  const entry = stateObj?.[jobId];
  if (!entry) return [];
  const isFail = entry.lastStatus === 'fail';
  const hasFailures = (entry.consecutiveFailures || 0) > 0;
  if (isFail || hasFailures) {
    return [{
      severity: 'error',
      signal: 'schedule-state',
      detail: `${jobId} lastStatus=${entry.lastStatus} consecutiveFailures=${entry.consecutiveFailures}`,
    }];
  }
  return [];
}

/**
 * findStrandedEscalations(issues, nowMs, { minAgeMs }) → flags[]
 *
 * issues: [{ number, createdAtMs, hasDiagnosis }]
 * Flag those with hasDiagnosis===false AND (nowMs - createdAtMs) >= minAgeMs
 *   → { severity:'warn', signal:'stranded', number, detail:`needs-human #${number} undiagnosed for >${Math.round(minAgeMs/3600000)}h` }
 */
export function findStrandedEscalations(issues, nowMs, { minAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const flags = [];
  const minAgeH = Math.round(minAgeMs / 3_600_000);
  for (const iss of (issues || [])) {
    if (iss.hasDiagnosis !== false) continue;
    if ((nowMs - iss.createdAtMs) < minAgeMs) continue;
    flags.push({
      severity: 'warn',
      signal: 'stranded',
      number: iss.number,
      detail: `needs-human #${iss.number} undiagnosed for >${minAgeH}h`,
    });
  }
  return flags;
}

/**
 * advanceClock(prevState, foundIssues, nowIso, windowMs) → nextState
 *
 * nowMs = Date.parse(nowIso).
 * If !prevState: base = { feature:'research-escalation', liveSince: nowIso, cleanSince: nowIso }.
 *   else base = { ...prevState }.
 * If foundIssues.length > 0: status='issues', cleanSince=nowIso (RESET), lastIssues=foundIssues.
 *   else: cleanMs = nowMs - Date.parse(base.cleanSince); status = cleanMs >= windowMs ? 'validated' : 'clean'; lastIssues=[].
 * Always set lastCheck=nowIso. Returns { ...base, status, lastCheck, lastIssues,
 *   cleanForMs: nowMs - Date.parse(cleanSince_after), windowMs }.
 */
export function advanceClock(prevState, foundIssues, nowIso, windowMs = DEFAULT_WINDOW_MS) {
  const nowMs = Date.parse(nowIso);

  let base;
  if (!prevState) {
    base = { feature: 'research-escalation', liveSince: nowIso, cleanSince: nowIso };
  } else {
    base = { ...prevState };
  }

  let status, cleanSince, lastIssues;

  if (foundIssues.length > 0) {
    status = 'issues';
    cleanSince = nowIso; // reset the clean clock
    lastIssues = foundIssues;
  } else {
    cleanSince = base.cleanSince;
    const cleanMs = nowMs - Date.parse(cleanSince);
    status = cleanMs >= windowMs ? 'validated' : 'clean';
    lastIssues = [];
  }

  const cleanForMs = nowMs - Date.parse(cleanSince);

  return {
    ...base,
    status,
    lastCheck: nowIso,
    lastIssues,
    cleanForMs,
    windowMs,
    cleanSince, // override base.cleanSince if reset
  };
}

/**
 * summarize(state) → string
 *
 * One-line human summary, e.g.:
 *   `STATUS: clean — 4.2h/24.0h clean (0 issues)`
 *   `STATUS: issues — clock reset; 2 issue(s): daemon-log, schedule-state`
 *   `STATUS: validated — 24.0h clean, feature validated`
 */
export function summarize(state) {
  const { status, cleanForMs, windowMs, lastIssues = [] } = state;
  const windowH = (windowMs / 3_600_000).toFixed(1);

  if (status === 'issues') {
    const signals = lastIssues.map((i) => i.signal).join(', ');
    return `STATUS: issues — clock reset; ${lastIssues.length} issue(s): ${signals}`;
  }
  if (status === 'validated') {
    const cleanH = (cleanForMs / 3_600_000).toFixed(1);
    return `STATUS: validated — ${cleanH}h clean, feature validated`;
  }
  // 'clean' (and any unknown status falls through here)
  const cleanH = (cleanForMs / 3_600_000).toFixed(1);
  return `STATUS: clean — ${cleanH}h/${windowH}h clean (${lastIssues.length} issues)`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
