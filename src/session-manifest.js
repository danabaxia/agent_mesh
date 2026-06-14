// src/session-manifest.js — per-agent session manifest (spec §7).
// The structured document layer over the raw `~/.claude/projects/.../<uuid>.jsonl`
// transcripts: one `.agent-mesh/sessions/index.json` per agent (under the framework
// state dir → change-detection-excluded). Pure CRUD + projections; the dashboard
// reads it for the task-session list / resume-proposals, absorption updates it.
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const MANIFEST_REL = '.agent-mesh/sessions/index.json';
const manifestPath = (root) => join(root, MANIFEST_REL);
const VALID_STATUS = new Set(['active', 'archived']);

export function emptyManifest() { return { version: 1, sessions: [] }; }

export async function readManifest(root) {
  try {
    const obj = JSON.parse(await readFile(manifestPath(root), 'utf8'));
    if (obj && Array.isArray(obj.sessions)) return obj;
  } catch { /* absent/unreadable → empty */ }
  return emptyManifest();
}

/** Normalize one entry to the §7 shape (defensive; never throws). */
export function normalizeEntry(e) {
  return {
    id: String(e.id),
    task_label: e.task_label ?? null,            // derived post-hoc (§9); null until distilled
    l0: e.l0 ?? null,
    status: VALID_STATUS.has(e.status) ? e.status : 'active',
    origin: e.origin ?? 'cli',                   // cli | worker:<route> | peer:<caller> | dashboard
    headroom_pct: typeof e.headroom_pct === 'number' ? e.headroom_pct : null,
    produced_memory_keys: Array.isArray(e.produced_memory_keys) ? e.produced_memory_keys : [],
    produced_workflows: Array.isArray(e.produced_workflows) ? e.produced_workflows : [],
    run_ids: Array.isArray(e.run_ids) ? e.run_ids : [],
    updated_at: e.updated_at ?? new Date().toISOString()
  };
}

const MERGE_FIELDS = ['task_label', 'l0', 'status', 'origin', 'headroom_pct', 'produced_memory_keys', 'produced_workflows', 'run_ids'];

/** Upsert by id (pure). Insert → normalized; update → merge ONLY the fields the
 *  caller actually provided (so a partial update never clobbers existing fields
 *  with normalize-defaults), with a fresh updated_at. */
export function upsertSession(manifest, entry) {
  const id = String(entry.id);
  const sessions = manifest.sessions.slice();
  const i = sessions.findIndex((s) => s.id === id);
  if (i === -1) {
    sessions.push(normalizeEntry(entry));
  } else {
    const patch = {};
    for (const k of MERGE_FIELDS) if (entry[k] !== undefined) patch[k] = entry[k];
    sessions[i] = normalizeEntry({ ...sessions[i], ...patch, id, updated_at: new Date().toISOString() });
  }
  return { ...manifest, sessions };
}

/** Backfill discovered sessions WITHOUT clobbering existing (richer) entries —
 *  migration for an agent with months of transcripts (§7). Discovered default to
 *  archived/task_label:null; L0 is generated lazily/at next Absorb (§7/§9). Pure. */
export function backfill(manifest, discovered) {
  const known = new Set(manifest.sessions.map((s) => s.id));
  let m = manifest;
  for (const d of discovered) {
    if (known.has(String(d.id))) continue;       // never overwrite an existing entry
    m = upsertSession(m, { status: 'archived', task_label: null, ...d });
  }
  return m;
}

/** Mark a session archived (retired from the active working set — not deleted). */
export function archiveSession(manifest, id) {
  return upsertSession(manifest, { ...(manifest.sessions.find((s) => s.id === String(id)) || { id }), status: 'archived' });
}

export async function writeManifest(root, manifest) {
  const p = manifestPath(root);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await rename(tmp, p);
  return p;
}

/** Active (non-archived) session one-liners for the runtime prompt's L0 index. */
export function activeSessionIndex(manifest) {
  return (manifest.sessions || [])
    .filter((s) => s.status === 'active')
    .map((s) => ({ id: s.id, l0: s.l0, task_label: s.task_label }));
}
