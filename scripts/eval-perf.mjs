#!/usr/bin/env node
// scripts/eval-perf.mjs — REAL-`claude` performance benchmark runner (spec §3, §8, §11).
// Drives agent A over the live A2A wire across routing cells, meters each task,
// judges answer quality, and writes a composite PerfCard. Like the behavior eval,
// this is a SCORECARD, not a CI gate: exit 0 unless an explicit --min-*/--max-* gate
// is set. Usage: node scripts/eval-perf.mjs [--list] [--scenario NAME] [--cell NxOverlap]
//   [--trials N] [--timeout-ms N] [--out DIR] [--judge-claude PATH]
//   [--min-quality 0..1] [--max-cost-usd N] [--min-precision 0..1]
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { runScenario } from '../eval/perf/runner.mjs';
import { aggregate, renderMarkdown, writePerfCard, exitCode } from '../eval/perf/perfcard.mjs';

function parseArgs(argv) {
  const o = { trials: 5, timeoutMs: 180_000, out: 'eval-perf-results', gates: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`); return v; };
    if (a === '--list') o.list = true;
    else if (a === '--scenario') o.scenario = val();
    else if (a === '--cell') o.cell = val();
    else if (a === '--trials') o.trials = posInt(val(), a);
    else if (a === '--timeout-ms') o.timeoutMs = posInt(val(), a);
    else if (a === '--out') o.out = val();
    else if (a === '--judge-claude') o.judgeClaude = val();
    else if (a === '--max-spawns') o.maxSpawns = posInt(val(), a);
    else if (a === '--min-quality') o.gates.minQuality = num01(val(), a);
    else if (a === '--max-cost-usd') o.gates.maxCostUsd = Number(val());
    else if (a === '--min-precision') o.gates.minPrecision = num01(val(), a);
    else if (a === '--help' || a === '-h') o.help = true;
    else fail(`unknown flag ${a}`);
  }
  return o;
}
const posInt = (v, f) => { const n = Number.parseInt(v, 10); if (!(n > 0)) fail(`${f} must be a positive int`); return n; };
const num01 = (v, f) => { const n = Number(v); if (!(n >= 0 && n <= 1)) fail(`${f} must be in [0,1]`); return n; };
function fail(msg) { process.stderr.write(`eval-perf: ${msg}\n`); process.exit(2); }

async function loadScenarios() {
  const dir = fileURLToPath(new URL('../eval/perf/scenarios/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  const out = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)).default;
    if (mod && mod.name && typeof mod.setup === 'function') out.push(mod);
  }
  return out;
}

const HELP = `node scripts/eval-perf.mjs [--list] [--scenario NAME] [--cell NxOverlap]
  [--trials N] [--timeout-ms N] [--out DIR] [--judge-claude PATH] [--max-spawns N]
  [--min-quality 0..1] [--max-cost-usd N] [--min-precision 0..1]
  (--cell accepts "6xconfusable" or "6×confusable")`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP + '\n'); return; }
  let scenarios = await loadScenarios();
  if (o.scenario) scenarios = scenarios.filter((s) => s.name === o.scenario);
  // --cell accepts the ASCII "6xconfusable" or the --list-rendered "6×confusable".
  const cellNorm = o.cell ? o.cell.replace('×', 'x') : null;
  if (cellNorm) scenarios = scenarios.filter((s) => s.cell && `${s.cell.peers}x${s.cell.overlap}` === cellNorm);
  if (o.list) {
    process.stdout.write('Perf scenarios:\n' + scenarios.map((s) => `  ${s.name}  [${s.cell?.peers}×${s.cell?.overlap}]`).join('\n') + '\n');
    return;
  }
  if (!scenarios.length) fail('no scenarios match the filter');
  const claude = process.env.AGENT_MESH_CLAUDE || 'claude';
  // Shared spawn budget (§11 real-money rail) across all scenarios; null = no cap.
  const budget = o.maxSpawns ? { remaining: o.maxSpawns } : null;
  const reports = [];
  for (const s of scenarios) {
    process.stderr.write(`# ${s.name} (${o.trials} trials)\n`);
    reports.push(await runScenario(s, {
      trials: o.trials, claude, judgeClaude: o.judgeClaude, timeoutMs: o.timeoutMs, budget,
      log: (m) => process.stderr.write(m + '\n')
    }));
    if (budget && budget.remaining <= 0) { process.stderr.write(`# --max-spawns budget exhausted; stopping.\n`); break; }
  }
  const report = aggregate(reports);
  const outDir = join(o.out, new Date().toISOString().replace(/[:.]/g, '-'));
  const { md, json } = await writePerfCard(outDir, report);
  process.stdout.write('\n' + renderMarkdown(report));
  process.stderr.write(`\nPerfCard: ${md}\n           ${json}\n`);
  process.exit(exitCode(report, o.gates));
}

main().catch((err) => { process.stderr.write(`eval-perf: ${err.stack || err.message}\n`); process.exit(1); });
