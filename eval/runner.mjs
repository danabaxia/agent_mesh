// eval/runner.mjs — per-scenario trial loop (spec §3, §6).
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as harness from './harness.mjs';
import { probe } from './probes.mjs';

// The API handed to scenario setup()/run() — everything a scenario may use.
export const api = { ...harness, probe };

export async function runScenario(scenario, { trials = 3, claude, timeoutMs = 180_000, outDir, log = () => {} }) {
  // Per-call api: never mutate the shared export (parallel/repeat calls would race).
  const callApi = { ...api, claudeBin: claude };
  // Custom-run scenarios (e.g. 04 roster A/B) own their whole loop.
  if (typeof scenario.run === 'function') {
    try {
      return await scenario.run(callApi, { trials, claude, timeoutMs, outDir, log });
    } catch (err) {
      return { name: scenario.name, trials: [{ trial: 0, pass: false, probes: [{ name: 'harness', pass: false, detail: err.message }], durationMs: 0 }] };
    }
  }
  const trialReports = [];
  for (let trial = 0; trial < trials; trial++) {
    const t0 = Date.now();
    let setup = null;
    let trialReport;
    try {
      setup = await scenario.setup(callApi);
      const results = await harness.driveAgent(setup.mesh, setup.driven, setup.turns, {
        claude, timeoutMs, agentEnv: setup.agentEnv || {},
        callerTag: `eval-${scenario.name}-${trial}`
      });
      const runs = {};
      for (const name of Object.keys(setup.mesh.agents)) {
        runs[name] = await harness.readRuns(setup.mesh.agents[name]);
      }
      const ctx = { results, runs, mesh: setup.mesh, planted: setup.planted || {} };
      const probes = [];
      for (const p of setup.probes) {
        try {
          probes.push({ name: p.name, ...(await p.check(ctx)) });
        } catch (err) {
          // One throwing probe must not abandon the rest — record it as a failure.
          probes.push({ name: p.name, pass: false, detail: 'probe threw: ' + err.message });
        }
      }
      const pass = probes.every((p) => p.pass);
      trialReport = { trial, pass, probes, durationMs: Date.now() - t0 };
      if (!pass && outDir) {
        try {
          await preserve(outDir, scenario.name, trial, setup.mesh, results, setup.turns);
        } catch (err) {
          // Preservation failure is extra evidence, never a replacement of the report.
          trialReport.probes.push({ name: 'preserve', pass: false, detail: err.message });
        }
      }
    } catch (err) {
      // Harness/setup failure scores as a failed trial — never crashes the run.
      trialReport = { trial, pass: false, probes: [{ name: 'harness', pass: false, detail: err.stack || err.message }], durationMs: Date.now() - t0 };
      if (setup?.mesh && outDir) await preserveLogs(outDir, scenario.name, trial, setup.mesh).catch(() => {});
    } finally {
      if (setup?.mesh) await harness.cleanupMesh(setup.mesh).catch(() => {});
    }
    log(`  ${scenario.name} trial ${trial}: ${trialReport.pass ? 'PASS' : 'FAIL'}`);
    trialReports.push(trialReport);
  }
  return { name: scenario.name, trials: trialReports };
}

// Preserve failed-trial evidence BEFORE teardown: answers + all run logs.
async function preserve(outDir, name, trial, mesh, results, turns) {
  const dir = await preserveLogs(outDir, name, trial, mesh);
  await writeFile(join(dir, 'answers.json'),
    JSON.stringify(results.map((r, i) => ({
      task: turns?.[i]?.task ?? null,
      answer: r.answer,
      runId: r.runId,
      state: r.state,
      errorCode: r.errorCode
    })), null, 2));
}

// Copy the mesh run logs into the failure dir; returns the failure dir path.
async function preserveLogs(outDir, name, trial, mesh) {
  const dir = join(outDir, 'failures', `${name}-t${trial}`);
  await mkdir(dir, { recursive: true });
  await cp(mesh.logsBase, join(dir, 'logs'), { recursive: true }).catch(() => {});
  return dir;
}
