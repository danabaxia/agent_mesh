// src/dashboard/public/schedules-render.js — pure helpers for the cron-jobs
// (Schedules) view. Every cron job shows its description + last result; jobs that
// publish a structured report get an expandable inline detail.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Cron job ids that publish a structured report (expandable inline). Generic hook:
// add an id here + its render wiring in graph-view's REPORT_RENDERERS to extend.
export const SCHEDULE_REPORT_JOBS = new Set(['merge-sweep']);
export const jobHasReport = (id) => SCHEDULE_REPORT_JOBS.has(id);

// The per-job "last result" line (lastSummary + relative time), shown for EVERY
// cron job that has run. `rel` formats an ISO timestamp → "2m ago".
export function jobResultLine(job, rel = () => '') {
  if (!job || !job.lastSummary) return '';
  const when = job.lastRunAt ? ` · ${esc(rel(job.lastRunAt))}` : '';
  const cls = job.lastStatus === 'fail' ? 'sched-result fail' : 'sched-result';
  return `<div class="${cls}" title="${esc(job.lastSummary)}">${esc(job.lastSummary)}${when}</div>`;
}
