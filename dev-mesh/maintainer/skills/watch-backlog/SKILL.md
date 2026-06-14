---
name: watch-backlog
description: Detect approved/ready backlog Issues and claim one atomically before dispatch.
---

# watch-backlog

The backlog is GitHub Issues; labels encode one lifecycle state (idea → … →
approved → in-progress → pr:in-review → done, plus blocked/rejected). A task is
**ready** when it is `approved` AND unclaimed (no assignee, not in-progress).

Steps:
1. List open Issues; select the ready ones (FIFO by number).
2. **Claim atomically**: assign yourself (the assignee is the lock) and move the
   label `approved → in-progress`. If it is already assigned, skip it — another
   tick took it.
3. Delegate the claimed task to the **coder**.

Never start a task that is not `approved` (the approval gate). Never double-claim.
