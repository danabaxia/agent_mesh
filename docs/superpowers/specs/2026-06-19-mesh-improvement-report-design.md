# Mesh Improvement Report (MIR) — Design

## 1. Goal

Give the dev-mesh a **machine-consumable improvement signal** that turns the
test/eval/run-log evidence the project produces into **deduped backlog issues** the
society can act on — closing the missing *"assessment → improvement task"* bridge in
the self-evolve loop.

The work is **owned by the existing Tester agent** (`dev-mesh/tester/`), whose
identity is already *"I read the test/eval scorecards the workflow produced and tell
the Coder what passed, what regressed, and where."* This spec makes that role
**scheduled** (nightly + on-demand) and backs it with a **durable, structured
artifact** (`mir.json`) and an automatic **finding → `idea` issue** bridge the
Analyst intake loop consumes.

The MIR is a scheduled Tester-owned job backed by a small pure library, exactly as
`daily-report-refresh` is a scheduled job (owned by the orchestrator) backed by
`src/report/*` and executed by a daemon builtin. **The report and the issue-filing
are produced/executed by the framework host (deterministic), not by an LLM agent
call** — see §5 for why this is forced by the safety model.

## 2. Non-goals

- **No LLM in the report or filing path (v1).** `mir.json`, the fileable gate, and
  the issue action-plan are produced by **pure deterministic code**; the host
  applies the plan. No `claude -p` call is required for the nightly cycle. (An
  optional ask-mode *human-prompted* narrative remains, reading only the
  framework-produced `mir.json` — never untrusted issue bodies — but it is not on
  the autonomous path.)
- **No auto-fix / auto-PR.** Findings become Issues only. Code changes stay with the
  Coder downstream, behind the existing approval gate.
- **No machine-applicable patch suggestions (v1).** SARIF-style `fixes` are v2 (§11).
- **No new agent.** This extends the existing Tester; it does not add a `qa` role.
- **No per-PR MIR.** Per-PR CI is the hermetic L0 gate (stubbed `claude`, no live
  scorecards) — wrong altitude. The MIR runs against **nightly** results.
- **No mutating MCP under ask-mode.** Issue create/update/close is a host action, not
  an agent MCP tool (§5). The Tester stays `ask`-only and is wired only with
  `readOnly` MCP servers.

## 3. Background — signals consumed, and the producer changes required

The MIR reads results from each tier. Most are already persisted JSON; two small,
**additive** producer changes are required (called out so the plan is honest — the
earlier "zero producer changes" claim was wrong for L0):

| Tier | Signal | Source | Persisted today? |
|------|--------|--------|------------------|
| L0 | per-file test pass/fail + timing | `run-all-tests.mjs` | **No** — prints a table only. **Add** opt-in `--json <path>` writing `{at, results[], summary}` (additive; default behavior unchanged). |
| L2 | behavior pass-rate + failing probes | `scorecard.json` | Yes |
| L3 | security invariants I1–I7 | adversarial `scorecard.json` | Yes |
| L4 | routing / efficiency / quality per task | `perfcard.json` (`samples[]`, `summary`) | Yes (but see evidence note) |
| — | per-delegation cost/tokens/files/status | `delegate-*.jsonl` run records | Yes |

**Evidence-pointer note (drives §7).** Passing scorecards do **not** retain
per-finding `runId`/`logPath`; only *failed* behavior/adversarial trials preserve
logs (`<outDir>/failures/<scenario>-t<trial>/`), and perf samples may drop `runId`
before temp cleanup. Therefore MIR `evidence` is **best-effort and nullable** (§7):
populated from preserved failure logs where they exist, otherwise carrying only the
`scorecardPath` + cell. Optionally (additive, v1-or-v2) extend the perf sample to
retain `runId`; not required for the schema to be valid.

## 4. Execution model (both hosts, concrete)

Suite *execution* + MIR *generation* + issue *sync* is done by a **host executor**
that calls the same pure library. Two hosts, identical library, identical artifact:

