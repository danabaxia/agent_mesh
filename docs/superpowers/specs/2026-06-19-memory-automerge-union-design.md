# Deterministic memory-conflict union for memory-automerge

Status: design (approved 2026-06-19)
Fixes the curator `memory:promote` PR backlog; subsumes issue #84 (quick.json LRU eviction).
Related: [a2a-dev-society-design](2026-06-16-a2a-dev-society-design.md), the
`dev-mesh-memory-automerge.yml` / `dev-mesh-mergefix.yml` workflows.

## Problem

Every curator `memory:promote` PR edits the single shared file
`dev-mesh/<role>/memory/quick.json`, so concurrent PRs mutually conflict.
`dev-mesh-memory-automerge.yml` does a plain `git merge origin/main`; on conflict it
**aborts and defers to `dev-mesh-mergefix.yml`**, which resolves **one PR per run via an
LLM agent**. The curator opens PRs faster than mergefix drains them, and every merge to
main re-conflicts the rest — so the backlog (observed: 10 DIRTY PRs, `mergefix_commits=0`)
never clears. There is no deterministic `quick.json` union resolver anywhere today.

## Decision

Give `dev-mesh-memory-automerge.yml` a **deterministic, inline conflict resolver** for
memory-data files so it stops deferring. Because the PR's file-scope guard already
guarantees a `memory:promote` PR touches only `quick.json` and memory `*.md` files, the
only possible conflicts are in those files.

Confirmed policy (2026-06-19):
- **`quick.json`** → keyed-JSON **union**. Key on one side only → keep. Key on both →
  keep the entry with the newer `provenance.ts` (tie → ours/PR). Then enforce caps by
  **LRU eviction** (oldest `provenance.ts` first): evict non-`core` live entries until
  within `MAX_QUICK_ENTRIES` (200); demote oldest live `core` entries to non-core until
  within `MAX_CORE_ENTRIES` (20). This LRU step IS issue #84.
- **memory `*.md`** → **line-union** both sides (`git merge-file --union`): keep both
  sides of every conflict hunk.
- **Any other conflicted path** → do NOT resolve; abort the merge and defer to mergefix
  (defense in depth — code is never auto-resolved, even though the scope guard should
  already exclude it).

## Components

### `src/quick-memory-merge.js` (pure, new)
- `mergeQuickMemory(ours, theirs) → merged` — 2-way key union + cap enforcement.
  - union: `for k in keys(ours) ∪ keys(theirs)`: both present → `ts(a) >= ts(b) ? a : b`;
    else the present one. `ts(e) = e?.provenance?.ts || ''` (missing ts = oldest).
  - `enforceCaps(merged)`:
    - core cap: while live-core count > `MAX_CORE_ENTRIES`, set `core:false` on the
      oldest-ts live core entry (demote, never lose the lesson).
    - total cap: while entries > `MAX_QUICK_ENTRIES`, delete the oldest-ts entry,
      preferring non-core (only evict core if no non-core remain).
  - returns a merged object that **passes `validateQuickMemory`** (asserted in tests).
- Reuses `isLive`, `MAX_QUICK_ENTRIES`, `MAX_CORE_ENTRIES`, `validateQuickMemory` from
  `src/quick-memory.js`. No fs/git/network — pure.

### `scripts/union-quick-memory.mjs` (new, git plumbing)
Run while a `git merge origin/main` is in the conflicted state.
1. `conflicted = git diff --name-only --diff-filter=U`.
2. For each path:
   - basename `quick.json` → `ours = git show :2:<path>`, `theirs = git show :3:<path>`
     (JSON.parse), `merged = mergeQuickMemory(ours, theirs)`, `validateQuickMemory(merged)`,
     write file, `git add <path>`.
   - matches `dev-mesh/<role>/memory/(<subdir>/)?<name>.md` → extract stages
     (`git show :1:` base if present, `:2:` ours, `:3:` theirs) to temp files,
     `git merge-file -p --union ours base theirs > <path>` (add/add with no base →
     concatenate ours + theirs), `git add <path>`.
   - anything else → print the offending path and **exit 3** (signal: defer to mergefix).
3. Exit 0 only when every conflicted path was resolved; non-zero on any parse/validate
   failure or non-memory path.

### `dev-mesh-memory-automerge.yml` (wiring)
Replace the conflict branch of the merge step:
```sh
if ! git merge origin/main --no-edit -q; then
  if node scripts/union-quick-memory.mjs; then
    git commit --no-edit -q
    branch=$(gh pr view "$pr" --repo "$GITHUB_REPOSITORY" --json headRefName --jq .headRefName)
    if git push origin "HEAD:$branch" -q; then
      echo "#$pr: auto-resolved memory conflict by union"
    else
      echo "#$pr push failed — mergefix will handle"; git checkout -; continue
    fi
  else
    echo "#$pr conflict not auto-resolvable here — mergefix will handle"
    git merge --abort || true; git checkout -; continue
  fi
fi
# (existing) validate the merged quick.json, then gh pr merge --squash --delete-branch
```
Pushing the resolved merge to the PR branch makes it non-conflicting server-side, so the
existing `gh pr merge --squash --delete-branch` then succeeds. The per-loop
`git fetch origin main` already re-bases each subsequent PR against the moved main, so one
sweep drains the whole backlog.

## Invariants preserved

- **Never auto-merge code**: only `quick.json` + memory `*.md` are resolved; any other
  conflicted path aborts to mergefix. The existing pre-checkout file-scope guard is
  unchanged.
- **Caps are fail-closed**: the merged result is run through `validateQuickMemory` before
  the existing `validate-quick-memory.mjs` gate; a violation aborts (defers), never merges.
- Pure core stays pure; `git push` uses the workflow's existing `GH_TOKEN` (same-repo).

## Testing

- `test/quick-memory-merge.test.js` (hermetic): union keeps one-sided keys; shared key →
  newer ts wins; tie → ours; total-cap LRU evicts oldest non-core and keeps core; core-cap
  demotes oldest core; **merged result always passes `validateQuickMemory`**; empty/absent
  inputs degrade to `{}`.
- Workflow lint (extend `test/dev-mesh-memory-automerge.test.js`): assert the workflow
  invokes `union-quick-memory.mjs` and still defers on non-resolvable conflicts.

## Out of scope / follow-ups

- Restructuring the curator to write per-entry files (would remove conflicts entirely) —
  larger change; union is the minimal fix.
- The code-PR path (`dev-mesh-automerge.yml` / `automerge-sweep.mjs`) is unchanged.
