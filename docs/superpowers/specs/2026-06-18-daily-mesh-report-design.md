# Daily Mesh Report — design

**Date:** 2026-06-18
**Status:** design (approved sections; pending written-spec review)
**Topic:** a daily PR / Issue / Token report for the self-hosting mesh, delivered as a GitHub issue digest (with a deferred dashboard view).

## 1. Problem & goal

The mesh develops itself 24/7 across two execution worlds: the **GitHub-Actions Dev-mesh** (research/intake/triage/review/curate/… — many ephemeral cloud runs) and the **local A2A Dev-Society daemon** (this host's Coder/Reviewer A2A runs + local delegations). There is no single place to see, each day: *what PRs and issues moved, and how many tokens the mesh burned.*

**Goal:** a once-a-day digest of **PRs**, **Issues**, and **Tokens** (both execution worlds), delivered somewhere reachable from a phone with no tunnel, and honest about what each number can and cannot measure.

### Non-goals
- Real-time streaming (the dashboard already covers live drill-down).
- Per-call billing reconciliation against Anthropic invoices.
- Reporting cross-repo; this is single-repo (`DEV_SOCIETY_REPO`).

## 2. Decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Primary surface | **GitHub-issue digest** + a deferred dashboard panel | Phone-native via the GitHub app, no host tunnel, no host-up dependency for *reading* |
| Who generates it | **The always-on host** | Already has `gh` + local token logs on disk; one place to merge all sources |
| Token scope | **Both** local mesh **and** CI mesh | "full CI token capture" requested |
| CI token transport | **Per-run artifact** (deposit → host pulls) | Race-free, GitHub-native, reuses the envelope `assert-run-healthy` already parses |
| Issue strategy | **One rolling pinned issue, one dated comment per day** | History in one place; idempotent re-runs |
| Schedule | **08:00 host-local**, daily | Sensible default; configurable |
| Dashboard | **Deferred to P3** | An Activity tab + `activity-stats.js` reducer already exist; reuse, don't duplicate |

## 3. Architecture

Pure report **core** + thin impure **adapters**, matching the repo's core/shell split.

```
 SOURCES (impure: src/report/sources.js)     CORE (pure)                DELIVERY
 ┌────────────────────────┐
 │ gh: PRs / issues        │──┐
 ├────────────────────────┤  │   ┌──────────────────┐    renderMarkdown ─▶ gh issue comment
 │ local logs              │──┼──▶│ aggregate()      │──▶ (P1/P2)
 │ (.agent-mesh/logs + ledger)│  │   │ → DailyReport    │
 ├────────────────────────┤  │   └──────────────────┘    renderModel ────▶ dashboard /api/daily
 │ CI usage artifacts      │──┘                                            (P3, deferred)
 │ (gh run download)       │
 └────────────────────────┘
```

### Modules
- **`src/report/usage.js`** (pure) — `extractUsage(envelope) → { input, output, cacheRead, turns, costUsd, model }`. The single normalizer for a Claude result envelope's `usage` block. Used by **both** CI capture and local-log parsing so the two streams are shaped identically. Builds on the existing `extractResultEnvelope` (src/dev-mesh/health.js) and `parseResultEnvelope` (src/delegate.js).
- **`src/report/aggregate.js`** (pure) — `aggregate({ prs, issues, localRecords, ciRecords, date, now }) → DailyReport`. No I/O, no `Date.now()` (inject `now`), deterministic — same contract style as `activity-stats.js`.
- **`src/report/render.js`** (pure) — `renderMarkdown(report) → string`, `renderModel(report) → object`.
- **`src/report/sources.js`** (impure shell) — `fetchGh(gh, window)`, `readLocalLogs(fs, logDir, date)`, `fetchCiUsage(gh, window)`. Each takes its effectful dependency as an argument (the `dev-society/core` injection pattern) so tests stub them.
- **`scripts/daily-report.mjs`** (entrypoint) — wires sources → core → delivery.

## 4. Data model

```js
DailyReport = {
  date: "2026-06-18",                  // calendar day, host-local tz (TZ configurable)
  window: { fromISO, toISO },          // [00:00, 24:00) of `date` in host tz
  prs: {
    opened:  [{ number, title, author, url }],
    merged:  [{ number, title, url }],
    closed:  [{ number, title, url }], // closed-unmerged
    openNow: Number,                   // snapshot count of open PRs
  },
  issues: {
    opened:  [{ number, title, labels, url }],
    closed:  [{ number, title, url }],
    openByLabel: { approved: 3, blocked: 1, "spec:in-review": 2, … },  // snapshot
  },
  tokens: {
    local: { input, output, turns, costUsd, runs, byRoute: { coder:{…}, reviewer:{…} } },
    ci:    { input, output, turns, costUsd: 0, runs, byWorkflow: { review:{…}, triage:{…} }, uncaptured: N },
    total: { input, output, turns },
  },
  health: { unhealthyRuns: N, blocked: [{ workflow, runId, url }] },  // from classifyRunHealth
  meta: { generatedAtISO, hostLabel, partial: Boolean },             // partial=true if a source failed
}
```

Honesty rules baked into the model:
- `tokens.ci.costUsd` is always `0` with a rendered footnote: *subscription auth reports $0*.
- `tokens.ci.uncaptured` counts in-window runs with **no** usage artifact (pre-capture runs, or runs that errored before upload). Never silently dropped.
- `meta.partial = true` when any source adapter throws (e.g. `gh` rate-limited); the digest still posts, flagged partial, with the failed section marked.

## 5. CI token capture (P2)

The 14 agent workflows share one seam today: `claude-code-action` (id `claude`) → `CLAUDE_EXECUTION_FILE` → `node scripts/assert-run-healthy.mjs`. That script **already parses the `usage` block**.

### Composite action `.github/actions/agent-postrun`
Replaces each workflow's bare assert step. Inputs: `execution_file`, `advisory_blocked` (bool). Steps:
1. `node scripts/assert-run-healthy.mjs` — unchanged honesty-gate behavior, but **also** writes `$RUNNER_TEMP/mesh-usage.json`:
   ```json
   { "ts":"…", "workflow":"$GITHUB_WORKFLOW", "runId":"$GITHUB_RUN_ID",
     "ref":"$GITHUB_REF", "issueOrPr": <derived>, "usage": { …extractUsage… } }
   ```
   (Writing the usage file is `try/catch` and **must never** change the gate's exit code — capture failure is not a run failure.)
2. `actions/upload-artifact@v4` with `name: mesh-usage-${{ github.run_id }}`, `path: $RUNNER_TEMP/mesh-usage.json`, `retention-days: 7`, `if: always()` (capture even when the gate fails).

### Workflow edits
Each of the 14 dev-mesh workflows swaps `run: node scripts/assert-run-healthy.mjs <flags>` → `uses: ./.github/actions/agent-postrun` with `advisory_blocked` set per its current flag. Logic stays in one place. Shape is lint-checked the way `test/integration-workflow.test.js` validates workflow structure.

### Host aggregation
In `fetchCiUsage`:
1. `gh run list --json databaseId,workflowName,createdAt,conclusion --limit N` → filter `createdAt ∈ window`.
2. For each run: `gh run download <id> -n mesh-usage-<id> -D <tmp>`; parse; missing artifact → `uncaptured++`.
3. Group by `workflowName`, sum via `extractUsage` shape.

## 6. Delivery: rolling pinned issue (P1)

`scripts/daily-report.mjs [--date YYYY-MM-DD] [--post] [--dry-run]`:
- **Find/create** the digest issue: search by label `mesh:daily-report` (created on first run, title `📊 Daily Mesh Report`, pinned). One issue for all time.
- **Idempotent post:** render the day's Markdown, wrap with a hidden marker `<!-- daily-report:<date> -->`. If a comment with that marker exists → **edit** it; else **add** a new comment. Re-running for a date never duplicates.
- `--dry-run` prints Markdown to stdout, posts nothing (default in `--selftest`-style local checks).

Rendered shape (`renderMarkdown`):
```
### 📊 Daily Mesh Report — 2026-06-18

**PRs**  · opened 4 · merged 3 · closed 1 · open now 7
  #106 chore(dev-mesh): re-init agent wiring …
  …
**Issues**  · opened 2 · closed 1 · open: approved 3, blocked 1, spec:in-review 2
  …
**Tokens**
| stream | input | output | turns | cost |
| local  | 1.2M  | 340K   | 18    | $4.10 |
| ci     | 8.7M  | 1.1M   | 142   | $0* (47 runs, 2 uncaptured) |
| total  | 9.9M  | 1.44M  | 160   | |
  *subscription auth reports $0

_generated 08:00 · host dev-society · partial: no_
```

## 7. Scheduling (P1)

Fold into the installer built in `feat/dev-society-247-installer` (`scripts/dev-society-install.sh`):
- New subcommand `install-report` (and include it in `install`):
  - **macOS:** a `StartCalendarInterval` LaunchAgent `com.danabaxia.agent-mesh.dev-society-report` (Hour 8, Minute 0) running `node scripts/daily-report.mjs --post`. (Calendar-scheduled, not `KeepAlive`.)
  - **Linux:** a systemd `--user` timer (`dev-society-report.timer`) `OnCalendar=*-*-* 08:00:00`.
- Reads `DEV_SOCIETY_REPO` (required), `DAILY_REPORT_HOUR` (default 8), `TZ` from the host.
- Logs to `.dev-society/daily-report.out.log`.

## 8. Dashboard (P3 — deferred, designed at high level only)

The dashboard already has an **Activity tab** backed by the pure `activity-stats.js` reducer (per-agent, range-based `today/week/month`, KPIs incl. `turns`, `a2aOut{ok,fail}`, `toolCalls`, `avgRunMs`). It already does the **local-mesh** half of aggregation — but per-agent and without token *counts*.

P3 plan (not detailed here): add a `Daily` tab (`public/daily-tab.js`) + `GET /api/daily?date=` route in `src/dashboard/server.js` that calls the **same report core**. Extend `activity-stats.js` to carry token `input`/`output` (currently only `turns`) so local aggregation isn't duplicated. The new-to-dashboard parts are the **whole-mesh day rollup**, **PR/Issue** stats, and the **CI-token** merge. Decided after P1/P2 prove the core + data model.

## 9. Testing (hermetic, zero-dep `node --test`)

Pure (the bulk):
- `extractUsage` over real envelope fixtures: a healthy `done` envelope, an errored envelope (usage present), a no-usage tail (→ zeros, not throw).
- `aggregate()` from fixture `prs/issues/localRecords/ciRecords` → asserts counts, per-route/per-workflow sums, `total`, `uncaptured`, `partial`.
- `renderMarkdown`/`renderModel` snapshot on a fixed `DailyReport` (deterministic; injected `generatedAt`).
- window/tz bounds (reuse the `rangeBounds`-style injected-`now` discipline).
- comment-marker idempotency: given existing comments, decide add-vs-edit correctly.

Impure (injected stubs, the `dev-society` pattern):
- `sources.js` with stub `gh`/fs returning fixtures; assert it shapes records for the core.
- composite-action presence/shape + each workflow references `agent-postrun` — extend `test/integration-workflow.test.js`.

No live `gh`/`claude` in the default suite. A `--selftest` flag on `daily-report.mjs` proves wiring with stubs (mirrors `dev-society-daemon.mjs --selftest`).

## 10. Build order

- **P1** — `usage.js` + `aggregate.js` + `render.js` + `sources.js` (local + gh) + `daily-report.mjs` + rolling-issue post + scheduling. End-to-end digest with **local tokens + PR/Issue** (CI section shows `0 runs` until P2). Shippable alone.
- **P2** — `agent-postrun` composite action + usage-file emit + artifact upload + `fetchCiUsage` host aggregation. The **both-sources** milestone.
- **P3** — dashboard `Daily` tab (deferred; section 8).

## 11. Security / invariants

- Read-only against GitHub except: creating/commenting/editing the single digest issue, and pinning it. No code writes, no merges — consistent with the daemon's "never merges" boundary.
- The usage artifact carries only token counts/turns/cost/workflow/run metadata — no source, no secrets. `assert-run-healthy` already masks; this writes strictly less.
- Capture must be **side-effect-free on the gate**: a failed usage write or upload never changes a workflow's pass/fail. The honesty gate's authority is unchanged.
- `daily-report.mjs` honors `AGENT_MESH_LOG_DIR` and the same `realpath` log-dir resolution as the rest of the framework.

## 12. Open defaults (confirm at spec review)
- Rolling pinned issue + dated comment (vs new issue/day). **Default: rolling.**
- 08:00 host-local schedule. **Default: 08:00.**
- Artifact retention 7 days. **Default: 7.**
- Report window = previous full calendar day when run at 08:00 (vs "last 24h"). **Default: previous calendar day.**
