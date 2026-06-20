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
  the cache has no recent run for a workflow. **The cache drops the trigger `event`**,
  so what we show is the **"latest cached run"** of the workflow, NOT necessarily its
  last *scheduled* run (many scheduled workflows also fire on `workflow_dispatch`/
  `push`); the UI labels it accordingly. **Conclusion coverage is partial:** status
  lives only on the gh-activity `:e` edge record, which is emitted only for
  non-orchestrator workflows — so every `workflowToAgent`→`orchestrator` workflow
  shows last-run time but `—` conclusion. **`workflowToAgent` maps a fixed `ROLE`
  set and defaults ALL other names to `orchestrator`**, so this is the majority of
  scheduled workflows — non-exhaustive examples: `integration`, `dev-mesh-health`,
  `dev-mesh-dogfood`, `dev-mesh-pr-janitor`, `dev-mesh-memory-automerge`, plus any
  unmapped name (`dev-mesh-issue-gate`, `dev-mesh-automerge`, `dev-mesh-escalate`,
  `dev-mesh-security`, …). Only the explicitly-mapped roles (analyst/maintainer/
  triager/reviewer/curator/coder) get a `:e` edge and thus a conclusion.
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
  Use an **indentation/section-aware line scanner** (not blind regex), since real
  workflows contain many nested `name:` keys and commented crons:
  - `workflow` = the **first column-0 (top-level) `name:` value** (strip quotes);
    fallback to the file basename sans `.yml`. (Nested `jobs.*.name`/`steps.*.name`
    are indented, so the column-0 rule ignores them.)
  - `crons` = every `cron:` value found **inside the `on:` → `schedule:` block only**
    (track the `on:` section and its `schedule:` child by indentation; stop at the
    next top-level key). **Skip lines whose first non-space char is `#`** (full-line
    commented crons). **Comment-safe scalar extraction:** read the cron *value* as the
    quoted scalar (`'…'`/`"…"`) — ignoring any trailing inline comment after the
    closing quote (e.g. `- cron: '*/30 * * * *' # poll` → `*/30 * * * *`); for an
    unquoted value, strip a trailing ` #…`. A workflow with no in-`schedule` cron is
    excluded.
- `normalizeCiStatus(conclusion) → 'ok' | 'fail' | null` (pure): maps the raw GitHub
  conclusion — `success`→`ok`; `failure`/`timed_out`/`startup_failure`→`fail`;
  `cancelled`/`skipped`/`neutral`/`action_required`/`null`/missing→`null` (renders `—`).
- `latestCiRuns(ghActivity) → Map<workflowDisplayName, { lastRunAt, running, status }>`:
  from the gh-activity array, for each node record whose `route` starts `ci:`, key by
  `route.slice(3)`, keep the latest by `started_at`; `lastRunAt = finished_at || started_at`,
  `running = !finished_at`; `status = normalizeCiStatus(<matching "<id>:e" edge record's status>)`
  (`null` when no edge — e.g. orchestrator-mapped workflows — or no run cached).
- `listCiSchedules({ files, ghActivity }) → [{ executor:'GitHub Actions', workflow,
  file, cron, cadenceLabel, lastRunAt, running, status }]`: combine — `cadenceLabel` =
  the joined cron expression(s) (e.g. `cron 0 7 * * *`); attach the `latestCiRuns`
  entry for its `workflow` name, or nulls when absent. Sorted by `file`. **Always
  returns a row per parsed cron workflow regardless of cache contents** (status just
  degrades to `null`).

