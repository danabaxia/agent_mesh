# Merge-Sweep Report-First State Machine Design (Sub-project ①)

**Date:** 2026-06-20
**Status:** Codex-reviewed (4 rounds: 10→4→3→1 findings, all addressed). Round-5 confirmation pending — Codex hit its usage limit (resets 2026-06-24); my own final self-review is clean. The only outstanding item was a mechanical consistency cleanup (round 4), already applied.
**Topic:** A local, **structurally read-only** daemon job that inspects the three housekeeping concerns (issue-gate · automerge · memory-automerge) and emits a structured state report, surfaced on the dashboard. Foundation for the later orchestrator-remediation loop (②) and research-driven fix (③), both out of scope here.

## Problem

GitHub `schedule:` cron is throttled under load, and the repo runs ~12 scheduled
`dev-mesh-*` workflows — the three every-15-min ones are the worst offenders.
They are also *coupled* (issue-gate must mark `blocked-by-issue` before automerge
reads it). Separately, there is **no single place to see** what these housekeeping
decisions are, and **no machine-readable state** another agent could consume to
drive remediation later (②/③).

This sub-project ① delivers only the **observability + state model** — a report.
It deliberately does **not** change, consolidate, or replace any mutator.

## Goal

A local daemon job, **`merge-sweep`**, that every 15 minutes performs **read-only**
GitHub queries, classifies the three concerns using the **existing decision
predicates**, and:

1. emits a structured **state report** to `<meshRoot>/mesh/reports/merge-sweep.json`
   — per-checkpoint status + per-item state, with per-item *age* across runs;
2. surfaces it on the **dashboard** so flagged items (held/blocked PRs, would-merge
   candidates, memory PRs needing a human) are visible.

## Report-only is a structural guarantee, not a flag

Earlier drafts proposed calling the mutating sweep functions (`runSweep`,
`runIssueGate`) in `dryRun` mode. Codex review (rounds 1–3) surfaced that this is
fragile and contradicts the guarantee even in dry-run (shared code path with the
merge/label-edit logic; `enabled`/`repo` footguns; dry-run sweeps don't expose
per-PR reasons). **Revised:** `merge-sweep` **never calls a function that can
mutate.** It issues only read-only `gh` queries (`pr list`, `pr view`, `issue
view`) and calls **read-only decision functions** — the eligibility predicate
`classifyAutomergePr`, a new read-only `classifyIssueGate` (extracted from
`issue-gate-sweep.js` — the collect-and-decide half, *without* the label-edit),
and `classifyMemoryPr`. The mutating `runSweep` / `runIssueGate` are **never**
invoked here. The read-only allowlist test (below) proves no mutating `gh`/git
command escapes.

## Pre-existing mutators (corrected — ① does not touch them)

Round 1 review correctly flagged that "GitHub crons are the only mutator" is
false. The current mutators, **all unchanged by ①**:
- the three GitHub crons (`dev-mesh-issue-gate/automerge/memory-automerge`), and
- a **local** `automerge-sweep` daemon builtin already on the maintainer schedule
  (gated by `AUTOMERGE_ENABLED`) that really merges.

`merge-sweep` runs **alongside** these as a pure observer. It makes no claim to be
the sole mutator, does not replace the local `automerge-sweep`, and does not
remove any GitHub `schedule:`. (The redundancy between the GitHub automerge cron
and the local `automerge-sweep`, and any consolidation/cutover, are noted for ②
— not resolved here.)

## Non-Goals (explicit — hold the line)

- **No actions.** No merges, no label edits, no comments, no git operations, no
  branch pushes. Read-only `gh` queries + one report-file write only.
- **No cutover / no consolidation of mutators.** GitHub crons and the local
  `automerge-sweep` are untouched.
- **No extraction of the memory-automerge mutating bash.** ① adds a *read-only
  classifier* (`classifyMemoryPr`); the workflow's mutating path stays as-is.
  (Round 1 asked for a full behavior-preserving `runMemoryAutomerge` extraction —
  **rebutted/rescoped:** ① needs only read-only classification, so the mutating
  module is not built here.)
- **No transition engine.** Per-item *age* is tracked; lifecycle transitions
  (`assigned → fixing → verified → done`) are ②.
- **No orchestrator / no research-fix.** ②/③.

## Background (verified against code)

