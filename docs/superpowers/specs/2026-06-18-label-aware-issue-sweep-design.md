# Label-aware issue sweep (10-min, maintainer-owned)

Status: design (approved in brainstorming 2026-06-18)
Supersedes the narrow `approved ∧ route:a2a → coder` selection in the dev-society daemon.
Related: [a2a-dev-society-design](2026-06-16-a2a-dev-society-design.md),
[mesh-gh-activity-poller-design](2026-06-18-mesh-gh-activity-poller-design.md),
[mesh-scheduling-ops-design](2026-06-18-mesh-scheduling-ops-design.md).

## Problem

Today the dev-society daemon (`scripts/dev-society-daemon.mjs`) polls every 60s and
routes **only** issues labeled `approved ∧ route:a2a` to the **coder** (build → test
→ review → PR). Everything else — bugs without `route:a2a`, ideas needing a spec,
questions, CI failures — is invisible to the mesh. We want a single recurring sweep
that looks at *all* open issues, applies a human-approval gate to ideas, and routes
each actionable issue to the right specialist by its labels.

## Decisions (from brainstorming)

1. **Owner:** the **maintainer** (the dev-mesh dispatcher) owns the sweep, expressed
   as a `kind: builtin` job in `dev-mesh/maintainer/.agent/schedule.json`
   (`issue-sweep`, `cadence: { every, minutes: 10 }`) — same pattern as the existing
   `gh-activity-poll` / `daily-report-refresh` builtins.
2. **Mechanism:** deterministic JS, not an LLM session. Ask-mode agents have no
   `Bash`/`gh`, so they cannot query or label GitHub. Routing *logic* lives in the
   pure, hermetically-tested core (`src/dev-society/core.js`); the daemon is the
   impure shell that runs `gh`/`git` and orchestrates writes.
3. **Replace the existing loop:** the daemon's standalone `do…while` poll loop is
   retired. The scheduler builtin is the single sweep entry point.
4. **Idea gate:** `idea` issues are skipped unless they also carry `approved`.
5. **Full specialist routing map** (see below).
6. **Fully autonomous code writes:** the coder builds + opens a PR for any actionable
   code-typed issue. `approved` and `route:a2a` are **no longer required** to build.
   `route:a2a` is kept as a harmless no-op for backward compatibility.
7. **Spec loop closes via the analyst:** ideas are driven through `spec:draft` →
   `spec:in-review` automatically; the human gate is at `spec:in-review` (approval)
   and `pr:in-review` (merge).
8. **Stale recovery for `in-progress`:** a stuck `in-progress` (no live build, age >
   timeout) is cleared and re-claimed.

## Routing core — `routeFor(issue)` (pure, new in `src/dev-society/core.js`)

Returns `{ target, mode, advance? }` or `{ target: null, reason }`. First match wins.

| # | Condition (labels / title) | target | mode | advance label | meaning |
|---|---|---|---|---|---|
| 1 | `done`/`rejected`/`wontfix`/`duplicate`/`invalid` | null | — | — | terminal — skip |
| 2 | `spec:in-review` / `pr:in-review` / `blocked` | null | — | — | human-gated — skip |
| 3 | `in-progress` **and** not stale | null | — | — | build in flight — skip |
| 4 | `in-progress` **and** stale (no live build, age > `STALE_MS`) | coder | do | clear `in-progress` | crash recovery — re-claim |
| 5 | `idea` **and not** `approved` | null | — | — | awaiting human approval — skip |
| 6 | title `^(flake\|real_bug\|infra_auth\|out_of_scope):` | triager | ask | — | CI failure — classify + plan |
| 7 | `spec:draft` | analyst | ask | `spec:draft`→`spec:in-review` | finalize spec, open spec PR |
| 8 | `idea` (+`approved`) | analyst | ask | add `spec:draft` | draft spec |
| 9 | `question` | analyst | ask | — | research + answer |
| 10 | `bug` / `enhancement` / `documentation` | coder | do | label swaps via `runOneTask` | build → PR |
| 11 | anything else (unlabeled/other) | triager | ask | — | triage + suggest labels |

