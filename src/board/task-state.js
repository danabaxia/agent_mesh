// src/board/task-state.js — PURE task lifecycle state machine (no I/O).
// v1 minimal lifecycle: assigned → acknowledged → in-progress → done.
// Modeled on src/dev-mesh/backlog.js: derive/validate/mutation only; the
// caller (src/board/store.js) performs all reads and writes.

export const STATES = Object.freeze({
  ASSIGNED: 'assigned',
  ACKNOWLEDGED: 'acknowledged',
  IN_PROGRESS: 'in-progress',
  DONE: 'done'
});

// Forward, single-step order. Index+1 is the only legal next state.
export const ORDER = Object.freeze([
  STATES.ASSIGNED, STATES.ACKNOWLEDGED, STATES.IN_PROGRESS, STATES.DONE
]);

export function isValidTransition(from, to) {
  const i = ORDER.indexOf(from);
  const j = ORDER.indexOf(to);
  if (i < 0 || j < 0) return false;
  return j === i + 1;
}

// Identity rule: only the task's `to` agent may advance it. `from` (the
// assigner) can read but never self-advance B's task. Returns data, not throws.
export function canAdvance(task, callerName) {
  if (!task || typeof task !== 'object') return { ok: false, error: 'no_task' };
  if (typeof callerName !== 'string' || callerName.length === 0) return { ok: false, error: 'no_caller' };
  if (callerName !== task.to) return { ok: false, error: 'not_assignee' };
  return { ok: true };
}

// Build the next record (immutably) for a transition. Returns
// { ok:true, task } or { ok:false, error }. Does NOT check the caller — call
// canAdvance() first; this keeps the lifecycle rule and the identity rule
// independently testable.
export function applyTransition(task, { to, by, at, result }) {
  if (!isValidTransition(task.state, to)) {
    return { ok: false, error: 'invalid_transition' };
  }
  const history = Array.isArray(task.history) ? task.history.slice() : [];
  history.push({ state: to, at, by });
  const next = { ...task, state: to, history };
  if (to === STATES.DONE && result !== undefined) next.result = result;
  return { ok: true, task: next };
}