- `src/automerge/eligibility.js` exports the **pure** predicate
  `isAutoMergeable(pr, {holdLabels})` — checks, in order: not draft · not
  cross-repo (fork) · `mergeStateStatus === 'CLEAN'` · `reviewDecision ===
  'APPROVED'` · no hold label. Each failing check is a distinct *reason*.
- `runIssueGate({gh, repo, enabled, dryRun})` (`src/automerge/issue-gate-sweep.js`)
  returns `{held:number[], cleared:number[], errors}`. Its work is two parts: a
  read-only **decision** (list open PRs → resolve `closingIssuesReferences` →
  check each linked issue's labels for blocked/rejected/wontfix/duplicate →
  held/cleared) and the **mutation** (`pr edit --add/remove-label`, behind
  `if (!dryRun)`). ① **extracts the decision half** into a read-only
  `classifyIssueGate({gh, repo}) → {held, cleared, error?}`; `runIssueGate` is
  refactored to call it and then apply labels (live behavior unchanged, guarded by
  the existing issue-gate tests). `merge-sweep` calls only `classifyIssueGate`.
- `dev-mesh-memory-automerge.yml` validates that every changed file of a
  `memory:promote` PR matches `dev-mesh/<agent>/memory/(quick.json | …*.md)` and
  that `quick.json` passes caps/shape, before merging. ① reuses these checks
  read-only.
- The daemon's mesh root is `SCHED_MESH_ROOT = join(repoRoot, 'dev-mesh')`; the
  dashboard reads under `join(meshRoot, 'mesh', …)` with `meshRoot = dev-mesh`.
  So the report path is `join(meshRoot, 'mesh', 'reports', 'merge-sweep.json')`,
  written and read via one shared helper.
- Builtins live in `scripts/dev-society-daemon.mjs`'s `builtins` map and return
  `{status:'ok'|'fail', output|error}`. The dashboard Graph view is foldable
  `#sec-*` panels fed by `/api/*` JSON.

## Architecture

```
scheduler tick (every 15m, maintainer)
  └─ merge-sweep builtin  (READ-ONLY)
       reads (gh): open PRs (with eligibility fields), issue-gate decisions, memory PRs+files
       ├─ classifyIssueGate({repo, gh})                       → {held, cleared, error?}   (read-only, extracted)
       ├─ classifyAutomerge(prs, {holdLabels, gate})          → per-PR {state, reason}   (pure)
       └─ classifyMemory(memoryPRs)                            → per-PR {state, reason}   (pure)
       └─ buildMergeSweepReport([...], prevReport, now)  ── pure ──▶ report
              atomic write → <meshRoot>/mesh/reports/merge-sweep.json
                                   │
dashboard:  GET /api/merge-sweep ──┘  →  ◆ MERGE-SWEEP panel (checkpoints + flagged items)
```

**Gate overlay — both sides, fail-closed** (Round 1 + Round 2 BLOCKERs). Dry-run
issue-gate neither adds nor removes the real `blocked-by-issue` label, so
automerge must reason over the gate's *intended* label state, not GitHub's
current one. The overlay computes, per PR, an **effective** `blocked-by-issue`:
`gate.held.has(n)` → present (→ `blocked / pending-issue-gate`);
`gate.cleared.has(n)` → absent (ignore a stale label still on GitHub);
otherwise → the PR's current label. **Fail-closed:** if `classifyIssueGate`
returned an `error` (or null — it returns errors as data, it does not throw),
`gate.ok = false`, and automerge **suppresses every `would-merge`**, reporting
those PRs as `blocked / gate-unknown` instead — a gate read failure can never
produce a false `would-merge`.

A classifier/runner that throws is caught → that checkpoint is `status:'error'`;
the others still run. The report write is atomic (temp + rename).

## Components

### 0. `classifyIssueGate` — `src/automerge/issue-gate-sweep.js` (extract, read-only)

Refactor the existing module to separate the read-only decision from the mutation:

```js
// classifyIssueGate({ gh, repo }) → { held:number[], cleared:number[], error? }
//   (the current runIssueGate decision logic, with NO `pr edit` label writes)
export async function runIssueGate({ gh, repo, enabled, dryRun }) {
  if (enabled !== true) return { disabled:true, held:[], cleared:[] };
  const { held, cleared, error } = await classifyIssueGate({ gh, repo });
  if (!dryRun) { /* apply +/- blocked-by-issue labels as today */ }
  return { held, cleared, error, errors: error ? 1 : 0 };
}
```

