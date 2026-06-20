# Research-Escalation Diagnosis Design (Sub-project ③a)

**Date:** 2026-06-20
**Status:** Draft — pending Codex review
**Topic:** A read-only daemon job that picks ②'s `needs-human` escalations, has the Analyst research each (web + GitHub + repo memory), and posts a deduped **diagnosis + recommended fix strategy** comment on the escalation issue. No code changes. Foundation that ③b (gated draft-PR fix) consumes.

## Problem

② files `needs-human` GitHub issues for PRs the naive auto-fixers
(`dev-mesh-autofix`/`dev-mesh-mergefix`) tried and **couldn't clear** (their
2-commit budgets exhausted), plus memory PRs needing review. Today a human reads
the comment and debugs from scratch. Nothing brings **research** to the hard case:
the auto-fixers run with **no web tools** and naive prompts; the Triager only
classifies a log; the Analyst researches the *landscape*, not stuck PRs. So the
exact thing the failed fixers lacked — a researched diagnosis — is never produced.

③a fills that gap, and only that. It does **not** attempt a fix (that is ③b).

## Goal

A daemon cron builtin **`research-escalation`** (ask-only, ~every 2h) that:
1. lists ②'s open `needs-human` issues, picks the **un-researched** ones (deduped
   by a `<!-- research-escalation -->` comment marker, capped per run);
2. for each, dispatches the **Analyst** (already `webTools:true`, ask-mode) with the
   stuck-PR context + a new `research-escalation` skill;
3. posts the Analyst's diagnosis + recommended strategy as a **marked comment** on
   the escalation issue — research the Coder/human (or ③b) can act on.

## Non-Goals (hold the line)

- **No code changes.** Ask-only: read-only `gh` (issue/PR/comment list, `pr view`),
  the Analyst's read+web tools, and `gh issue comment` (post). No `do`-mode, no
  commits, no PRs. (③b is the fix.)
- **No re-running the naive fixers** (`classify.js`, the Coder fix prompt) — that's
  autofix/the Triager. ③a brings *research* those lack.
- **No new detection.** ③a reads ②'s `needs-human` issues; it does not re-scan PRs.
- **No routing change.** A self-contained builtin reads the issues directly; no edit
  to `core.routeFor` / no new routing label.
- **No re-research.** Each issue is researched once (marker dedup); a human can
  re-trigger by deleting the marker comment.

## Background (verified against code)

- **② escalations:** open issues with label `needs-human`, body marker
  `<!-- needs-human:<checkpoint>:PR#N -->` (`src/merge-sweep/remediation.js`
  `markerFor`/`MARKER_RE`). The PR number is parseable from the marker.
- **Daemon ask-dispatch template** (`scripts/dev-society-daemon.mjs`
  `dispatchAdvisory`, ≈ line 390): `core.advisoryRegistry({binPath, meshRoot})` →
  `createA2AClient(reg, {requestTimeoutMs})` → `client.send('analyst',
  core.a2aMessage('ask', prompt))` → `core.taskText(task)` → `issueComment(n, body)`
  → `client.close()`. ③a reuses this exact path.
- **Web-tools gate:** the Analyst has `"webTools": true` in `dev-mesh/mesh.json`;
  `agentWantsWebTools` grants `WebSearch`/`WebFetch` **only in ask-mode** for a
  served `webTools` agent on a non-digest route (`src/delegate-invocation.js`). So
  the research must run as an Analyst **ask** call (which ③a does).
- **Skill availability:** a mesh skill under `dev-mesh/<agent>/skills/<name>/SKILL.md`
  is summarized into that agent's runtime system prompt (`src/agent-context.js`
  assembly). So creating `dev-mesh/analyst/skills/research-escalation/SKILL.md`
  makes it available to the Analyst; the prompt references it by name.
- **Builtins:** `scripts/dev-society-daemon.mjs` `builtins` map (return
  `{status,output|error}`); `sh`, `cfg.repo`, `cfg.timeoutMs`, `SCHED_MESH_ROOT`,
  `BIN`, `core`, `createA2AClient`, `issueComment` in scope; scheduler dispatches
  `builtins[job.builtin]`; schedule needs `kind:"builtin"`+`builtin:"<id>"`.

## Architecture

```
analyst schedule (every 2h)
  └─ research-escalation builtin  (ASK-ONLY)
       gh issue list --label needs-human (open) + per-issue comment markers (read-only)
       planResearch(issues, researchedNums, cfg)  ── pure ──▶ { toResearch:[{number, prNum, body}] }   (dedup + cap)
       for each picked (≤ cap):
         gh pr view <prNum> --json title,url,mergeStateStatus,...   (read-only context)
         createA2AClient(advisoryRegistry) → client.send('analyst', a2aMessage('ask', researchPrompt(ctx)))
         text = taskText(task)
         gh issue comment <number> --body "<!-- research-escalation -->\n\n🔬 Analyst research:\n<text>"
```

A per-issue dispatch failure is logged and skipped (failure is data). The Analyst
runs ask-only with web tools; it cannot write code or run `gh`.

## Components

### 1. `dev-mesh/analyst/skills/research-escalation/SKILL.md` (new)

