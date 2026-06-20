// src/merge-sweep/remediation.js — pure backstop state machine for ②. No I/O.
// Reads ①'s report (the desired-state source, re-derived each run) + a tracked
// state cache; proposes deduped escalation file/close actions with age-gate,
// delayed-close hysteresis, reopen backoff, cap, and human-ack. The runner commits
// state only after the gh action succeeds.

export const itemKey = (checkpoint, ref) => `${checkpoint}:${ref}`;
export const markerFor = (key) => `<!-- needs-human:${key} -->`;
export const MARKER_RE = /<!--\s*needs-human:([a-z0-9:#_-]+)\s*-->/i;

// What ② escalates: automerge PRs the fixers couldn't clear, and memory PRs needing a human.
export function ACTIONABLE(checkpoint, it) {
  if (checkpoint === 'automerge') return it.state === 'blocked' && String(it.detail || '').startsWith('not-clean:');
  if (checkpoint === 'memory-automerge') return it.state === 'needs-human';
  return false;
}

export function planRemediation({ report, prev = {}, ownIssues = {}, triagePrNums = new Set(), now, cfg }) {
  const { escalateAfter, hysteresisK, capPerRun, backoffBaseMs } = cfg;
  const iso = now.toISOString();
  const tNow = now.getTime();

  const stuck = new Map();
  for (const cp of (report.checkpoints || [])) {
    for (const it of (cp.items || [])) {
      if (ACTIONABLE(cp.name, it)) stuck.set(itemKey(cp.name, it.ref), { ...it, checkpoint: cp.name });
    }
  }

  const file = [], close = [], skip = [];
  const nextState = {};
  let filed = 0;

  for (const [key, it] of stuck) {
    const p = prev[key] || { state: 'watching', healthyStreak: 0, reopenCount: 0 };
    const own = ownIssues[key];

    if (own && own.open === false && p.state !== 'done') { nextState[key] = { ...p, state: 'acked', issueNumber: own.issueNumber }; continue; }
    if (p.state === 'acked') { nextState[key] = p; continue; }
    if (own && own.open) { nextState[key] = { ...p, state: 'escalated', issueNumber: own.issueNumber }; continue; }
    if (it.checkpoint === 'automerge' && Number.isInteger(it.number) && triagePrNums.has(it.number)) { nextState[key] = { ...p, state: 'escalated' }; continue; }
    if ((it.ageRuns || 1) < escalateAfter) { nextState[key] = { ...p, state: 'watching', healthyStreak: 0 }; continue; }
    if (p.state === 'done') {
      const reopenCount = (p.reopenCount || 0) + 1;
      nextState[key] = { ...p, state: 'cooldown', reopenCount, nextEligibleAt: new Date(tNow + backoffBaseMs * 2 ** reopenCount).toISOString(), healthyStreak: 0 };
      continue;
    }
    if (p.nextEligibleAt && tNow < Date.parse(p.nextEligibleAt)) { nextState[key] = { ...p, state: 'cooldown' }; continue; }
    if (filed >= capPerRun) { nextState[key] = { ...p, state: 'watching' }; continue; }
    file.push({ key, number: it.number, checkpoint: it.checkpoint, ref: it.ref, detail: it.detail });
    nextState[key] = { ...p, state: 'escalated', firstEscalatedAt: p.firstEscalatedAt || iso, healthyStreak: 0, nextEligibleAt: null };
    filed++;
  }

  for (const [key, p] of Object.entries(prev)) {
    if (stuck.has(key) || nextState[key]) continue;
    if (p.state === 'acked' || p.state === 'done') { nextState[key] = p; continue; }
    if (p.state === 'escalated') { nextState[key] = { ...p, state: 'cooldown', healthyStreak: 1 }; continue; }
    if (p.state === 'cooldown') {
      const hs = (p.healthyStreak || 1) + 1;
      const own = ownIssues[key];
      if (hs >= hysteresisK && p.issueNumber && !(own && own.exempt)) { close.push({ key, issueNumber: p.issueNumber }); nextState[key] = { ...p, state: 'done', healthyStreak: hs }; }
      else nextState[key] = { ...p, state: 'cooldown', healthyStreak: hs };
      continue;
    }
    nextState[key] = p;
  }

  return { file, close, skip, nextState };
}
