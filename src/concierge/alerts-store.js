/**
 * Atomic alerts store for the concierge over-the-loop monitor.
 * Single rolling file <mesh-root>/mesh/alerts/alerts.json, single-writer (the sweep).
 *
 * Spec: docs/superpowers/specs/2026-06-21-concierge-mesh-agent-design.md
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const MAX_ALERTS = 200;
const rel = (meshRoot) => join(meshRoot, 'mesh', 'alerts', 'alerts.json');

/** Tolerant read: missing/corrupt → { alerts: [], updatedAt: null }. */
export async function readAlerts(meshRoot) {
  try {
    const data = JSON.parse(await readFile(rel(meshRoot), 'utf8'));
    return { alerts: Array.isArray(data.alerts) ? data.alerts : [], updatedAt: data.updatedAt ?? null };
  } catch { return { alerts: [], updatedAt: null }; }
}

/**
 * Upsert open findings by stable id (preserve firstSeen + acknowledged), drop alerts
 * whose id is no longer present (resolved), bound the list, write atomically.
 * @returns {Promise<Array>} the new alert list
 */
export async function syncAlerts(meshRoot, findings, now) {
  const prev = (await readAlerts(meshRoot)).alerts;
  const prevById = new Map(prev.map((a) => [a.id, a]));
  const list = (Array.isArray(findings) ? findings : []).map((f) => {
    const old = prevById.get(f.id);
    return { ...f, firstSeen: old?.firstSeen ?? now, lastSeen: now, acknowledged: old?.acknowledged ?? false };
  }).slice(0, MAX_ALERTS);
  const file = rel(meshRoot);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ alerts: list, updatedAt: now }, null, 2), 'utf8');
  await rename(tmp, file);   // atomic replace
  return list;
}
