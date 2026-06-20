# Merge-Sweep Remediation Loop Design (Sub-project ②)

**Date:** 2026-06-20
**Status:** Codex round 1 reviewed (3 BLOCKER + 3 MAJOR, all fixed). Round 2 pending — Codex usage limit (resets 2026-06-24); self-review clean.
**Topic:** A level-triggered **backstop** controller that reads the merge-sweep report (①), escalates only items the automatic fixers couldn't clear (or don't cover) as one deduped `needs-human` issue per item, and tracks every flagged item through a per-item state machine (`watching → escalated → done`) surfaced on the dashboard. It never re-runs a fixer and never double-files.

## Problem

Sub-project ① produces a read-only report (`mesh/reports/merge-sweep.json`) of
flagged items — stuck PRs (`automerge` `blocked` with `not-clean:DIRTY|UNSTABLE`),
memory PRs needing review (`memory-automerge` `needs-human`), and issue-gate
items — each with an `ageRuns` counter. Nothing acts on that report. The reactive
fixers (`dev-mesh-autofix` on CI-red, `dev-mesh-mergefix` on conflicts) each get
~2 attempts then give up; `escalation-sweep` files `needs-triage` issues for
*time-stale* PRs. But there is no layer that (a) notices an item is **still stuck
after the fixers exhausted their budgets**, (b) covers items the PR-fixers don't
(memory/issue-gate), and (c) tracks each flagged item to closure. ② fills exactly
that, and only that.

## Goal

A daemon cron builtin **`merge-sweep-remediate`** (~every 30 min) that, per the
Kubernetes reconcile-loop contract, re-reads the report each tick and:

