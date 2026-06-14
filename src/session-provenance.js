// src/session-provenance.js — shared session management-event store (moved
// verbatim from src/dashboard/session-index.js — 2026-06-13 spec §3: core
// delegate.js must tag framework spawns without importing dashboard code;
// session-index re-exports for back-compat). Events live under the runtime
// temp dir keyed by mesh root: <tmp>/agent-mesh/sessions/<hash>/events.jsonl.
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Provenance event log
// ---------------------------------------------------------------------------

const hash = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 24);
export function sessionsDir(meshRoot) {
  return join(tmpdir(), 'agent-mesh', 'sessions', hash(meshRoot));
}
function eventsPath(meshRoot) {
  return join(sessionsDir(meshRoot), 'events.jsonl');
}

/** Append one management event {kind:'create'|'select'|'open'|'rotate', source, ...}. */
export async function recordEvent(meshRoot, ev) {
  const p = eventsPath(meshRoot);
  await mkdir(dirname(p), { recursive: true });
  const rec = { at: ev.at ?? Date.now(), ...ev };
  await appendFile(p, JSON.stringify(rec) + '\n', { mode: 0o600 });
}

export async function readEvents(meshRoot) {
  try {
    const raw = await readFile(eventsPath(meshRoot), 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/**
 * originSource = source of the session's `create` or `rotate` event, else 'cli'
 * (`select`/`open` never change origin); lastManagedBy = most recent event's source.
 */
export function deriveProvenance(events, sessionId) {
  const mine = events.filter((e) => e.sessionId === sessionId);
  // `rotate` births the new generation exactly like `create` births a session
  // (spec 2026-06-12 §4.2) — either establishes origin.
  const create = mine.find((e) => e.kind === 'create' || e.kind === 'rotate');
  const last = mine.length ? mine.reduce((a, b) => (b.at >= a.at ? b : a)) : null;
  return { originSource: create ? create.source : 'cli', lastManagedBy: last ? last.source : null };
}
