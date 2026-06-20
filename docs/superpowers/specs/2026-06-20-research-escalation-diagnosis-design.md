# Research-Escalation Diagnosis Design (Sub-project ③a)

**Date:** 2026-06-20
**Status:** Draft — Codex review round 1 addressed (see Review log)
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
- **No new routing label, no re-scan.** The builtin reads the `needs-human` issues
  directly. **One deliberate routing change is in scope** (Component 0): `core.routeFor`
  must *skip* `needs-human` issues so the existing Triager fallback stops
  double-commenting on them — see the duplication note in Background. This is an
  exclusion, not a new route.
- **No re-research.** Each issue is researched once (marker dedup); a human can
  re-trigger by deleting the marker comment.

## Background (verified against code)

- **② escalations:** open issues with label `needs-human`, body marker
  `<!-- needs-human:<checkpoint>:PR#N -->` (`src/merge-sweep/remediation.js`
  `markerFor`/`MARKER_RE`). The PR number is parseable from the marker.
- **Existing routing double-handles `needs-human` (must fix).** The daemon's
  `listAllOpen()` (`scripts/dev-society-daemon.mjs:294`) lists *all* open issues
  **unfiltered by label**, and `core.routeFor` (`src/dev-society/core.js:184`) falls
  through to `{ target:'triager', mode:'ask', reason:'triage' }` for any issue with
  no more-specific label. So a `needs-human` issue is *already* picked up by the
  Triager today. Without an exclusion, ③a's diagnosis comment and the Triager's
  triage comment would both land on the same issue. Component 0 adds the `needs-human`
  skip to `routeFor` to make ③a the sole handler of these issues.
- **Daemon ask-dispatch template** (`scripts/dev-society-daemon.mjs`
  `dispatchAdvisory`, ≈ line 390): `core.advisoryRegistry({binPath, meshRoot})` →
  `createA2AClient(reg, {requestTimeoutMs})` → `client.send('analyst',
  core.a2aMessage('ask', prompt, { caller }))` → `core.taskText(task)` →
  `issueComment(n, body)` → `client.close()`. ③a reuses this path **with a per-issue
  caller stamp** (see session note below). `a2aMessage(mode, text, messageId)` today
  builds only `{ 'agentmesh/mode' }` metadata (`src/dev-society/core.js:251`); ③a
  extends its 3rd arg to an options object `{ messageId, caller }` that, when `caller`
  is set, adds `agentmesh/caller: caller` to the message metadata. Backward-compatible:
  a string 3rd arg is still treated as `messageId`.
- **Web-tools gate (sound on this path):** `agentWantsWebTools`
  (`src/delegate-invocation.js:156-174`) grants `WebSearch`/`WebFetch` when the agent
  is `served`, `enabledModes` includes `ask`, `webTools === true`, the route is
  **not** `digest`, and the agent root matches — and **nothing else**. It does **not**
  read `AGENT_MESH_MESH_ROOT`/`MESH_CEILING`; `advisoryRegistry` only stamps
  `AGENT_MESH_ENABLED_MODES:'ask'` on the peer (`src/dev-society/core.js:282`), which
  is irrelevant to the web-tools grant. The Analyst has `"webTools": true`, so an
  ask call on this advisory path gets web tools — the same path ②'s `research-landscape`
  advisory already uses in production. (Verification step 3 still confirms it live.)
