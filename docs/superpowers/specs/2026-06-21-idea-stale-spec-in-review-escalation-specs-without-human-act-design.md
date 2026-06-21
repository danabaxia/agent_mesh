e the linked PR and read its latest comment / review / push timestamp via `gh pr view --json comments,reviews,commits` (or equivalent), reducing to a single `last_activity`.
- **Pure plan builder** — given `[{ issue, lastActivity, alreadyEscalated, escalationClosedByHuman, specState }]` and `now`/`N`, returns the reconciliation actions:
  - `create` a `needs-human` issue (stale, non-blocked, no existing open/closed-by-human marker),
  - `close` an existing escalation (spec now `approved`/`rejected`),
  - `noop` (fresh spec, already escalated, or human-closed). This pure function is the unit-test seam — no `gh` calls inside.
- **Dedup-marker matcher** — searches existing issues for `<!-- needs-human:spec:#N -->`, distinguishing open (suppress duplicate) from human-closed (suppress permanently).
- **Action applier** — thin imperative shell: `gh issue create` / `gh issue close` / `gh issue comment`, plus lazy `needs-human` label creation.
- **Config resolver** — `AGENT_MESH_SPEC_STALE_DAYS` (default 3) and the schedule cadence (daily or every few hours).
- **Scheduling hook** — wired into the daemon's existing sweep cadence; no new protocol surface.

## Data flow

1. Sweep fires on schedule.
2. `gh issue list --label spec:in-review --state open` → candidates; drop any also labeled `blocked`.
3. For each candidate: resolve linked PR, compute `last_activity` from comments/reviews/pushes.
4. For each candidate, look up its `<!-- needs-human:spec:#N -->` marker state (no escalation / open escalation / human-closed escalation).
5. Pure plan builder decides per spec:
   - stale (> N days) **and** non-blocked **and** no existing/human-closed escalation → **create**.
   - escalation exists and spec moved to `approved`/`rejected` → **close** the escalation.
   - otherwise → **noop**.
6. Applier executes the plan via `gh` (lazily creating the `needs-human` label if needed).
7. Result: each genuinely stalled spec has exactly one open `needs-human` issue; resolved specs have their escalations auto-closed; human-closed escalations stay closed.

## Testing

Pure-plan unit tests (no live GitHub), mirroring the PR #254 remediation test pattern:

- **Stale spec, no prior escalation:** `spec:in-review`, last activity 4 days ago, N=3 → plan `create` with correct title (`X days` matching elapsed) and `<!-- needs-human:spec:#N -->` marker.
- **Fresh spec:** last activity 1 day ago → `noop`.
- **Boundary:** exactly N days → assert the chosen comparison (`>` vs `>=`) is locked by a test.
- **Dedup — open escalation exists:** stale spec already has an open marker issue → `noop` (no duplicate), optional body refresh asserted not to open a second issue.
- **Human-ack permanence:** stale spec whose marker issue was **closed by a human** → `noop` forever (no recreate).
- **Auto-close on `approved`:** spec moved to `approved` with an open escalation → plan `close` the escalation.
- **Auto-close on `rejected`:** same for `rejected`.
- **`blocked` exclusion:** stale `spec:in-review` issue also labeled `blocked` → `noop` (not escalated).
- **No linked PR / unresolvable activity:** candidate skipped, no throw, surfaced as data.
- **Title/marker format:** exact title string and marker namespace (`spec:#N`) asserted.
- **Config:** with `AGENT_MESH_SPEC_STALE_DAYS` lowered, a 2-day-idle spec becomes stale; unset → default 3.

## Out of scope

- **Approving specs or assigning `approved`** — the approval gate stays human-only; this sweep escalates, it never resolves.
- **Redefining `spec:in-review`** — the state's meaning is unchanged.
- **`blocked` specs** — excluded; they need the block lifted, not an approval nudge.
- **Auto-retry / auto-edit of the spec** — none.
- **Push notifications** — polling via the scheduled sweep is sufficient for v1.
- **Path-guard, anti-spoof, or write-boundary changes** — none; ask-mode reads plus `gh` CLI only.
- **New label/marker machinery** — reuses the `needs-human` label and dedup-marker/hysteresis pattern established by PR #254.
