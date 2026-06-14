---
name: distill-lesson
description: Turn a merged/reverted outcome into a concise, reusable lesson.
---

# distill-lesson

Use this after a PR merges or is reverted. Extract durable, recallable knowledge —
not a diary entry.

Produce one of:
- a **fact** for `quick.json` (short key + value), e.g. "check X is a flake →
  re-kick, don't patch"; or
- a **workflow pattern** for `workflows/<slug>.md` when a fix shape recurred; or
- a **supersession** when a new outcome contradicts a live lesson (mark the old
  one expired via drift-watch — keep history, don't delete).

Keep it general enough to recall on a similar future task; cite the PR. Hand the
staged lesson to `promote-to-memory`.
