---
name: code-review
description: Review a PR diff for correctness, regressions, missing tests, and clarity.
---

# code-review

Use this for ask-mode review of an open PR. You comment; you never edit or merge.

Check:
1. **Correctness** — does the change do what its plan/spec says? Edge cases?
2. **Tests** — is the change covered (incl. the negative/safety case)? Hermetic?
3. **Scope** — minimal diff; no unrelated churn; matches surrounding style.
4. **Spec conformance** — aligns with the approved spec; no scope creep.

Post specific, actionable comments. Approve only when correctness + tests + scope
are satisfied; otherwise request changes. CI is the authoritative gate — you add
judgment on top.
