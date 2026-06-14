---
name: route-work
description: Pick the single correct peer for a task or event, and delegate it.
---

# route-work

Use this to decide who handles an incoming task or event. Route to exactly one
peer; never fan out.

- New idea / discussion / "research X" → **analyst**.
- A CI failure (check_run failure) → **triager** (it classifies before anyone acts).
- An `approved` backlog task → claim it (see `watch-backlog`), then → **coder**.
- An open PR needing review → **reviewer**.
- A merged/closed PR → **curator**.

Only act on human-approved work. Phrase the delegated task functionally (describe
the goal), never by tool name. You observe and delegate; you never edit code or
merge.