The research protocol for a stuck PR (mirrors the existing `research-landscape`
skill's fan-out→fetch→verify→synthesize shape, retargeted to failure diagnosis):
read the PR + the auto-fix history in the issue → **web-search** the specific error
/ conflict pattern (how comparable OSS projects — SWE-agent/OpenHands/Aider, the
failing library, etc. — handled it) → cross-check the repo's own memory + open
issues for prior art → **synthesize a diagnosis** (why the naive fix failed) + a
**concrete recommended strategy** (the approach a fix should take). Output is
analysis only — **never code, never "I fixed it."** Bounded length; cite sources.

### 2. `src/dev-society/research-escalation.js` (pure)

```js
// planResearch(issues, researchedNums, cfg) → { toResearch:[{ number, prNum, body }] }
//   issues: [{ number, body }] open needs-human issues
//   researchedNums: Set<number> issues that already carry the <!-- research-escalation --> marker
//   cfg: { capPerRun }
// Picks issues NOT already researched, parses the PR number from the needs-human
// marker, caps at capPerRun (oldest-first = lowest issue number first). Pure.
```

`MARKER` = `<!-- research-escalation -->` (dedup marker the builtin writes). The
PR-number parse reuses the `needs-human:<checkpoint>:PR#N` shape.

### 3. `research-escalation` builtin — `scripts/dev-society-daemon.mjs`

Extracted into a testable `runResearchEscalation({ gh, dispatchAnalyst, repo, meshRoot, now, cfg, log })`
(in a new `src/dev-society/research-escalation-run.js`) so the A2A dispatch is
**injected** (fake-able), exactly as ② split its runner:
```
issues = gh issue list --label needs-human --state open --json number,body
researchedNums = for each issue: gh issue view <n> --json comments → has the MARKER?  (read-only)
plan = planResearch(issues, researchedNums, cfg)
for f in plan.toResearch:                       // ≤ capPerRun
  ctx = gh pr view <f.prNum> --json title,url,mergeStateStatus,statusCheckRollup   // best-effort context
  text = await dispatchAnalyst(researchPrompt(f, ctx))     // ask-mode Analyst, web-enabled
  if (text) gh issue comment <f.number> --body `${MARKER}\n\n🔬 **Analyst research** (ask):\n\n${text.slice(0,60000)}`
return { status:'ok', output:`researched ${done}/${plan.toResearch.length}` }
```
The daemon wires `dispatchAnalyst` to the real path: `createA2AClient(core.advisoryRegistry(...))`
→ `client.send('analyst', core.a2aMessage('ask', prompt))` → `core.taskText(task)`
→ `client.close()`. Per-issue failures (dispatch or comment) are logged and skipped.

### 4. Schedule entry — `dev-mesh/analyst/.agent/schedule.json`

```json
{ "id":"research-escalation", "name":"Research stuck escalations (diagnosis)", "kind":"builtin",
  "builtin":"research-escalation", "cadence":{ "kind":"every", "minutes":120 }, "enabled":true,
  "description":"Read-only: Analyst researches needs-human escalations (web+repo) and posts a diagnosis + strategy comment. No code changes." }
```
`capPerRun = 2` (research is a real-`claude` ask call per issue — bound the cost).

## Data Flow

`② files needs-human issue → research-escalation (2h) lists them → planResearch
(dedup+cap) → Analyst ask-research per issue → post marked diagnosis comment`. The
only mutation is `gh issue comment`. The diagnosis becomes ③b's input (and a
human's).

## Error Handling

- Per-issue dispatch/comment failure → logged, that issue skipped; the run
  continues and returns `ok` with a count (failure is data).
- A2A client always `close()`d in a `finally`.
- Analyst returns empty/no usable text → no comment posted (the issue stays
  un-researched and is retried next run; no empty marker is written).
- `gh issue list` failure → return `{status:'fail'}` with no comments posted.
- Dedup is marker-based, so a re-run never double-comments.

## Testing (hermetic, `node --test`, zero deps)

- **`planResearch` (pure):** dedups issues already carrying the marker; caps at
  `capPerRun`; parses the PR number from the `needs-human:automerge:PR#N` marker;
  an issue with no parseable PR marker is skipped.
- **`runResearchEscalation`** (fake `gh` + fake `dispatchAnalyst`):
  - read-only allowlist: only `issue list`, `issue view`, `pr view`, `issue comment`
    — **no** `issue create`, `pr merge/edit`, `api`, `git`.
  - posts exactly one `<!-- research-escalation -->`-marked comment per researched
    issue; an issue already carrying the marker gets **no** second comment (dedup).
  - an empty `dispatchAnalyst` result → **no** comment (issue stays un-researched).
  - a `dispatchAnalyst` throw for one issue → logged, others still researched.
  - cap honored (≤ capPerRun comments per run).
- **Schedule lint:** the analyst job has `builtin:"research-escalation"`.
- **Skill lint** (if the repo lints skills): the new SKILL.md has a name/description
  frontmatter and the research-only (no-code) instruction.

## Verification (manual, on the host — after merge)

1. The analyst schedule shows `research-escalation` (2h).
2. For an open `needs-human` issue, within a run a `<!-- research-escalation -->`
   comment appears with an Analyst diagnosis + strategy (and web citations); a
   second run posts nothing more for it.
3. The Analyst run-log shows ask-mode + `WebSearch`/`WebFetch` only — no `do`-mode,
   no commits/PRs.

## Deferred (not ③a)

- **Dashboard "🔬 researched" indicator** — the research lives on the issue the
  dashboard's `escalated → #NNN` badge already links to; a separate flag is a
  nice-to-have, not built here.
- **③b — gated draft-PR fix** — a separate `dev-mesh-research-fix` workflow that
  invokes the Coder (do-mode) using this diagnosis as context and opens a DRAFT PR
  (never auto-merged). Its own spec/cycle.
