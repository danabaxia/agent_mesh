# MIR Eval-Metrics Sync — Design

## 1. Goal

Stop the **locally-generated** Mesh Improvement Report (MIR) from being blind to
behavior / adversarial / perf quality. Today the nightly `tester-suite-run` daemon
builtin runs `runMir({ runSuites: true })`, which only spawns `run-all-tests.mjs`
(L0 unit red/green). The L2/L3/L4 eval scorecards are produced **only on CI** and
staged into `eval-results/` · `adversarial-results/` · `perf-results/` by the
`integration.yml` `mir` job. The local dev-society host never has those directories,
so `collect.js` reads nothing and every local MIR carries `behavior.passRate`,
`adversarial.invariantsPassed`, `perf.quality_per_1k_tokens_p50`,
`perf.wasted_hops_p50` (and their deltas) as **`null`**, with empty `trend` arrays.
The daily Analyst review can therefore only reason over unit red/green — risky on
days dominated by behavior changes (self-heal loops, `memory:promote` PRs) that a
unit suite does not meaningfully cover (issue #337).

This wires the existing CI eval artifacts into the local MIR run by **pulling the
latest CI scorecards** into the exact paths `collect.js` already scans — no schema,
collector, baseline, or policy changes.

## 2. Non-goals

- **No new gate.** Report-first, matching #242: once metrics flow, `policy.js`
  already files a regression finding when a populated delta crosses
  `AGENT_MESH_MIR_NOISE_BAND_PCT`, and `baseline.js` already appends to the `trend`
  arrays (filtering nulls). Both activate automatically — we add **no** merge block.
- **No producer changes.** `eval-a2a.mjs` / `eval-adversarial.mjs` / `eval-perf.mjs`
  and their scorecard shapes are untouched; we only relocate their CI outputs.
- **No running real evals locally.** The local host does not have the
  `CLAUDE_CODE_OAUTH_TOKEN` budget to run L2/L3/L4 (~30 min, REAL `claude`). We
  reuse CI's nightly scorecards, not re-compute them.

## 3. Root cause (confirmed against code)

`scripts/mir-run.mjs` → `collectInputs({ resultsRoots: { behavior:
<repoRoot>/eval-results, adversarial: <repoRoot>/adversarial-results, perf:
<repoRoot>/perf-results } })`. `collect.js`'s `latestJson(dir, 'scorecard.json' |
'perfcard.json')` returns `null` when `dir` is missing. The CI `mir` job
(`integration.yml`) stages those dirs via `cp artifacts/l2-behavior-scorecard/* …`
from `actions/download-artifact`; the local daemon has no such step. Confirmed by
the `github-actions` diagnosis comment on #337.

## 4. Mechanism

New `src/mesh-improvement/sync-artifacts.js` — `syncEvalArtifacts(...)`:

| CI artifact | local dir |
|---|---|
| `l2-behavior-scorecard` | `eval-results/` |
| `l3-adversarial-results` | `adversarial-results/` |
| `l4-perf-scorecard` | `perf-results/` |

For each artifact, list the newest `integration.yml` runs (`gh run list --workflow
integration.yml -L 10 --json databaseId`) and `gh run download <id> -n <artifact>
-D <dir>`, **newest run first, first hit wins** — mirroring the CI baseline-restore
loop that already exists in `integration.yml`. `gh run download` lands the
artifact's `<timestamped>/scorecard.json` under `<dir>`, exactly the shape
`latestJson` expects.

`runMir` calls `syncEvalArtifacts` **once, before `collectInputs`** (after the L0
suite run), injectable via a `syncArtifacts` param (default = the real one) for
hermetic tests.

## 5. Safety / invariants

- **No-op on CI** (`process.env.GITHUB_ACTIONS`): the workflow stages *this* run's
  freshly-produced artifacts; re-pulling the "latest" run there could clobber fresh
  data with older. The sync only runs on the local daemon.
- **Failure is data, degrade to null.** A fresh repo, missing/unauthenticated `gh`,
  or an expired artifact is swallowed per-artifact — the MIR proceeds with `null`
  metrics exactly as today. The report never aborts on a sync failure.
- **Read-only external effect.** `gh run download` only fetches artifacts into the
  served repo root; it writes no peer folder and creates no GitHub mutation. It does
  not touch the path-guarded write boundary (the daemon host, not a `do` worker).
- **No new schema / collector / policy surface.** The null slots, deltas, trend
  arrays, and regression filing are all pre-existing and merely start receiving data.

## 6. Tests (hermetic)

`test/mir-sync-artifacts.test.js` (injected `gh` + `download`, no real `gh`):
artifact→dir mapping; newest-run-first download into the right dir; fallback to an
older run when the newest lacks an artifact; **no-op on CI**; degrade to `[]` when
no runs / `gh` throws; one artifact's download throwing never aborts the others.
`test/tester-suite-run-builtin.test.js` updated to inject a no-op `syncArtifacts`
so the dry-run path stays hermetic (`ghCalls === 0` preserved).
