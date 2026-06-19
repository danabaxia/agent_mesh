// Pure: normalize an activity event into the canonical shape, and filter a list.
// No I/O. The single place the event shape + filter semantics are defined.
import { MAX_ACTIVITY_SUMMARY } from '../config.js';

const LEVELS = new Set(['info', 'warn', 'error']);

/**
 * @returns {{ts, source, type, level, summary, agent?, ref?, detail?}}
 */
export function formatEvent({ source, agent, type, level, summary, ref, detail } = {}, { now = () => new Date() } = {}) {
  const ev = {
    ts: now().toISOString(),
    source: String(source || 'daemon'),
    type: String(type || 'event'),
    level: LEVELS.has(level) ? level : 'info',
    summary: String(summary == null ? '' : summary).slice(0, MAX_ACTIVITY_SUMMARY),
  };
  if (agent) ev.agent = String(agent);
  if (ref) ev.ref = String(ref);
  if (detail && typeof detail === 'object') ev.detail = detail;
  return ev;
}

export function filterEvents(events, { agent, type, since, level } = {}) {
  const sinceMs = since ? Date.parse(since) : NaN;
  return (Array.isArray(events) ? events : []).filter((e) => {
    if (!e || typeof e !== 'object') return false;
    if (agent && e.agent !== agent) return false;
    if (type && e.type !== type) return false;
    if (level && e.level !== level) return false;
    if (Number.isFinite(sinceMs) && Date.parse(e.ts) < sinceMs) return false;
    return true;
  });
}