`merge-sweep` calls **only** `classifyIssueGate` — never `runIssueGate`. Live
behavior of `runIssueGate` is unchanged (it now delegates the decision), and the
existing `dev-mesh` issue-gate tests guard the refactor.

### 1. `classifyAutomergePr` — `src/automerge/eligibility.js` (extend, pure)

Refactor so the reason is exposed without duplicating logic:

```js
// classifyAutomergePr(pr, { holdLabels, gate }) → { state, reason }
//   gate = { held:Set<number>, cleared:Set<number>, ok:boolean }
// Effective blocked-by-issue label (overlay, both sides):
//   const gated = gate.held.has(pr.number) ? true
//               : gate.cleared.has(pr.number) ? false
//               : prHasLabel(pr, 'blocked-by-issue');
// Order mirrors isAutoMergeable exactly, with the overlay + fail-closed first:
//   gated                          → { state:'blocked', reason:'pending-issue-gate' }
//   pr.isDraft   !== false         → { state:'blocked', reason:'draft' }
//   pr.isCrossRepository !== false → { state:'blocked', reason:'fork' }
//   pr.mergeStateStatus!=='CLEAN'  → { state:'blocked', reason:'not-clean:<status>' }
//   pr.reviewDecision!=='APPROVED' → { state:'blocked', reason:'not-approved:<decision>' }
//   has other hold label           → { state:'held',    reason:'<label>' }
//   !gate.ok                       → { state:'blocked', reason:'gate-unknown' }   // fail-closed
//   else                           → { state:'would-merge', reason:null }
```

`isAutoMergeable` is re-implemented as `classifyAutomergePr(pr, {holdLabels,
gate:{held:new Set(),cleared:new Set(),ok:true}}).state === 'would-merge'` (same
`PR_FIELDS`), so the predicate and the report can never diverge. The
`blocked-by-issue` label is handled **only** via the `gated` overlay (it is not
in `holdLabels`), so the gate's intended state — not GitHub's stale label — drives
the decision.

### 2. `classifyMemoryPr` — `src/automerge/memory-classify.js` (new, pure)

```js
// classifyMemoryPr({ number, title, isCrossRepository, files, quickJsonContents }) → { state, reason }
//   isCrossRepository !== false                                   → needs-human:'fork'
//   files not all matching dev-mesh/<a>/memory/(quick.json|…*.md) → needs-human:'non-memory-path'
//   any quick.json failing caps/shape (reuse the existing validator)→ needs-human:'invalid-quick-json'
//   else                                                          → merge-candidate
```

The positive state is **`merge-candidate`, not `would-merge`** (Round 2 MAJOR):
the live workflow additionally merges `origin/main`, union-resolves memory
conflicts, and validates the *merged* tree — outcomes a static read-only check
cannot fully predict. `merge-candidate` means "passes the cheap, read-only
pre-checks (same-repo · memory-paths-only · current `quick.json` valid)"; final
mergeability is decided by the unchanged live path. ① does **not** attempt to
reproduce the merge/union/merged-tree validation. Reuses the same path allowlist +
`quick.json` validator the workflow uses (factored into a shared pure validator);
read-only — inspects only the PR's file list/contents fetched via `gh`. **The
workflow's mutating bash is untouched.**

### 3. `buildMergeSweepReport` — `src/merge-sweep/report.js` (new, pure)

`buildMergeSweepReport(checkpoints, prev, now) → report`, schema:

```jsonc
{
  "ranAt": "<iso>",                  // = now (injected)
  "mode": "report",
  "cadenceMinutes": 15,              // for staleness math on the client
  "checkpoints": [
    { "name":"issue-gate", "status":"clean|flagged|error", "error":null,
      "items":[ {"ref":"PR#123","kind":"pr","number":123,"state":"would-clear",
                 "detail":"issue #99 closed","firstSeen":"<iso>","ageRuns":3} ] },
    { "name":"automerge", "status":"...", "items":[ /* would-merge|held|blocked + reason */ ] },
    { "name":"memory-automerge", "status":"...", "items":[ /* merge-candidate|needs-human */ ] }
  ],
  "summary": { "ok":<int>, "flagged":<int>, "errors":<int> }
}
```