**A. Local daemon (`scripts/dev-society-daemon.mjs`).** Register a new builtin
`tester-suite-run` (sibling to `daily-report-refresh`). When the Tester's scheduled
job fires (§6), the daemon invokes this builtin (framework JS, **not** a `claude -p`
spawn), which:
1. runs the suites via `child_process` — `node run-all-tests.mjs --json <tmp>` (L0)
   and the live eval scripts (`eval-a2a` / `eval-adversarial` / `eval-perf`) to
   their result dirs;
2. runs `collect → aggregate → baseline → policy → render → issues`;
3. writes `mir.json` + `mir.md` under `AGENT_MESH_MIR_DIR`;
4. executes the issue action-plan via `gh` (the same auth path `daily-report.mjs`
   uses), honoring `--dry-run`.

Because builtins run framework-side, **no agent ever shells out** — the
*no-Bash-in-agent-modes* invariant is intact.

**B. Cloud (`.github/workflows/integration.yml`).** Today the live jobs are
`l1-e2e`, `l2-behavior`, `l3-adversarial`, `l4-perf` — **separate isolated jobs**, so
no single step sees every artifact, and L1 emits no scorecard. Add:
1. a **new `l0-json` job** that runs `node run-all-tests.mjs --json test-results.json`
   (L0 has no live producer in this pipeline today — the per-PR `ci.yml` owns the
   hermetic L0 gate; the nightly needs its own JSON producer). `run-all-tests.mjs`
   exits **nonzero on red**, so `--json` MUST write `test-results.json` *before* the
   process exits, and the upload step MUST be `if: always()` — otherwise the red-test
   hard signal is lost exactly when it matters;
2. `actions/upload-artifact` in `l2-behavior`/`l3-adversarial`/`l4-perf` for their
   `scorecard.json` / `perfcard.json`. L1 has no artifact: it is **explicitly
   excluded** from MIR inputs (its pass/fail is already the nightly gate); a future
   L1 result artifact is a v2 add.
3. a new aggregation job `mir` with `needs: [l0-json, l2-behavior, l3-adversarial,
   l4-perf]` and **`if: always()`** (a `needs` job otherwise skips when a producer
   fails — but a failed producer is exactly a hard finding we must surface). It
   `actions/download-artifact`s all present inputs (tolerating missing ones as
   `error`/absent findings), restores the **baseline** (§10), runs the
   `src/mesh-improvement` library, uploads `mir.json`/`mir.md`, and runs the `gh`
   issue sync.

The `mir` job is **non-gating** (record-only). It needs job-level `permissions`
(§13). `integration.yml` triggers are `schedule` + `workflow_dispatch` only (no
`pull_request` — consistent with the no-per-PR-MIR non-goal): live issue mutation
runs only on the `schedule` trigger; `workflow_dispatch` runs `--dry-run`.

## 5. Why filing is a host action, not an agent MCP call

The original "ask-mode Tester files issues via the GitHub MCP" is **incompatible
with the mesh safety model**, for two independent reasons:

1. **Ask grants only `readOnly` MCP servers** (`x-agentmesh readOnly` marker). Issue
   create/update/close is an external mutation, not path-guardable; marking such a
   server `readOnly` would be a lie that violates the MCP mode-gating invariant.
2. **Issue bodies are untrusted data.** Letting an LLM read open issues to dedup is a
   prompt-injection surface (an attacker-authored issue body could steer the agent).

Resolution: the **pure `issues.js`** computes the action-plan deterministically from
*trusted* inputs only — the framework-produced findings + the persisted top-level
**ledger** (§7/§10), which maps each `finding.id → { …, issueNumber }`. **Dedup is by
the ledger, not by reading issue bodies.** The host refreshes/repairs the ledger by
listing open issues carrying the deterministic `MESH_SCAN_LABEL` (a GitHub *label* is
trusted metadata, queryable via the API without reading any body) and reconciling
their numbers against the ledger; an HTML-comment marker in the body is kept only as
a human-visible breadcrumb, never as a dedup input. The **host** (daemon builtin or
CI job) then applies the plan via `gh`. No LLM, no body reads, no injection surface,
no mode-gating violation — same trust posture as `daily-report.mjs`.

