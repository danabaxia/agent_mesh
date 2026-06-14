/**
 * src/dashboard/public/follow-policy.js — PURE.
 * Which session should the canvas track? (2026-06-13 spec §4)
 *   pin > live USER session (grew since last poll) > sticky current-while-active
 *   > canonical > newest. peer:<x>/worker:<x> sessions are framework spawns and are
 * never auto-followed (reviewable by explicit click only).
 */
export function isUserOrigin(originSource) {
  const o = String(originSource || 'cli');
  return !(o.startsWith('peer:') || o.startsWith('worker:'));
}

export function followTarget(rows, { currentId, pinnedId, canonicalId, lastSeen }) {
  if (pinnedId && rows.some((r) => r.id === pinnedId)) return pinnedId;
  const current = rows.find((r) => r.id === currentId);
  // Sticky: never leave an actively-followed session (no flapping mid-thought).
  if (current && current.active) return currentId;
  // Live user session: grew since the previous poll, user-origin, most recent first.
  const grown = rows
    .filter((r) => isUserOrigin(r.originSource))
    .filter((r) => r.active && lastSeen[r.id] !== undefined && r.endedAt > lastSeen[r.id])
    .sort((a, b) => b.endedAt - a.endedAt);
  if (grown.length) return grown[0].id;
  if (current) return currentId; // quiet but still listed — hold position
  if (canonicalId && rows.some((r) => r.id === canonicalId)) return canonicalId;
  return rows.length ? rows.slice().sort((a, b) => b.endedAt - a.endedAt)[0].id : null;
}