**Item-state vocabulary** (closed set): `would-merge · merge-candidate · held ·
blocked · would-clear · would-label · needs-human · resolved`. (`would-merge` is
automerge's definitive pass; `merge-candidate` is memory's weaker read-only
pre-check; `blocked` reasons include `gate-unknown` and `pending-issue-gate`.)
Each item carries `number` (parsed int) so the dashboard builds links from the
number, never from free text.

**Status rule:** `error` if the checkpoint threw; else `flagged` if any item's
state ≠ `resolved`; else `clean`.

**Age + `resolved` rule (Round 1 MAJOR):** for each current item, find the same
`ref` in `prev`: same ref+state → carry `firstSeen`, `ageRuns = prev+1`;
new/changed → `firstSeen = now`, `ageRuns = 1`. A ref that was flagged in `prev`
but is **absent** now is emitted **once** as `{state:'resolved', ageRuns:1}` then
dropped on the following run — so ② can distinguish "resolved" from "never seen".

### 4. `merge-sweep` builtin — `scripts/dev-society-daemon.mjs`

Registered in `builtins`; uses the injected read-only `gh`, the
scheduler-provided mesh root, and a **shared path helper** so writer and reader
agree:

```js
'merge-sweep': async () => {
  const gh = async (args) => (await sh('gh', args, { maxBuffer: 1 << 24 })).stdout;
  const reportPath = mergeSweepReportPath(SCHED_MESH_ROOT);   // shared helper
  const prev = readJsonSafe(reportPath);                      // {} if missing/corrupt
  const checkpoints = [];
  const g = await safe(() => classifyIssueGate({ gh, repo: cfg.repo }));   // read-only; {held,cleared,error?}
  const gate = { held: new Set(g?.held || []), cleared: new Set(g?.cleared || []),
                 ok: !!g && !g.error };                        // fail-closed if the gate read failed
  checkpoints.push(issueGateCheckpoint(g));                    // status:'error' when g.error / !g
  checkpoints.push(await safe(() =>                            // automerge gets the FULL gate
    automergeCheckpoint(await listOpenPrs(gh, cfg.repo), { holdLabels, gate })));
  checkpoints.push(await safe(() =>
    memoryCheckpoint(gh, await listMemoryPrs(gh, cfg.repo))));
  // `safe(fn)` wraps fn in try/catch → returns an {name,status:'error'} checkpoint on throw,
  // so one broken concern never blanks the report.
  const report = buildMergeSweepReport(checkpoints, prev, new Date());
  writeJsonAtomic(reportPath, report);
  const s = report.summary;
  return s.errors ? { status:'fail', error:`${s.errors} checkpoint error(s); ${s.flagged} flagged` }
                  : { status:'ok',   output:`${s.flagged} flagged, ${s.ok} clean (report-only)` };
};
```

Each checkpoint helper wraps its own `gh`/classify in try/catch and returns an
`error` checkpoint on failure (so one broken concern never blanks the report).
`cfg.repo`/`sh`/`SCHED_MESH_ROOT` already exist in the daemon.

### 5. Schedule entry — `dev-mesh/maintainer/.agent/schedule.json`

```json
{ "id":"merge-sweep", "name":"Merge sweep (report-only)", "kind":"builtin",
  "builtin":"merge-sweep",
  "cadence":{ "kind":"every", "minutes":15 }, "enabled":true,
  "description":"Read-only inspect: issue-gate → automerge → memory-automerge; writes mesh/reports/merge-sweep.json. No merges/labels." }
```

The `"builtin":"merge-sweep"` field is required — the scheduler dispatches via
`builtins[job.builtin]` (`kind:"builtin"` alone resolves to `unknown builtin:
undefined`). A schedule lint test asserts the entry has it.

### 6. Dashboard — `/api/merge-sweep` + `◆ MERGE-SWEEP` panel

- **Endpoint** (`src/dashboard/server.js`): `GET /api/merge-sweep` reads
  `mergeSweepReportPath(meshRoot)` (the **same** shared helper as the writer) and
  returns the report, adding a server-computed `stale` flag:
  `stale = (now - ranAt) > 2 * cadenceMinutes*60_000`. Absent file →
  `{ available:false }`. Read-only; same auth as other `/api/*`.
- **Panel** (`graph-view.js` + `.css`): new foldable `#sec-merge-sweep`
  ("◆ MERGE-SWEEP") rendered like the approved mockup — one row per checkpoint
  (name · status pill · counts) expanding to the flagged items: a `number`-built
  link, the `state` chip, `detail`, and `ageRuns`. Header pill: `flagged N ·
  clean M · report-only`, plus a **`stale`** badge when the server flag is set.
  `{available:false}` → placeholder. **All GitHub-derived strings (titles,
  details, error messages) are rendered with the existing `esc()` / `textContent`
  — never as HTML — and links are built only from the parsed numeric `number`**
  (Round 1 MAJOR: XSS).