## 6. The Tester agent & its scheduled job

`dev-mesh/tester/` gains exactly:

1. **`.agent/schedule.json`** with one autonomous job:
   ```jsonc
   { "jobs": [
     { "id": "tester-suite-run", "name": "Suite + improvement report",
       "kind": "builtin", "builtin": "tester-suite-run",
       "cadence": { "kind": "daily", "at": "06:30" },   // post-integration hour
       "enabled": true, "saveArtifact": false }         // MIR already writes mir.json/.md itself
   ]}
   ```
   Cadence uses the existing `src/schedule/schedule-cadence.js` shapes. The builtin
   is registered in the daemon (§4A); the job *belongs to* the Tester, mirroring how
   `daily-report-refresh` belongs to the orchestrator.
2. **`AGENT.md` / `agent.json`** updated to state the Tester owns the scheduled
   suite-run + MIR domain. Still `ask`-only; **no mutating MCP** is wired to it.
3. The existing `interpret-scorecard` / `read-mesh-health` skills are unchanged and
   remain available for ad-hoc, human-prompted interpretation of `mir.json`.

`mesh.json`: Tester entry unchanged (`enabledModes: ["ask"]`); no new agent row.

**On-demand:** the builtin is also exposed as a hidden CLI verb
(`agent-mesh tester-report [mesh-root] [--dry-run]`) for local runs and tests.

State uses the standard `.agent-mesh/schedule-state.json` (`lastRunAt`,
`lastStatus`, `lastSummary`, `nextRunAt`, `running`) — no new state mechanism.

## 7. The MIR artifact (`mir.json`, schema v1)

```jsonc
{
  "schema": "mesh-improvement-report/v1",
  "at": "2026-06-20T06:30:00Z",            // injected, not Date.now()
  "ref":      { "commit": "fb403fe", "branch": "main" },
  "baseline": { "commit": "321f6d7", "at": "..." },   // null on first run

  "summary": {
    "tests":       { "green": 179, "red": 1,    "delta": -1 },
    "behavior":    { "passRate": 0.889,         "delta": 0.02 },
    "adversarial": { "invariantsPassed": "7/7", "delta": 0 },
    "perf":        { "quality_per_1k_tokens_p50": 333, "delta": -18, "wasted_hops_p50": 1 }
  },

  "findings": [
    {
      "id": "perf:6x-confusable:routing-precision",   // controlled vocab; regex-validated
      "tier": "soft",                                  // "hard" | "soft"
      "cluster": "wrong-peer-selection",
      "severity": "warning",                           // "error"|"warning"|"note"
      "metric": {
        "name": "precision", "value": 0.6, "baseline": 0.9,
        "direction": "higher_is_better",               // from the metric registry (§9)
        "deltaPct": -33.3                               // signed; "regression" per direction
      },
      "weakestCell": { "peers": 6, "overlap": "confusable" },
      "evidence": {                                     // best-effort; any field may be null
        "trace": "delegated to peer C; ground truth was peer B" | null,
        "runId": "delegate-..." | null,
        "logPath": "<outDir>/failures/06-.../logs" | null,
        "scorecardPath": "eval-perf-results/2026-06-20.../perfcard.json"
      },
      "fileable": true                                 // policy.js gate output
    }
  ],

  // top-level, carried forward across MIRs for EVERY known id — present AND absent —
  // so close-after-N is computable even when a finding stops appearing in findings[].
  "ledger": {
    "perf:6x-confusable:routing-precision": {
      "firstSeen": "2026-06-18", "lastSeen": "2026-06-20",
      "occurrences": 3, "cleanRuns": 0, "issueNumber": 412
    }
  },

  "trend": { "passRate": [0.85, 0.87, 0.889], "quality_per_1k_tokens": [351, 348, 333] }
}
```

