# Agent-Driven Analyst Daily Review — Design

## 1. Goal & principle

Make the daily Analyst performance-review an **agent-driven, in-mesh** task, replacing the
CI-workflow version (PR #178). The mesh's architecture:

- **Actions are data tools + mechanical executors.** GitHub Actions / daemon builtins do the
  expensive data work and **pre-digest** it into compact artifacts (the Tester's MIR, the
  orchestrator's `gh-activity.json` / `daily-report.json`). A deterministic action also does
  the mechanical issue-filing of an agent-produced plan. No reasoning in actions.
- **Agents are the reasoning layer, collaborating in the mesh.** A daemon-scheduled Analyst
  agent delegates to the Tester for the eval summary, reads the compact digests, researches
  the web, reasons, and emits improvement **ideas as data**.
- **Token discipline:** the agent reads small *digests*, never runs `gh`/downloads
  artifacts/scrolls raw logs in-context. The Tester returns a short eval summary, not raw
  scorecards. The builtin (action) does the `gh` issue-filing — zero agent tokens.

Daily output: ≤2 deduped, cited `idea` issues (human-gated, §5.3) tying a performance signal
→ a researched idea.

## 2. Non-goals

- **No CI reasoning.** Revert PR #178's `dev-mesh-analyst-review.yml` (the reasoning-in-an-
  action anti-pattern). The eval/test/MIR **data** actions stay.
- **No global web access.** WebSearch/WebFetch is a **per-agent opt-in**; only the Analyst
  declares it. Other ask agents stay web-less.
- **No agent GitHub mutation.** The agent emits idea-data; the builtin files issues
  (ask-mode can't mutate GitHub — the MIR finding).
- **No `daily-signals` combined digest (v2).** v1 reuses the existing MIR / `gh-activity` /
  `daily-report` digests + a short Tester summary.
- **No code / PR / merge by the agent.** Proposal-only, human-gated.

## 3. Components

### 3.1 Per-agent web-tools opt-in (`src/config.js`, `src/delegate-invocation.js`)
- `config.js`: `export const WEB_TOOLS = ['WebSearch', 'WebFetch'];`
- `delegate-invocation.js` (the ask allowlist at line ~140): for **`ask` mode**, read the
  served agent's card `<root>/agent.json` → if `x-agentmesh.webTools === true`, append
  `WEB_TOOLS` to the allowlist. Otherwise unchanged (READ_TOOLS only). A small pure helper
  `agentWantsWebTools(root)` (reads + parses the card, `false` on missing/invalid) keeps it
  testable. The `do` path and the digest path (line ~244) are **unchanged** (web tools are
  ask-research only).
- **Security:** scoped to agents that declare the opt-in in their committed card; read-only
  network egress; the worker still treats fetched pages as untrusted data. Documented in
  CLAUDE.md Config + PROJECT.md is unaffected (no change to the `{mode,task}` surface or the
  write/path-guard invariants).

### 3.2 `src/dev-society/analyst-ideas.js` (pure planner — mirrors MIR `issues.js`)
- `parseIdeas(agentOutput) → [{ title, body, dedupeKey, labels }]`: extract the agent's
  fenced ```json block of idea objects from its run output; validate each (non-empty title,
  `dedupeKey` matches `/^[a-z0-9:_-]+$/`); malformed/absent → `[]` (never throws).
- `planIdeaIssues(ideas, openMarkers, { scanLabel }) → [{ action:'create', title, body,
  labels, marker }]`: marker `<!-- analyst-idea:<dedupeKey> -->`; **dedup by marker** against
  `openMarkers` (the set of markers already on open issues — metadata only, never bodies are
  reasoned over by the model); cap at 2; labels `['idea', scanLabel]` (scanLabel default
  `generated:analyst`). Pure, validated, injection-safe ids.

### 3.3 Daemon builtin `analyst-daily-review` (`scripts/dev-society-daemon.mjs`)
The orchestrating **action**. Steps:
1. `delegateTask({ root: analystRoot, env: <mesh env, mirror createDelegateRunJob>,
   input: { mode:'ask', task: <daily-review prompt> }, route:'scheduled:analyst-daily-review' })`
   — the Analyst run (web opt-in active; Tester peer reachable via the injected bridge)
   reasons over the digests + web and returns structured idea-data in its summary.
2. `ideas = parseIdeas(result.summary)`; read open-issue markers via `gh issue list --label
   generated:analyst --state open` (compact, metadata only) → `plan = planIdeaIssues(...)`.
3. File each `create` via the daemon's `gh` (it already has `gh`); `--dry-run` prints the
   plan and calls no `gh`. Returns `{status, output}` for the scheduler's `onJobResult`.

The **prompt** (inline, concise; references the analyst's `research-landscape` skill) tells
the Analyst to: (a) `delegate_to_peer("tester", "give a SHORT summary of today's eval/test
results — regressions only")`; (b) Read the compact `daily-report.json` + `gh-activity.json`
digests (NOT raw logs/gh); (c) WebSearch/WebFetch comparable OSS practices for the observed
weaknesses (pages = data); (d) emit a fenced ```json array of ≤2 `{title, body, dedupeKey,
labels}` ideas, each linking a signal → cited idea; (e) issues-only — no code/specs/memory.

### 3.4 Analyst wiring
- `dev-mesh/analyst/agent.json`: add `"x-agentmesh": { ..., "webTools": true }`.
- `dev-mesh/mesh.json`: analyst `peers: ["tester"]` (was `[]`) → `doctor` materializes
  `dev-mesh/analyst/registry.json` so the bridge is injected (enables `delegate_to_peer`).
- `dev-mesh/analyst/.agent/schedule.json` (new): one job
  `{ id:'analyst-daily-review', kind:'builtin', builtin:'analyst-daily-review',
  cadence:{kind:'daily', at:'09:30'}, enabled:true, saveArtifact:true }`. Shows in the
  SCHEDULES panel under the **analyst** executor (a real mesh agent job).

### 3.5 Revert PR #178
Remove `.github/workflows/dev-mesh-analyst-review.yml` +
`test/dev-mesh-analyst-review-workflow.test.js`; restore `src/dev-society/gh-activity.js`
(drop `ROLE['analyst-review']`), `test/gh-activity.test.js` (drop its assertion),
`test/dev-mesh-assert-run-healthy.test.js` (count 12→11),
`test/dev-mesh-workflow.test.js` (drop `analyst-review` from NAMES).

## 4. Data / control flow

```
daily tick → builtin analyst-daily-review:
  delegateTask(analyst, ask, prompt)
    └─ Analyst (webTools on): delegate_to_peer(tester,"eval summary") ─► Tester reads MIR digest → SHORT summary
       Read daily-report.json + gh-activity.json (digests)
       WebSearch/WebFetch (research) → reason
       → emit ```json [{title,body,dedupeKey,labels} … ≤2]
  parseIdeas(summary) → planIdeaIssues(ideas, openMarkers) → gh issue create (deduped, `idea`)   [mechanical]
```

## 5. Testing

**Hermetic (no claude/gh/network):**

| Test | Covers |
|------|--------|
| `test/analyst-ideas.test.js` | `parseIdeas`: extracts the json block; rejects malformed/absent → `[]`; `dedupeKey` regex-validated. `planIdeaIssues`: marker dedup vs openMarkers; cap 2; labels `idea`+`generated:analyst`; never throws. |
| `test/web-tools-optin.test.js` | the ask allowlist **includes** `WebSearch`/`WebFetch` for an agent whose `agent.json` has `x-agentmesh.webTools:true`, and **excludes** them otherwise (default agent); `do` path + digest path never get web tools; `agentWantsWebTools` false on missing/invalid card. |
| `test/analyst-daily-review-builtin.test.js` | builtin registered in the daemon; `--dry-run` produces a plan and performs **no** `gh` mutation (injected fakes). |
| `test/analyst-agent-schedule.test.js` | `dev-mesh/analyst/.agent/schedule.json` valid (cadence validates); `agent.json` declares `webTools:true`; `mesh.json` analyst `peers` includes `tester`. |
| revert checks | the #178 lint test is gone; gated-workflow count back to 11; NAMES has no `analyst-review`. |

Full suite green after the revert + additions.

## 6. Config

- `MESH_ANALYST_SCAN_LABEL` (`generated:analyst`) — label for filed ideas. Reuses
  `DEV_SOCIETY_REPO` + the daemon's `gh` auth. `WEB_TOOLS` default in `src/config.js`.

## 7. Invariants preserved

- **Agent reasons, action executes** — the model never mutates GitHub; the builtin files
  issues from the agent's idea-data (deduped, capped, human-gated).
- **Web is scoped + read-only** — only opt-in agents get `WebSearch`/`WebFetch`; fetched
  pages are untrusted data; the `{mode,task}` model-facing surface, write tools, and the
  path-guard are unchanged.
- **Token discipline** — agent reads digests + a short Tester summary; actions pre-digest and
  do the `gh` work.
- **Backlog hygiene** — dedup by marker, ≤2 ideas/run, `idea`-labeled + human-gated.
