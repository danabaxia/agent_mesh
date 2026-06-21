// src/mesh-improvement/sync-artifacts.js — impure shell: stage the CI-produced
// eval scorecards into the local repo layout that collect.js scans, so a MIR run
// on the local dev-society daemon can populate behavior/adversarial/perf metrics
// instead of emitting them null. Issue #337; spec
// docs/superpowers/specs/2026-06-21-mir-eval-metrics-sync-design.md.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// The three artifacts the nightly integration workflow uploads, each mapped to the
// repo-root directory collect.js reads (mirrors integration.yml's `mir` staging
// step — keep these in lockstep). The CI job runs `cp artifacts/<name>/* <dir>/`;
// the local daemon has no such artifacts on disk, so it must fetch them.
export const EVAL_ARTIFACTS = [
  { artifact: 'l2-behavior-scorecard', dir: 'eval-results' },
  { artifact: 'l3-adversarial-results', dir: 'adversarial-results' },
  { artifact: 'l4-perf-scorecard', dir: 'perf-results' },
];

const INTEGRATION_WORKFLOW = 'integration.yml';

// Newest-first run ids for the nightly integration workflow. Best-effort: any
// failure (no `gh`, no auth, no runs) yields [] so the caller degrades to the
// existing null-metric behavior rather than aborting the report.
async function listIntegrationRuns(gh, limit) {
  try {
    const out = await gh(['run', 'list', '--workflow', INTEGRATION_WORKFLOW,
      '-L', String(limit), '--json', 'databaseId', '-q', '.[].databaseId']);
    return String(out).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

// Real downloader: `gh run download <id> -n <artifact> -D <dest>` lands the
// artifact's contents under <dest>/<timestamped>/ — exactly the shape
// collect.js's latestJson(dir, 'scorecard.json'|'perfcard.json') expects.
// Returns true on a clean exit, false otherwise (missing artifact / expired).
export function ghDownload(runId, artifact, dest) {
  const r = spawnSync('gh', ['run', 'download', String(runId), '-n', artifact, '-D', dest],
    { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * Stage the latest available CI eval scorecards into `repoRoot` so a local MIR run
 * can populate behavior/adversarial/perf metrics. NO-OP on CI (`isCI`), where the
 * workflow already stages *this* run's freshly-produced artifacts — re-pulling the
 * latest run there would clobber fresh data with older. Every failure is swallowed:
 * a fresh repo, missing `gh`, or expired artifact degrades to null metrics, never
 * an abort.
 *
 * @param {object}   o
 * @param {string}   o.repoRoot   repo root; artifacts land under repoRoot/<dir>.
 * @param {Function} o.gh         async (args[]) => stdout — used only to list runs.
 * @param {Function} [o.download] async (runId, artifact, dest) => boolean.
 * @param {boolean}  o.isCI       true on GitHub Actions — disables the sync.
 * @param {number}   [o.limit]    how many recent runs to scan per artifact.
 * @param {Function} [o.log]      optional progress sink.
 * @returns {Promise<string[]>}   artifact names successfully synced.
 */
export async function syncEvalArtifacts({
  repoRoot, gh, download = ghDownload, isCI, limit = 10, artifacts = EVAL_ARTIFACTS, log,
}) {
  if (isCI) return [];
  const runIds = await listIntegrationRuns(gh, limit);
  if (!runIds.length) return [];
  const synced = [];
  for (const { artifact, dir } of artifacts) {
    const dest = join(repoRoot, dir);
    for (const runId of runIds) {              // newest first; first hit wins
      let ok = false;
      try { ok = await download(runId, artifact, dest); } catch { ok = false; }
      if (ok) { synced.push(artifact); log?.(`MIR: synced ${artifact} from run ${runId}`); break; }
    }
  }
  return synced;
}
