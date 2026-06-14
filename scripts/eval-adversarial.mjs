#!/usr/bin/env node
// scripts/eval-adversarial.mjs — REAL-`claude` adversarial security battery (L3).
// One scenario per security invariant (I1–I7); every probe is a HARD gate. Reuses
// the behavior-eval runner + scorecard. Unlike the behavior eval, this is meant to
// be GATED: the recommended security run is `--min-pass-rate 1.0` (any failure is a
// security regression, not acceptable stochastic noise). Exit 0 by default.
// Usage: node scripts/eval-adversarial.mjs [--list] [--scenario NAME] [--trials N]
//        [--timeout-ms N] [--out DIR] [--min-pass-rate 0..1]
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { runScenario } from '../eval/runner.mjs';
import { aggregate, renderMarkdown, writeScorecard, exitCode } from '../eval/scorecard.mjs';

function parseArgs(argv) {
  const o = { trials: 5, timeoutMs: 180_000, out: 'eval-adversarial-results' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`); return v; };
    if (a === '--list') o.list = true;
    else if (a === '--scenario') o.scenario = val();
    else if (a === '--trials') o.trials = posInt(val(), a);
    else if (a === '--timeout-ms') o.timeoutMs = posInt(val(), a);
    else if (a === '--out') o.out = val();
    else if (a === '--min-pass-rate') { const n = Number(val()); if (!(n >= 0 && n <= 1)) fail('--min-pass-rate must be in [0,1]'); o.minPassRate = n; }
    else if (a === '--help' || a === '-h') o.help = true;
    else fail(`unknown flag ${a}`);
  }
  return o;
}
const posInt = (v, f) => { const n = Number.parseInt(v, 10); if (!(n > 0)) fail(`${f} must be a positive int`); return n; };
function fail(msg) { process.stderr.write(`eval-adversarial: ${msg}\n`); process.exit(2); }

async function loadScenarios() {
  const dir = fileURLToPath(new URL('../eval/adversarial/', import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  const out = [];
  for (const f of files) {
    const mod = (await import(pathToFileURL(join(dir, f)).href)).default;
    if (mod && mod.name && typeof mod.setup === 'function') out.push(mod);
  }
  return out;
}

const HELP = `node scripts/eval-adversarial.mjs [--list] [--scenario NAME] [--trials N]
  [--timeout-ms N] [--out DIR] [--min-pass-rate 0..1]
  (security run: --min-pass-rate 1.0 — any failure is a security regression)`;

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { process.stdout.write(HELP + '\n'); return; }
  let scenarios = await loadScenarios();
  if (o.scenario) scenarios = scenarios.filter((s) => s.name === o.scenario);
  if (o.list) { process.stdout.write('Adversarial scenarios (one per invariant):\n' + scenarios.map((s) => `  ${s.name}`).join('\n') + '\n'); return; }
  if (!scenarios.length) fail('no scenarios match the filter');
  const claude = process.env.AGENT_MESH_CLAUDE || 'claude';
  const outDir = join(o.out, new Date().toISOString().replace(/[:.]/g, '-'));
  const reports = [];
  for (const s of scenarios) {
    process.stderr.write(`# ${s.name} (${o.trials} trials)\n`);
    reports.push(await runScenario(s, { trials: o.trials, claude, timeoutMs: o.timeoutMs, outDir, log: (m) => process.stderr.write(m + '\n') }));
  }
  const report = aggregate(reports);
  const { md, json } = await writeScorecard(outDir, report);
  process.stdout.write('\n' + renderMarkdown(report));
  process.stderr.write(`\nScorecard: ${md}\n           ${json}\n`);
  process.exit(exitCode(report, o.minPassRate));
}

main().catch((err) => { process.stderr.write(`eval-adversarial: ${err.stack || err.message}\n`); process.exit(1); });
