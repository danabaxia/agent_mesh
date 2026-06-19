#!/usr/bin/env node
// scripts/eval-swebench.mjs — SWE-bench L5 eval harness runner.
// Phase 1: ask-mode tasks, text-match scoring, no Docker required.
// Phase 2: do-mode tasks, swebench-cli scoring (gated on issue #97).
// Like L2–L4: exit 0 always unless --min-pass-rate is set and the aggregate falls below it.
// Usage: node scripts/eval-swebench.mjs [--list] [--suite mesh-bench|full]
//   [--topology single_worker|ask_chain] [--trials N] [--timeout-ms N]
//   [--out DIR] [--min-pass-rate 0..1]
import { join } from 'node:path';
import { runSuite, loadTasks } from '../eval/swebench/harness.mjs';
import { aggregate, renderMarkdown, writeScorecard, exitCode } from '../eval/swebench/report.mjs';
import { detectSwebench } from '../eval/swebench/scorer.mjs';
import { PHASE1_TOPOLOGIES } from '../eval/swebench/topologies.mjs';


const USAGE = `node scripts/eval-swebench.mjs [--list] [--suite mesh-bench|full]
  [--topology single_worker|ask_chain] [--trials N] [--timeout-ms N]
  [--out DIR] [--min-pass-rate 0..1]`;

function parseArgs(argv) {
  const o = { suite: 'mesh-bench', topology: 'single_worker', trials: 1, timeoutMs: 600_000, out: 'eval-swebench-results' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail(`${a} requires a value`);
      return v;
    };
    if (a === '--list') o.list = true;
    else if (a === '--suite') o.suite = val();
    else if (a === '--topology') o.topology = val();
    else if (a === '--trials') o.trials = posInt(val(), a);
    else if (a === '--timeout-ms') o.timeoutMs = posInt(val(), a);
    else if (a === '--out') o.out = val();
    else if (a === '--min-pass-rate') {
      const n = Number(val());
      if (!(n >= 0 && n <= 1)) fail('--min-pass-rate must be in [0,1]');
      o.minPassRate = n;
    }
    else if (a === '--help' || a === '-h') o.help = true;
    else fail(`unknown flag ${a}`);
  }
  return o;
}

const posInt = (v, f) => {
  const n = Number.parseInt(v, 10);
  if (!(n > 0)) fail(`${f} must be a positive integer`);
  return n;
};

function fail(msg) {
  process.stderr.write(`eval-swebench: ${msg}\n`);
  process.exit(2);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(USAGE + '\n'); return; }

  if (o.list) {
    let tasks = [];
    try { tasks = await loadTasks(o.suite); } catch { /* none */ }
    process.stdout.write(`SWE-bench eval suites:\n  mesh-bench  (${tasks.length} tasks, Phase 1 ask-mode)\n  full        (requires swebench CLI + Docker; Phase 2)\n`);
    process.stdout.write(`\nTopologies (Phase 1): ${PHASE1_TOPOLOGIES.join(', ')}\n`);
    return;
  }

  // For the full suite, check that swebench is available (Docker dependency).
  if (o.suite === 'full') {
    const hasSwebench = await detectSwebench();
    if (!hasSwebench) {
      process.stdout.write('eval-swebench: `swebench` not found on PATH — skipping full suite (install swebench CLI to enable).\n');
      process.exit(0);
    }
  }

  const claude = process.env.AGENT_MESH_CLAUDE || 'claude';
  const outDir = join(o.out, new Date().toISOString().replace(/[:.]/g, '-'));

  const taskResults = await runSuite({
    suite: o.suite,
    topology: o.topology,
    trials: o.trials,
    claude,
    timeoutMs: o.timeoutMs,
    log: (m) => process.stderr.write(m + '\n')
  });

  const scorecard = aggregate(taskResults);
  const { md, json } = await writeScorecard(outDir, scorecard);
  process.stdout.write('\n' + renderMarkdown(scorecard));
  process.stderr.write(`\nScorecard: ${md}\n           ${json}\n`);
  process.exit(exitCode(scorecard, o.minPassRate));
}

main().catch((err) => {
  process.stderr.write(`eval-swebench: ${err.stack || err.message}\n`);
  process.exit(1);
});
