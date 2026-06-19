# Mesh Improvement Report (MIR) — Design

## 1. Goal

Give the dev-mesh a **machine-consumable improvement signal** that turns the
test/eval/run-log evidence the project already produces into **deduped backlog
issues** the society can act on — closing the missing *"assessment → improvement
task"* bridge in the self-evolve loop.

The work is **owned by the existing Tester agent** (`dev-mesh/tester/`), whose
identity is already *"I read the test/eval scorecards the workflow produced and
tell the Coder what passed, what regressed, and where."* Today the Tester is
reactive (it interprets when handed output) and produces prose. This spec makes it
**scheduled** (runs nightly + on-demand) and gives it a **durable, structured
artifact** (`mir.json`) plus the ability to **file findings as `idea` issues** the
Analyst intake loop picks up.

The MIR is not a new transport or a freestanding script. It is **agent-owned work
on a schedule**, backed by a small pure library, consistent with how
`daily-report-refresh` is a scheduled job backed by `src/report/*`.

## 2. Non-goals

- **No LLM in the report-generation path (v1).** The `mir.json` artifact — metrics,
  baseline deltas, clusters, weakest-cell, and the *fileable* gate — is produced by
  **pure deterministic code**. The agent's judgment is confined to writing issue
  prose and deduping against the live backlog; it may not overrule a deterministic
  finding.
- **No auto-fix / auto-PR.** The Tester is `ask`-only. It writes **only GitHub
  Issues** (via the GitHub MCP), never the repo tree. Code changes stay with Coder
  downstream, behind the existing approval gate.
- **No machine-applicable patch suggestions (v1).** SARIF-style `fixes` are a v2
  candidate (§11), not in scope now.
- **No new agent.** This extends the existing Tester; it does not add a `qa` role.
- **No per-PR MIR.** Per-PR CI is the hermetic L0 gate (stubbed `claude`, no live
  scorecards) — the wrong altitude. The MIR runs against the **nightly** live
  scorecards.
- **No change to any eval/test producer.** The MIR *reads* already-persisted JSON
  (`scorecard.json`, `perfcard.json`, adversarial scorecard, `delegate-*.jsonl`,
  test results). Producers are untouched.

## 3. Background — signals that already exist

Inventory of what the MIR consumes (all already persisted as JSON; see CLAUDE.md
and the eval specs):

| Tier | Signal | Source |
|------|--------|--------|
| L0 | per-file test pass/fail + timing | `run-all-tests.mjs` results array |
| L2 | behavior pass-rate + failing probes | `scorecard.json` (`scenarios[].trials[].probes[]`) |
| L3 | security invariants I1–I7 | adversarial `scorecard.json` |
| L4 | routing / efficiency / quality per task | `perfcard.json` (`samples[]`, `summary{p50,p95,mean}`) |
| — | per-delegation cost/tokens/files/status | `delegate.js` run records (`.agent-mesh/logs/delegate-*.jsonl`) |

The connective tissue that does **not** exist yet, and that this spec adds: a
**baseline to diff against**, a **unified envelope**, a **tiered fileable gate**,
and the **finding → deduped issue** bridge.

## 4. Architecture

Follows the repo's **pure-core / thin-impure-shell** split, mirroring
`src/report/aggregate.js` (pure) + the `daily-report-refresh` job (impure host).

```
src/mesh-improvement/
  collect.js   (impure)  — locate & read latest scorecard/perfcard/adversarial/
                           run-log/test-result JSON from disk; returns raw inputs
  aggregate.js (pure)    — raw inputs → MIR { summary, findings } (no deltas yet);
                           assigns cluster + weakestCell + evidence per finding
  baseline.js  (pure)    — previous mir.json + current MIR → per-metric signed delta
  policy.js    (pure)    — tiered threshold gate → finding.fileable (bool) + severity
  render.js    (pure)    — MIR → mir.md (human) ; the MIR object IS mir.json (machine)
  issues.js    (pure)    — fileable findings + open-issue snapshot →
                           [{ id, title, body, labels, marker, action }]
```

