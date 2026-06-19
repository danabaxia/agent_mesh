# Post-Merge Integration Test Pipeline — Design

## 1. Goal

`ci.yml` is the **L0 hermetic gate**: every push/PR runs `run-all-tests.mjs`
(stubbed `claude`, linux+windows × node 20/22) and **must pass to merge**. By
construction it never runs a real model, so the integration tiers of the
[Evaluation Methodology](2026-06-13-evaluation-methodology-design.md) — **L1**
real-`claude` e2e, **L2** behavior eval, **L3** adversarial battery, **L4**
performance benchmark — never run in CI today. A regression in *real-model
behavior* (delegation, confinement, routing, cost) would merge undetected.

This spec adds a **second, separate pipeline**: a **nightly** GitHub Actions
workflow (`integration.yml`) on `v0.4-development` that runs the
**integration tier** against a **real `claude`** (authenticated via a repo
secret), reports scorecards as artifacts, and signals regressions — **without
gating per-PR merges** (the L0 gate stays the only per-PR blocker).

## 2. Non-goals

- **Not a per-PR gate.** It runs *after* merge, on a schedule. The per-PR
  experience is unchanged: `ci.yml` (L0) remains the only merge blocker.
- **Not a replacement for `ci.yml`.** The hermetic gate keeps running per-push;
  this is additive.
- **No new test logic.** It *runs* the existing/forthcoming harnesses
  (`demo-e2e`, `eval-a2a.mjs`, and `eval-adversarial.mjs` / `eval-perf.mjs` as
  they land) — it does not invent tests.
- **No secret management in-repo.** The `claude` auth secret is added to the
  repo's Actions secrets by the maintainer (§6); the workflow only references it.

## 3. Trigger & shape

```yaml
# .github/workflows/integration.yml
name: Integration (nightly)
on:
  schedule:
    - cron: '0 7 * * *'        # ~nightly; after a day's merges land
  workflow_dispatch:            # manual kick (ad-hoc full run)
concurrency:
  group: integration-${{ github.ref }}
  cancel-in-progress: false     # never cancel a half-done scorecard
```

