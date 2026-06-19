# Mesh self-healing gap closure — nothing hangs silently

Status: design (2026-06-19) · from a full audit of the issue/PR/heartbeat automation.
Goal: every open issue and PR is detected and driven forward or **surfaced** — no silent
hangs.

## Audit summary (holes found)

| # | Hole | Verdict | Action |
|---|---|---|---|
| I1 | Terminal-labelled issues (`done`/`rejected`/`wontfix`/`duplicate`/`invalid`) stay **open forever** — nothing runs `gh issue close` | REAL | **FIX** (this PR) |
| P1 | Repair-budget dead-ends: `review-respond`/`autofix`/`mergefix` exhaust ≤2 attempts → "needs a human" comment, **no label, janitor doesn't catch** → invisible hang | REAL | **FIX** via escalation sweep (this PR) |
| P2 | No-review orphan: a CLEAN PR whose review never ran hangs awaiting APPROVED | REAL | **FIX** via escalation sweep |
| P3 | Long-DIRTY / long-UNKNOWN / long-UNSTABLE PRs past their repair window | REAL | **FIX** via escalation sweep |
| I2 | `blocked` issue never auto-unblocks | INTENTIONAL (safety after #98) | document |
| I3 | advisory comment (analyst/triager) doesn't auto-advance labels | INTENTIONAL (ask-only agents) | document |
| I4 | `discussing` orphan label | INTENTIONAL/orphan | document |
| I5 | `listAllOpen` caps at 100 | scalability | document (raise later) |
| H1 | heartbeat escalation issues lack root-cause context | enhancement | defer |
| H2 | daemon meta-health (process down), gh-auth expiry, workflow-disabled | infra | defer |
| P4 | fork PRs can't auto-merge (no review) | INTENTIONAL (F4 security) | document |

This PR closes I1, P1, P2, P3 — the holes that cause **silent** hangs. The rest are
either intentional human gates or infra/enhancement items, documented here so they are
tracked rather than forgotten.

## Fix 1 — auto-close terminal issues (issue side)

`src/dev-society/core.js`: `isTerminalState(issue) → boolean` (open issue carrying any of
`done`/`rejected`/`wontfix`/`duplicate`/`invalid`). The daemon `sweep()` closes such
issues (`gh issue close --comment …`) at the top of the tick, before routing. Idempotent
(the sweep only ever sees open issues). Closes the "done but still open" hang (e.g. the
manual closes of #82/#76).

## Fix 2 — escalation sweep (PR side): surface stale-stuck PRs

A PR past automated recovery is **surfaced as a `needs-triage` issue** so a human (and the
issue automation, which routes `needs-triage` to the triager) sees it — instead of hanging
invisibly. Self-cleaning: when the PR is no longer stuck, the escalation issue is closed.

### `src/automerge/escalation.js` (pure)
- `prNeedsEscalation(pr, {now, staleMs}) → boolean` — true iff PR is open, **non-draft**,
  **same-repo**, not `memory:promote`, in a stuck state, and not updated within `staleMs`.
  Stuck state = `mergeStateStatus ∈ {DIRTY, UNKNOWN, UNSTABLE}` OR
  `reviewDecision === 'CHANGES_REQUESTED'` OR (`mergeStateStatus === 'CLEAN'` AND
  `reviewDecision !== 'APPROVED'`). Excludes `BLOCKED` (intentional hold, e.g.
  `blocked-by-issue`), `BEHIND` (mergefix), and CLEAN+APPROVED (auto-merges).
- `escalationTitle(pr)` / `escalationBody(pr)` — the dedup-keyed title (`needs-triage: PR
  #N stuck (…)`) and a context-rich body (url, state, reviewDecision, guidance).
- `parsePrNumber(title) → number|null` — extracts the PR number from an escalation title,
  for the self-cleaning close pass.

### `src/automerge/escalation-sweep.js` (impure, injected gh — mirrors `sweep.js`)
`runEscalation({ gh, repo, enabled, staleMs, now, dryRun, log })`:
1. `enabled !== true` → no-op.
2. List open PRs (`number,title,url,isDraft,isCrossRepository,mergeStateStatus,
   reviewDecision,updatedAt,labels`).
3. **Open:** for each `prNeedsEscalation` PR with no existing open `needs-triage` issue
   titled `PR #N` (dedup via `gh issue list --search`), create one.
4. **Close (self-clean):** for each open `needs-triage` escalation issue whose PR is no
   longer in the stuck set (merged/closed/now-mergeable), `gh issue close` it.
   Per-item errors are data — logged, never abort.

### `scripts/escalation-sweep.mjs` + `.github/workflows/dev-mesh-escalate.yml`
- cron `12,42 * * * *` (every 30 min, offset from the others); `workflow_dispatch` w/ dry_run.
- Gated by `AUTOMERGE_ENABLED`; `permissions: { contents: read, issues: write, pull-requests: read }`.
- `DEV_MESH_PR_STALE_MS` (default 10800000 = 3h) — long enough that transient/in-repair
  states clear themselves before escalation.
- Ensures the `needs-triage` label exists.

## Testing

- `test/escalation.test.js` (pure): `prNeedsEscalation` truth table (each stuck state,
  draft/fork/memory exclusions, BLOCKED/CLEAN+APPROVED excluded, staleMs boundary);
  `parsePrNumber`; title/body shape.
- `test/escalation-sweep.test.js` (injected gh): opens for a stale-stuck PR, dedups when an
  issue exists, closes the escalation when the PR is no longer stuck, disabled → no-op,
  dryRun → decides but no writes.
- `test/dev-society.test.js`: `isTerminalState` cases.
- `test/escalate-workflow.test.js`: cron/gate/label-ensure/permissions/invokes script.

## Out of scope (documented follow-ups)
- I2/I3/I4 intentional gates; I5 pagination; H1 escalation context; H2 daemon meta-health
  (process liveness, gh-auth, workflow-enabled detection) — the largest remaining
  self-healing work, deferred to a daemon-health PR.
