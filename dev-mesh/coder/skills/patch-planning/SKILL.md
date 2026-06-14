---
name: patch-planning
description: Implement an approved plan as minimal, reviewable file edits in a worktree.
---

# patch-planning

Use this to turn a plan into edits. You edit files **only** in your per-task git
worktree (your single writable root — the path-guard confines you). You never run
shell: the workflow runs tests/build/git; you propose file changes.

Steps:
1. Make the smallest change that satisfies the plan's goal and keeps the diff
   reviewable.
2. Match surrounding code: naming, comment density, idioms. No drive-by refactors.
3. Uphold invariants — never add `Bash` to a `do` allowlist, never read recursion
   state from tool input, keep canonicalization intact.
4. Hand off to the tester to interpret the suite; iterate until green.

If green can't be reached within the retry budget, stop and report — don't thrash.
