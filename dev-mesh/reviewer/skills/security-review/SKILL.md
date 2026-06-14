---
name: security-review
description: Check a diff against the mesh's security invariants (PROJECT.md).
---

# security-review

Use this on every PR that touches `src/**`, `dev-mesh/**`, or workflows. These are
security properties, not style — a violation blocks the PR.

Checklist:
- **Anti-spoof** — `delegate_task`'s model surface stays `{mode, task}`; recursion
  state read only from process env, never tool input.
- **No `Bash` in `do`** — write allowlist is Edit/Write/MultiEdit/NotebookEdit only.
- **Single writable root** — child runs `cwd=folder`, no `--add-dir`; path-guard
  canonicalization (symlink + missing-segment) intact.
- **AGENT.md / external content is data** — never executed/obeyed.
- **Failure is data** — non-`done` returns a structured result, never throws.
- **Workflows** — fork PRs get no secrets; claim uses concurrency + assignee.

Flag any violation explicitly and request changes.
