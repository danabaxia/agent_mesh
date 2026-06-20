// Pure helpers for the Schedules panel's run-now + per-task description. No I/O.

const MAX_DESC = 200;

/**
 * Return a new schedule-state object with job `id` marked due now (the daemon's
 * next tick will run it, per its enabled && nextRunAt ≤ now rule). Clones — never
 * mutates the input. Creates the entry if absent.
 */
export function markJobDue(state, id, now = new Date()) {
  const base = (state && typeof state === 'object') ? state : {};
  const prev = (base[id] && typeof base[id] === 'object') ? base[id] : {};
  return { ...base, [id]: { ...prev, nextRunAt: now.toISOString(), running: false } };
}

function firstLine(s) {
  for (const line of String(s).split('\n')) { const t = line.trim(); if (t) return t; }
  return '';
}

/** A human description for a job: explicit `description`, else a delegate job's
 *  `prompt` first line, else ''. Trimmed + length-capped. */
export function describeJob(job) {
  if (!job || typeof job !== 'object') return '';
  const d = typeof job.description === 'string' ? job.description.trim() : '';
  const text = d || (job.prompt ? firstLine(job.prompt) : '');
  return text.slice(0, MAX_DESC);
}
