// src/dev-mesh/backlog.js — PURE backlog state machine (spec 2026-06-14 §5.4/§5.5).
// The authoritative to-do list is GitHub Issues; their labels encode exactly one
// lifecycle state. This module derives state, validates transitions, and selects
// claimable (ready) tasks — deterministically, so the watch loop's pickup is
// unit-provable. It NEVER calls GitHub; callers apply the returned mutations.

export const STATES = Object.freeze({
  IDEA: 'idea',
  DISCUSSING: 'discussing',
  SPEC_DRAFT: 'spec:draft',
  SPEC_IN_REVIEW: 'spec:in-review',
  APPROVED: 'approved',            // == ready to claim
  IN_PROGRESS: 'in-progress',
  PR_IN_REVIEW: 'pr:in-review',
  DONE: 'done',
  BLOCKED: 'blocked',
  REJECTED: 'rejected'
});

// Input aliases normalized to the canonical label.
const ALIASES = { ready: STATES.APPROVED };

// Main-path ordering — for ambiguity resolution, the furthest-along label wins.
const MAIN_PATH = [
  STATES.IDEA, STATES.DISCUSSING, STATES.SPEC_DRAFT, STATES.SPEC_IN_REVIEW,
  STATES.APPROVED, STATES.IN_PROGRESS, STATES.PR_IN_REVIEW, STATES.DONE
];
const ALL_STATES = new Set([...MAIN_PATH, STATES.BLOCKED, STATES.REJECTED]);

const TRANSITIONS = Object.freeze({
  [STATES.IDEA]: [STATES.DISCUSSING, STATES.REJECTED],
  [STATES.DISCUSSING]: [STATES.SPEC_DRAFT, STATES.REJECTED],
  [STATES.SPEC_DRAFT]: [STATES.SPEC_IN_REVIEW, STATES.REJECTED],
  [STATES.SPEC_IN_REVIEW]: [STATES.APPROVED, STATES.SPEC_DRAFT, STATES.REJECTED],
  [STATES.APPROVED]: [STATES.IN_PROGRESS, STATES.BLOCKED, STATES.REJECTED],
  [STATES.IN_PROGRESS]: [STATES.PR_IN_REVIEW, STATES.BLOCKED],
  [STATES.PR_IN_REVIEW]: [STATES.DONE, STATES.IN_PROGRESS, STATES.BLOCKED],
  [STATES.BLOCKED]: [STATES.IN_PROGRESS, STATES.APPROVED, STATES.REJECTED],
  [STATES.DONE]: [],
  [STATES.REJECTED]: []
});

const labelsOf = (issue) =>
  (issue?.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);

const assigneesOf = (issue) => {
  const a = issue?.assignees || (issue?.assignee ? [issue.assignee] : []);
  return a.map((x) => (typeof x === 'string' ? x : x?.login)).filter(Boolean);
};

const norm = (label) => ALIASES[label] || label;

/**
 * The single lifecycle state of an issue, or null if none. Exception states
 * (rejected > blocked) win; otherwise the furthest-along main-path label wins.
 */
export function deriveState(issue) {
  const present = new Set(labelsOf(issue).map(norm).filter((l) => ALL_STATES.has(l)));
  if (present.has(STATES.REJECTED)) return STATES.REJECTED;
  if (present.has(STATES.BLOCKED)) return STATES.BLOCKED;
  let state = null;
  for (const s of MAIN_PATH) if (present.has(s)) state = s;
  return state;
}

/** Claimed = in-progress, or already assigned to someone. */
export function isClaimed(issue) {
  return deriveState(issue) === STATES.IN_PROGRESS || assigneesOf(issue).length > 0;
}

/** Ready = approved AND unclaimed (no assignee, not in-progress). */
export function isReady(issue) {
  return deriveState(issue) === STATES.APPROVED && !isClaimed(issue);
}

/** Claimable tasks, sorted by issue number (FIFO). */
export function selectReady(issues = []) {
  return issues.filter(isReady).sort((a, b) => (a.number || 0) - (b.number || 0));
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Validate + return the target state, or throw on an illegal transition. */
export function nextState(from, to) {
  if (!canTransition(from, to)) {
    throw Object.assign(new Error(`illegal backlog transition ${from} -> ${to}`), { code: 'bad_transition' });
  }
  return to;
}

/**
 * PURE claim plan: the label/assignee mutation to atomically take an approved
 * task (the assignee is the lock — spec §9). Returns null if the issue is not
 * ready, so a double-tick can't produce a second claim.
 */
export function planClaim(issue, assignee) {
  if (!isReady(issue)) return null;
  nextState(STATES.APPROVED, STATES.IN_PROGRESS); // assert the transition is legal
  return {
    number: issue.number,
    addLabels: [STATES.IN_PROGRESS],
    removeLabels: [STATES.APPROVED],
    addAssignee: assignee ?? null
  };
}

/** Count issues per state (for the backlog.md mirror / dashboard). */
export function summarize(issues = []) {
  const counts = {};
  for (const issue of issues) {
    const s = deriveState(issue) || 'unknown';
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}
