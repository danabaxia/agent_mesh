---
name: promote-to-memory
description: Stage approved lessons into quick.json / workflows via a review-gated PR.
---

# promote-to-memory

Use this to persist a distilled lesson. Memory lives in the repo (git) so it
survives the ephemeral runner — but it is **review-gated**, never a silent write
to main.

Steps:
1. Apply the lesson to the memory store (your single writable root): a `quick.json`
   entry or a `workflows/<slug>.md` (slug sanitized — no separators / `..`).
2. Respect the caps (entry count + field length); fail closed if exceeded.
2b. Run `node scripts/validate-quick-memory.mjs dev-mesh/curator/memory/quick.json`
    and abort (do NOT push) if it exits non-zero — a cap violation means the file is
    invalid and will deadlock the auto-merge queue.
3. Open a **`memory:promote` PR** for human review; do not push to main directly.

Only EXPLICITLY approved lessons get written. Everything you touch is the memory
root only — never code.