- Runs on the **default integration branch** `v0.4-development` (the schedule
  fires against the branch's latest commit). `workflow_dispatch` allows a manual
  run on any ref for debugging.
- **`ubuntu-latest` only.** The real-`claude` tiers are POSIX-first
  (`demo-e2e.test.js` is POSIX-only by design; the Windows path is the separate
  `live-a2a-check.mjs`). No OS matrix — that's the L0 gate's job.

## 4. Jobs (the integration tier, in ascending cost)

Each tier is its own job so one tier's failure/flake is isolated and its
artifacts are preserved independently. Forward-compatible: a tier whose script
does not yet exist **skips cleanly** (so the pipeline ships now and grows as
#3/#4 land).

| Job | Runs | Source | Gating |
|---|---|---|---|
| `setup-claude` | install + auth-check the `claude` CLI (composite/used by each job) | §6 | hard (no auth → fail fast) |
| `l1-e2e` | `AGENT_MESH_E2E=1 node --test test/demo-e2e.test.js` | exists | **gates the nightly** (real pass/fail) |
| `l2-behavior` | `node scripts/eval-a2a.mjs --trials 3 --out eval-results` | exists | scorecard — non-gating unless `--min-pass-rate` set |
| `l3-adversarial` | `node scripts/eval-adversarial.mjs --min-pass-rate 1.0` **if present** | when #3 lands | **gates when present** (security, 1.0) |
| `l4-perf` | `node scripts/eval-perf.mjs --trials 5 --out perf-results` **if present** | when #4 lands | scorecard — non-gating (records the PerfCard) |

Skip guard for the not-yet-built tiers:

```yaml
- name: L3 adversarial battery
  run: |
    if [ -f scripts/eval-adversarial.mjs ]; then
      node scripts/eval-adversarial.mjs --min-pass-rate 1.0
    else
      echo "::notice::eval-adversarial.mjs not present yet — skipping L3"
    fi
```

**Gating posture (nightly, not per-PR):**
- `l1-e2e` and `l3-adversarial` are **pass/fail** → a failure **fails the nightly
  run** (a real regression: confinement broke / an invariant fell).
- `l2-behavior` and `l4-perf` are **scorecards** → they always exit 0 by default
  (record-only); regressions surface via artifacts + the run summary, not a red
  X. A threshold (`--min-pass-rate`, `--min-quality`) can be turned on later once
  the score baselines are known stable.

## 5. Artifacts & reporting

- Each scorecard job uploads its output dir (`eval-results/`, `perf-results/`)
  via `actions/upload-artifact` — the scorecard `.md` + `.json` + preserved
  failed-trial evidence (already produced by the runners). Retention ~14 days.
- A final `summary` step writes the headline pass-rates / PerfCard numbers into
  `$GITHUB_STEP_SUMMARY` so the run page shows the scorecard without downloading.
- **Regression signal:** the nightly's own pass/fail (driven by L1/L3) is the
  alert. (A richer "compare against last good baseline" is future work — §9.)

## 6. Real-`claude` auth in CI

The feasibility gate, confirmed available (a secret can be added):

- **Secret:** `CLAUDE_CODE_OAUTH_TOKEN` added to the repo's Actions secrets by
  the maintainer. The workflow sanitizes it and exposes it as an env to the
  claude-spawning steps only.
- **Install:** `npm i -g @anthropic-ai/claude-code` in `setup-claude`; verify
  with `claude --version`. The harnesses honor `AGENT_MESH_CLAUDE` and otherwise
  find `claude` on PATH.
- **Fail-fast auth check:** `setup-claude` runs a trivial `claude -p` probe; if
  it can't authenticate, the job fails immediately with a clear message (rather
  than every tier timing out).
- **Model/cost pin:** set the cheap model via the CLI's model env for the eval
  tiers (documented in the eval specs) to bound nightly spend.

## 7. Cost & flake controls

- **Nightly cadence** (one run/day) bounds spend; `--trials 3` (L2) / `5` (L4)
  per the eval specs. Rough order: a few dozen `claude -p` invocations per night.
- **Per-job `timeout-minutes`** (e.g. 30) so a wedged spawn can't burn the
  budget; the eval runners already tree-kill per-scenario timeouts.
- **Scorecard tiers never fail on stochastic noise** (record-only); only the
  deterministic L1/L3 gates can fail the run. This keeps the nightly's red/green
  meaningful (a real regression), not flaky.
- `cancel-in-progress: false` — a long scorecard is never cancelled by the next
  schedule tick.

## 8. Testing this pipeline itself

A YAML workflow can't be unit-tested like the harnesses, so:
- **Lint/shape:** a tiny hermetic test (`test/integration-workflow.test.js`) that
  parses `.github/workflows/integration.yml` and asserts the invariants that
  matter — schedule + `workflow_dispatch` triggers present, runs on
  `ubuntu-latest`, the skip-guards reference the right script paths, and the
  scorecard jobs are non-gating while `l1-e2e`/`l3-adversarial` are gating. This
  catches drift (e.g. a renamed eval script) in the L0 suite.
- **Live validation:** a `workflow_dispatch` manual run after the secret is added
  proves the real path end to end (this is the acceptance check, not a unit
  test).

## 9. Limitations & future work

- **Real-model stochasticity** — scorecards vary run-to-run; the record-only
  posture + percentiles (per the eval specs) bound this. A **baseline-compare**
  (diff tonight's scorecard against the last good one, alert on a drop beyond a
  band) is the natural v2 — it turns the scorecards into true regression gates
  without arbitrary absolute thresholds.
- **Windows real-`claude` integration** stays out (POSIX-first); the Windows live
  path remains `live-a2a-check.mjs`, which could get its own scheduled job later.
- **Notifications** (Slack/issue-on-failure) are out of scope; the run's
  red/green + `$GITHUB_STEP_SUMMARY` is the v1 signal.

## 10. Open decisions

1. Cron time — `0 7 * * *` UTC (proposed, off-peak) vs. tied to a known
   low-merge window.
2. Should `l2-behavior` gate at a conservative `--min-pass-rate` (e.g. 0.6) once
   a baseline exists, or stay record-only indefinitely? Proposed: record-only in
   v1; revisit after ~2 weeks of nightly data.
3. One workflow with parallel tier-jobs (proposed) vs. a single sequential job
   (simpler logs, slower). Proposed: parallel jobs sharing a `setup-claude`
   composite, for isolation + independent artifacts.
4. Secret form — resolved: this repo uses `CLAUDE_CODE_OAUTH_TOKEN` only for
   real-`claude` CI auth.