- **Ask-mode tool surface is read-only — the Analyst cannot fetch GitHub itself.**
  ask-mode grants only `READ_TOOLS` (`Read`/`Glob`/`Grep`/`LS`) + web tools — **no
  `Bash`, no `gh`** (`src/config.js:46-50`, `src/delegate-invocation.js:188`) — and the
  peer's cwd is its *own* `dev-mesh/analyst` folder, not the repo root. So the Analyst
  **cannot** run `gh pr view`, read the PR diff, or read repo memory on its own. **All
  GitHub/repo context must be pre-fetched host-side and embedded as fenced data in the
  prompt** (Component 3's context collector). The Analyst's job is web research +
  reasoning over the provided context, not data gathering.
- **Sessions default to a shared `_anon` and resume across calls.** The A2A server
  derives the worker session from `agentmesh/caller` metadata, defaulting to `'_anon'`
  and **resuming** an existing transcript (`src/a2a/stdio-server.js:372-384`). Because
  `dispatchAdvisory` stamps no caller today, sequential asks share one `_anon` session
  — one issue's content could contaminate the next diagnosis. ③a **stamps a distinct
  per-issue caller** (`research-escalation:issue-<n>`) so each issue gets an isolated
  session.
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
       gh issue list --label needs-human --state open --limit 100 (read-only)
       per-issue: gh issue view <n> --json comments → carries <!-- research-escalation --> marker?
       planResearch(issues, researchedNums, cfg)  ── pure ──▶ { toResearch:[{number, prNum, body}] }
            (skip already-marked · sort ASCENDING by issue number · cap at capPerRun)
       for each picked (≤ cap):
         ctx = collectContext(prNum, issueBody)   ── host-side, read-only ──
               gh pr view <prNum> --json title,url,mergeStateStatus,statusCheckRollup
               gh pr view <prNum> --json comments  (autofix/mergefix failed-fix history)
         caller = `research-escalation:issue-${number}`     ── isolates the session ──
         task = client.send('analyst', a2aMessage('ask', researchPrompt(ctx), { caller }))
         if (taskDone(task)) {                              ── status gate ──
           text = taskText(task)
           if (text) gh issue comment <number> --body "<!-- research-escalation -->\n\n🔬 …<text>"
         }   // non-done (timeout/refused/error) OR empty → NO marker, retried next run
```

A per-issue dispatch failure is logged and skipped (failure is data). The Analyst
runs ask-only with web tools over **host-pre-fetched** context; it cannot write
code, run `gh`, or read the PR/repo itself.

## Components

### 0. `core.routeFor` — exclude `needs-human` (`src/dev-society/core.js`)

A single guard, before the triage fallback at `core.js:184`: if the issue's labels
include `needs-human`, return a skip (`{ target: null, reason: 'needs-human-research-owned' }`,
matching however the daemon already represents a no-route — verify against the
existing skip shape and `runRoute` handling). This stops the Triager from
double-commenting on issues ③a owns. It is the one routing change ③a makes; the
research-escalation builtin, not the router, drives these issues.

### 1. `dev-mesh/analyst/skills/research-escalation/SKILL.md` (new)

The research protocol for a stuck PR (mirrors the existing `research-landscape`
skill's fan-out→fetch→verify→synthesize shape, retargeted to failure diagnosis).
**The PR diff, failing checks, the issue's failure detail, and the auto-fix history
are supplied to the Analyst as fenced text in the prompt** (the Analyst has only
read + web tools — no `gh`, no repo access; see Background). So the protocol is:
read the **provided** stuck-PR context → **web-search** the specific error / conflict
pattern (how comparable OSS projects — SWE-agent/OpenHands/Aider, the failing
library, etc. — handled it) → reason over the provided context for prior art →
**synthesize a diagnosis** (why the naive fix failed) + a **concrete recommended
strategy** (the approach a fix should take). Output is analysis only — **never code,
never "I fixed it," never claims of having run commands.** Bounded length; cite the
web sources it used.

### 2. `src/dev-society/research-escalation.js` (pure)

```js
// planResearch(issues, researchedNums, cfg) → { toResearch:[{ number, prNum, body }] }
//   issues: [{ number, body }] open needs-human issues (any order from gh)
//   researchedNums: Set<number> issues that already carry the <!-- research-escalation --> marker
//   cfg: { capPerRun }
// 1. drop issues already in researchedNums (dedup)
// 2. drop issues whose body has no parseable needs-human:<checkpoint>:PR#N marker
// 3. SORT ascending by issue number (oldest-first) — deterministic, independent of
//    gh's newest-first default order, so old escalations are never starved
// 4. cap at capPerRun (take the first N after the ascending sort). Pure.
```

`MARKER` = `<!-- research-escalation -->` (dedup marker the builtin writes). The
PR-number parse reuses the `needs-human:<checkpoint>:PR#N` shape. The ascending sort
inside `planResearch` (not relying on the `gh` list order) is what guarantees the
oldest backlog item is researched first even when the open `needs-human` set exceeds
one run's cap.

### 3. `research-escalation` builtin — `scripts/dev-society-daemon.mjs`

Extracted into a testable `runResearchEscalation({ gh, dispatchAnalyst, repo, meshRoot, now, cfg, log })`
(in a new `src/dev-society/research-escalation-run.js`) so the A2A dispatch is
**injected** (fake-able), exactly as ② split its runner:
```
issues = gh issue list --label needs-human --state open --limit 100 --json number,body
researchedNums = for each issue: gh issue view <n> --json comments → has the MARKER?  (read-only)
plan = planResearch(issues, researchedNums, cfg)              // dedup · ascending sort · cap
for f in plan.toResearch:                                     // ≤ capPerRun, oldest-first
  ctx = collectContext(gh, f)                                 // host-side, read-only — see below
  res = await dispatchAnalyst({ issueNumber: f.number, prompt: researchPrompt(f, ctx) })
  // dispatchAnalyst returns { done:boolean, text:string } — NOT a bare string
  if (res.done && res.text)                                   // status gate: only a succeeded, non-empty task marks
    gh issue comment <f.number> --body `${MARKER}\n\n🔬 **Analyst research** (ask):\n\n${res.text.slice(0,60000)}`
  // non-done (timeout/refused/error) or empty → no comment, no marker; retried next run
return { status:'ok', output:`researched ${done}/${plan.toResearch.length}` }
```
`collectContext(gh, f)` is the host-side, read-only collector (Analyst can't run
`gh`): `gh pr view <prNum> --json title,url,mergeStateStatus,statusCheckRollup` for
the PR state + failing checks, **and** `gh pr view <prNum> --json comments` for the
autofix/mergefix failed-fix history — plus the `needs-human` issue body (already in
`f.body`) carrying the checkpoint/failure detail. Each best-effort: a missing field
degrades the context, never throws.

The daemon wires `dispatchAnalyst` to the real path: `createA2AClient(core.advisoryRegistry(...))`
→ `client.send('analyst', core.a2aMessage('ask', prompt, { caller: 'research-escalation:issue-'+issueNumber }))`
→ inspect the returned Task: `{ done: core.taskSucceeded(task), text: core.taskText(task) }`
(`core.taskSucceeded`, `src/dev-society/core.js:386`, already returns true only for
`TASK_STATE_COMPLETED`/`done`/`completed` with no `errorCode` — so timeout/refused/error
tasks are gated out even when they carry partial `taskText`) → `client.close()`.
The per-issue `caller` isolates each
issue's session (Background session note). Per-issue failures (dispatch or comment)
are logged and skipped.

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
- **Non-succeeded task** (timeout/refused/error) → `core.taskSucceeded` is false →
  **no comment, no marker**, even if the failed task returned partial `taskText`.
  The issue stays un-researched and is retried next run. (This is the BLOCKER-1 fix:
  a failed diagnosis must never be permanently deduped.)
- Analyst returns succeeded-but-empty text → no comment posted (issue stays
  un-researched; no empty marker is written).
- `collectContext` partial failure (e.g. `gh pr view` errors) → the missing field is
  omitted from the prompt; research still proceeds on the issue body + whatever
  context was gathered. Context collection never aborts the issue.
- `gh issue list` failure → return `{status:'fail'}` with no comments posted.
- Dedup is marker-based, so a re-run never double-comments.

## Testing (hermetic, `node --test`, zero deps)

- **`planResearch` (pure):** dedups issues already carrying the marker; caps at
  `capPerRun`; parses the PR number from the `needs-human:automerge:PR#N` marker;
  an issue with no parseable PR marker is skipped; **given issues in newest-first
  (gh default) order and a backlog larger than `capPerRun`, the picked set is the
  LOWEST issue numbers (ascending sort before cap) — old escalations aren't starved.**
- **`routeFor` needs-human skip (Component 0):** an issue labeled `needs-human` is
  **not** routed to the Triager (returns the no-route/skip shape); an issue with a
  more-specific actionable label still routes as before (the skip is scoped to the
  triage fallback, not a blanket drop).
- **`runResearchEscalation`** (fake `gh` + fake `dispatchAnalyst`):
  - read-only allowlist: only `issue list`, `issue view`, `pr view`, `issue comment`
    — **no** `issue create`, `pr merge/edit`, `api`, `git`.
  - `issue list` is called with `--limit 100` (matches the daemon convention; not the
    gh default of 30).
  - **context collector:** `collectContext` issues `pr view … statusCheckRollup` and
    `pr view … comments`; a `pr view` throw degrades the prompt but the issue is still
    researched (no abort).
  - **per-issue caller:** each `dispatchAnalyst` call is invoked with a distinct
    `issueNumber`, and the real wiring stamps `agentmesh/caller: research-escalation:issue-<n>`
    (assert the caller passed to the message builder differs per issue).
  - **status gate:** a `dispatchAnalyst` result with `done:false` (timeout/refused/error)
    — even with non-empty `text` — posts **no** comment and **no** marker; a `done:true`
    result with empty `text` also posts nothing; only `done:true` + non-empty `text`
    posts the marked comment.
  - posts exactly one `<!-- research-escalation -->`-marked comment per researched
    issue; an issue already carrying the marker gets **no** second comment (dedup).
  - a `dispatchAnalyst` throw for one issue → logged, others still researched.
  - cap honored (≤ capPerRun comments per run).
- **`a2aMessage` extension (unit):** `a2aMessage('ask', t, 'mid')` still sets
  `messageId:'mid'` and no caller (back-compat); `a2aMessage('ask', t, { caller:'c' })`
  adds `agentmesh/caller:'c'` to metadata.
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

## Review log

### Round 1 — Codex (independent), 2026-06-20

Findings: 2 BLOCKER, 4 MAJOR. Each validated against the code before acting.

| # | Finding | Resolution |
|---|---------|------------|
| BLOCKER-1 | A failed/timeout Task can still return partial `taskText`; posting a marker on it permanently dedups a *failed* diagnosis. | **Fixed.** Status gate via `core.taskSucceeded(task)` before posting any marker (Architecture, Component 3, Error Handling, Testing). Only `TASK_STATE_COMPLETED`/`done` with no `errorCode` marks. |
| BLOCKER-2 | `listAllOpen()` is label-unfiltered and `routeFor` falls through to the **Triager** for `needs-human` issues → the Triager and ③a both comment. | **Fixed.** Added **Component 0**: `routeFor` skips `needs-human` (confirmed `core.js:184` fallback). Updated the "No routing change" non-goal to scope-in this single exclusion. |
| MAJOR-3 | Web-tools "guarantee" unsound because `advisoryRegistry` doesn't set `MESH_ROOT`/`CEILING`. | **Rebutted, then reinforced in-spec.** `agentWantsWebTools` (`delegate-invocation.js:156-174`) grants web tools on manifest `webTools:true` + ask + non-digest route + root match — it never reads `MESH_ROOT`/`CEILING`. `advisoryRegistry` only stamps `AGENT_MESH_ENABLED_MODES:'ask'`, which is irrelevant to the grant. The premise is a misread; the path is the one ②'s `research-landscape` already uses live. Background now states the exact predicate; Verification step 3 still confirms live. |
| MAJOR-4 | All asks default to the shared `_anon` session and *resume* a persistent transcript → one issue contaminates the next. | **Fixed.** Confirmed `stdio-server.js:372-384`. ③a stamps a per-issue `agentmesh/caller: research-escalation:issue-<n>`; `a2aMessage`'s 3rd arg extended to `{ messageId, caller }` (back-compatible with a string `messageId`). |
| MAJOR-5 | Ask-mode Analyst has read+web tools only (no `gh`/`Bash`), cwd is its own folder — it can't fetch the PR/issue/repo context the skill assumes. | **Fixed.** Confirmed `config.js:46-50` / `delegate-invocation.js:188`. Added the host-side `collectContext` (PR view + checks + autofix-comment history; issue body already in hand) passed as fenced data; reworded SKILL.md to "reason over provided context," not "read the PR / run gh." |
| MAJOR-6 | `oldest-first` underspecified; `gh issue list` default order/limit could starve old escalations. | **Fixed.** Explicit `--limit 100` (daemon convention) and an explicit **ascending sort by issue number inside `planResearch` before the cap** — order is now independent of gh's newest-first default. Test added. |

Outcome: all 5 valid findings fixed; MAJOR-3 mutually rebutted (carried into round 2 for Codex to accept). Re-review pending.
