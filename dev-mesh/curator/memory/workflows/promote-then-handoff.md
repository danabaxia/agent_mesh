---
slug: promote-then-handoff
status: active
provenance: "PR #45 (2026-06-16) — intention gap in memory-cap-validate-at-write"
---

# Pattern: Promote → Coder Handoff for Workflow-Touching Lessons

## When to apply

After a `memory:promote` PR merges whose `value` field specifies a change inside
`.github/workflows/**` or any code path **outside the memory root**
(`dev-mesh/*/memory/`).

## Why it matters

The Curator writes only to `dev-mesh/curator/memory/` — never to `.github/workflows/**`.
A lesson that calls for a CI workflow fix (e.g. "add a validate step before `git push`")
is correctly encoded in memory but leaves an **intention gap**: the lesson says what to do,
but no follow-up task routes it to the Coder.

**Observed case — PR #45**: promoted `memory-cap-validate-at-write`, which calls for

```
node scripts/validate-quick-memory.mjs dev-mesh/curator/memory/quick.json
```

to be added in `dev-mesh-curate.yml` (after Curator commit, before `git push`). The script
exists; only the workflow invocation is missing. The lesson is live in memory;
`dev-mesh-curate.yml` still lacks the step.

## Steps

1. **Promote the lesson** to `quick.json` or `workflows/*.md` as normal.
2. **Identify the code target** — the specific file and change the lesson's `value` recommends.
3. **Open a Coder-facing GitHub issue** immediately after the memory:promote PR is opened:
   - Title: `fix(dev-mesh): <exact change> in <file>`
   - Body: quote the `value` field; link the memory:promote PR.
   - No label needed beyond the default; Maintainer routes via backlog.
4. **Stop** — Curator's job ends at step 3. The Maintainer routes to the Coder.

## What NOT to do

- Do NOT skip step 3 assuming "the lesson in memory is enough." Memory records intention;
  code PRs close the gap.
- Do NOT add the code change to the memory:promote PR — Curator's path-guard allows only
  `dev-mesh/curator/memory/`.
- Do NOT bundle code + memory in one PR — they run on different trust paths
  (Curator = GITHUB_TOKEN, Coder = DEV_MESH_PAT).

## Provenance

PR #45 (2026-06-16): first observed intention gap after memory-cap-validate-at-write
was promoted. See also: `quick.json#memory-cap-validate-at-write`,
`quick.json#fix-then-lint-pattern`.
