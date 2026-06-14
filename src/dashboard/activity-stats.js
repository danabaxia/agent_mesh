// src/dashboard/activity-stats.js — PURE reducer for the workspace Activity tab
// (Phase 4 spec §3.2). No I/O and no Date.now(): `now` is always injected so
// range bounds are deterministic and unit-testable. The server route gathers
// run-log records / sessions / artifacts / tool counts and calls this.
//
// Contract (LOCKED — see docs/superpowers/plans/2026-06-11-dashboard-redesign-phase4-activity.md):
//   buildActivityStats({ agent, records, sessions, artifacts, toolCounts, now, range }) → {
//     range, from, to,
//     kpis: { served, a2aOut: { total, ok, fail }, turns, toolCalls, artifactsSaved, avgRunMs },
//     toolUsage: [{ name, count }],          // desc by count
//     worklog: [{ at, end, channel, status, summary }],  // newest first, cap 50
//     sessionsAvailable, toolUsageTruncated
//   }

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKLOG_CAP = 50;

/**
 * Range bounds from an injected `now`:
 *   today → local midnight of now → now; week → now-7d; month → now-31d.
 * Returns { from: Date, to: Date }. Throws on an unknown range (route maps to 400).
 */
export function rangeBounds(range, now) {
  const n = now instanceof Date ? now : new Date(now);
  if (range === 'today') return { from: new Date(n.getFullYear(), n.getMonth(), n.getDate()), to: n };
  if (range === 'week') return { from: new Date(n.getTime() - 7 * DAY_MS), to: n };
  if (range === 'month') return { from: new Date(n.getTime() - 31 * DAY_MS), to: n };
  throw new Error(`unknown range: ${range}`);
}

// Tolerant time coercion: ISO string | epoch-ms number | Date → ms (NaN when absent/bad).
function toEpochMs(v) {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return Date.parse(v);
}

function toIso(v) {
  const ms = toEpochMs(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// fail = status 'failed' or any other error-ish truthy status (or a truthy error
// field); status null/'ok'/'done'/'completed' count as ok ('done' is the
// delegate run-log success status, 'completed' the a2a one).
function isFail(r) {
  if (r.error) return true;
  const s = r.status;
  if (s == null || s === 'ok' || s === 'done' || s === 'completed') return false;
  return Boolean(s);
}

const isA2a = (r) => r.kind === 'a2a';

function runStatus(r) {
  if (!r.finished_at) return 'running';
  return isFail(r) ? 'fail' : 'ok';
}

export function buildActivityStats({
  agent, records, sessions, artifacts, toolCounts, now, range,
  sessionsAvailable, toolUsageTruncated
} = {}) {
  const { from, to } = rangeBounds(range, now);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const inRange = (v) => {
    const ms = toEpochMs(v);
    return Number.isFinite(ms) && ms >= fromMs && ms <= toMs;
  };

  // --- runs (delegate + a2a), range-filtered by started_at -----------------
  const recs = (Array.isArray(records) ? records : []).filter((r) => r && inRange(r.started_at));
  const served = recs.filter((r) => !isA2a(r) || r.to === agent).length;
  const outRuns = recs.filter((r) => isA2a(r) && r.from === agent);
  const failCount = outRuns.filter(isFail).length;
  const a2aOut = { total: outRuns.length, ok: outRuns.length - failCount, fail: failCount };

  const completed = recs.filter((r) => Number.isFinite(toEpochMs(r.finished_at)));
  const avgRunMs = completed.length
    ? Math.round(completed.reduce((sum, r) => sum + (toEpochMs(r.finished_at) - toEpochMs(r.started_at)), 0) / completed.length)
    : null;

  // --- sessions (degrade: null when unavailable) ----------------------------
  const sessAvail = sessionsAvailable ?? (sessions != null);
  const sessList = Array.isArray(sessions) ? sessions : [];
  const turns = sessions == null ? null : sessList.reduce((sum, s) => sum + (Number(s.turns) || 0), 0);

  // --- tool usage (degrade: null/empty when unavailable) --------------------
  const toolCalls = toolCounts == null
    ? null
    : Object.values(toolCounts).reduce((sum, c) => sum + (Number(c) || 0), 0);
  const toolUsage = toolCounts == null
    ? []
    : Object.entries(toolCounts)
      .map(([name, count]) => ({ name, count: Number(count) || 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  // --- artifacts, range-filtered by savedAt ---------------------------------
  const artsInRange = (Array.isArray(artifacts) ? artifacts : []).filter((a) => a && inRange(a.savedAt));
  const artifactsSaved = artsInRange.length;

  // --- worklog: one line per item, merged, newest first, capped -------------
  const entries = [];
  for (const r of recs) {
    const status = runStatus(r);
    if (isA2a(r)) {
      if (r.from === agent) {
        entries.push({ at: toIso(r.started_at), end: toIso(r.finished_at), channel: 'a2a-out', status, summary: `to ${r.to} (${r.mode})` });
      } else if (r.to === agent) {
        entries.push({ at: toIso(r.started_at), end: toIso(r.finished_at), channel: 'a2a-served', status, summary: `from ${r.from} (${r.mode})` });
      }
    } else {
      entries.push({ at: toIso(r.started_at), end: toIso(r.finished_at), channel: 'delegate', status, summary: r.route ?? '' });
    }
  }
  for (const s of sessList) {
    // Sessions carry epoch-ms startedAt/endedAt (listSessions); include when in
    // range — or unconditionally when no timestamp is available.
    const hasTime = s.startedAt != null || s.endedAt != null;
    if (hasTime && !inRange(s.startedAt) && !inRange(s.endedAt)) continue;
    entries.push({ at: toIso(s.startedAt ?? s.endedAt), end: toIso(s.endedAt), channel: 'session', status: 'ok', summary: s.firstPrompt ?? '' });
  }
  for (const a of artsInRange) {
    entries.push({ at: toIso(a.savedAt), end: null, channel: 'artifact-save', status: 'saved', summary: a.title ?? '' });
  }
  entries.sort((a, b) => (toEpochMs(b.at) || 0) - (toEpochMs(a.at) || 0));
  const worklog = entries.slice(0, WORKLOG_CAP);

  return {
    range,
    from: from.toISOString(),
    to: to.toISOString(),
    kpis: { served, a2aOut, turns, toolCalls, artifactsSaved, avgRunMs },
    toolUsage,
    worklog,
    sessionsAvailable: Boolean(sessAvail),
    toolUsageTruncated: Boolean(toolUsageTruncated)
  };
}
