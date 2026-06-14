---
name: issue-to-plan
description: Turn an approved issue (or a real_bug classification) into a concrete fix plan.
---

# issue-to-plan

Use this to produce an actionable plan for the coder. Do not edit code.

A good plan states:
1. **Goal** — the observable outcome (a test that must pass / behavior that must
   hold).
2. **Files** — the likely files to touch (and which tests cover them).
3. **Approach** — minimal change; uphold the repo invariants (no Bash in do,
   single writable root, anti-spoof surface).
4. **Verification** — the exact suite/eval the workflow should run to prove it.

Keep it small and reviewable. If the issue is ambiguous or architecturally
significant, flag it for a human rather than guessing.
