# Merge-Sweep Remediation Loop Design (Sub-project ②)

**Date:** 2026-06-20
**Status:** Draft — pending Codex review
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
2. **self-closes** that issue when the item resolves, gated by **resolve
   hysteresis + reopen backoff** so a flapping item can't storm;
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
  only writes are: create/close `needs-human` issues + write its state file.
- **No agent assignment / task board.** ② files **human** escalation issues only.
  Routing escalations to agents for research-driven fixes is **sub-project ③**.
- **No new detection.** ② reads ①'s report; it does not re-scan PRs itself.
- **No double-escalation.** It dedups against `escalation-sweep`'s `needs-triage`
  issues; it never files a second issue for a PR already escalated.
- **No change to ① / merge-sweep, the fixers, or escalation-sweep.**

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
  (terminal; never re-file).
- An existing **open** escalation covers it (our open marker, or an
  `escalation-sweep` `needs-triage` issue for the PR) → `state:'escalated'`, **no
  file** (track only).
- Exempt (the item's PR carries an exempt label) → `skip`, `state:'watching'`.
- Previously `acked` → stay `acked`, no file.
- `ageRuns < escalateAfter` → `state:'watching'`, no action (let the fixers work).
- `now < nextEligibleAt` (flap backoff active) → `state:'cooldown'`, no action.
- A `done`/`cooldown` item re-stuck with `healthyStreak < hysteresisK` (a flap) →
  `reopenCount++`, `nextEligibleAt = now + backoffBaseMs * 2^reopenCount`,
  `state:'cooldown'`, no file.
- Otherwise (eligible) and `< capPerRun` files used this run → **`file`**,
  `state:'escalated'`, stamp `firstEscalatedAt`, `healthyStreak=0`.

For each **tracked item NOT currently stuck** (resolve edge):
- `state:'escalated'` with our `issueNumber` still open → **`close`** it
  (self-clean), `state:'done'`, `healthyStreak=1`.
- `state:'done'`/`'cooldown'`/already-healthy → increment `healthyStreak` each
  consecutive healthy sweep (this is what later satisfies the `≥ hysteresisK`
  reopen gate above).
- `state:'acked'` → terminal, unchanged.

Pure: no I/O, `now` injected, deterministic.

### 2. `merge-sweep-remediate` builtin — `scripts/dev-society-daemon.mjs`

Mirrors `runEscalation`'s injected, failure-is-data shape. Read-mostly:
```
gh issue list --label needs-human --json number,body,state,closedAt   (own escalations + markers)
gh issue list --label needs-triage --json number,title,state          (escalation-sweep dedup)
read report (mergeSweepReportPath) + prev state (remediationPath)
reconcile: for each tracked PR, gh pr view <n> --json number,state,updatedAt,mergeStateStatus (guard/fingerprint)
plan = planRemediation(...)
for f in plan.file:  ensureLabels([needs-human]); gh issue create --label needs-human --title … --body "<marker>\n\n…"
for c in plan.close: gh issue close <n> --comment "🤖 ② resolved — closing."
writeJsonAtomic(remediationPath, plan.nextState)
return { status:'ok', output:`escalated ${file.length}, closed ${close.length}, tracking ${n}` }
```
A new pure `src/merge-sweep/remediation-run.js` `runRemediation({gh, repo, meshRoot, readReport, readState, writeState, now, cfg})` holds the orchestration (so it's testable with a fake `gh`), exactly as ① split `runMergeSweep` from the builtin. Per-item `gh` failures are logged and skipped.

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

- Per-item `gh` failure (create/close/view) → logged, that item skipped; the run
  continues and still writes state (failure is data).
- Missing/corrupt report or state file → treated as empty; `ageRuns`-based gating
  simply won't fire; never throws.
- Reconcile guard: before acting on a tracked PR, re-fetch its live state; if the
  PR is closed/merged, the item converges to `done`/`acked`, never escalated.
- State write is atomic (temp + rename).
- The builtin returns `status:'fail'` only if the report read itself throws;
  per-item issues are `ok` with a count, so Health doesn't flap on a transient gh
  error.

## Testing (hermetic, `node --test`, zero deps)

`planRemediation` (pure) carries the weight — one test per research rule:
- **open-gate:** `ageRuns < N` → watching, no file; `≥ N` → file. Exempt label → skip.
- **dedup:** existing own-marker issue → no second file; existing `needs-triage`
  for the same PR → no file (escalation-sweep dedup); never dedups by title alone.
- **cap:** more than `capPerRun` eligible → only `capPerRun` filed; rest stay watching.
- **self-close:** escalated item absent from the stuck set → close, state `done`.
- **human-ack:** our issue closed by a human while still stuck → `acked`, never re-file.
- **hysteresis:** a `done` item re-stuck before `hysteresisK` healthy sweeps → not
  re-escalated (cooldown); re-stuck after `≥ hysteresisK` → re-escalated.
- **reopen backoff:** repeated flaps widen `nextEligibleAt` (2^reopenCount); within
  the window → no re-file.
- **actionable filter:** `would-merge`/`held`/`pending-issue-gate`/`merge-candidate`/
  `resolved` never escalate; `not-clean:*` and memory `needs-human` do.

`runRemediation` (with a fake recording `gh`): read-mostly allowlist (only
`issue list`, `pr view`, `issue create`, `issue close` — **no** `pr merge`/`pr edit`/
`api`/`git`), writes one state file, dedups against seeded `needs-triage`/`needs-human`
issues. `/api/merge-sweep` overlay shape test + a panel render test for the badge
(escaped). Schedule lint: the job has `builtin:"merge-sweep-remediate"`.

## Verification (manual, on the host — after merge)

1. The maintainer schedule shows `merge-sweep-remediate` (30m); `mesh/reports/merge-sweep-remediation.json` appears.
2. For a PR stuck `not-clean:DIRTY` with high `ageRuns` and no existing escalation,
   exactly one `needs-human` issue (with the `<!-- needs-human:automerge:PR#N -->`
   marker) is filed; a second run files nothing more.
3. When that PR is fixed/merged, ② closes its issue on the next run; the dashboard
   badge flips `escalated → done`. A human-closed escalation flips to `acked` and is
   never re-filed.
4. Run-log shows only read `gh` + `issue create/close` — no `pr merge`/`pr edit`.