## Data Flow

`tick → merge-sweep (read-only gh) → classifyIssueGate + classifyAutomergePr +
classifyMemoryPr → buildMergeSweepReport(prev) → atomic write merge-sweep.json →
/api/merge-sweep → ◆ MERGE-SWEEP panel`. No GitHub mutation anywhere.

## Error Handling

- Per-checkpoint try/catch → `status:'error'` for that checkpoint; others run;
  builtin returns `status:'fail'` so Health surfaces it; a partial report is still
  written.
- **Gate read failure is data, not a throw** (Round 2 MAJOR): `classifyIssueGate`
  returns `{held:[], cleared:[], error}` on failure rather than throwing.
  `issueGateCheckpoint` treats a returned `error` (or a null result) as
  `status:'error'`, and the builtin sets `gate.ok = false` so the dependent
  automerge checkpoint **fails closed** — every otherwise-eligible PR becomes
  `blocked / gate-unknown`, never a false `would-merge`.
- Missing/corrupt prior report → empty (`ageRuns` resets); never throws.
- Atomic report write (temp + rename) — the dashboard never reads a partial file.
- `/api/merge-sweep`: absent → `{available:false}`; present-but-old → `stale:true`.

## Testing (hermetic, `node --test`, zero deps)

- **`classifyAutomergePr` (pure)** — each branch returns the right `{state,
  reason}`; the **both-sides gate overlay** (`held` → `blocked / pending-issue-gate`;
  `cleared` → ignores a stale `blocked-by-issue` label → can be `would-merge`);
  the **fail-closed** path (`gate.ok===false` → `blocked / gate-unknown`, never
  `would-merge`); and `isAutoMergeable` still agrees with `state==='would-merge'`
  under an empty, ok gate.
- **`classifyMemoryPr` (pure)** — valid same-repo memory PR → `merge-candidate`;
  fork → `needs-human:'fork'`; non-memory path or invalid `quick.json` →
  `needs-human` with reason.
- **`classifyIssueGate` extract** — the existing issue-gate tests still pass
  (refactor is behavior-preserving for `runIssueGate`); a new test asserts
  `classifyIssueGate` issues **no `pr edit`** (read-only) and returns the same
  `{held, cleared}` decision.
- **`buildMergeSweepReport` (pure)** — status classification; the age-merge
  (new→1, same→increment, changed→reset); the **`resolved` carry-once** rule;
  summary counts; injected `now`.
- **builtin read-only safety** — run `merge-sweep` with a **recording fake `gh`**
  and assert the command set is within a **read-only allowlist** (`pr list`,
  `pr view`, `issue view` only — no `pr merge`, `pr edit`, `pr comment`, `api`,
  `git push/commit/merge/checkout`) **and** the only filesystem write is the
  atomic report path. (Round 1 MAJOR: allowlist, not denylist.)
- **path consistency** — `mergeSweepReportPath(meshRoot)` used by both the builtin
  and `/api/merge-sweep` yields the identical path (one test pins it).
- **schedule lint** — the maintainer `schedule.json` `merge-sweep` job has
  `kind:"builtin"` **and** `builtin:"merge-sweep"` (so the scheduler can dispatch it).
- **dashboard** — `/api/merge-sweep` returns the report + `stale` for
  absent/old/current; a render test that flagged items list with state chips and
  that a hostile PR title is escaped (XSS regression).

## Verification (manual, on the host — after merge)

1. After deploy-sync pulls this, the maintainer schedule shows `merge-sweep`
   every 15m; within a tick `dev-mesh/mesh/reports/merge-sweep.json` appears.
2. Dashboard → `◆ MERGE-SWEEP` lists the checkpoints + flagged PRs/issues with
   state + age; a stale report shows the `stale` badge.
3. Confirm `merge-sweep` itself performed **no** mutation — its run-log shows only
   read `gh` calls; any state changes to PRs come from the *unchanged* existing
   mutators (GitHub crons / local `automerge-sweep`), which ① neither uses nor
   alters.

## State-machine boundary (① vs ②)

