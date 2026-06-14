import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_LOG_DIR } from './config.js';

/**
 * Run logs are GROUPED BY DATE: all runs on the same day for an agent share one
 * newline-delimited JSON file `<logdir>/<prefix>-YYYY-MM-DD.jsonl`. Each run
 * appends a START record and a FINAL record (same `id`); readers dedup by id
 * (last wins). Appends are serialized per-path within a process and kept compact
 * so cross-process appends stay atomic (POSIX O_APPEND).
 */

function logDirFor(root, env) {
  return resolve(root, (env && env.AGENT_MESH_LOG_DIR) || DEFAULT_LOG_DIR);
}

/**
 * Ensure the log dir and return { logPath, runId }:
 *   logPath — the per-date grouped file the run appends to,
 *   runId   — a unique id for this run (start + final records share it).
 * The date is fixed at start, so a run that crosses midnight still lands its
 * start + final in the same (start-date) file.
 */
export async function createRunLog(root, env, prefix = 'delegate') {
  const dir = logDirFor(root, env);
  await mkdir(dir, { recursive: true });
  const iso = new Date().toISOString();           // 2026-06-06T23:10:00.000Z
  const date = iso.slice(0, 10);                   // 2026-06-06
  const stamp = iso.replace(/[:.]/g, '-');
  const random = Math.random().toString(16).slice(2, 10);
  return {
    logPath: join(dir, `${prefix}-${date}.jsonl`),
    runId: `${prefix}-${stamp}-${random}`
  };
}

// Per-path append serialization (within this process) so concurrent runs in one
// server never interleave a partial line; across processes O_APPEND + compact
// records keep each line atomic.
const _appendChains = new Map();

export function appendRunLog(logPath, record) {
  const line = JSON.stringify(record) + '\n';
  const prev = _appendChains.get(logPath) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => appendFile(logPath, line, 'utf8'));
  _appendChains.set(logPath, next);
  return next;
}

/**
 * Read all records from a grouped log file. Robust to both the new NDJSON format
 * and any legacy single pretty-printed JSON object.
 * @returns {Promise<object[]>}
 */
export async function readRunLogRecords(logPath) {
  let raw;
  try { raw = await readFile(logPath, 'utf8'); } catch { return []; }
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Legacy: a single pretty-printed object (or array) spanning multiple lines.
  try {
    const whole = JSON.parse(trimmed);
    if (Array.isArray(whole)) return whole;
    if (whole && typeof whole === 'object') return [whole];
  } catch { /* not a single value → NDJSON */ }
  const out = [];
  for (const line of trimmed.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* skip a partial/corrupt line */ }
  }
  return out;
}

/**
 * Collapse start+final records to one per run id (last write wins). Records
 * without an id (legacy) are kept as-is.
 * @param {object[]} records
 * @returns {object[]}
 */
export function dedupeRunRecords(records) {
  const byId = new Map();
  const out = [];
  for (const r of records) {
    if (r && r.id) byId.set(r.id, r);
    else out.push(r);
  }
  return [...out, ...byId.values()];
}
