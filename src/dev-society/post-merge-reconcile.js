// src/dev-society/post-merge-reconcile.js — pure planner for post-merge drift.
//
// When a coder PR ("Closes #N") merges, GitHub's keyword auto-close USUALLY closes
// issue #N. But it intermittently misses (observed on #183/#199), and nothing in the
// dev-society pipeline backstops it: planLabelRepair never touches `pr:in-review`, and
// the terminal sweep only acts on TERMINAL labels. So a done issue hangs OPEN with
// `pr:in-review` forever — a "stale = wrong" violation of the always-active invariant.
//
// This plans the reconciliation: an OPEN issue carrying `pr:in-review` whose closing PR
// has MERGED should be closed and have its in-flight labels cleared. Pure (no I/O) so the
// daemon builtin can apply it via gh; unit-testable with plain objects.

const IN_FLIGHT = ['pr:in-review', 'in-progress'];

const labelNames = (issue) => (issue?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

/**
 * @param {Array<{number:number,labels:Array}>} openIssues  open issues (with labels)
 * @param {Array<{number:number,closingIssuesReferences?:Array<{number:number}>}>} mergedPrs  merged PRs
 * @returns {Array<{issue:number, closingPr:number, removeLabels:string[]}>}
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
    // Scope to the stuck state: only reconcile an issue still flagged in-flight
    // (`pr:in-review`/`in-progress`). Don't touch issues a human deliberately reopened
    // without those labels.
    if (!labels.some((l) => IN_FLIGHT.includes(l))) continue;
    plan.push({
      issue: n,
      closingPr: closedBy.get(n),
      removeLabels: IN_FLIGHT.filter((l) => labels.includes(l)),
    });
  }
  return plan;
}
