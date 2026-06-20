// src/mesh-improvement/baseline-restore.js — pure CI baseline-selection planner.
// A failed nightly is exactly where hard findings live, so we DO NOT gate on conclusion.
export function selectBaselineRun(runs) {
  const withMir = (runs ?? []).filter((r) => r.hasMir);
  if (!withMir.length) return null;
  return withMir.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}
