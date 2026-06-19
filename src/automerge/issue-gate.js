// src/automerge/issue-gate.js — pure logic for gating a PR's merge on its linked
// issue's state. A PR whose linked issue is blocked/rejected/wontfix/duplicate gets a
// dedicated hold label (ISSUE_HOLD_LABEL) that the auto-merge gate (eligibility.js)
// honors. No I/O. Spec: docs/superpowers/specs/2026-06-19-issue-gates-pr-merge-design.md

// Owned EXCLUSIVELY by the issue-gate sweep — never a human-set hold label, so the sweep
// can add/remove it freely without clobbering manual do-not-merge/hold/wip.
export const ISSUE_HOLD_LABEL = 'blocked-by-issue';

// A linked issue in any of these states blocks its PR from merging.
export const DEFAULT_BLOCK_LABELS = ['blocked', 'rejected', 'wontfix', 'duplicate'];

/**
 * @param {string[][]} labelSets  label-name arrays, one per linked issue
 * @returns {boolean} true iff ANY linked issue carries ANY block label.
 *   No linked issues (empty / non-array) → false (the no-issue policy: allow).
 */
export function shouldHoldForIssues(labelSets, { blockLabels = DEFAULT_BLOCK_LABELS } = {}) {
  if (!Array.isArray(labelSets)) return false;
  return labelSets.some((labels) => Array.isArray(labels) && labels.some((l) => blockLabels.includes(l)));
}

/**
 * Idempotent action for the gate's OWN label only.
 * @param {string[]} prLabelNames  the PR's current label names
 * @param {boolean} shouldHold
 * @returns {'add'|'remove'|'none'}
 */
export function gateDecision(prLabelNames, shouldHold, { holdLabel = ISSUE_HOLD_LABEL } = {}) {
  const has = Array.isArray(prLabelNames) && prLabelNames.includes(holdLabel);
  if (shouldHold && !has) return 'add';
  if (!shouldHold && has) return 'remove';
  return 'none';
}
