#!/usr/bin/env node
// A2A behavior eval runner (spec: docs/superpowers/specs/2026-06-10-a2a-behavior-evals-design.md)
// Usage: node scripts/eval-a2a.mjs [--list] [--scenario NAME] [--trials N]
//        [--timeout-ms N] [--out DIR] [--min-pass-rate 0..1]
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnFile } from '../src/process.js';
import { runScenario } from '../eval/runner.mjs';
import { aggregate, writeScorecard, exitCode, renderMarkdown } from '../eval/scorecard.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const USAGE = `A2A behavior eval runner (spec: docs/superpowers/specs/2026-06-10-a2a-behavior-evals-design.md)
Usage: node scripts/eval-a2a.mjs [--list] [--scenario NAME] [--trials N]
       [--timeout-ms N] [--out DIR] [--min-pass-rate 0..1]`;

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { trials: 3, timeoutMs: 180_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Every value-taking flag must actually be followed by a value, not the
    // end of argv or another --flag.
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`${a} requires a value`);
      i++;
      return v;
    };
    const positiveInt = () => {
      const raw = value();
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) fail(`${a} must be a positive integer, got "${raw}"`);
      return n;
    };
    if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else if (a === '--list') opts.list = true;
    else if (a === '--scenario') opts.scenario = value();
    else if (a === '--trials') opts.trials = positiveInt();
    else if (a === '--timeout-ms') opts.timeoutMs = positiveInt();
    else if (a === '--out') opts.out = value();
    else if (a === '--min-pass-rate') {
      const raw = value();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 1) fail(`--min-pass-rate must be a number in [0,1], got "${raw}"`);
      opts.minPassRate = n;
    }
    else fail(`unknown arg: ${a}\n${USAGE}`);
  }
  return opts;
}

async function loadScenarios() {
  const dir = join(repoRoot, 'eval', 'scenarios');
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort(); } catch { /* none yet */ }
  const out = [];
  for (const f of files) out.push((await import(pathToFileURL(join(dir, f)).href)).default);
  return out;
}

async function detectClaude() {
  const bin = process.env.AGENT_MESH_CLAUDE || 'claude';
  const r = await spawnFile(bin, ['--version'], { timeoutMs: 15_000 });
  if (r.error || r.code !== 0) {
    fail(`cannot run "${bin}" — install claude or set AGENT_MESH_CLAUDE.`);
  }
  return bin;
}

const opts = parseArgs(process.argv.slice(2));
const scenarios = await loadScenarios();
if (opts.list) {
  for (const s of scenarios) console.log(s.name);
  process.exit(0);
}
if (scenarios.length === 0) fail('no scenarios found under eval/scenarios/');
const selected = opts.scenario ? scenarios.filter((s) => s.name === opts.scenario) : scenarios;
if (selected.length === 0) fail(`no scenario named "${opts.scenario}"`);

const claude = await detectClaude();
const outDir = opts.out || join(repoRoot, 'eval-results', new Date().toISOString().replace(/[:.]/g, '-'));
console.log(`eval-a2a: ${selected.length} scenario(s) × ${opts.trials} trial(s) → ${outDir}`);

const reports = [];
for (const s of selected) {
  console.log(`\n▶ ${s.name}`);
  reports.push(await runScenario(s, { ...opts, claude, outDir, log: console.log }));
}
const report = aggregate(reports);
const paths = await writeScorecard(outDir, report);
console.log(`\n${renderMarkdown(report)}`);
console.log(`scorecard: ${paths.md}`);
process.exit(exitCode(report, opts.minPassRate));
