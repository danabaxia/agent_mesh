#!/usr/bin/env node
// scripts/dev-mesh-health.mjs — the Dev-mesh health probe (used by
// .github/workflows/dev-mesh-health.yml, runnable locally).
//
// Two honest signals (NOT "is the CI job green?", which masks errored runs):
//   1. Conformance: run the framework's own `doctor --apply` on dev-mesh and
//      surface any `flagged` wiring drift (registry/peer-bridge/manifest).
//   2. Canary: read the dogfood run's result envelope(s) (dogfood-run.json) and
//      classify is_error / cost / turns — the only way to catch a green-but-no-op
//      model run (the 2026-06-14 [1m]-model bug).
//
// Usage: node scripts/dev-mesh-health.mjs [envelope.json ...]
// Exits non-zero when the mesh is unhealthy, so the monitor job goes red for real.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../src/builder/doctor.js';
import { assessMesh, renderHealthReport } from '../src/dev-mesh/health.js';

// AGENT_MESH_DEV_ROOT lets CI/tests point at a materialized copy instead of the
// committed dev-mesh/ (doctor --apply writes per-env registries; we don't pollute
// the source tree).
const meshRoot = process.env.AGENT_MESH_DEV_ROOT || fileURLToPath(new URL('../dev-mesh/', import.meta.url));

async function conformanceFlags() {
  try {
    const report = await doctor(meshRoot, { apply: true });
    return report.flagged ?? [];
  } catch (e) {
    return [`doctor failed to run: ${e.message}`];
  }
}

function readEnvelopes(paths) {
  const runs = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      console.warn(`note: probe envelope not found, skipping: ${p}`);
      continue;
    }
    try {
      runs.push({ name: basename(p), envelope: JSON.parse(readFileSync(p, 'utf8')) });
    } catch {
      runs.push({ name: basename(p), envelope: null }); // unparseable ⇒ unknown ⇒ unhealthy
    }
  }
  return runs;
}

const runs = readEnvelopes(process.argv.slice(2));
const flags = await conformanceFlags();
const assessment = assessMesh({ runs, conformanceFlags: flags });
const report = renderHealthReport(assessment);

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) {
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n'); } catch { /* best-effort */ }
}
if (!assessment.healthy) {
  console.error(`::warning::Dev-mesh unhealthy — ${assessment.summary}`);
  process.exit(1);
}
console.log('Dev-mesh healthy.');
