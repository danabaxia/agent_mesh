/**
 * src/dashboard/public/timeline-model.js — PURE.
 * Stitched cross-session canvas model (2026-06-13 spec §7): an ordered list of
 * segments, exactly one live (last). Sealing keeps records; switching never
 * clears. Records address as (sessionId, seq) — seq stays per-session.
 */
export const MAX_STITCHED_SEGMENTS = 8;

export function dividerLabel(metaOrRow) {
  const o = String(metaOrRow.originSource || 'cli');
  if (o === 'headroom') return 'generation rotated (digest applied)';
  if (o === 'dashboard') return 'dashboard session';
  return 'new CLI session';
}

export function createTimeline() {
  let segments = []; // { sessionId, startedAt, originSource, label, sealed, records[] }

  const seal = () => { const live = segments[segments.length - 1]; if (live) live.sealed = true; };
  const evict = () => { while (segments.length > MAX_STITCHED_SEGMENTS) segments.shift(); };

  return {
    openSegment(meta) {
      if (segments.length && segments[segments.length - 1].sessionId === meta.id) return;
      seal();
      segments.push({ sessionId: meta.id, startedAt: meta.startedAt ?? Date.now(),
        originSource: meta.originSource || 'cli', label: dividerLabel(meta), sealed: false, records: [] });
      evict();
    },
    append(sessionId, rec) {
      const live = segments[segments.length - 1];
      if (!live || live.sessionId !== sessionId || live.sealed) return; // sealed = static history
      live.records.push(rec);
    },
    prependHistory(meta, records) {
      segments.unshift({ sessionId: meta.id, startedAt: meta.startedAt ?? 0,
        originSource: meta.originSource || 'cli', label: dividerLabel(meta), sealed: true,
        records: records.slice() });
      evict();
    },
    seedLive(sessionId, records) {           // windowed /transcript load for the live segment
      const live = segments[segments.length - 1];
      if (live && live.sessionId === sessionId && !live.sealed) live.records = records.slice();
    },
    segments: () => segments,
    liveSessionId: () => (segments.length ? segments[segments.length - 1].sessionId : null)
  };
}
