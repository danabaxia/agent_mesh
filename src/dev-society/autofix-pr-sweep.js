// src/dev-society/autofix-pr-sweep.js — pure planner for stale bug-autofix PRs.
//
// PR #215's bug-autofix gate lets a `bug`-labeled issue bypass human review and route
// straight to the coder, which opens a PR and moves the issue to `pr:in-review`. But if
// that PR is later closed WITHOUT merging (abandoned / wrong fix / conflicts), nothing
// re-routes the issue — it hangs at `pr:in-review` forever, the feedback loop the gate
// opened left dangling. (routeFor hard-gates `pr:in-review`; the post-merge reconciler
// only acts on MERGED PRs.)
//
// This plans the escalation: a `bug` + `pr:in-review` OPEN issue whose closing PR has been
// closed-without-merge should drop `pr:in-review`, gain `blocked`, and get re-triaged by a
// human. Pure (no I/O) so the daemon builtin can apply it via gh; unit-testable with plain
// objects. Symmetric with planPostMergeReconcile, scoped to the bug-autofix loop only.

const BUG = 'bug';
const PR_IN_REVIEW = 'pr:in-review';
const BLOCKED = 'blocked';

const labelNames = (issue) => (issue?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

/**
 * @param {Array<{number:number,labels:Array}>} openIssues  open issues (with labels)
 * @param {Array<{number:number,closingIssuesReferences?:Array<{number:number}>}>} closedPrs
 *        PRs closed WITHOUT merging (caller filters via `gh pr list --state closed`)
 * @param {{openPrIssues?:Set<number>}} [opts]  issue numbers that still have an OPEN PR →
 *        skip (the coder reopened/retried; the issue isn't actually abandoned)
 * @returns {Array<{issue:number, closedPr:number, removeLabels:string[], addLabels:string[]}>}
 */
export function planAutofixPrSweep(openIssues, closedPrs, { openPrIssues = new Set() } = {}) {
  // Map each issue number → the closed-unmerged PR that closes it (from "Closes #N").
  const closedBy = new Map();
  for (const pr of closedPrs || []) {
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
    // Don't re-escalate an issue a human already parked; don't blame an issue whose coder
    // has an open retry PR in flight.
    if (openPrIssues.has(n)) continue;
    const labels = labelNames(iss);
    if (labels.includes(BLOCKED)) continue;
    // Scope to the bug-autofix loop: only a `bug` still flagged `pr:in-review` is the open
    // feedback loop PR #215 created. enhancement/idea/documentation still require approval.
    if (!labels.includes(BUG) || !labels.includes(PR_IN_REVIEW)) continue;
    plan.push({ issue: n, closedPr: closedBy.get(n), removeLabels: [PR_IN_REVIEW], addLabels: [BLOCKED] });
  }
  return plan;
}