**Purity rule:** `aggregate`/`baseline`/`policy`/`render`/`issues` take all
time/identity as **injected parameters** (`at`, `now`, `ref`, `baseline`) — never
`Date.now()`. Only `collect.js` reads disk. This makes the whole report engine
unit-testable with fixture JSON, no `claude`/`gh`/clock.

**Deployment-agnostic execution host.** Suite *execution* + MIR *generation* is done
by whichever host is running the society:

- **Local daemon:** a `builtin` scheduled job (`tester-suite-run`) runs the suites
  via `child_process` and then calls `collect → aggregate → baseline → policy →
  render`, writing `mir.json` + `mir.md`. Builtins run framework-side (like
  `daily-report-refresh`), so this never violates the *no-Bash-in-agent-modes*
  invariant — the agent itself never shells out.
- **Cloud (GitHub Actions):** the existing nightly `integration.yml` already runs
  the suites as shell steps; a final step calls the same `src/mesh-improvement`
  library to emit `mir.json` + `mir.md` as a workflow artifact.

Both hosts produce the identical artifact. The Tester's assessment job is identical
in both.

## 5. The Tester agent changes

`dev-mesh/tester/` gains:

1. **`.agent/schedule.json`** with two jobs (§6).
2. **A new skill** `skills/file-improvement-findings/SKILL.md` — the procedure for
   turning `mir.json` fileable findings into deduped backlog issues (§8).
3. **`prompts/ask.md`** updated to invoke the new skill when assessing.
4. **`AGENT.md` / `agent.json`** updated to declare the scheduled + issue-filing
   capability (still `ask`-only; new skill listed in `agent.json.skills`).

`mesh.json`: the Tester entry stays `enabledModes: ["ask"]`. No new agent row. The
Tester needs the **GitHub MCP server** wired (issue create/update/close) — added to
its `.mcp.json` via `doctor` with the appropriate `x-agentmesh` marker, per
`registering-mesh-mcp-servers`. (Credential note: GitHub token via the standard
`gh`/MCP auth the daily-report path already uses.)

The existing `interpret-scorecard` and `read-mesh-health` skills are unchanged and
still usable for ad-hoc, human-prompted interpretation.

## 6. Scheduled jobs

`dev-mesh/tester/.agent/schedule.json`:

| Job | kind | cadence | role |
|-----|------|---------|------|
| `tester-suite-run` | `builtin` | nightly (after integration) | Run suites + emit `mir.json` + `mir.md`. No model. |
| `tester-assess` | prompt (`ask`) | shortly after `tester-suite-run` | `claude -p` ask-mode: read `mir.json`, reconcile with open backlog, file/update/close issues. |

Cadence uses the existing scheduler shapes (`src/schedule/schedule-cadence.js`):
`{kind:'daily', at:'HH:MM'}`. Defaults: `tester-suite-run` at the post-integration
hour; `tester-assess` offset later the same night. Both `enabled: true`,
`saveArtifact: true`.

**On-demand:** the same builtin is exposed as a thin hidden CLI verb
(`agent-mesh tester-report [mesh-root]`) for local runs and tests; `tester-assess`
supports `--dry-run` (prints the issue plan without calling `gh`, mirroring
`daily-report.mjs --dry-run`).

State is tracked in the standard `.agent-mesh/schedule-state.json` (`lastRunAt`,
`lastStatus`, `lastSummary`, `nextRunAt`, `running`) — no new state mechanism.

## 7. The MIR artifact (`mir.json`, schema v1)

