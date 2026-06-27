# Curator — Long-Term Learnings

These are stable, durable lessons about memory management, CI automation, and dev-mesh
self-hosting that have proven true across many incidents and are unlikely to shift.

---

## Memory Integrity

**Validate `quick.json` caps at write time (Curator workflow), not only at auto-merge.**

Over-cap `l0` fields deadlock the pipeline: validate-quick-memory rejects them at
auto-merge but mergefix cannot fix validation failures, so PRs pile up permanently.
Wire `node scripts/validate-quick-memory.mjs` in `dev-mesh-curate.yml` AFTER the
claude commit, BEFORE `git push` — fail fast at source.

Recovery from a deadlock: list open `memory/*` branches, read each PR diff, dedup+trim
to caps, fold into one consolidation PR, close stale PRs. Mergefix handles CONFLICTS
(key-union); write-time guard is the only robust pipeline protection.

_Provenance: PR #44 (origin) + PR #66 (implementation); encoded 2026-06-16_

---

**Supersession is a two-step delete, never a `status: superseded` marker.**

`isLive()` in `dev-mesh-memory.test.js` requires every persisted entry to have
`status: 'active', valid_to: null`. A `superseded` entry with `valid_to` set compiles
silently until dynamic role discovery expands coverage — then it causes an immediate CI
failure. Pattern: write replacement entry → delete old key → open one `memory:promote` PR.

_Provenance: PR #50 (2026-06-15), closing Issue #48_

---

**Auto-merge must validate the MERGE RESULT, not the stale branch HEAD.**

A stale-but-clean PR that would validate after merging is permanently blocked if you
validate the HEAD (nothing triggers a refresh since mergefix only touches conflict-dirty
branches). Simulate the merge first: `git fetch origin main && git merge origin/main --no-edit`,
then validate the resulting tree.

Also: the automerge guard regex must admit subdir depth explicitly. `quick.json` alone
is too narrow — curator-authored `workflows/*.md` pattern docs are also inert memory
data and must be accepted. Use an anchored ERE: `([^/]+/)?[^/]+\.md`.

_Provenance: PR #42 (2026-06-15), fixing stale-clean-branch deadlock + guard scope gap_

---

## GitHub Actions Automation

**`GITHUB_TOKEN` PRs never trigger `pull_request` events — use a cron schedule to
auto-merge them.**

GitHub's recursion guard blocks all `pull_request` events on GITHUB_TOKEN-created PRs.
A `merge when checks pass on pull_request: [opened]` trigger never fires. Use a
scheduled workflow (e.g. every 15 min) that polls for open PRs matching a label+same-repo
filter, runs a light validator, and squash-merges. Structural guards must run inside the
scheduled job, not as branch protection.

_Provenance: PR #21 (2026-06-15)_

---

**`GITHUB_TOKEN` cannot write `.github/workflows/**` — do-workers need `DEV_MESH_PAT`.**

GitHub rejects `GITHUB_TOKEN` pushes to `.github/workflows/**`. Without a PAT, a Coder
writing a workflow fix cannot push — the branch is discarded and the issue deadlocks.
Fix: `DEV_MESH_PAT || GITHUB_TOKEN` fallback in every do-worker. Curate MUST stay on
`GITHUB_TOKEN` only — its `memory:promote` PRs rely on the recursion guard.

Add `.github/CODEOWNERS` gating `.github/workflows/**` on owner review: the mesh can
now author its own CI harness, so the human merge gate must be explicit.

_Provenance: PR #53 (2026-06-16), fixing Issue #38 + #41_

---

**Event-driven CI automation must be paired with a scheduled polling backstop.**

GitHub webhook delivery is not guaranteed. Wire a scheduled twin at ≤30-min intervals
alongside every `check_run`/`pull_request`/`push` event-driven workflow. Let them share
a named commit-message marker (e.g. `[autofix]`) as the budget token; count spend via
`git log --grep` on `base..HEAD`. Offset cron minutes to avoid thundering-herd.

_Provenance: PR #24 (2026-06-15)_

---

**`claude-code-action@v1` rejects `push` events — guard claude steps with
`github.event_name != 'push'`.**

When a workflow triggers on `push:` alongside `schedule:`, the Action raises
"Unsupported event type: push" and aborts entirely if the push-triggered run reaches
the claude step. Push events are fine for fast discovery steps but cannot drive the
Action. Add a hermetic lint assertion that the `if:` expression contains
`github.event_name != push`.

_Provenance: PR #56 (2026-06-16), closing Issue #38_

---

## Memory Promotion Lifecycle

**When a `quick.json` lesson calls for a code/workflow change, open a Coder issue immediately.**

The Curator writes only to `dev-mesh/curator/memory/` — never to `.github/workflows/**`.
A lesson encoding a CI fix leaves an intention gap: the lesson says what to do but no
task routes it to the Coder. After opening the `memory:promote` PR, immediately open a
Coder-facing GitHub issue (title: `fix(dev-mesh): <exact change> in <file>`) quoting
the `value` field and linking the PR. Stop — Curator's job ends there.

_Provenance: workflows/promote-then-handoff.md; PR #45 (2026-06-16)_

---

## CI Test Design

**Enumerate test subjects dynamically (glob/readdir) — hardcoded role lists silently
miss newly added entries.**

`readdirSync` + `existsSync` to discover roles; guard with `assert.ok(length >= EXPECTED_MIN)`
so an empty result doesn't vacuously pass. Apply whenever the subject set can grow
(roles, agents, modules, plugins).

_Provenance: PR #40 / Issue #39 (2026-06-15)_

---

**CI sweeps that match nothing must post a comment — silent skip stalls the queue.**

For any sweep (automerge, autofix, ci-sweep, mergefix) that conditionally skips a PR:
detect the skip condition explicitly, post a PR comment naming the reason, then continue.
Never silently `continue` — the author has no signal and the PR sits indefinitely.

_Provenance: PR #67 (2026-06-16)_
