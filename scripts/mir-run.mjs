import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectInputs } from '../src/mesh-improvement/collect.js';
import { buildReport, syncReport } from '../src/mesh-improvement/run.js';
import {
  DEFAULT_MIR_DIR, DEFAULT_MIR_NOISE_BAND_PCT, DEFAULT_MIR_RECOVER_RUNS,
  DEFAULT_MIR_TREND_N, DEFAULT_MESH_SCAN_LABEL, DEFAULT_LOG_DIR,
} from '../src/config.js';

const env = (k, d) => (process.env[k] ?? d);

export async function runMir({ repoRoot, ref, dryRun, runSuites, gh, now, repo }) {
  try {
    const at = now().toISOString();
    const mirDir = join(repoRoot, env('AGENT_MESH_MIR_DIR', DEFAULT_MIR_DIR));
    mkdirSync(mirDir, { recursive: true });

    if (runSuites) {
      spawnSync(process.execPath, ['run-all-tests.mjs', '--json', join(mirDir, 'test-results.json')],
        { cwd: repoRoot, stdio: 'inherit' });
    }
    const { inputs, previousMir } = collectInputs({
      resultsRoots: {
        tests: join(mirDir, 'test-results.json'),
        behavior: join(repoRoot, 'eval-results'),
        adversarial: join(repoRoot, 'adversarial-results'),
        perf: join(repoRoot, 'perf-results'),
      },
      logDir: join(repoRoot, env('AGENT_MESH_LOG_DIR', DEFAULT_LOG_DIR)),
      mirDir,
    });

    const mir = buildReport({
      inputs, previousMir, at, ref,
      noiseBandPct: Number(env('AGENT_MESH_MIR_NOISE_BAND_PCT', DEFAULT_MIR_NOISE_BAND_PCT)),
      trendN: Number(env('AGENT_MESH_MIR_TREND_N', DEFAULT_MIR_TREND_N)),
    });
    const { plan, mutations } = await syncReport({
      mir, mirDir, dryRun, gh, repo, writeFile: (p, c) => writeFileSync(p, c),
      recoverRuns: Number(env('AGENT_MESH_MIR_RECOVER_RUNS', DEFAULT_MIR_RECOVER_RUNS)),
      scanLabel: env('MESH_SCAN_LABEL', DEFAULT_MESH_SCAN_LABEL),
    });
    const fileable = mir.findings.filter((f) => f.fileable).length;
    return { status: 'ok', summary: `${fileable} fileable, ${plan.length} planned, ${mutations} applied`, mutations };
  } catch (e) {
    return { status: 'fail', summary: e?.message || String(e), mutations: 0 };
  }
}

// CLI: `node scripts/mir-run.mjs [--dry-run] [--run-suites]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');
  const runSuites = process.argv.includes('--run-suites');
  const gh = async (args) => spawnSync('gh', args, { encoding: 'utf8' }).stdout || '';
  const res = await runMir({ repoRoot: process.cwd(),
    ref: { commit: process.env.GITHUB_SHA || 'local', branch: 'main' },
    dryRun, runSuites, gh, now: () => new Date(), repo: process.env.DEV_SOCIETY_REPO || '' });
  console.log(JSON.stringify(res));
  process.exit(res.status === 'ok' ? 0 : 1);
}