1. **escalates** an actionable item to **one deduped `needs-human` GitHub issue**
   — only when `ageRuns ≥ ESCALATE_AFTER` (the fixers' budgets are spent), it is
   not exempt, under a per-run cap, and **no existing escalation already covers
   it** (its own marker *or* `escalation-sweep`'s issue);
2. **self-closes** that issue once the item has been resolved for **K consecutive
   sweeps** (resolve hysteresis — the issue stays *open* through a brief flap so it
   isn't closed-then-reopened), with exponential backoff on repeat flaps;
3. **tracks** every flagged item's lifecycle in `mesh/reports/merge-sweep-remediation.json`
   and surfaces it on the dashboard.

## Design principles (researched, not invented)

| ② decision | prior art |
|---|---|
| Level-triggered: re-derive the action set from the report each run; tracked state is a **cache, not ground truth**; cron = `RequeueAfter` | Kubernetes controller-runtime reconcile |
| `ageRuns ≥ N` open-gate (hold "pending", ignore transient) | Prometheus `for:` · CloudWatch M-of-N |
| Resolve **hysteresis** (K healthy sweeps before reopen) + exponential **reopen backoff** | Prometheus `keep_firing_for` · Nagios flap thresholds · CrashLoopBackOff |
| Two-layer dedup (shared label + per-item hidden marker), never title-only; self-close; exemption label | probot/stale · peter-evans/find-comment · k8s test-infra post-mortems |
| Human-closed issue ⇒ **never recreate** | Renovate `recreateWhen:never` · Dependabot |
| One artifact per item; humans own destructive steps | Mozilla intermittent-bug-filer · Chromium Flake Portal |

## Non-Goals (hold the line)

- **Not a fixer.** ② never re-runs autofix/mergefix and never edits code/PRs. Its
  only writes are: create/close `needs-human` issues, the idempotent
  `gh label create needs-human` self-heal, and its state file. (Round-1 MAJOR: the
  allowlist test must include `label create`.)
- **No agent assignment / task board.** ② files **human** escalation issues only.
  Routing escalations to agents for research-driven fixes is **sub-project ③**.
- **No new detection.** ② reads ①'s report; it does not re-scan PRs itself.
- **No double-escalation — bidirectional.** ② dedups against `escalation-sweep`'s
  `needs-triage` issues, **and** `escalation-sweep` is taught to dedup against ②'s
  `needs-human` markers (Round-1 BLOCKER: one-way dedup let `escalation-sweep` file
  a second issue *after* ② filed for the same PR). One small edit to
  `escalation-sweep` is in scope; the fixers and ①/merge-sweep are untouched.
- **No change to ① / merge-sweep or the fixers.**

## Background (verified against code)

- ① report (`src/merge-sweep/report.js`): `{ ranAt, cadenceMinutes, checkpoints:[
  { name, status, items:[{ ref:'PR#240', number:240, state, detail, firstSeen, ageRuns }] } ], summary }`.
  `mergeSweepReportPath(meshRoot)` → `<meshRoot>/mesh/reports/merge-sweep.json`.
- `src/automerge/escalation-sweep.js` `runEscalation` is the pattern to mirror: it
  lists open PRs + open `needs-triage` issues, files a deduped issue per stuck PR
  (`escalationTitle` = ``needs-triage: PR #N stuck (STATUS)``, dedup by
  `parsePrNumber(title)`), self-closes its **own** issues (guarded by an
  own-title regex) when the PR recovers, supports `dryRun`, and treats per-item
  failure as data. `ensureLabels(gh, [...], {repo})` self-heals a missing label.
- Daemon builtins live in `scripts/dev-society-daemon.mjs`'s `builtins` map (return
  `{status, output|error}`); `sh`, `cfg.repo`, `SCHED_MESH_ROOT` in scope; scheduler
  dispatches `builtins[job.builtin]`; schedule entries need `kind:"builtin"` +
  `builtin:"<id>"`.
- The dashboard renders the merge-sweep report in the Schedules expand via
  `renderMergeSweep` (`src/dashboard/public/merge-sweep-render.js`) fed by
  `/api/merge-sweep`. ② adds a remediation-state overlay.

## Architecture

```
merge-sweep (15m) ── writes ──▶ mesh/reports/merge-sweep.json
                                       │  (fresh gh observation each 15m → ageRuns are independent samples)
merge-sweep-remediate (30m, level-triggered)
   read report  +  read prev remediation-state  +  read open issues (needs-human, needs-triage)
        └─ reconcile LIVE state: re-fetch each tracked PR/issue; guard transitions on prStillOpen
        └─ planRemediation(...)  ── pure ──▶ { file:[…], close:[…], skip:[…], nextState }
   execute: gh issue create (label needs-human + marker) · gh issue close (self-clean)
   write mesh/reports/merge-sweep-remediation.json
                                       │
dashboard: /api/merge-sweep + remediation overlay → per-item badge (watching · escalated→#N · done · acked)
```

## Components

### 1. `src/merge-sweep/remediation.js` (pure) — the state machine

The whole policy is one pure function plus small helpers, so every research rule
is a unit test.

**Item key:** `key = \`${checkpoint}:${ref}\`` (e.g. `automerge:PR#240`) — stable.

**Actionable states** (what ② escalates): `automerge` items with state `blocked`
whose reason starts `not-clean:` (DIRTY/UNSTABLE — the fixers' domain, now
exhausted); `memory-automerge` items with state `needs-human`. **Excluded:**
`would-merge`, `held`, `would-clear`/`would-label`, `merge-candidate`,
`pending-issue-gate` (a gate state, not a fix), and any `resolved`. (`issue-gate`
items are tracked but not escalated in v1 — they're advisory.)

**Marker:** `<!-- needs-human:${key} -->` embedded in the issue body. Dedup is
two-layer: the shared `needs-human` **label** (fast list) + the per-key **marker**
(exact match). For an `automerge:PR#N` item, ② *also* treats any open
`needs-triage` issue whose title parses to PR `#N` as an existing escalation
(dedup against `escalation-sweep`).

**State record** (per key, in the state file):
```jsonc
{ "state":"watching|escalated|done|cooldown|acked",
  "issueNumber": 312|null,          // the needs-human issue ② opened (null if escalation-sweep owns it / none)
  "firstEscalatedAt":"<iso>|null",
  "healthyStreak": 0,               // consecutive sweeps the item has been ABSENT from the stuck set
  "reopenCount": 0,                 // flap counter → exponential backoff
  "nextEligibleAt":"<iso>|null",    // backoff gate before a re-escalation is allowed
  "observed": "<updatedAt or sha>"  // live fingerprint for staleness detection
}
```

**`planRemediation({ report, prev, openIssues, liveByKey, now, cfg })` → `{ file, close, skip, nextState }`** where `cfg = { escalateAfter:4, hysteresisK:3, capPerRun:5, backoffBaseMs:30*60_000, exemptLabels:['exempt','pinned'] }`:

For each **currently-stuck** actionable item (from the report), in order:
- Our marker-issue exists but is **closed** (we only self-close *resolved* items, so
  a closed issue on a still-stuck item means a **human** closed it) → `state:'acked'`
  (terminal; never re-file). Detecting this requires querying closed issues — see runner.
- Already `acked` → stay `acked`, no file.
- A `cooldown` item (its issue is still open) becomes stuck again → `state:'escalated'`,
  **same open issue, no new file** (delayed-close kept it open through the flap).
- An existing **open** escalation already covers it (our open marker, or an
  `escalation-sweep` `needs-triage` for the PR) → `state:'escalated'`, **no file**.
- Exempt (the item's PR carries an exempt label) → `skip`, `state:'watching'`.
- `ageRuns < escalateAfter` → `state:'watching'`, no action (let the fixers work).
- `now < nextEligibleAt` (backoff after a `done`→re-stuck flap) → `state:'cooldown'`, no file.
- Otherwise eligible and `< capPerRun` filed this run → **propose `file`**,
  `state:'escalated'`, stamp `firstEscalatedAt`, `healthyStreak=0`.

For each **tracked item NOT currently stuck** (resolve edge) — **close is delayed by
hysteresis** so a flapping item keeps one open issue instead of churning closed/reopened:
- `state:'escalated'` → `state:'cooldown'`, `healthyStreak=1`, **issue stays open** (no close).
- `state:'cooldown'`, `healthyStreak+1 < hysteresisK` → stay `cooldown`, `healthyStreak++`, issue open.
- `state:'cooldown'`, `healthyStreak+1 ≥ hysteresisK` → **propose `close`** (self-clean), `state:'done'`.
- `state:'done'` that later re-sticks then resolves again → `reopenCount++`,
  `nextEligibleAt = now + backoffBaseMs * 2^reopenCount` (widening flap backoff).
- `state:'acked'` → terminal, unchanged.

`planRemediation` only **proposes** `file`/`close`; the runner commits the
post-action state (`escalated` with the *actual* created issue number, or `done`)
**only after** the `gh` create/close succeeds. A failed create/close leaves the item
in its prior state to retry next tick — failures never advance the state machine
(Round-1 MAJOR). So `nextState` is the plan's *non-action* transitions; action
outcomes are merged by the runner.

Pure: no I/O, `now` injected, deterministic.

### 2. `merge-sweep-remediate` builtin — `scripts/dev-society-daemon.mjs`

Mirrors `runEscalation`'s injected, failure-is-data shape. The orchestration lives
in a testable `src/merge-sweep/remediation-run.js`
`runRemediation({gh, repo, meshRoot, readReport, readState, writeState, now, cfg})`
(fake-`gh` testable, exactly as ① split `runMergeSweep`):

```
report = readReport()                         // {available:bool, ...} — distinguishes valid-empty from unavailable
if (!report.available) {                       // ROUND-1 BLOCKER: never close live issues on a read failure
  return { status:'fail', error:'merge-sweep report unavailable — no remediation this tick (state preserved)' }
}
prev = readState() || {}
own  = gh issue list --label needs-human --state all --json number,body,state   // OPEN *and CLOSED* → human-ack detection
triage = gh issue list --label needs-triage --state open --json number,title     // escalation-sweep dedup
liveByKey = reconcile: for each tracked item still referenced, gh pr view <n> --json number,state,updatedAt,mergeStateStatus
plan = planRemediation({ report, prev, openIssues:own, triage, liveByKey, now, cfg })   // pure → { file, close, skip, nextState }
state = { ...plan.nextState }
for f in plan.file:                            // commit state ONLY on success
  try { ensureLabels(['needs-human']); const n = parseNewIssueNumber(gh issue create --label needs-human --title … --body "<marker>\n\n…")
        state[f.key] = { ...state[f.key], state:'escalated', issueNumber:n, firstEscalatedAt:iso } }
  catch (e) { log(...); state[f.key] = prev[f.key] || { state:'watching' } }   // leave prior state to retry
for c in plan.close:
  try { gh issue close <c.issueNumber> --comment "🤖 ② resolved — closing."; state[c.key] = { ...state[c.key], state:'done' } }
  catch (e) { log(...); state[c.key] = prev[c.key] }                            // stay cooldown/escalated, retry
writeJsonAtomic(remediationPath, state)
return { status:'ok', output:`escalated ${plan.file.length}, closed ${plan.close.length}, tracking ${Object.keys(state).length}` }
```
Per-item `gh` failures are logged and skipped; the run still writes state and returns
`ok` (failure is data). `ensureLabels(['needs-human'])` is an idempotent
`gh label create` — see the mutation boundary below.

### 2b. `escalation-sweep` — bidirectional dedup (one small edit)

To close the one-way-dedup BLOCKER, `src/automerge/escalation-sweep.js` is taught
to also skip a PR that ② has already escalated. It already lists open
`needs-triage` issues and builds `existingPrNums`; add a second list of open
`needs-human` issues and union their PR numbers (parsed from ②'s
`<!-- needs-human:automerge:PR#N -->` markers) into `existingPrNums` before the
file loop. ~6 lines; the existing escalation tests are extended with "an open
`needs-human` for PR #N suppresses the `needs-triage` open." No other behavior
changes. (Now neither sweep can file a second issue for the same PR, regardless of
order.)

### 3. Schedule entry — `dev-mesh/maintainer/.agent/schedule.json`
```json
{ "id":"merge-sweep-remediate", "name":"Merge-sweep remediation (backstop)", "kind":"builtin",
  "builtin":"merge-sweep-remediate", "cadence":{ "kind":"every", "minutes":30 }, "enabled":true,
  "description":"Backstop: escalate report items the fixers couldn't clear as deduped needs-human issues; track lifecycle. No code changes." }
```

### 4. Dashboard — remediation overlay

`/api/merge-sweep` additionally loads `merge-sweep-remediation.json` (via the same
mesh-root helper) and merges a per-item `remediation` field
(`{state, issueNumber}`) keyed by `checkpoint:ref` into the report it returns.
`renderMergeSweep` shows a badge per flagged item: `watching` (muted),
`escalated → #312` (linked), `done` (green), `acked` (violet). Escaped, numeric
issue links only. Absent state file → no badge (unchanged behavior).

## Data Flow

`merge-sweep (15m) → report` → `merge-sweep-remediate (30m)`: read report + state +
issues → reconcile live → `planRemediation` → file/close deduped `needs-human`
issues → write state → dashboard overlays per-item badges. The only mutations are
issue create/close + the state file.

## Error Handling

- Per-item `gh` failure (create/close/view) → logged, that item left in its prior
  state to retry next tick (never advances on failure); the run continues and still
  writes state (failure is data).
- **Report unavailable vs valid-empty (Round-1 BLOCKER).** `readReport` returns
  `{available:false}` when the report file is missing/corrupt/unreadable — distinct
  from a present report with zero flagged items. On `available:false`, ② performs
  **no create or close** (which would otherwise wrongly close every live escalation)
  and returns `status:'fail'` with state **preserved**. Only a present, parseable
  report drives close decisions.
- Missing/corrupt state file → treated as empty (no prior tracking); `ageRuns`
  gating simply won't fire on first sight; never throws.
- Reconcile guard: before acting on a tracked PR, re-fetch its live state; if the
  PR is closed/merged, the item converges to `done`/`acked`, never escalated.
- State write is atomic (temp + rename).
- The builtin returns `status:'fail'` only if the report read itself throws;
  per-item issues are `ok` with a count, so Health doesn't flap on a transient gh
  error.

## Testing (hermetic, `node --test`, zero deps)

`planRemediation` (pure) carries the weight — one test per rule:
- **open-gate:** `ageRuns < N` → watching, no file; `≥ N` → propose file. Exempt label → skip.
- **dedup:** an open own-marker issue → no second file; an open `needs-triage` for the
  same PR → no file; never dedups by title alone.
- **cap:** more than `capPerRun` eligible → only `capPerRun` proposed; rest stay watching.
- **delayed close (hysteresis):** escalated item absent for 1 sweep → `cooldown`, issue
  stays open (no close proposed); absent for `hysteresisK` sweeps → propose close, `done`;
  a `cooldown` item re-stuck before K → back to `escalated`, **no new file**.
- **human-ack:** our marker-issue is *closed* while the item is still stuck → `acked`,
  never re-file (the runner must have surfaced the closed issue via `--state all`).
- **reopen backoff:** a `done` item that flaps → `reopenCount++`, `nextEligibleAt`
  widens (2^reopenCount); within the window → no re-file.
- **actionable filter:** `would-merge`/`held`/`pending-issue-gate`/`merge-candidate`/
  `resolved` never escalate; `not-clean:*` and memory `needs-human` do.

`runRemediation` (fake recording `gh`):
- **read-mostly allowlist:** only `issue list`, `pr view`, `issue create`, `issue close`,
  `label create` — **no** `pr merge`/`pr edit`/`pr comment`/`api`/`git`.
- **report-unavailable safety:** with `readReport()→{available:false}`, it issues **no
  `issue close`/`create`**, preserves the prior state file, and returns `status:'fail'`.
- **closed-issue ack:** the `needs-human` list is queried `--state all`; a seeded closed
  marker issue for a still-stuck item → `acked`, no create.
- **state after mutation:** a failing `issue create` leaves that item in its prior state
  (not `escalated`); a failing `issue close` leaves it `cooldown` (not `done`).

`escalation-sweep` (extend existing test): an open `needs-human` issue carrying
`<!-- needs-human:automerge:PR#N -->` suppresses the `needs-triage` open for PR #N
(bidirectional dedup).

Dashboard: `/api/merge-sweep` overlay shape test + a panel render test for the badge
(escaped, numeric issue link). Schedule lint: the job has `builtin:"merge-sweep-remediate"`.

---

### Review log

**Round 1 — Codex (gpt-5.5): VERDICT CHANGES_REQUESTED** (3 BLOCKER, 3 MAJOR).
- *BLOCKER one-way dedup* → **fixed**: bidirectional — `escalation-sweep` also dedups against ②'s `needs-human` PR markers (§2b).
- *BLOCKER human-ack invisible (no `--state all`)* → **fixed**: runner queries `needs-human --state all`; closed-marker-while-stuck → `acked`; test added.
- *BLOCKER report-unavailable → closes live issues* → **fixed**: `readReport` returns `{available}`; on `false`, no create/close, state preserved, `status:'fail'`.
- *MAJOR resolve-hysteresis claim vs close-on-first-absent* → **fixed**: switched to **delayed close** (keep the issue open K sweeps, `keep_firing_for` semantics); claim now matches.
- *MAJOR `ensureLabels` = `label create` outside the mutation boundary* → **fixed**: `label create` added to the allowed-writes list + allowlist test.
- *MAJOR state set before mutation results* → **fixed**: `planRemediation` only *proposes* file/close; the runner commits `escalated`(real issue #)/`done` only on success, leaving failures in prior state.

## Verification (manual, on the host — after merge)

1. The maintainer schedule shows `merge-sweep-remediate` (30m); `mesh/reports/merge-sweep-remediation.json` appears.
2. For a PR stuck `not-clean:DIRTY` with high `ageRuns` and no existing escalation,
   exactly one `needs-human` issue (with the `<!-- needs-human:automerge:PR#N -->`
   marker) is filed; a second run files nothing more.
3. When that PR is fixed/merged, ② closes its issue on the next run; the dashboard
   badge flips `escalated → done`. A human-closed escalation flips to `acked` and is
   never re-filed.
4. Run-log shows only read `gh` + `issue create/close` — no `pr merge`/`pr edit`.
