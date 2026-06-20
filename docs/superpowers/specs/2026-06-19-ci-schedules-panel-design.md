# CI Schedules Panel — Design

## 1. Goal

Surface the project's **GitHub Actions cron-scheduled workflows** (the nightly
`integration.yml` that runs the MIR job, plus the ~13 `dev-mesh-*` society crons) in
the dashboard's **SCHEDULES panel**, alongside the mesh daemon's scheduled jobs, each
labeled by its **executor**. Today the panel (`/api/schedules` → Graph-view
"⏱ SCHEDULES") shows only the daemon scheduler's jobs; GitHub Actions crons — a
whole half of the autonomous mesh's scheduling — are invisible there. This adds a
read-only "GitHub Actions" group so an operator sees *all* scheduled automation in
one place.

## 2. Non-goals

- **No dispatch/"run now" for CI rows (v1).** Read-only — workflow · cron · last
  run · conclusion only. Triggering (`gh workflow run`) is a v2 add (it's a new
  privileged mutation surface).
- **No new `gh` calls.** Last-run/status is derived from the **already-cached**
  `.dev-society/gh-activity.json` (polled every 5 min by the orchestrator's
  `gh-activity-poll`). Cron is parsed from the workflow YAML. Degrades to `—` when
  the cache has no recent run for a workflow.
- **No cron→next-run computation.** We display the cron expression (and a light
  label for trivial cases); computing the next fire time would need a cron library
  (zero-dep repo). Out of scope.
- **No change to `/api/schedules`** — its tested contract (daemon jobs) is untouched;
  CI is a separate additive route.
- **Only `schedule:`/`cron:` workflows.** push/pull_request/dispatch-only workflows
  are not schedules and are excluded.

## 3. Background (verified)

- Daemon jobs: `listAllSchedules` (`src/schedule/list-all.js`) →
  `GET /api/schedules` → `graph-view.js loadSchedules` renders the SCHEDULES table.
- The dashboard already computes `repoRoot = resolve(meshRoot, '..')`
  (`server.js:231`), so `repoRoot/.github/workflows/*.yml` is reachable.
- `.dev-society/gh-activity.json` records (`src/dev-society/gh-activity.js`):
  - node record: `{ id:"gh-<dbid>", agent, route:"ci:<workflowDisplayName>", started_at, finished_at? }`
  - edge record: `{ id:"gh-<dbid>:e", kind:"a2a", status:<conclusion|null>, started_at, finished_at? }`
  - **`route` uses the workflow's display `name:` field, not the filename.** Conclusion
    (`status`) lives only on the **edge** record, which is emitted only for
    non-orchestrator workflows; orchestrator-mapped workflows (incl. `integration`)
    have a node record but **no status** in the cache.
- The poll keeps a ~120-min window, so a nightly workflow is in the cache only near
  its run time — most of the day its last-run shows `—` (acceptable, by §2).

## 4. Architecture

```
repoRoot/.github/workflows/*.yml ──parseCronWorkflows──┐
                                                         ├─ listCiSchedules ─► GET /api/ci-schedules ─► loadSchedules()
.dev-society/gh-activity.json ───────(enrich)────────────┘                                              renders 2 groups:
                                                                                                         • mesh agents (existing)
                                                                                                         • GitHub Actions (new)
```

Parallels the daemon track; reuses the gh-activity cache for status. The SCHEDULES
table gains a second `<tbody>` group; both rows carry an executor.

## 5. Components

### 5.1 `src/dev-society/ci-schedules.js` (pure)
- `parseCronWorkflows(files) → [{ workflow, file, crons }]` where `files: [{name, text}]`.
  For each file, extract the top-level `name:` (→ `workflow`; fallback to the file
  basename sans extension) and every `cron: '…'` under a `schedule:` block, via regex
  over the YAML text (the repo's established no-YAML-dep lint pattern, cf.
  `integration-workflow.test.js`). Files with no `schedule:`/`cron:` are excluded.
- `latestCiRuns(ghActivity) → Map<workflowDisplayName, { lastRunAt, running, status }>`:
  from the gh-activity array, for each node record whose `route` starts `ci:`, key by
  `route.slice(3)`, keep the latest by `started_at`; `lastRunAt = finished_at || started_at`,
  `running = !finished_at`; `status` = the matching `"<id>:e"` edge record's `status`
  (or `null` if no edge / not present).
- `listCiSchedules({ files, ghActivity }) → [{ executor:'GitHub Actions', workflow,
  file, cron, cadenceLabel, lastRunAt, running, status }]`: combine — for each parsed
  workflow, `cadenceLabel` = the joined cron expression(s) (e.g. `cron 0 7 * * *`);
  attach the `latestCiRuns` entry for its `workflow` name, or nulls when absent.
  Sorted by `file`.

### 5.2 Route `GET /api/ci-schedules` (`src/dashboard/server.js`)
Cookie-gated identically to `/api/schedules` (403 without the same-origin cookie).
Reads `repoRoot/.github/workflows/*.yml` (each file's text) + the gh-activity cache
(reuse the existing cache path/reader), calls `listCiSchedules`, returns
`{ workflows: [...] }`. Missing workflows dir or cache → `{ workflows: [] }` (never
throws). The existing `/api/schedules` route is unchanged.

### 5.3 UI — `graph-view.js loadSchedules`
After rendering the daemon jobs, fetch `/api/ci-schedules` and append a labeled
**"GitHub Actions"** group to the same SCHEDULES table:
- executor·name column: `GitHub Actions · <workflow>` (distinct color/label from agents).
- cadence: the cron expression(s).
- last: conclusion pill (`ok`/`fail`/`—`) from `status`; `running` → running pill.
- next run: `—` (no cron next-run computation, §2).
- no run button (read-only).
The header count line includes both groups (e.g. "5 mesh jobs · 14 CI workflows").
A CI fetch failure leaves the daemon group intact (the CI group just shows nothing).

## 6. Testing

**Hermetic unit tests (no `gh`/network):**

| Test | Covers |
|------|--------|
| `test/ci-schedules.test.js` | `parseCronWorkflows`: single + multi `cron:` extraction; top-level `name:` capture (+ basename fallback); schedule-less workflow excluded. `latestCiRuns`: keys by display name, picks latest by `started_at`, joins `:e` edge `status`, `running` when no `finished_at`. `listCiSchedules`: workflow with a cached run → enriched; workflow absent from cache → `lastRunAt:null, status:null`; orchestrator-mapped (no edge) → `status:null` but `lastRunAt` set. |
| `test/ci-schedules-route.test.js` | `GET /api/ci-schedules`: cookie-gated (403 without cookie); with a temp `repoRoot/.github/workflows` fixture + a gh-activity fixture → returns the expected `{workflows}`; missing dir/cache → `{workflows: []}` (no throw). |

UI (`graph-view.js`) rendering is exercised manually (browser); no DOM unit test
harness exists for it — keep the change a thin render of the tested `listCiSchedules`
shape.

## 7. Config / scope

No new env vars. Reuses the gh-activity cache path the dashboard already reads.
v2 candidates: dispatch button (`gh workflow run`), cron→next-run, fresh `gh run list`
for authoritative status, surfacing non-cron workflow triggers.

## 8. Invariants preserved

- **Read-only window.** Like `/api/schedules`, the CI route only *reads* (workflow
  files + the gh cache); no mutation, no `gh` invocation.
- **Additive.** `/api/schedules` and `listAllSchedules` are untouched; the daemon
  scheduler is unaffected.
- **Degrades, never throws.** Missing workflows dir, unparseable YAML, or absent
  gh-activity cache yield empty/`—`, not errors.
