// Pure: decide whether one open PR is safe to auto-merge. Fail-closed — any
// missing/unknown field or disqualifier → false. No I/O.
// 'blocked-by-issue' is stamped by the issue-gate sweep (src/automerge/issue-gate.js)
// when a PR's linked issue is blocked/rejected/wontfix/duplicate — honored here so such
// a PR never auto-merges.
export const DEFAULT_HOLD_LABELS = ['do-not-merge', 'hold', 'wip', 'blocked-by-issue'];

/**
 * @param {object} pr  one `gh pr list/view --json` row:
 *   { isDraft, isCrossRepository, mergeStateStatus, reviewDecision, labels:[{name}] }
 * @param {{holdLabels?:string[]}} [opts]
 * @returns {boolean} true iff safe to auto-merge
 */
export function isAutoMergeable(pr, { holdLabels = DEFAULT_HOLD_LABELS } = {}) {
  if (!pr || typeof pr !== 'object') return false;
  if (pr.isDraft !== false) return false;              // missing/true/garbage → not mergeable
  if (pr.isCrossRepository !== false) return false;   // missing/true/garbage → not mergeable (never forks)
  if (pr.mergeStateStatus !== 'CLEAN') return false;   // mergeable + checks green + up-to-date
  if (pr.reviewDecision !== 'APPROVED') return false;  // explicit approval required
  const names = Array.isArray(pr.labels)
    ? pr.labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || ''))
    : [];
  if (names.some((n) => holdLabels.includes(n))) return false;
  return true;
}
