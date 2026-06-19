// src/schedule/list-all.js
// Pure-ish mesh-wide aggregation of agent-level schedules. Reads each served
// agent's .agent/schedule.json (defs) + .agent-mesh/schedule-state.json (state)
// and merges them into one read-only list. Effectful deps are injected.
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readManifest } from '../builder/manifest.js';
import { describeCadence } from './schedule-cadence.js';
import { describeJob } from './run-now.js';

async function readJsonDefault(path, fallback) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

export async function listAllSchedules({ meshRoot, readManifestFn = readManifest, readJsonFn = readJsonDefault }) {
  const root = resolve(meshRoot);
  let manifest;
  try { manifest = await readManifestFn(root); } catch { return { jobs: [] }; }
  const agents = (Array.isArray(manifest?.agents) ? manifest.agents : [])
    .filter((a) => a && typeof a.name === 'string' && typeof a.root === 'string');
  const jobs = [];
  for (const a of agents) {
    const agentRoot = resolve(join(root, a.root));
    const defs = await readJsonFn(join(agentRoot, '.agent', 'schedule.json'), { jobs: [] });
    const state = await readJsonFn(join(agentRoot, '.agent-mesh', 'schedule-state.json'), {});
    for (const job of (Array.isArray(defs.jobs) ? defs.jobs : [])) {
      if (!job || typeof job.id !== 'string') continue;
      const e = (state && state[job.id]) || {};
      jobs.push({
        agent: a.name,
        id: job.id,
        name: job.name ?? job.id,
        description: describeJob(job),
        cadence: job.cadence ?? null,
        cadenceLabel: job.cadence ? describeCadence(job.cadence) : '',
        enabled: !!job.enabled,
        lastRunAt: e.lastRunAt ?? null,
        lastStatus: e.lastStatus ?? null,
        lastSummary: e.lastSummary ?? '',
        nextRunAt: e.nextRunAt ?? null,
        running: !!e.running,
        consecutiveFailures: e.consecutiveFailures ?? 0,
      });
    }
  }
  return { jobs };
}
