// Pure: decide whether one open PR is safe to auto-merge. Fail-closed — any
// missing/unknown field or disqualifier → false. No I/O.
// 'blocked-by-issue' is stamped by the issue-gate sweep (src/automerge/issue-gate.js)
// when a PR's linked issue is blocked/rejected/wontfix/duplicate — honored here so such
// a PR never auto-merges.
export const DEFAULT_HOLD_LABELS = ['do-not-merge', 'hold', 'wip', 'blocked-by-issue'];

const HOLD_LABELS_NO_GATE = DEFAULT_HOLD_LABELS.filter((l) => l !== 'blocked-by-issue');

function prLabelNames(pr) {
  return Array.isArray(pr?.labels)
    ? pr.labels.map((l) => (typeof l === 'string' ? l : (l && l.name) || ''))
    : [];
}

/**
 * @param {object} pr  a gh pr row with a numeric `number`
 * @param {{holdLabels?:string[], gate:{held:Set<number>,cleared:Set<number>,ok:boolean}}} opts
 * @returns {{state:string, reason:string|null}}
 */
export function classifyAutomergePr(pr, { holdLabels = HOLD_LABELS_NO_GATE, gate } = {}) {
  if (!pr || typeof pr !== 'object') return { state: 'blocked', reason: 'no-pr' };
  const names = prLabelNames(pr);
  const gated = gate?.held?.has(pr.number) ? true
              : gate?.cleared?.has(pr.number) ? false
              : names.includes('blocked-by-issue');
  if (gated) return { state: 'blocked', reason: 'pending-issue-gate' };
  if (pr.isDraft !== false) return { state: 'blocked', reason: 'draft' };
  if (pr.isCrossRepository !== false) return { state: 'blocked', reason: 'fork' };
  if (pr.mergeStateStatus !== 'CLEAN') return { state: 'blocked', reason: `not-clean:${pr.mergeStateStatus}` };
  if (pr.reviewDecision !== 'APPROVED') return { state: 'blocked', reason: `not-approved:${pr.reviewDecision}` };
  const hold = names.find((n) => holdLabels.includes(n));
  if (hold) return { state: 'held', reason: hold };
  if (!gate?.ok) return { state: 'blocked', reason: 'gate-unknown' };
  return { state: 'would-merge', reason: null };
}

/**
 * @param {object} pr  one `gh pr list/view --json` row:
 *   { isDraft, isCrossRepository, mergeStateStatus, reviewDecision, labels:[{name}] }
 * @param {{holdLabels?:string[]}} [opts]
 * @returns {boolean} true iff safe to auto-merge
 */
export function isAutoMergeable(pr, { holdLabels = DEFAULT_HOLD_LABELS } = {}) {
  if (Array.isArray(pr?.labels) && prLabelNames(pr).includes('blocked-by-issue')) return false;
  return classifyAutomergePr(pr, { holdLabels: holdLabels.filter((l) => l !== 'blocked-by-issue'),
    gate: { held: new Set(), cleared: new Set(), ok: true } }).state === 'would-merge';
}
