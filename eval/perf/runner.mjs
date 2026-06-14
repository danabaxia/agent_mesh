// eval/perf/runner.mjs — per-scenario trial loop (spec §3): build → drive → meter →
// judge → tear down. Produces { name, cell, samples } where each sample is one
// task-drive's flat metrics; the PerfCard (perfcard.mjs) aggregates them.
import { randomUUID } from 'node:crypto';
import * as harness from './harness.mjs';
import { runJudge } from './judge.mjs';
import { routing, efficiency, quality } from './meters.mjs';

const defaultMeters = () => [routing(), efficiency(), quality()];

// The API handed to a scenario's setup(): fixtures + plant + the meter set.
export const api = { ...harness, meters: { routing, efficiency, quality } };

/**
 * `budget` (shared across scenarios) is the §11 real-money safety rail: a mutable
 * `{ remaining }` counter of REAL claude invocations the runner initiates. Each task
 * costs 1 drive (which itself fans out to ≤ peers, bounded by the cell) + 1 judge; we
 * charge the actual count read from the run records + 1 for the judge. When it runs
 * out the loop aborts and records a `budget_exhausted` sample. Default: no cap.
 */
export async function runScenario(scenario, { trials = 5, claude, judgeClaude, timeoutMs = 180_000, budget = null, log = () => {} }) {
  const callApi = { ...api, claudeBin: claude };
  const samples = [];
  const exhausted = () => budget && budget.remaining <= 0;
  for (let trial = 0; trial < trials; trial++) {
    if (exhausted()) break;
    let mesh = null;
    try {
      const setup = await scenario.setup(callApi);
      mesh = setup.mesh;
      const driven = setup.driven || mesh.driven || 'A';
      const meterSet = setup.meters || defaultMeters();
      for (let ti = 0; ti < setup.tasks.length; ti++) {
        if (exhausted()) { samples.push({ scenario: scenario.name, trial, task: ti, budget_exhausted: 1 }); break; }
        const task = setup.tasks[ti];
        const [result] = await harness.driveAgent(mesh, driven, [{ task: task.prompt }], {
          claude, timeoutMs, callerTag: `perf-${scenario.name}-${trial}-${ti}-${randomUUID().slice(0, 4)}`
        });
        const runs = {};
        for (const name of Object.keys(mesh.agents)) runs[name] = await harness.readRuns(mesh.agents[name]);
        let judgeScore = null;
        try {
          ({ score: judgeScore } = await runJudge(
            { prompt: task.prompt, groundTruth: task.groundTruth, answer: result.answer },
            { claude: judgeClaude || claude, timeoutMs: Math.min(timeoutMs, 90_000) }
          ));
        } catch { judgeScore = null; }   // fail-closed: a null judge score, not a crash
        const ctx = { task: { ...task, driven }, result, runs, fixture: mesh, judgeScore };
        const sample = { scenario: scenario.name, trial, task: ti };
        for (const meter of meterSet) Object.assign(sample, meter.compute(ctx));
        samples.push(sample);
        if (budget) budget.remaining -= (Number.isFinite(sample.hops) ? sample.hops : 0) + 2; // root drive + fan-out + judge
      }
      log(`  ${scenario.name} trial ${trial}: ${setup.tasks.length} task(s)`);
    } catch (err) {
      samples.push({ scenario: scenario.name, trial, error: err.message });
      log(`  ${scenario.name} trial ${trial}: FAILED ${err.message}`);
    } finally {
      if (mesh) await harness.cleanupMesh(mesh).catch(() => {});
    }
  }
  return { name: scenario.name, cell: scenario.cell || null, samples };
}
