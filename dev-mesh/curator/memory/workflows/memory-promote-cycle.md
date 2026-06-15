---
slug: memory-promote-cycle
status: active
provenance: "PR #14 (2026-06-15) — first fully autonomous memory:promote cycle"
---

# Pattern: memory:promote end-to-end cycle

## When to apply

After any PR merges into `main`. The Curator runs `distill-lesson` → `promote-to-memory` once per event. Memory:promote PRs themselves are valid triggers (they usually yield a meta-lesson about the loop, not a code fact).

## Steps

1. **Identify the lesson** — one of: `quick.json` fact, `workflows/<slug>.md` pattern, or supersession of a stale entry. Cite the PR.
2. **Write to memory root only** — `dev-mesh/curator/memory/`. Never touch code or other agents' roots.
3. **Branch**: `memory/<kebab-slug>` (no `..`, no `/` separators within the slug).
4. **Commit**: message `memory:promote — <slug> (from PR #N)`.
5. **Open PR**: title `memory:promote — <title>`, body explains the lesson and what to inspect. Label: `memory:promote`.
6. **Stop** — do not auto-merge. Human review is the gate.

## Gotchas

- **quick.json caps**: keep entries focused; `l0` ≤ 120 chars, `l1` ≤ 400 chars, `value` ≤ 400 chars.
- **Branch must not already exist** — check `git branch -r | grep memory/` before creating.
- **No source issue** for memory:promote PRs themselves — they are Curator-generated, not issue-driven; skip the "move issue to done" step when no matching issue exists.
- **Actions PR-creation permission** must be enabled in repo Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" — see `quick.json#curator-actions-pr-bootstrap`.

## Provenance

First complete autonomous cycle confirmed by PR #14 (2026-06-15): branch pushed, PR self-opened by Actions, human-merged with no manual bridging. Prior PR #13 required manual bridging (bootstrap gap; see `quick.json#curator-actions-pr-bootstrap`).