> Metric keys mirror the real producers exactly (e.g. `eval/perf/perfcard.mjs` emits
> `quality_per_1k_tokens`, `wasted_hops`, `precision`); `collect.js` does no renaming.

Field roles (grounded in self-improving-agent research — Reflexion, Self-Refine,
SICA, ADAS, the 2025 Self-Evolving Agents survey): `metric.deltaPct` is the
direction-aware accept/reject signal; `evidence` is the localizable trace (nullable
per §3); `cluster` + `weakestCell` target structural fixes; `id` is the stable
dedup/trend key; the top-level `ledger` map makes close-after-N deterministic and is
the **trusted dedup source** (`id → issueNumber`, §5/§8); `fileable` is the
deterministic policy gate (§9).

`mir.md` renders the same data with a `<!-- mir:<date> -->` marker for idempotent
posting.

## 8. Finding → backlog issue (`issues.js`, pure; host applies)

`issues.js` is **pure** and takes only trusted inputs: this run's `fileable`
findings and the **full top-level `ledger` map** (every known id, present and absent,
each with its `issueNumber`/`cleanRuns`). It returns an action-plan:

```jsonc
[ { "id": "...", "issueNumber": 412 | null, "action": "create|update|close",
    "title": "...", "body": "...", "labels": ["idea","generated:mesh-scan","perf"],
    "marker": "<!-- mesh-scan:<id> -->" } ]   // marker is a human breadcrumb, not a dedup key
```

Plan rules (deterministic; dedup by `ledger[id].issueNumber`, never by body):
- finding `fileable` ∧ `ledger[id].issueNumber == null` → **create** (labels `idea` +
  `MESH_SCAN_LABEL` + tier label; body = factual summary + `metric` + `evidence` +
  path to `mir.json`). The Analyst intake loop then treats it as a normal `idea`.
- finding `fileable` ∧ `issueNumber != null` → **update** that issue (refresh
  metric/deltaPct + `occurrences`).
- id **absent** from this run's findings with `ledger[id].cleanRuns ≥
  AGENT_MESH_MIR_RECOVER_RUNS` ∧ `issueNumber != null` → **close** with a recovery
  comment. (This is why the ledger carries absent ids — §7/§10.)

The host repairs the ledger before calling `issues.js` by listing open issues with
`MESH_SCAN_LABEL` (metadata only) and reconciling numbers, so a manually-closed or
externally-deleted issue self-heals. `finding.id` is a controlled vocabulary
`tier:cell:metric`, **regex-validated** (`^[a-z0-9:_-]+$`), so neither the label nor
the breadcrumb marker can be injected. The host applies the plan via `gh`;
`--dry-run` prints it without mutating.

## 9. Direction-aware fileable gate (`policy.js`)

Deterministic, computed into `finding.fileable` before any host action. Backed by a
**metric registry** so "regression" is well-defined for every metric:

```jsonc
// METRICS registry (excerpt)
{ "passRate":            { "tier":"soft", "direction":"higher_is_better", "unit":"ratio" },
  "precision":           { "tier":"soft", "direction":"higher_is_better", "unit":"ratio" },
  "quality_per_1k_tokens": { "tier":"soft", "direction":"higher_is_better", "unit":"score" },
  "cost_usd":            { "tier":"soft", "direction":"lower_is_better",  "unit":"usd" },
  "latency_ms":          { "tier":"soft", "direction":"lower_is_better",  "unit":"ms" },
  "wasted_hops":         { "tier":"soft", "direction":"lower_is_better",  "unit":"count" } }
