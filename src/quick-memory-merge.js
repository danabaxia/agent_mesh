// src/quick-memory-merge.js — deterministic union of two quick.json snapshots.
//
// Used by dev-mesh-memory-automerge to resolve the (very common) conflict where two
// memory:promote PRs both edit dev-mesh/<role>/memory/quick.json. Pure data layer:
// no fs/git/network. Spec: docs/superpowers/specs/2026-06-19-memory-automerge-union-design.md
//
// Policy (confirmed 2026-06-19): union keys (keep every lesson); a key on both sides
// resolves to the newer provenance.ts (tie → ours); then enforce the quick-memory caps
// by LRU eviction (oldest provenance.ts first) — this is issue #84.
import { MAX_QUICK_ENTRIES, MAX_CORE_ENTRIES } from './quick-memory.js';

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x)) ? x : {};
const ts = (e) => (e && e.provenance && e.provenance.ts) || '';
const isLiveCore = (e) => Boolean(e) && e.core === true && e.status === 'active' && e.valid_to == null;

/** Enforce the hard caps in place, never losing a lesson silently:
 *  - total cap → evict oldest entries, non-core first (core only if nothing else left);
 *  - core cap → demote (core:false) the oldest live-core entries (keep the entry). */
function enforceCaps(merged) {
  let keys = Object.keys(merged);
  if (keys.length > MAX_QUICK_ENTRIES) {
    const order = keys.slice().sort((a, b) => {
      // Protect only LIVE core (a retired/expired core entry is not worth keeping over a
      // live lesson) — matches the spec's "evict non-core live entries first".
      const ca = isLiveCore(merged[a]) ? 1 : 0, cb = isLiveCore(merged[b]) ? 1 : 0;
      if (ca !== cb) return ca - cb;                       // evictable (0) before live-core (1)
      return ts(merged[a]).localeCompare(ts(merged[b]));   // oldest provenance.ts first
    });
    for (const k of order.slice(0, keys.length - MAX_QUICK_ENTRIES)) delete merged[k];
    keys = Object.keys(merged);
  }
  const liveCore = keys.filter((k) => isLiveCore(merged[k]));
  if (liveCore.length > MAX_CORE_ENTRIES) {
    liveCore.sort((a, b) => ts(merged[a]).localeCompare(ts(merged[b])));  // oldest first
    for (const k of liveCore.slice(0, liveCore.length - MAX_CORE_ENTRIES)) {
      merged[k] = { ...merged[k], core: false };
    }
  }
  return merged;
}

/** 2-way key union of two quick.json objects, then cap-enforced.
 *  Result is guaranteed to satisfy validateQuickMemory (asserted in tests). */
export function mergeQuickMemory(ours, theirs) {
  const o = obj(ours), t = obj(theirs);
  const merged = {};
  for (const k of new Set([...Object.keys(o), ...Object.keys(t)])) {
    const a = o[k], b = t[k];
    if (a && b) merged[k] = ts(a) >= ts(b) ? a : b;        // newer ts wins; tie → ours
    else merged[k] = a || b;                                // present on one side only
  }
  return enforceCaps(merged);
}
