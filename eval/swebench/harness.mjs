// eval/swebench/harness.mjs — SWE-bench task runner.
// Loads task descriptors, builds a mesh topology, drives the agent, scores the result.
// Reuses eval/harness.mjs (buildMesh, driveAgent, cleanupMesh) from L2–L4.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { buildMesh, driveAgent, cleanupMesh } from '../harness.mjs';
import { scoreTextMatch, scoreWithCli } from './scorer.mjs';
import { buildTopology } from './topologies.mjs';

const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'tasks');

/** Load a task suite JSON file. Returns an array of task descriptors. */
export async function loadTasks(suite = 'mesh-bench') {
  const filePath = join(TASKS_DIR, `${suite}.json`);
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`swebench: cannot read task file "${filePath}": ${err.message}`);
  }
  let tasks;
  try {
    tasks = JSON.parse(raw);
  } catch (err) {
    throw new Error(`swebench: malformed JSON in "${filePath}": ${err.message}`);
  }
  if (!Array.isArray(tasks)) throw new Error(`swebench: task file must be a JSON array`);
  return tasks;
}

/**
 * Run all tasks in a suite through a mesh topology.
 *
 * opts:
 *   suite       'mesh-bench' | 'full' (default: 'mesh-bench')
 *   topology    topology name (default: 'single_worker')
 *   trials      number of trials per task (default: 1)
 *   claude      path to claude binary
 *   timeoutMs   per-task timeout (default: 600_000)
 *   log         function(string) for progress output (default: no-op)
 *
 * Returns an array of task result objects.
 */
export async function runSuite(opts = {}) {
  const {
    suite = 'mesh-bench',
    topology = 'single_worker',
    trials = 1,
    claude,
    timeoutMs = 600_000,
    log = () => {}
  } = opts;

  if (!claude) throw new Error('swebench harness: claude binary path is required');

  const tasks = await loadTasks(suite);
  log(`eval-swebench: ${tasks.length} task(s) in "${suite}" × ${trials} trial(s) via "${topology}"`);

  if (tasks.length === 0) {
    log('eval-swebench: no tasks to run (mesh-bench task list is empty — human curation needed)');
    return [];
  }

  const results = [];

  for (const task of tasks) {
    if (task.phase === 2 || task.topology === 'do_required') {
      log(`  skip [do_required] ${task.id} — Phase 2 requires issue #97`);
      results.push({ taskId: task.id, topology, pass: false, skipped: true, detail: 'do_required: Phase 2', costUsd: 0, durationMs: 0 });
      continue;
    }

    for (let trial = 0; trial < trials; trial++) {
      const t0 = Date.now();
      let mesh = null;
      try {
        const topSpec = buildTopology(topology);
        mesh = await buildMesh({ agents: topSpec.agents, claude, timeoutMs });
        const taskText = formatTaskPrompt(task);
        const [result] = await driveAgent(mesh, topSpec.driven, [{ task: taskText }], {
          claude, timeoutMs, callerTag: `swebench-${task.id}-t${trial}-${randomUUID().slice(0, 6)}`
        });
        const score = scoreTextMatch(task, result.answer || '');
        const costUsd = extractCost(result);
        const durationMs = Date.now() - t0;
        log(`  [${score.pass ? 'PASS' : 'FAIL'}] ${task.id} trial ${trial}: ${score.detail}`);
        results.push({ taskId: task.id, topology, trial, pass: score.pass, score, costUsd, durationMs });
      } catch (err) {
        const durationMs = Date.now() - t0;
        log(`  [ERROR] ${task.id} trial ${trial}: ${err.message}`);
        results.push({ taskId: task.id, topology, trial, pass: false, error: err.message, costUsd: 0, durationMs });
      } finally {
        if (mesh) await cleanupMesh(mesh).catch(() => {});
      }
    }
  }

  return results;
}

function formatTaskPrompt(task) {
  const lines = [];
  if (task.repo) lines.push(`Repository: ${task.repo}`);
  if (task.issue) lines.push(`\nIssue:\n${task.issue}`);
  if (!lines.length) lines.push(String(task.description || task.id));
  return lines.join('\n');
}

function extractCost(result) {
  try {
    const metrics = result?.task?.metadata?.['agentmesh/metrics'];
    if (metrics && typeof metrics.total_cost_usd === 'number') return metrics.total_cost_usd;
  } catch { /* best-effort */ }
  return 0;
}