### 5.2 Route `GET /api/ci-schedules` (`src/dashboard/server.js`)
Cookie-gated identically to `/api/schedules` (403 without the same-origin cookie).
Reads `repoRoot/.github/workflows/*.yml` (each file's text) + the gh-activity cache
(reuse the existing cache path/reader), calls `listCiSchedules`, returns
`{ workflows: [...] }`. **Cache behavior (per review):** a **missing/corrupt
gh-activity cache** is treated as an empty activity array — the route still returns
the **parsed cron workflows** (status `—`); only a **missing/unreadable workflows
dir** yields `{ workflows: [] }`. Never throws. The existing `/api/schedules` route
is unchanged.

### 5.3 UI — `graph-view.js loadSchedules`
**Fetch both routes before the empty-state decision** (per review — the current
`loadSchedules` early-returns when daemon `jobs` is empty, which would hide the CI
group in a CI-only/empty-daemon state). Render the empty placeholder only when
**both** groups are empty. Append a labeled **"GitHub Actions"** group to the same
SCHEDULES table:
- executor·name column: `GitHub Actions · <workflow>` (distinct color/label from agents).
- cadence: the cron expression(s).
- last: pill from the already-normalized `status` (`ok`/`fail`/`—`); `running` → running pill.
  (`status` is normalized in §5.1, so the daemon pill helper renders CI results correctly.)
- next run: `—` (no cron next-run computation, §2).
- no run button (read-only).
The header count line includes both groups (e.g. "5 mesh jobs · 14 CI workflows").
A CI fetch failure leaves the daemon group intact (the CI group just shows nothing).
The "last" column header/tooltip reads **"latest cached run"** — NOT "last scheduled
run": the gh-activity cache drops the trigger `event`, and several scheduled
workflows also have `workflow_dispatch`/`push`/`issues` triggers, so the cached run
may not have been a scheduled one (§2).

## 6. Testing

**Hermetic unit tests (no `gh`/network):**

| Test | Covers |
|------|--------|
| `test/ci-schedules.test.js` | `parseCronWorkflows`: single + multi `cron:` extraction; top-level `name:` capture vs **nested `jobs.*.name`/`steps.*.name` ignored** (indentation); **commented-out `cron:` (leading `#`) excluded**; **inline trailing comment after a quoted cron stripped** (fixture: `- cron: '*/30 * * * *' # poll` → `*/30 * * * *`); a `cron:` outside the `on.schedule` block excluded; **quoted/special-char `name:`** (e.g. `Integration (nightly)`) parsed; schedule-less workflow excluded; basename fallback when no top-level `name:`. `normalizeCiStatus`: `success`→`ok`; `failure`/`timed_out`/`startup_failure`→`fail`; `cancelled`/`skipped`/`neutral`/`null`→`null`. `latestCiRuns`: keys by display name, latest by `started_at`, joins `:e` edge status through the normalizer, `running` when no `finished_at`. `listCiSchedules`: **non-orchestrator** workflow w/ cached edge → `status` set; **orchestrator-mapped (no edge)** → `lastRunAt` set, `status:null`; workflow **absent from cache** → row still present, `lastRunAt:null,status:null`. |
| `test/ci-schedules-route.test.js` | `GET /api/ci-schedules`: cookie-gated (403 without cookie); temp `repoRoot/.github/workflows` fixture + gh-activity fixture → expected `{workflows}`; **missing/corrupt cache → workflows still returned with `—` status** (NOT empty); **missing workflows dir → `{workflows: []}`**; no throw in any case. |

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

## Review log

### Round 1 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → all 6 findings accepted

- **[BLOCKER] missing-cache hid crons** — fixed: missing/corrupt gh-activity cache → still return parsed cron workflows (status `—`); only a missing workflows *dir* → `[]` (§5.2/§6).
- **[MAJOR] CI status is raw GitHub conclusion** — added pure `normalizeCiStatus` (`success`→`ok`, `failure`/`timed_out`/`startup_failure`→`fail`, else `null`) before the pill (§5.1/§5.3).
- **[MAJOR] loadSchedules early-returns on empty daemon jobs** — fetch both routes before the empty-state decision; render empty only when both groups empty (§5.3).
- **[MAJOR] regex parsing underspecified** — replaced with an indentation/section-aware scanner: column-0 `name:` only, crons only inside `on.schedule`, skip comment lines; added tests for nested-name/commented-cron/multi-cron/special-char-name (§5.1/§6).
- **[MAJOR] "last run" ≠ "last scheduled run"** — cache drops `event`; relabeled UI/spec to "latest cached run" and documented the caveat (§2/§5.3).
- **[MINOR] conclusion coverage broader than implied** — §2 now enumerates the orchestrator-catch-all workflows (incl. integration) that show last-run but `—` conclusion; tests cover both orchestrator-owned and non-orchestrator (§2/§6).

### Round 2 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → both findings accepted (0 blockers)

- **[MAJOR] inline comment after a quoted cron scalar** — added comment-safe scalar
  extraction (read the quoted value, ignore trailing `# …`; unquoted → strip ` #…`)
  + fixture `- cron: '*/30 * * * *' # poll` (§5.1/§6).
- **[MINOR] orchestrator-catch-all list incomplete** — reworded §2 as non-exhaustive;
  noted `workflowToAgent` defaults ALL unmapped names to orchestrator (so most
  scheduled workflows show `—` conclusion), only the 6 mapped roles get an edge.
