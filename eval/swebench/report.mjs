// eval/swebench/report.mjs — scorecard aggregation + rendering for SWE-bench L5.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Aggregate an array of task results into a scorecard.
 *
 * taskResults: Array of { taskId, topology, pass, skipped?, score, costUsd?, durationMs, detail? }
 * Returns a scorecard object.
 */
export function aggregate(taskResults) {
  const byTopology = {};
  for (const r of taskResults) {
    if (!byTopology[r.topology]) byTopology[r.topology] = [];
    byTopology[r.topology].push(r);
  }
  const topologies = Object.entries(byTopology).map(([name, results]) => {
    const runnable = results.filter((r) => !r.skipped);
    const passed = runnable.filter((r) => r.pass).length;
    const totalCost = runnable.reduce((s, r) => s + (r.costUsd || 0), 0);
    const passRate = runnable.length ? passed / runnable.length : 0;
    const costPerPass = passed > 0 ? totalCost / passed : null;
    return { name, total: results.length, runnable: runnable.length, passed, passRate, totalCost, costPerPass };
  });
  const totalRunnable = topologies.reduce((s, t) => s + t.runnable, 0);
  const totalPassed = topologies.reduce((s, t) => s + t.passed, 0);
  return {
    at: new Date().toISOString(),
    topologies,
    aggregate: {
      tasks: taskResults.length,
      runnable: totalRunnable,
      passed: totalPassed,
      passRate: totalRunnable ? totalPassed / totalRunnable : 0
    }
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;
const usd = (x) => (x === null ? 'n/a' : `$${x.toFixed(4)}/pass`);

export function renderMarkdown(scorecard) {
  const lines = [
    `# SWE-bench L5 eval — ${scorecard.at}`,
    '',
    `**Aggregate: ${scorecard.aggregate.passed}/${scorecard.aggregate.runnable} tasks (${pct(scorecard.aggregate.passRate)})**`,
    '',
    '| topology | pass/runnable | pass-rate | cost/pass |',
    '|---|---|---|---|'
  ];
  for (const t of scorecard.topologies) {
    lines.push(`| ${t.name} | ${t.passed}/${t.runnable} | ${pct(t.passRate)} | ${usd(t.costPerPass)} |`);
  }
  return lines.join('\n') + '\n';
}

export async function writeScorecard(outDir, scorecard) {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, 'swebench-scorecard.json');
  const mdPath = join(outDir, 'swebench-scorecard.md');
  await writeFile(jsonPath, JSON.stringify(scorecard, null, 2));
  await writeFile(mdPath, renderMarkdown(scorecard));
  return { json: jsonPath, md: mdPath };
}

/** Exit 0 always; 1 if --min-pass-rate is set and the aggregate falls below it. */
export function exitCode(scorecard, minPassRate) {
  if (minPassRate === undefined || minPassRate === null) return 0;
  return scorecard.aggregate.passRate >= Number(minPassRate) ? 0 : 1;
}