① defines and persists the **report state vocabulary + per-item age + the
`resolved` carry rule** — the source of truth. The **remediation lifecycle**
(`reported → assigned → fixing → verified → done`), the orchestrator polling, and
issue assignment are **sub-project ②**, which reads `mesh/reports/merge-sweep.json`.

---

### Review log

**Round 1 — Codex (gpt-5.5): VERDICT CHANGES_REQUESTED** (2 BLOCKER, 7 MAJOR, 1 MINOR).
- *BLOCKER dry-run gate vs automerge consistency* → **fixed**: overlay issue-gate `held` set onto automerge classification (`pending-issue-gate`).
- *BLOCKER `runIssueGate`/`runSweep` need `repo`+`enabled`* → **fixed**: pass `repo:cfg.repo, enabled:true, dryRun:true` to `runIssueGate`; automerge no longer calls `runSweep` at all (uses a read-only classifier).
- *MAJOR `runSweep` exposes no per-PR held/blocked reasons* → **fixed**: new pure `classifyAutomergePr` reusing the eligibility checks.
- *MAJOR report path (`repoRoot/mesh` vs `meshRoot=dev-mesh`)* → **fixed**: shared `mergeSweepReportPath(meshRoot)` helper + path-consistency test.
- *MAJOR existing local `automerge-sweep` mutator ⇒ "sole mutator" false* → **fixed**: new "Pre-existing mutators" section; verification reworded; ① framed as pure observer.
- *MAJOR `runMemoryAutomerge` behavior preservation* → **rebutted/rescoped**: ① does not extract the mutating bash; it adds a read-only `classifyMemoryPr`. The workflow is untouched, so "no behavior change" is trivially true.
- *MAJOR dry-run safety test too narrow* → **fixed**: read-only command allowlist + single-path filesystem-write allowlist.
- *MAJOR `resolved` has no emit rule* → **fixed**: carry-once rule defined.
- *MAJOR dashboard XSS* → **fixed**: `esc()`/`textContent` + numeric-ref links + XSS regression test.
- *MINOR staleness undefined* → **fixed**: server-computed `stale = now-ranAt > 2*cadence`, rendered + tested.

**Round 2 — Codex (gpt-5.5): VERDICT CHANGES_REQUESTED** (2 BLOCKER, 2 MAJOR). Round-1 rebuttal (memory rescope) **accepted** by Codex.
- *BLOCKER schedule job missing `"builtin"`* → **fixed**: added `"builtin":"merge-sweep"` (scheduler dispatches `builtins[job.builtin]`) + schedule lint test.
- *BLOCKER gate overlay only handled `held`, not `cleared`* → **fixed**: effective `blocked-by-issue` overlay handles both sides (`held`→present, `cleared`→absent).
- *MAJOR memory `would-merge` overclaims (no merge/union/merged-tree validation)* → **fixed**: positive state downgraded to `merge-candidate` (read-only pre-check); same-repo/fork filter added; live merge outcome explicitly out of scope.
- *MAJOR `runIssueGate` returns `{error}` not throws → false `would-merge`* → **fixed**: `gate.ok=false` on `error`/`errors>0`; automerge fails closed (`blocked / gate-unknown`).

**Round 3 — Codex (gpt-5.5): VERDICT CHANGES_REQUESTED** (2 BLOCKER, 1 MINOR).
- *BLOCKER still calls mutating-capable `runIssueGate(dryRun)` vs the read-only guarantee* → **fixed**: extract read-only `classifyIssueGate` (component 0); `merge-sweep` calls only it; `runIssueGate` refactored to delegate the decision.
- *BLOCKER builtin pseudocode passed only `gateHeld`, not the `cleared`/`ok` gate* → **fixed**: builtin now builds `gate={held,cleared,ok}` and threads it through `automergeCheckpoint`.
- *MINOR schema example still said memory `would-merge`* → **fixed**: now `merge-candidate|needs-human`.

**Round 4 — Codex (gpt-5.5): VERDICT CHANGES_REQUESTED** (1 BLOCKER, consistency only).
- *BLOCKER Data Flow / Error Handling still referenced `runIssueGate(dryRun)`* → **fixed**: both now describe `classifyIssueGate + classifyAutomergePr + classifyMemoryPr`; gate-failure framed via `classifyIssueGate` returning `{error}` / `gate.ok=false`. (Also corrected the architecture fail-closed paragraph's stale `gate.errors`/`runIssueGate` wording.)
