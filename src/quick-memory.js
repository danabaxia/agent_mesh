// src/quick-memory.js — structured quick-recall memory store.
// Spec: docs/superpowers/specs/2026-06-13-single-agent-session-management-design.md §8.
//
// Replaces the prose `memory/learned.md` blob with `memory/quick.json` — a keyed,
// L0/L1/L2-tiered, hard-capped, bi-temporal store. Pure data layer: read/validate/
// write + the projections (index, core, recall) the runtime prompt and the recall
// verb consume. Writes are atomic and validated; over-cap → throw (fail-closed).
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const QUICK_MEMORY_REL = 'memory/quick.json';
// Hard caps (the structure layer must never re-bloat the conversation, §1/§5).
export const MAX_QUICK_ENTRIES = 200;     // total keyed entries
export const MAX_CORE_ENTRIES = 20;       // always-resident "core" entries (§5)
export const MAX_FIELD_CHARS = { l0: 120, l1: 600, value: 4000 };

const quickPath = (root) => join(root, QUICK_MEMORY_REL);

/** Read the store (or {} when absent/unreadable — degrade, never throw). */
export async function readQuickMemory(root) {
  try {
    const obj = JSON.parse(await readFile(quickPath(root), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch { return {}; }
}

/** Live = active AND not bi-temporally expired (valid_to null). Only live entries
 *  are ever injected or recalled (§6/§10). */
export function isLive(entry) {
  return Boolean(entry) && entry.status === 'active' && (entry.valid_to == null);
}

/** The always-injected L0 index: { key: l0 } for every LIVE entry. The key IS the
 *  recall handle (the index advertises what exists + the exact key, §6). */
export function memoryIndex(quick) {
  const out = {};
  for (const [k, e] of Object.entries(quick || {})) if (isLive(e)) out[k] = e.l0 ?? '';
  return out;
}

/** Core memory: { key: {l0, l1} } for LIVE entries flagged `core` — the only
 *  bodies eagerly injected into the runtime prompt (§5). */
export function coreMemory(quick) {
  const out = {};
  for (const [k, e] of Object.entries(quick || {})) if (isLive(e) && e.core) out[k] = { l0: e.l0 ?? '', l1: e.l1 ?? '' };
  return out;
}

/** Recall one entry's full value + provenance (L2). null when absent/not live —
 *  a retired/expired entry is genuinely un-recallable (no ghost injection, §6). */
export function recall(quick, key) {
  const e = quick?.[key];
  if (!isLive(e)) return null;
  return { value: e.value ?? null, l1: e.l1 ?? null, provenance: e.provenance ?? null };
}

/** Validate shape + enforce hard caps. Throws on violation (fail-closed). */
export function validateQuickMemory(quick) {
  if (!quick || typeof quick !== 'object' || Array.isArray(quick)) throw new Error('quick.json: not an object');
  const entries = Object.entries(quick);
  if (entries.length > MAX_QUICK_ENTRIES) throw new Error(`quick.json: ${entries.length} entries exceeds cap ${MAX_QUICK_ENTRIES}`);
  let core = 0;
  for (const [k, e] of entries) {
    if (!e || typeof e !== 'object') throw new Error(`quick.json: entry "${k}" is not an object`);
    for (const [field, cap] of Object.entries(MAX_FIELD_CHARS)) {
      const v = e[field];
      if (typeof v === 'string' && v.length > cap) throw new Error(`quick.json: "${k}".${field} exceeds ${cap} chars`);
    }
    if (e.core && isLive(e)) core++;
  }
  if (core > MAX_CORE_ENTRIES) throw new Error(`quick.json: ${core} live core entries exceeds cap ${MAX_CORE_ENTRIES}`);
  return quick;
}

/** Atomic, validated write (temp + rename) to `<root>/memory/quick.json`. */
export async function writeQuickMemory(root, quick) {
  validateQuickMemory(quick);
  const p = quickPath(root);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(quick, null, 2) + '\n', 'utf8');
  await rename(tmp, p);
  return p;
}

/** Real delete — remove the entry entirely, no tombstone (§6 real-deletes). */
export function deleteEntry(quick, key) {
  const next = { ...quick };
  delete next[key];
  return next;
}

/** Bi-temporal supersede — mark expired (`valid_to` set), KEEP for history (§10).
 *  expired ≠ retired: expired keeps the record, a delete removes it. */
export function expireEntry(quick, key, at = new Date().toISOString()) {
  if (!quick?.[key]) return quick;
  return { ...quick, [key]: { ...quick[key], valid_to: at } };
}
