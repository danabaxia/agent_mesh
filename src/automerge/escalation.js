// src/automerge/escalation.js — pure logic for surfacing stale-STUCK PRs as needs-triage
// issues, so a PR past automated recovery never hangs invisibly. No I/O.
// Spec: docs/superpowers/specs/2026-06-19-mesh-self-healing-gaps-design.md

const names = (labels) => (Array.isArray(labels) ? labels : []).map((l) => (typeof l === 'string' ? l : (l && l.name) || '')).filter(Boolean);

// mergeStateStatus values that no merge/repair path resolves on its own once they linger.
// Deliberately EXCLUDES: CLEAN+APPROVED (auto-merges), BLOCKED (intentional hold, e.g.
// blocked-by-issue), BEHIND (mergefix re-bases it).
function isStuckState(pr) {
  const ms = pr.mergeStateStatus, rd = pr.reviewDecision;
  if (ms === 'DIRTY' || ms === 'UNKNOWN' || ms === 'UNSTABLE') return true;  // conflict / unresolved / failing checks
  if (rd === 'CHANGES_REQUESTED') return true;                                // review feedback unaddressed
  if (ms === 'CLEAN' && rd !== 'APPROVED') return true;                       // green but never approved (no-review orphan)
  return false;
}

/**
 * @param {object} pr  gh json row: {number,isDraft,isCrossRepository,mergeStateStatus,reviewDecision,updatedAt,labels}
 * @param {{now:number, staleMs:number}} opts
 * @returns {boolean} true iff the PR is open, non-draft, same-repo, not memory:promote,
 *   in a stuck state, and hasn't moved within staleMs (so repair loops had their chance).
 */
export function prNeedsEscalation(pr, { now, staleMs }) {
  if (!pr || typeof pr !== 'object') return false;
  if (pr.isDraft !== false || pr.isCrossRepository !== false) return false;
  if (names(pr.labels).includes('memory:promote')) return false;
  if (!isStuckState(pr)) return false;
  const updated = Date.parse(pr.updatedAt || '') || 0;
  return (now - updated) > staleMs;
}

/** Dedup-stable issue title for a stuck PR (one escalation issue per PR). */
export function escalationTitle(pr) {
  return `needs-triage: PR #${pr.number} stuck (${pr.mergeStateStatus || '?'})`;
}

/** Extract the PR number from an escalation/janitor title ("… PR #N …"), or null. */
export function parsePrNumber(title) {
  const m = String(title || '').match(/PR #(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Context-rich body so a human/triager can act without spelunking. */
export function escalationBody(pr) {
  return [
    '🤖 dev-mesh escalation: this PR is past automated recovery (repair loops are bounded to 2 attempts) and is not auto-mergeable.',
    '',
    `- PR: ${pr.url || '#' + pr.number}`,
    `- merge state: \`${pr.mergeStateStatus || '?'}\``,
    `- review: \`${pr.reviewDecision || 'none'}\``,
    `- title: ${pr.title || ''}`,
    '',
    'Needs a human (or re-label/close). This issue auto-closes once the PR is no longer stuck.',
  ].join('\n');
}
