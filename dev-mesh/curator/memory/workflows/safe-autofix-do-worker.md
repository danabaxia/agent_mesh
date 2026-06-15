# Pattern: Safe Autonomous CI Autofix Do-Worker

**Provenance:** PR #15 `feat(dev-mesh): autofix` · 2026-06-15

## What it solves

Gives an autonomous agent write access to fix failing CI on a PR branch — without
creating infinite loops, leaking write credentials to fork PRs, or bypassing the
human merge gate.

## The four safety invariants

| Invariant | Mechanism |
|-----------|-----------|
| **Budget cap** | Count `[autofix]` commits already on the branch. If ≥2 (configurable), post a "needs human" comment and stop. Bounds repeated-failure loops and surface area for misuse. |
| **Fork-PR safety** | `check_run.pull_requests[]` is empty for fork-originated PRs. Gate the entire fix path on that array being non-empty. A fork PR simply receives no write action — no explicit fork-detection logic needed. |
| **No re-trigger loop** | Commits pushed with `GITHUB_TOKEN` do not re-trigger `ci.yml` in the same repo (GitHub's built-in protection). The next human push or manual re-run is the next gate — the agent cannot ping-pong with itself. |
| **Scoped trigger** | Filter `check_run.name` to only `test`-prefixed checks (the hermetic suite matrix). This prevents the autofix from reacting to agent advisory checks or its own run IDs. |

## The Triager → Coder flow

```
CI test check fails
  └─ check_run.pull_requests[] non-empty?  (fork guard)
       └─ [autofix] commit count < budget?  (budget guard)
            └─ Triager classifies failure
                 ├─ flake / infra / out-of-scope → comment + stop
                 └─ real_bug → Coder fixes → commit "[autofix] …" → push → comment
```

Classification precedence: `infra > out-of-scope > flake > real_bug`.
Only `real_bug` spawns a do-worker with write tools.

## Commit tagging

Tag every agent commit with `[autofix]` in the message. This is what the budget
counter reads — keep the tag consistent or the guard stops working.

## What it never does

- Never merges (human gate is preserved).
- Never runs on fork PRs (write creds not in scope).
- Never adds `--no-verify` (hooks still run on the commit).
- Never reacts to its own check run (scoped trigger).

## Reuse checklist

When applying this pattern to a new autonomous do-worker:

- [ ] Tag all agent commits with a consistent `[<worker>]` prefix.
- [ ] Read the tag count before acting; bail if ≥ budget.
- [ ] Gate the whole fix path on `pull_requests[]` being non-empty.
- [ ] Scope the trigger to the check name(s) you own — not `*`.
- [ ] No auto-merge; comment a summary after push.
- [ ] Honesty gate: `assert-run-healthy.mjs` after the agent step.
