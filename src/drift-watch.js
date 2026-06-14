// src/drift-watch.js — bi-temporal drift watch (spec §10).
// PURE, zero-dependency, and strictly NON-MUTATING: it only ever *proposes*
// (review-first, §9) — never auto-edits the store. Two health signals:
//   1. staleness  — entries unused over a sliding window → propose retire/re-absorb;
//   2. supersession — a newly-absorbed fact conflicting with a live one → propose
//      marking the OLD entry expired (`valid_to`, bi-temporal) — NOT a delete.
//
// `expired` ≠ `retired` (spec §10): supersession sets `valid_to` (history kept,
// never injected/recalled); retirement is a hard real delete. Applying an
// approved expire proposal reuses `expireEntry` from quick-memory.js.
import { isLive } from './quick-memory.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tally usage from drift events. An event is { key, kind:'recall'|'prefetch', at }.
 * BOTH a verb `recall` AND a framework `prefetch` injection count as usage (spec
 * §10): otherwise a prefetched-into-prompt entry (never `recall`ed via the verb)
 * would look perpetually unused and be proposed for retirement — backwards for the
 * high-volume headless entries. Returns { [key]: { count, lastAt } }.
 */
export function tallyUsage(events) {
  const t = {};
  for (const ev of events || []) {
    if (!ev || typeof ev.key !== 'string' || !ev.key) continue;
    if (ev.kind !== 'recall' && ev.kind !== 'prefetch') continue;
    const e = (t[ev.key] ||= { count: 0, lastAt: null });
    e.count++;
    if (ev.at && (e.lastAt == null || ev.at > e.lastAt)) e.lastAt = ev.at;
  }
  return t;
}

/**
 * Propose (never apply) staleness actions for LIVE entries idle beyond `staleMs`.
 * `core` entries are exempt (they are intentionally always-resident, not stale).
 * Idle is measured from last usage (tally) or, absent any usage, from `valid_from`.
 * Returns [{ key, kind:'retire', reason }] — sorted by key for determinism.
 */
export function stalenessProposals(quick, usage, { now = Date.now(), staleMs = 30 * DAY_MS } = {}) {
  const props = [];
  for (const [key, e] of Object.entries(quick || {})) {
    if (!isLive(e) || e.core) continue;
    const u = usage?.[key];
    const ref = u?.lastAt ?? e.valid_from ?? null;
    const lastMs = ref ? Date.parse(ref) : NaN;
    const idle = Number.isNaN(lastMs) ? Infinity : now - lastMs;
    if (idle > staleMs) {
      const days = Number.isFinite(idle) ? Math.round(idle / DAY_MS) : null;
      props.push({ key, kind: 'retire', reason: `idle ${days == null ? 'never-used' : `${days}d`}, ${u?.count ?? 0} uses` });
    }
  }
  return props.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Propose supersession when a newly-absorbed fact conflicts with a LIVE entry of
 * the same key but a different value. PROPOSAL ONLY (review-first) — applying it
 * is `expireEntry` on approval. `newFacts` = [{ key, value }].
 * Returns [{ key, kind:'expire', reason, newValue }].
 */
export function supersessionProposals(quick, newFacts) {
  const props = [];
  for (const nf of newFacts || []) {
    if (!nf || typeof nf.key !== 'string') continue;
    const cur = quick?.[nf.key];
    if (isLive(cur) && cur.value !== nf.value) {
      props.push({ key: nf.key, kind: 'expire', reason: 'superseded by a newer absorbed fact', newValue: nf.value ?? null });
    }
  }
  return props.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Convenience: all drift proposals for an agent in one pass (still non-mutating). */
export function driftProposals(quick, usage, newFacts = [], opts = {}) {
  return [...stalenessProposals(quick, usage, opts), ...supersessionProposals(quick, newFacts)];
}
