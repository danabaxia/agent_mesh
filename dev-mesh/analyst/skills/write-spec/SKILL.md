---
name: write-spec
description: Draft a ready-for-review design spec from a discussed idea, and shepherd it to approval.
---

# write-spec

Use this once an idea's scope is clear. Produce a spec that a reviewer can approve.

Structure (match the repo's existing specs):
1. **Goal** · **Non-goals** · numbered design sections · **invariants** it must
   uphold (path-guard, anti-spoof, single-root, no-Bash-in-do) · risks.
2. Save as `docs/superpowers/specs/<date>-<slug>-design.md`; open a spec PR and
   label it `spec:in-review`.
3. Optionally run codex-spec-review to converge with a second model first.
4. Move the Issue through `spec:draft → spec:in-review`; on human approval it
   becomes `approved`. **No code happens before approval.**

Self-review against the repo invariants before requesting review.