```jsonc
{
  "schema": "mesh-improvement-report/v1",
  "at": "2026-06-20T06:00:00Z",            // injected, not Date.now()
  "ref":      { "commit": "fb403fe", "branch": "main" },
  "baseline": { "commit": "321f6d7", "at": "..." },   // null on first run

  "summary": {                              // top-of-funnel, per tier
    "tests":       { "green": 179, "red": 1,    "delta": -1 },
    "behavior":    { "passRate": 0.889,         "delta": 0.02 },
    "adversarial": { "invariantsPassed": "7/7", "delta": 0 },
    "perf":        { "quality_per_1k_p50": 333, "delta": -18, "wasted_hops_p50": 1 }
  },

  "findings": [
    {
      "id": "perf:6x-confusable:routing-precision",   // stable dedup key
      "tier": "soft",                                  // "hard" | "soft"
      "cluster": "wrong-peer-selection",               // failure taxonomy
      "severity": "warning",                           // "error"|"warning"|"note"
      "metric": { "name": "precision", "value": 0.6, "baseline": 0.9, "delta": -0.3 },
      "weakestCell": { "peers": 6, "overlap": "confusable" },
      "evidence": {
        "trace": "delegated to peer C; ground truth was peer B",
        "runId": "delegate-2026-...-abc",
        "logPath": ".agent-mesh/logs/delegate-2026-06-20.jsonl",
        "scorecardPath": "eval-perf-results/2026-06-20.../perfcard.json"
      },
      "fileable": true                                 // policy.js gate output
    }
  ],

  "trend": { "passRate": [0.85, 0.87, 0.889], "quality_per_1k": [351, 348, 333] }
}
```

Field roles (each grounded in self-improving-agent research — Reflexion,
Self-Refine, SICA, ADAS, the 2025 Self-Evolving Agents survey):

- `metric.delta` — signed accept/reject signal; the most actionable field.
- `evidence` — the localizable failure trace (a score without a trace is
  un-actionable).
- `cluster` + `weakestCell` — structural-fix targeting, not per-case patching.
- `id` — stable key for dedup and trend continuity.
- `fileable` — the deterministic policy gate (§9); the agent does not decide this.

`mir.md` is a human render of the same data (summary table + findings list) with a
`<!-- mir:<date> -->` marker for idempotent posting.

`mir.json`, `mir.md`, and the rolling baseline live under `AGENT_MESH_MIR_DIR`
(default `.dev-society/mir/`), keyed by date/commit. The previous run's `mir.json`
is the baseline for the next (§10).

## 8. Finding → backlog issue (`tester-assess`)

The agent reads `mir.json` and reconciles `fileable` findings with the live backlog
via the GitHub MCP. **Deterministic findings are ground truth; the agent owns only
wording + dedup.**

Each fileable finding is keyed by a hidden marker
`<!-- mesh-scan:<finding.id> -->` (same dedup pattern as `mesh-health/heartbeat.js`
escalations):

- **No open issue with that marker** → **create**. Labels: `idea` +
  `generated:mesh-scan` + tier label (`regression` for hard, `perf`/`routing` etc.
  for soft). Title from `cluster` + `metric.name`; body = factual summary +
  `evidence` + `metric` (value/baseline/delta) + path to `mir.json`. The Analyst
  intake loop then picks it up as a normal `idea`.
- **Open issue exists** → **update** (refresh metric/delta, increment an occurrence
  count in the body). Never duplicate.
- **Finding absent for ≥ `AGENT_MESH_MIR_RECOVER_RUNS` consecutive runs** →
  **comment + close** ("resolved as of `<commit>`; delta back within band").

The agent writes only to Issues — never the repo tree, never a PR.

## 9. Tiered fileable gate (`policy.js`)

Deterministic, computed into `finding.fileable` before the agent runs:

- **Hard signals — always fileable**, `severity: error`, label `regression`/`security`:
  - a red test in `run-all-tests` results,
  - a failed invariant I1–I7 in the adversarial scorecard,
  - an `error`/`timeout` status in a run-log record for an eval run.
