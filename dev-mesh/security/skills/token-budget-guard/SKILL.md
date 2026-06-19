---
name: token-budget-guard
description: Check autonomous loop budgets, usage capture, and branch-scoped retry caps.
---

# Token Budget Guard

Check that autonomous work is bounded and observable:

- Repeated fix loops must have branch-scoped caps such as `[autofix]` or
  `[review-fix]` commit budgets.
- Scheduled workflows must use concurrency groups that avoid runaway overlap.
- Every model-agent workflow should run the postrun honesty gate and capture
  usage artifacts.
- Budget checks must count only the relevant branch or PR range, never all repo
  history.
- A budget-exhausted path must leave a human-visible comment or issue instead of
  silently retrying.

Blocking findings are any unbounded autonomous loop, missing usage/honesty gate,
or global budget counter that can disable unrelated future PRs.
