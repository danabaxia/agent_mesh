// src/dev-society/post-merge-reconcile.js — pure planner for post-merge drift.
//
// When a coder PR ("Closes #N") merges, GitHub's keyword auto-close USUALLY closes
// issue #N. But it intermittently misses (observed on #183/#199), and nothing in the
// dev-society pipeline backstops it: planLabelRepair never touches `pr:in-review`, and
// the terminal sweep only acts on TERMINAL labels. So a done issue hangs OPEN with
// `pr:in-review` forever — a "stale = wrong" violation of the always-active invariant.
//
// This plans the reconciliation: an OPEN issue carrying a live state label whose closing PR
// has MERGED should be closed, gain `done`, and have its stale state labels cleared. Pure
// (no I/O) so the daemon builtin can apply it via gh; unit-testable with plain objects.

const IN_FLIGHT = ['pr:in-review', 'in-progress'];
// `approved` issues whose closing PR merged without ever being claimed `in-progress` are
// orphans too (#248/#251): GitHub's keyword auto-close missed and no in-flight label was set,
// so the in-flight-only backstop skipped them. Treat `approved` as a reconcilable state.
const APPROVED = 'approved';
const RECONCILE_STATES = [...IN_FLIGHT, APPROVED];
const DONE = 'done';

const labelNames = (issue) => (issue?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

/**
 * @param {Array<{number:number,labels:Array}>} openIssues  open issues (with labels)
 * @param {Array<{number:number,closingIssuesReferences?:Array<{number:number}>}>} mergedPrs  merged PRs
 * @returns {Array<{issue:number, closingPr:number, removeLabels:string[], addLabel:string}>}
 */
export function planPostMergeReconcile(openIssues, mergedPrs) {
  // Map each issue number → the merged PR that closes it (from the PR's "Closes #N" link).
  const closedBy = new Map();
  for (const pr of mergedPrs || []) {
    if (typeof pr?.number !== 'number') continue;
    for (const ref of (pr.closingIssuesReferences || [])) {
      if (ref && typeof ref.number === 'number' && !closedBy.has(ref.number)) {
        closedBy.set(ref.number, pr.number);
      }
    }
  }
  const plan = [];
  for (const iss of openIssues || []) {
    const n = iss?.number;
    if (typeof n !== 'number' || !closedBy.has(n)) continue;
    const labels = labelNames(iss);
    // Scope to a live state: only reconcile an issue still flagged in-flight
    // (`pr:in-review`/`in-progress`) or `approved`. Don't touch issues a human deliberately
    // reopened without any of those state labels.
    if (!labels.some((l) => RECONCILE_STATES.includes(l))) continue;
    plan.push({
      issue: n,
      closingPr: closedBy.get(n),
      removeLabels: RECONCILE_STATES.filter((l) => labels.includes(l)),
      addLabel: DONE,
    });
  }
  return plan;
}
