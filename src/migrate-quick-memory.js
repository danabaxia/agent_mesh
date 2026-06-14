// src/migrate-quick-memory.js — one-time `learned.md` → `quick.json` migration
// (spec §5 Decision 2). PURE transform + a thin impure wrapper.
//
// Why this matters (the §5 cutover hazard): once `quick.json` exists,
// buildAgentRuntimePrompt switches from eager full-body memory injection to
// CORE-ONLY. So a naive migration that produced all-`core:false` entries would
// SILENTLY drop the agent's prior in-prompt memory. To honor "no agent silently
// loses prompt content," migrated entries are marked `core:true` (capped at
// MAX_CORE_ENTRIES) — what WAS eagerly injected stays eagerly injected — with the
// full item carried in `l1` so the core block renders it. A later ask-only Absorb
// refines core membership / generates better L0/L1.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readQuickMemory, writeQuickMemory,
  MAX_QUICK_ENTRIES, MAX_CORE_ENTRIES, MAX_FIELD_CHARS
} from './quick-memory.js';

/** Parse a `learned.md` blob into its list items (lines starting with "- "). */
export function parseLearned(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

/**
 * PURE: fold parsed learned items into a quick store. Feature-flagged — migrates
 * ONLY into an EMPTY store (never clobbers a live `quick.json`, since that is
 * authoritative once present, §5). Deterministic keys `learned-<n>`; the full item
 * goes to `value` AND `l1` (core renders l1), `l0` is the capped one-liner.
 * Returns { quick, migrated, skipped? }.
 */
export function migrateLearnedToQuick(existingQuick, learnedText, { now = () => new Date().toISOString() } = {}) {
  const quick = { ...(existingQuick || {}) };
  if (Object.keys(quick).length > 0) return { quick, migrated: 0, skipped: 'quick-not-empty' };

  const items = parseLearned(learnedText);
  let migrated = 0;
  let coreCount = 0;
  for (let i = 0; i < items.length && migrated < MAX_QUICK_ENTRIES; i++) {
    const key = `learned-${i + 1}`;
    if (key in quick) continue;
    const item = items[i];
    const at = now();
    const core = coreCount < MAX_CORE_ENTRIES;   // preserve prior eager-inject as core
    if (core) coreCount++;
    quick[key] = {
      l0: item.slice(0, MAX_FIELD_CHARS.l0),
      l1: item.slice(0, MAX_FIELD_CHARS.l1),
      value: item.slice(0, MAX_FIELD_CHARS.value),
      core,
      valid_from: at,
      valid_to: null,
      provenance: { source: 'learned.md', migrated_at: at },
      status: 'active'
    };
    migrated++;
  }
  return { quick, migrated };
}

/**
 * IMPURE: migrate `<root>/memory/learned.md` into `<root>/memory/quick.json` once.
 * No-op (skipped) when the store is already non-empty or there is no learned.md.
 * `learned.md` is left in place (read-only back-compat, §5). Failure-tolerant.
 */
export async function migrateAgentLearned(root, opts = {}) {
  const existing = await readQuickMemory(root);
  if (Object.keys(existing).length > 0) return { migrated: 0, skipped: 'already-migrated' };
  const learned = await readFile(join(root, 'memory', 'learned.md'), 'utf8').catch(() => '');
  if (!learned.trim()) return { migrated: 0, skipped: 'no-learned' };
  const { quick, migrated } = migrateLearnedToQuick(existing, learned, opts);
  if (migrated > 0) await writeQuickMemory(root, quick);
  return { migrated };
}