- **Soft signals — fileable only past a noise band** (`severity: warning`):
  behavior pass-rate, routing precision/recall, quality-per-token, cost. Fileable
  iff the **negative** delta magnitude exceeds `AGENT_MESH_MIR_NOISE_BAND_PCT`
  (default 10%). This guards against live-`claude` eval variance flooding the
  backlog.
- First run (no baseline): soft findings have `delta: null` and are **not**
  fileable (no regression can be established); hard signals still file.

## 10. Baseline & trend

- Baseline = the **previous stored `mir.json`** under `AGENT_MESH_MIR_DIR`. Each run
  diffs current metrics against it to compute `delta`. Self-contained; no external
  store; first run yields `baseline: null` and `delta: null` (valid data).
- `trend` carries the last *N* values per headline metric (sliced from the stored
  history), letting a future trend-watcher detect plateaus/regressions. (v1 emits
  the array; acting on it is v2.)

## 11. Out of scope for v1 (YAGNI; v2 candidates)

- LLM-generated `critique` + machine-applicable `suggestions[].patch` (SARIF
  `fixes` shape).
- Per-PR MIR.
- Rolling-window / median baselines to further smooth eval noise.
- A trend-watcher that opens "plateau" issues.
- Auto-PR / auto-fix from a finding.

## 12. Testing strategy

**Hermetic unit tests (L0 gate — pure modules, fixture JSON, no `claude`/`gh`/clock):**

| Test file | Covers |
|-----------|--------|
| `test/mesh-improvement-aggregate.test.js` | scorecard/perfcard/run-log JSON → `findings` + `summary`; cluster + weakest-cell |
| `test/mesh-improvement-baseline.test.js` | signed deltas; **null deltas on first run** |
| `test/mesh-improvement-policy.test.js` | tiered gate: hard always fileable; soft only past band; band config-driven; first-run soft not fileable |
| `test/mesh-improvement-issues.test.js` | findings → `{id,title,body,labels,marker,action}`; create/update/close; recovered-finding close after N clean runs |
| `test/mesh-improvement-render.test.js` | MIR → `mir.md` with stable `<!-- mir:<date> -->` marker |
| `test/tester-agent-schedule.test.js` | `dev-mesh/tester/.agent/schedule.json` valid; both jobs parse against the cadence validator; `agent.json` lists the new skill |

All deterministic: `at`/`now`/`ref`/`baseline` injected. Fixtures are trimmed real
`scorecard.json` / `perfcard.json` / `delegate-*.jsonl`.

**Integration (nightly, real, non-gating):** the `tester-suite-run` builtin's actual
suite execution + MIR emission rides the existing nightly integration pipeline. The
`tester-assess` GitHub side is exercised via `--dry-run` in CI (prints the issue
plan; no `gh` mutation).

## 13. Config (env, all optional; defaults in `src/config.js`)

- `AGENT_MESH_MIR_DIR` (`.dev-society/mir`) — artifact + baseline storage.
- `AGENT_MESH_MIR_NOISE_BAND_PCT` (`10`) — soft-finding delta threshold.
- `AGENT_MESH_MIR_RECOVER_RUNS` (`2`) — clean runs before a finding's issue closes.
- `AGENT_MESH_MIR_TREND_N` (`10`) — trend-history length.
- `MESH_SCAN_LABEL` (`generated:mesh-scan`) — label for filed findings.
- repo for issues reuses the existing `DEV_SOCIETY_REPO`.

## 14. Invariants preserved

- **No Bash in agent modes** — suite execution is a framework `builtin`/CI step, never
  an agent tool. The Tester stays `ask`-only.
- **Single writable root** — the Tester writes only GitHub Issues (external surface),
  never any agent folder or the repo tree.
- **Failure is data** — every non-`done` eval/run outcome becomes a structured
  finding with a `log_path`/`evidence`, never an exception.
- **Deterministic safety logic** — the fileable gate is pure, unit-provable code; the
  LLM cannot manufacture or suppress a regression finding.
- **Producers untouched** — the MIR only reads already-persisted artifacts.
