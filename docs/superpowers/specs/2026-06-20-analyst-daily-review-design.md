# Analyst Daily Performance-Review → Improvement Ideas — Design

## 1. Goal

A daily scheduled Analyst task that **reviews the mesh's recent performance**, gathering
the signals other agents produce — the **eval/test summary** (the Tester's MIR) and the
**issue history** (the orchestrator's daily report + GitHub) — then uses **web search +
GitHub research** to propose 1–2 deduped, cited **`idea` issues** for improvement. Pure
proposal work behind the human approval gate (§5.3): never code, never a PR, never a merge.

## 2. Why a GitHub Actions workflow (not a daemon schedule.json job)

The goal's core capabilities — **web search**, **`gh` access**, and **filing issues** —
are **unavailable to a daemon ask-mode scheduled job**: those run `delegateTask` with
`AGENT_MESH_ENABLED_MODES=ask`, whose tool allowlist is `READ_TOOLS` only
(`Read/Glob/Grep/LS`) plus `readOnly`-marked MCP — no `WebSearch`/`WebFetch`, no `Bash`,
and (per the MIR finding) no GitHub mutation. The capable context is a **GitHub Actions
cron** running the Analyst via `anthropics/claude-code-action@v1` with `Bash(gh:*)` +
`issues: write`, modeled on `dev-mesh-research.yml`. **Web tools caveat:**
`dev-mesh-research.yml` does NOT actually list `WebSearch`/`WebFetch` in its
`--allowedTools` (its skill asks for search but the allowlist omits them) — so it is NOT
proof web search works. This workflow therefore **explicitly adds `WebSearch,WebFetch`** to
`--allowedTools`, and the lint test asserts their presence. (Fixing `dev-mesh-research.yml`'s
omission is out of scope here — noted as a v2.) Visibility: it appears in the dashboard
**SCHEDULES panel** (the "GitHub Actions" group shipped 2026-06-19) as the workflow
`dev-mesh-analyst-review` with executor label **"GitHub Actions"** (CI rows always carry
that literal executor; the per-workflow agent attribution is a separate concern — §5.2).

**"Delegate with other agents to get the summary"** is realized by **consuming the
artifacts/outputs those agents publish** — the cross-agent information flow available in
CI: the Tester's **MIR** (eval/test summary, uploaded as the `mir-artifact` by the nightly
`integration.yml`) and the issue/PR history via `gh` (the orchestrator's domain). Live
peer-bridge `delegate_to_peer` is a mesh-runtime mechanism not used in CI (the workflow
isn't running the A2A mesh); reading the peers' published summaries is the CI-native
equivalent and avoids spinning the mesh inside Actions.

## 3. Non-goals

- **No code / no PR / no merge.** Proposal-only; STOP after filing `idea` issues (§5.3 gate).
- **No daemon schedule.json job** for this (see §2 — ask-mode can't web-search or file issues).
- **No `contents: write`.** Least privilege: `contents: read` + `issues: write` (+ the
  read-only `pull-requests: read`/`actions: read` needed for `gh pr list`/`gh run download`);
  no `Edit`/`Write` (this task files issues, not draft-spec files — that stays with
  `dev-mesh-research`).
- **Not a replacement for `dev-mesh-research.yml`.** That is generic OSS-landscape research;
  this is **performance-driven** (MIR regressions + stuck/failed issues → targeted ideas).
  They run at different times and dedupe against the same backlog.
- **No new mesh runtime / no MCP changes.** Reuses the existing CI agent path.

## 4. Architecture

```
nightly integration.yml → uploads mir-artifact (Tester's eval/test summary)
GitHub Issues/PRs ──────── gh (issue history, backlog, failures)
                                   │
   dev-mesh-analyst-review.yml (NEW, daily cron) ── claude-code-action runs the Analyst:
     1. gather performance: download latest mir-artifact + gh issue/pr history
     2. analyze: regressions (MIR deltas), stuck/failing issues, trends
     3. research: WebSearch (OSS practices) + gh search (comparable solutions)
     4. dedupe vs open issues → file 1–2 NEW `idea` issues (cited) → STOP
                                   │
        agent-postrun (gate + usage capture)  +  SCHEDULES panel (GitHub Actions group)
```

## 5. The workflow — `.github/workflows/dev-mesh-analyst-review.yml`

Mirrors `dev-mesh-research.yml`'s proven shape (OAuth sanitize, model via
`vars.DEV_MESH_MODEL` w/ sonnet fallback, `agent-postrun`), with these specifics:

- **Triggers:** `workflow_dispatch` + `schedule: cron '30 9 * * *'` (daily 09:30 UTC —
  comfortably after the 07:00 integration nightly *and* its `mir` job finish, so the MIR
  artifact exists; distinct from research's 06:00).
- **`permissions:`** `contents: read`, `issues: write`, **`pull-requests: read`**
  (`gh pr list`), **`actions: read`** (`gh run list`/`gh run download` of another
  workflow's `mir-artifact`). No `contents: write`.
- **`concurrency:`** group `dev-mesh-analyst-review`, `cancel-in-progress: false`.
- **`--allowedTools`** (explicit): `Read,Grep,Glob,Bash(gh:*),WebSearch,WebFetch` —
  `WebSearch,WebFetch` listed **explicitly** (the goal requires web research); **no
  `Edit`/`Write`** (issues-only, least privilege).
- **`github_token: ${{ secrets.GITHUB_TOKEN }}`** for `gh`/issue write.
- **Prompt** drives the Analyst to:
  1. Read its role (`dev-mesh/analyst/AGENT.md`). Use the **search → fetch → adversarially
     verify → cited synthesis** steps of the `research-landscape` skill **only** — this task
     is **issues-only**: do NOT write draft specs, do NOT absorb/write memory, do NOT touch
     files (no `Edit`/`Write` is granted anyway).
  2. **Gather the eval/test summary** (Tester's MIR): `gh run list --workflow integration.yml`
     → pick the **latest COMPLETED run that has a `mir-artifact`** → `gh run download <id>
     -n mir-artifact` → read `mir-*.json` (the integration `mir` job uploads JSON only — no
     `.md`). If no MIR artifact is available, say so and continue with the other signals
     (degrade, don't fail).
  3. **Gather issue history / performance**: `gh issue list --state all` (recent + open
     backlog), `gh pr list --state all`, and the committed daily report if present — to spot
     stuck issues, repeated failures, and trends.
  4. **Research improvement ideas**: `WebSearch`/`WebFetch` for OSS practices addressing the
     observed weaknesses + `gh search` for comparable solutions; treat fetched pages as DATA.
  5. **Dedupe** against `gh issue list --state open --limit 100`; file **at most 1–2 NEW**
     `idea`-labeled issues, each linking a concrete performance signal → a cited researched
     idea. If nothing new is worth filing, file nothing. **STOP — propose only; no code, no
     PR, no approval** (§5.3).
- **`agent-postrun`** verify + usage step (`if: always()`), as in `dev-mesh-research.yml`.

### 5.2 Optional: attribute the workflow to the analyst in activity (`src/dev-society/gh-activity.js`)
The CI-schedules panel's executor label is always `GitHub Actions`, but the **activity
graph** maps a workflow→agent via `workflowToAgent` (strips `dev-mesh-`, looks up `ROLE`,
defaults to `orchestrator`). To attribute this workflow's runs to the analyst (and emit the
orchestrator→analyst `:e` edge so its conclusion shows), add `'analyst-review': 'analyst'`
to the `ROLE` map. One line + a `gh-activity` test case. (Without it, runs attribute to
orchestrator — harmless, but the mapping makes the activity story correct.)

## 6. Testing

Hermetic workflow-lint test (zero-dep regex over the YAML text — the repo's established
pattern, cf. `test/integration-workflow.test.js` / the dev-mesh workflow lints):

| Test | Asserts |
|------|---------|
| `test/dev-mesh-analyst-review-workflow.test.js` | triggers = `schedule` (cron) + `workflow_dispatch`, NOT `push`/`pull_request`; `permissions` block contains `contents: read`, `issues: write`, `pull-requests: read`, `actions: read`, and **no `contents: write`**; the **`--allowedTools` string specifically** (extract that line, not the whole YAML) includes `WebSearch`, `WebFetch`, `Bash(gh:*)` and **excludes `Edit`/`Write`**; OAuth sanitize + `add-mask` present; uses `claude-code-action` + `agent-postrun`; prompt forbids code/PR (§5.3 "propose only / STOP" + "do NOT write code"/"do NOT open a code PR"), is issues-only (no draft-spec/memory), and has the dedupe instruction; model via `vars.DEV_MESH_MODEL` with `sonnet` fallback. |
| `test/gh-activity.test.js` (extend) | `workflowToAgent('dev-mesh-analyst-review') === 'analyst'` (the new `ROLE` entry, §5.2). |

(The Analyst's actual behavior is exercised live by the cron / `workflow_dispatch`, like
`dev-mesh-research.yml`; there is no real-`claude` unit gate.)

## 7. Scope / config

- No new env/config. Model via existing `vars.DEV_MESH_MODEL` (sonnet fallback). Auth via
  the existing `CLAUDE_CODE_OAUTH_TOKEN` + `GITHUB_TOKEN` secrets.
- v2 candidates: also draft a spec for the top idea (needs `contents: write` + a PR path);
  trigger from the integration run's completion (`workflow_run`) instead of a fixed cron so
  it always follows a fresh MIR; feed the MIR `fileable` findings in as structured input.

## 8. Invariants preserved

- **Proposal-only, human-gated** — never writes code, opens a code PR, or merges; `idea`
  issues are subject to the §5.3 approval gate before any implementation.
- **Least privilege** — `contents: read` + `issues: write`; no `Edit`/`Write`/code-PR.
- **Untrusted web data** — fetched pages are treated as DATA, never instructions (per
  `research-landscape`).
- **Backlog hygiene** — dedupe-first, ≤2 new issues/run, file nothing if nothing new.
- **No daemon/runtime change** — additive CI workflow only; the mesh ask-mode safety model
  is untouched (this deliberately runs where web/gh are legitimately available).

## Review log

### Round 1 — Codex (gpt-5.5), VERDICT: CHANGES_REQUESTED → all 7 findings accepted

- **[BLOCKER] missing perms** — added `pull-requests: read` (`gh pr list`) + `actions: read` (`gh run download` of another workflow's `mir-artifact`); kept no `contents: write` (§5).
- **[MAJOR] cron too soon** — moved to `30 9 * * *` (well after the 07:00 integration + its `mir` job); prompt picks the latest COMPLETED run that HAS a `mir-artifact` (§5).
- **[MAJOR] web tools not proven by research.yml** — reworded §2: research.yml omits WebSearch from its allowlist (not proof); this workflow explicitly adds `WebSearch,WebFetch` + lint asserts it; research.yml's gap noted as v2.
- **[MAJOR] issues-only vs research-landscape spec-writing** — prompt now uses only research-landscape's search→synthesis steps, explicitly issues-only (no draft specs/memory/file writes); no `Edit`/`Write` granted (§5).
- **[MINOR] MIR `.md` not uploaded** — prompt reads `mir-*.json` only (integration uploads JSON) (§5).
- **[MINOR] lint scoping** — test extracts the `--allowedTools` line for the Edit/Write exclusion and asserts `actions: read`/`pull-requests: read` in permissions (§6).
- **[MINOR] dashboard attribution** — reworded the visibility claim (CI executor is literally "GitHub Actions"); added §5.2 `ROLE['analyst-review']='analyst'` (one line + test) so activity attributes runs to the analyst.