Notes:
- **No `security` route in v1.** The repo has no `security` label and CI failures are
  expressed as *title prefixes* (e.g. `infra_auth:` on #76), so security/CI work folds
  into the triager path (rows 6, 11). Adding a real `security` label + a security-agent
  route is a follow-up, not part of this change.
- Label reads use the existing `names(issue)` helper (handles string and `{name}` shapes).

## Per-tick policy (`sweep()` — impure, in the daemon)

```
async function sweep() {
  const issues = await listAllOpen();              // gh issue list --state open --json number,title,body,labels
  const routed = issues
    .map(i => ({ issue: i, route: core.routeFor(i, { now, staleMs: STALE_MS, liveBuilds }) }))
    .filter(x => x.route.target);
  const state = readDispatchState();               // .dev-society/dispatch-state.json

  // Advisory routes (analyst/triager): cheap A2A ask → comment. Dispatch ALL pending.
  for (const { issue, route } of routed.filter(r => r.route.mode === 'ask')) {
    if (!core.shouldDispatch(issue, route, state)) continue;
    await dispatchAdvisory(issue, route);          // ask peer → post comment → advance label
    core.recordDispatch(state, issue, route, now());
  }
  writeDispatchState(state);

  // Code routes (coder do): heavy + must serialize on the git worktree → ONE per tick (FIFO).
  const coderQ = routed.filter(r => r.route.mode === 'do').map(r => r.issue);
  const pick = core.selectCoderTask(coderQ);       // lowest number, not already building
  if (pick) await runOneTask(pick);                // existing build→test→review→PR pipeline
}
```

- **One coder build per tick** preserves the worktree serialization that keeps the git
  snapshot race-free (the existing invariant). Advisory asks are cheap and batched.
- The sweep is the body of the `issue-sweep` builtin: `builtins['issue-sweep'] = () => sweep()`.

## Advisory dispatch (`dispatchAdvisory`) + spec PR path

- **analyst / triager asks:** spawn an A2A client from a generalized `registryFor` that
  adds `analyst` and `triager` as **ask-only** peers rooted at their `dev-mesh/<name>`
  folders (alongside the existing `coder`/`reviewer`). Send `core.a2aMessage('ask', prompt)`
  with a role-appropriate prompt (issue text passed as **data**), take `core.taskText`,
  and post it as an **issue comment**. All `gh` writes are the daemon's — agents stay
  ask-safe.
- **Spec PR (rows 7–8).** The analyst is ask-only and cannot write files, so the daemon
  owns the spec write, mirroring `runOneTask`:
  - row 8 (`idea`+`approved`): analyst drafts → daemon posts the draft as a comment and
    adds `spec:draft`. No PR yet (lightweight).
  - row 7 (`spec:draft`): analyst finalizes the spec markdown → daemon writes
    `docs/superpowers/specs/<date>-<slug>-design.md` in a fresh worktree, commits,
    pushes, opens a **spec PR**, and swaps `spec:draft`→`spec:in-review`.
    (`runSpecTask(issue)`, reusing the worktree/commit/PR helpers from `runOneTask`.)
- Label advancement (`spec:draft`, `spec:in-review`) is secondary polish; the
  dispatch-state file (below) is the authoritative re-fire guard.

## Idempotency — `.dev-society/dispatch-state.json`

Advisory comments do not always move an issue out of the actionable set, so without a
guard they would re-fire every 10 min. New pure helpers in `core.js`:

- `shouldDispatch(issue, route, state)` → true only when the issue has no prior dispatch,
  OR its route target changed, OR its **label-set hash** changed since last dispatch.
- `recordDispatch(state, issue, route, ts)` → records `{ route, labelsHash, dispatchedAt }`
  keyed by issue number.

Coder routes self-guard via their `in-progress`/`pr:in-review`/`blocked` label swaps but
are still recorded for observability. File sits alongside the existing `.dev-society/*.json`
artifacts (`gh-activity.json`, `ledger.jsonl`, heartbeat).

## Stale `in-progress` recovery

`runOneTask` is synchronous within a tick (it awaits coder → tests → PR), so `in-progress`
normally clears within the same tick. It only persists across ticks if a build crashed.
`routeFor` treats `in-progress` as stale when it is not in the in-memory `liveBuilds` set
AND its age exceeds `STALE_MS` (config, default 30 min), routing it back to the coder after
clearing the label. `STALE_MS` via `DEV_SOCIETY_STALE_MS`.

## Config (new/changed env, all optional)

- `issue-sweep` cadence: `every 10m` (in `dev-mesh/maintainer/.agent/schedule.json`).
- `DEV_SOCIETY_STALE_MS` (1800000) — in-progress crash-recovery threshold.
- Removed dependence on `DEV_SOCIETY_POLL_MS` for routing (the standalone loop is retired;
  the var may remain for any non-routing use but no longer drives the sweep).

## Testing

- **Pure (core), hermetic — extend `test/dev-society-*` :**
  - `routeFor` truth table: every label combination and title-prefix → expected
    `{target, mode}` or skip; idea-gate; terminal/human-gated skips; stale vs live
    `in-progress`; precedence/first-match-wins.
  - `shouldDispatch`/`recordDispatch`: new issue, unchanged labels (no re-fire),
    changed labels (re-fire), changed target (re-fire).
  - `selectCoderTask`: FIFO, excludes in-flight.
- **Harness:** extend the daemon `--selftest` with a sample issue set asserting the full
  routing decision vector (no GitHub/claude).
- **Schedule lint:** assert `issue-sweep` / `every 10m` present + enabled in the maintainer
  schedule (mirrors `test/daily-report-schedule.test.js`).
- The real build/PR path stays covered by the existing dev-society e2e/ledger machinery.

## Out of scope (follow-ups)

- A dedicated `security` label + security-agent route.
- Reviewer pre-review of `spec:in-review` spec PRs (kept a pure human gate for now).
- Multi-build parallelism (one coder build per tick is intentional).