```

The registry keys the **base metric** the producer emits (e.g. `latency_ms`,
`quality_per_1k_tokens`). A percentile (e.g. `p50`) is a **summary statistic** of a
base metric, not a registry entry: `aggregate.js` reads the producer's
`summary.<metric>.{p50,p95,mean}` and the headline `summary` (§7) compares the chosen
statistic (default `p50`) against the baseline's same statistic, applying the base
metric's `direction`.

- **`deltaPct`** is signed toward "better" per `direction` (improvement positive,
  regression negative), so the gate is a single rule across metrics.
- **Hard signals — always fileable** (`severity:error`, label `regression`/`security`):
  a red test (from `test-results.json`), a failed invariant I1–I7, or an
  `error`/`timeout` status in an eval run-log.
- **Soft signals — fileable iff a *regression* exceeds the noise band**: `deltaPct`
  is negative (per direction) and `|deltaPct| > AGENT_MESH_MIR_NOISE_BAND_PCT`
  (default 10).
- **Zero / null baseline:** if `baseline` is null (first run) or zero (deltaPct
  undefined), soft findings are **not** fileable; hard signals still file.

## 10. Baseline, ledger & durability (both hosts)

Baseline = the **previous run's `mir.json`** (including its top-level `ledger` map).
Each run computes `deltaPct` and rebuilds the ledger for the **union** of previous
ledger ids and this run's finding ids: `occurrences++` / `cleanRuns=0` for ids
present this run; `cleanRuns++` for ids absent this run; ids retained until their
issue is closed. Because absent ids stay in the map, close-after-N (§8) is computable
from `current findings + previous ledger` alone — no external history needed.

Durability per host:
- **Local daemon:** `AGENT_MESH_MIR_DIR` (default `.dev-society/mir/`) persists on
  the host disk across runs. Baseline = newest `mir-*.json` there.
- **Cloud CI (ephemeral runners):** the `mir` job **restores** the baseline by
  downloading the `mir.json` artifact from the **most recent prior run whose `mir`
  job produced one — regardless of the overall workflow conclusion** (a failed
  nightly is exactly where hard findings live, so gating restore on workflow success
  would discard the baseline we most need). Implementation: `gh run list`/`gh run
  download` filtered to runs with a `mir.json` artifact, newest first;
  `actions/cache` keyed by a rolling key is a fast path. None found → first-run
  semantics (`baseline: null`). The new `mir.json` is uploaded as the next baseline.
  The baseline-*selection* logic is a pure, unit-tested planner; the download is host
  I/O.

## 11. Out of scope for v1 (YAGNI; v2 candidates)

- LLM-generated `critique` + SARIF-style machine-applicable `fixes`.
- Per-PR MIR; a trend-watcher that opens "plateau" issues.
- Auto-PR / auto-fix from a finding.
- Extending perf samples to always retain `runId` (additive enhancement of evidence).

## 12. Testing strategy

**Hermetic unit tests (L0 gate — pure modules, fixture JSON, no `claude`/`gh`/clock;
`at`/`now`/`ref`/`baseline` injected):**

| Test file | Covers |
|-----------|--------|
| `test/mesh-improvement-aggregate.test.js` | scorecard/perfcard/run-log/test-results JSON → `findings` + `summary`; cluster + weakest-cell; **null/missing evidence fields tolerated** |
| `test/mesh-improvement-baseline.test.js` | direction-aware `deltaPct`; **null baseline** (first run); **zero baseline** undefined-delta; top-level ledger **union** carry-forward incl. **absent ids** (`occurrences`/`cleanRuns`); ledger retains ids until close |
| `test/mesh-improvement-policy.test.js` | metric-registry direction (higher vs lower is better); hard always fileable; soft only past band; first/zero baseline → soft not fileable |
| `test/mesh-improvement-issues.test.js` | plan create/update/close; dedup by `ledger[id].issueNumber` (never body); close only at `cleanRuns ≥ N`; **`finding.id` regex validation / label+marker cannot be injected**; ledger self-heal when an issue was externally closed/deleted |
| `test/mesh-improvement-render.test.js` | MIR → `mir.md` with stable `<!-- mir:<date> -->` marker |
| `test/mesh-improvement-baseline-restore.test.js` | CI baseline-selection planner: picks the latest prior run with a `mir.json` artifact **regardless of workflow conclusion** (incl. a failed-nightly prior run); none → first-run |
| `test/tester-suite-run-builtin.test.js` | the builtin is registered & resolvable in the daemon; orchestrates collect→…→issues; `--dry-run` emits a plan and performs **no** `gh` mutation |
| `test/tester-agent-schedule.test.js` | `dev-mesh/tester/.agent/schedule.json` valid; job parses against the cadence validator; Tester is **not** wired any mutating/non-`readOnly` MCP server (mode-gating guard) |

**Integration (nightly, real, non-gating):** the builtin's actual suite execution +
MIR emission + `gh` sync rides the existing nightly pipeline; the CI `mir` job runs
live issue mutation only on the `schedule` trigger and `--dry-run` on
`workflow_dispatch` (the only two `integration.yml` triggers).

## 13. Config (env, all optional; defaults in `src/config.js`)

- `AGENT_MESH_MIR_DIR` (`.dev-society/mir`) — artifact + baseline storage (local host).
- `AGENT_MESH_MIR_NOISE_BAND_PCT` (`10`) — soft-finding regression threshold.
- `AGENT_MESH_MIR_RECOVER_RUNS` (`2`) — consecutive clean runs before an issue closes.
- `AGENT_MESH_MIR_TREND_N` (`10`) — trend-history length.
- `MESH_SCAN_LABEL` (`generated:mesh-scan`) — label for filed findings.
- repo for issues reuses the existing `DEV_SOCIETY_REPO`; `gh` auth reuses the
  daily-report path.

**CI permissions (the `mir` job).** The current `integration.yml` grants
`contents: read` only; the `mir` job additionally needs:
```yaml
permissions: { contents: read, actions: read, issues: write }
env:        { GH_TOKEN: ${{ github.token }} }
```
`actions: read` for baseline artifact/run download, `issues: write` for the sync.
Live mutation is gated on `if: github.event_name == 'schedule'`; other triggers run
`--dry-run`.

## 14. Invariants preserved

- **No Bash in agent modes** — suite execution is a framework builtin / CI step,
  never an agent tool. The Tester stays `ask`-only.
- **No mutating MCP under ask** — issue create/update/close is a host action over a
  pure plan, not an agent MCP tool; the Tester is wired only `readOnly` servers (§5).
- **Single writable root** — no *agent* mutates any folder or the repo tree. The
  framework host's trusted writes are limited to: `AGENT_MESH_MIR_DIR` (the
  artifact + baseline), the standard scheduler-owned `.agent-mesh/schedule-state.json`,
  and GitHub Issues. (`saveArtifact:false`, so no `<agent>/.agent/artifacts` copy.)
- **Untrusted data stays data** — `issues.js` consumes open-issue *metadata* only,
  never bodies; `finding.id`/markers are validated against a controlled vocabulary.
- **Failure is data** — every non-`done` eval/run outcome becomes a structured
  finding with best-effort `evidence`, never an exception.
- **Deterministic safety logic** — the fileable gate, the issue plan, and the
  baseline-selection are pure, unit-provable code; no LLM can manufacture or suppress
  a finding.

## Review log

### Round 1 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → all 8 findings accepted

- **[BLOCKER] §4/§6 execution host underspecified** — accepted. Rewrote §4 with the
  concrete daemon-builtin registration and a CI `mir` aggregation job
  (`needs:[...]` + artifact upload/download, explicit L0 run).
- **[BLOCKER] §5/§8/§14 ask-mode can't mutate GitHub via MCP** — accepted; central
  redesign. Filing moved to a **deterministic host step** executing a pure
  `issues.js` plan (new §5); the Tester stays `ask`-only with no mutating MCP.
- **[BLOCKER] §10 baseline not durable in cloud** — accepted. §10 now restores the
  baseline from the latest successful prior MIR artifact in CI; local host persists
  in `AGENT_MESH_MIR_DIR`.
- **[MAJOR] §3 run-all-tests doesn't persist JSON** — accepted. Added the additive
  `run-all-tests.mjs --json` producer change; relaxed the "no producer changes"
  claim.
- **[MAJOR] §7 evidence fields not available** — accepted. `evidence` is now
  best-effort/nullable; documented per-tier availability (preserved failure logs).
- **[MAJOR] §9 delta ambiguous for lower-is-better** — accepted. Added a metric
  registry with `direction` + signed `deltaPct` + zero/null-baseline handling.
- **[MAJOR] §8/§10 dedup/close needs deterministic history + injection risk** —
  accepted. Added the per-finding `ledger` (deterministic close-after-N); `issues.js`
  is pure over metadata only; markers validated.
- **[MINOR] §12 missing integration-seam tests** — accepted. Added builtin-registration,
  baseline-restore, dry-run/no-mutation, and mode-gating-guard tests.

### Round 2 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → all 6 findings accepted

- **[BLOCKER] §4 CI topology not executable** — accepted. §4B now uses the real job
  ids (`l1-e2e`/`l2-behavior`/`l3-adversarial`/`l4-perf`), adds a new `l0-json`
  producer, explicitly excludes L1 (no artifact), sets `mir.needs` to match, and adds
  `if: always()` so a failed producer becomes a finding.
- **[BLOCKER] §5/§8 marker-in-body vs no-body-reads contradiction** — accepted. Dedup
  is now by the persisted top-level `ledger` (`id → issueNumber`) refreshed from the
  trusted `MESH_SCAN_LABEL`; the HTML marker is a human breadcrumb only, never a dedup
  input.
- **[MAJOR] §8/§10 close-after-N input not representable** — accepted. Ledger moved to
  a **top-level map** carried for the union of ids (present + absent); `issues.js`
  receives the whole map.
- **[MAJOR] §10 baseline restore drops failed nightlies** — accepted. Restore now
  takes the most recent prior run with a `mir.json` artifact **regardless of overall
  workflow conclusion**.
- **[MAJOR] §4/§13 CI permissions** — accepted. Added the `mir` job
  `permissions: {contents:read, actions:read, issues:write}` + `GH_TOKEN`, live
  mutation gated to the `schedule` trigger.
- **[MINOR] §6/§14 saveArtifact contradicts invariant** — accepted. Set
  `saveArtifact:false`; §14 now enumerates the trusted host writes (MIR dir,
  schedule-state, Issues).

### Round 3 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → all 4 findings accepted (0 BLOCKER)

- **[MAJOR] §4B L0 artifact lost on red** — accepted. `--json` must write before the
  nonzero exit; the `l0-json` upload is `if: always()`.
- **[MAJOR] §7/§9 metric-name mismatch** — accepted. Aligned all keys to the real
  producer (`quality_per_1k_tokens`); added a note that `collect.js` does no renaming.
- **[MAJOR] §10/§12 stale "successful" in test row** — accepted. Test row now says
  "latest prior run with a `mir.json` artifact regardless of workflow conclusion."
- **[MAJOR] §2/§4 PR-context dry-run conflict** — accepted. Removed `pull_request`
  references; live on `schedule`, dry-run on `workflow_dispatch` (the real triggers).

### Round 4 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → both findings accepted (0 BLOCKER)

- **[MAJOR] §12 residual PR-context dry-run** — accepted. Fixed the integration test
  line to `schedule` live / `workflow_dispatch` dry-run.
- **[MAJOR] §9 `latency_ms_p50` not a base metric** — accepted. Registry now keys the
  base metric `latency_ms`; documented that a percentile is a summary statistic
  compared statistic-to-statistic under the base metric's direction.
