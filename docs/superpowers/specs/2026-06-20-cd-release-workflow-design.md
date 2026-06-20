# CD Release Workflow — publish the tarball as a GitHub Release Design

**Date:** 2026-06-20
**Status:** Approved (design); pending spec review
**Topic:** A GitHub Actions workflow that publishes the packed npm tarball as a GitHub Release after every CI-green push to `main`, so any machine can `npm i -g` the latest build.

## Problem

CI verifies every change; the local `deploy-sync` pull-agent keeps *this host's*
running services on `main`. But there is no **distribution** path: to install
`agent-mesh` on another machine you must clone the repo and `npm pack` by hand.
A cloud GitHub Action cannot restart services on a home-network Mac, but it *can*
do the distribution half of CD — build the artifact and publish it where any
machine can fetch it. This adds that.

## Goal

On every push to `main` that passes CI, publish the packed tarball as a GitHub
Release using the built-in `GITHUB_TOKEN` (no external secrets):

1. a **rolling** prerelease (always-newest) — its `agent-mesh.tgz` asset replaced
   on each green push, fetchable at a stable URL;
2. an **immutable versioned** release `v<version>` — created only when
   `package.json` `version` bumps, for pinnable semver milestones.

Install UX:
- bleeding edge: `npm i -g https://github.com/danabaxia/agent_mesh/releases/download/edge/agent-mesh.tgz`
- latest stable version: `npm i -g https://github.com/danabaxia/agent_mesh/releases/latest/download/agent-mesh.tgz`
- pinned: `npm i -g https://github.com/danabaxia/agent_mesh/releases/download/v0.1.0/agent-mesh.tgz`

**Rolling tag = `edge`** (not `main`): a git tag named `main` would collide with
the `main` branch (ambiguous ref). `edge` is the conventional bleeding-edge tag.

## Non-Goals (YAGNI)

- **No npm-registry publish** (no `NPM_TOKEN`). GitHub Releases only — secret-free.
- **No changelog generation, signing, or provenance attestation.**
- **No per-commit tags** (the rolling `edge` release covers "newest"; git history covers per-commit reproducibility via `npm pack` at any SHA).
- **No auto version bump.** `v<version>` is cut only when a human edits
  `package.json` `version`. Since nothing in the automation bumps it, `edge` is
  the de-facto *moving* channel and `v<version>`/`/releases/latest/` advance only
  on deliberate version bumps — documented as such, not a bug.
- **No host deploy** — that's the existing local `deploy-sync` pipeline; this is distribution, not restart.
- **No matrix** — it's a pure-JS, zero-dep package; one `npm pack` on `ubuntu-latest`.

## Architecture

One new workflow file plus one hermetic lint test. The pack→publish logic lives
entirely in the workflow (shell + `gh`); the test asserts the workflow's shape.

```
push → main ──▶ CI (ci.yml, existing) ──completed,success──▶ release.yml
  checkout head_sha → npm pack → rename to agent-mesh.tgz
  ├─ gh release delete+create  edge  (prerelease, re-pointed to head_sha each push)
  └─ if v<version> absent: gh release create v<version> ...    (immutable, on bump)
```

## Components

### 1. `.github/workflows/release.yml`

**Trigger — gate on CI success on main:**

```yaml
name: Release
on:
  workflow_run:
    workflows: ["CI"]          # matches ci.yml's `name: CI` — keep in sync (lint-asserted)
    types: [completed]
permissions:
  contents: write          # create releases, tags, upload assets via GITHUB_TOKEN
concurrency:
  group: release           # serialize release runs so the edge delete+create can't race
  cancel-in-progress: false  # never cancel mid-run → never leave a partial versioned release
jobs:
  release:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.head_branch == 'main' &&
      github.event.workflow_run.event == 'push'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}   # the exact green commit
```

Using `workflow_run` keyed to the existing `CI` workflow means a release is cut
**only** for commits CI marked green. The guard requires three things, each
load-bearing:

- `conclusion == 'success'` — never release a red commit.
- `head_branch == 'main'` — skip CI runs from PR branches (incl. forks): a fork
  PR's CI completion *does* fire this `workflow_run`, but its `head_branch` is the
  PR branch, so the job is skipped and the fork's `head_sha` is **never checked
  out**. (Combined with `workflow_run` always executing from the base repo's
  default-branch definition with the base `GITHUB_TOKEN`, this is what makes a
  fork unable to publish — not the absence of a `pull_request` trigger.)
- `event == 'push'` — a CI **re-run** of an old commit, or a `workflow_dispatch`
  CI run, also has `head_branch == 'main'` + success; without this clause it would
  re-cut `edge` pointing at a *stale* `head_sha`, rolling the rolling release
  **backwards**. Restricting to `push` events keeps `edge` always-forward.

`concurrency: { group: release, cancel-in-progress: false }` serializes release
runs (rapid main pushes queue rather than race on the `edge` tag delete+create),
and never cancels in flight, so a versioned `v<version>` create is never
interrupted mid-way. Trade-off: a burst of pushes runs sequentially; the final
`edge` ends at the newest queued SHA. Note `workflows: ["CI"]` matches CI's
`name:` field, so renaming the CI workflow silently disables releases — the lint
test asserts `ci.yml` keeps `name: CI`.

**Build (stable asset name):**

```yaml
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Pack
        id: pack
        run: |
          VERSION=$(node -p "require('./package.json').version")
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          TARBALL=$(npm pack --ignore-scripts | tail -1)   # capture real name (scope/version-proof); no build scripts to run
          echo "tarball=$TARBALL" >> "$GITHUB_OUTPUT"
          cp "$TARBALL" agent-mesh.tgz                      # stable name for predictable URLs
```

`npm pack | tail -1` reads the produced filename rather than reconstructing it,
so it stays correct if the package name/version ever changes (e.g. a scoped
name). `--ignore-scripts` keeps pack inert (the package has no build/`prepack`
step; `files` already scopes the tarball contents).

**Publish — rolling prerelease (always):** delete-and-recreate so the tag,
commit, and asset are all re-pointed to the newest green SHA each push.

```yaml
      - name: Rolling release (edge)
        env: { GH_TOKEN: ${{ github.token }} }
        run: |
          gh release delete edge --yes --cleanup-tag 2>/dev/null || true
          gh release create edge --prerelease \
            --target "${{ github.event.workflow_run.head_sha }}" \
            --title "edge (rolling main)" \
            --notes "Always-newest build of main; re-cut on every green push. Not a stable release." \
            agent-mesh.tgz
```

**Publish — immutable versioned release (only on bump):**

```yaml
      - name: Versioned release (on bump)
        env: { GH_TOKEN: ${{ github.token }} }
        run: |
          VERSION="${{ steps.pack.outputs.version }}"
          if gh release view "v$VERSION" >/dev/null 2>&1; then
            echo "v$VERSION already released — skipping (no version bump)."
          else
            gh release create "v$VERSION" \
              --target "${{ github.event.workflow_run.head_sha }}" \
              --title "v$VERSION" \
              --notes "agent-mesh v$VERSION — npm i -g https://github.com/danabaxia/agent_mesh/releases/download/v$VERSION/agent-mesh.tgz" \
              "agent-mesh.tgz" "${{ steps.pack.outputs.tarball }}" \
              || echo "v$VERSION was created concurrently — leaving the existing release."
          fi
```

The versioned release carries both the stable `agent-mesh.tgz` (for the pinned
install URL) and the version-named tarball. The `view`→`create` check is not
atomic, so the trailing `|| echo …` tolerates the rare case where a concurrent
run created `v$VERSION` first (serialized by `concurrency`, this is near-impossible,
but the guard makes a re-run safe regardless).

Idempotency: the versioned step is a no-op when `v<version>` already exists, so
ordinary (non-bump) commits only refresh the rolling release, and workflow
re-runs never error. The rolling step's delete-then-create (with `|| true` on the
delete) is safe whether or not `edge` already exists.

### 2. `test/release-workflow.test.js` — hermetic lint

Mirrors `test/integration-workflow.test.js` (zero-dep string/regex assertions on
the file; the repo has no YAML parser):

- the file exists at `.github/workflows/release.yml`;
- triggers on `workflow_run` with `workflows: ["CI"]` and `types: [completed]`;
- the job guard requires all three of `conclusion == 'success'`,
  `head_branch == 'main'`, and `event == 'push'`;
- has a top-level `concurrency:` block with `cancel-in-progress: false`;
- the job sets `timeout-minutes`;
- `permissions:` grants `contents: write`;
- checks out `github.event.workflow_run.head_sha`;
- runs `npm pack` and copies to the stable `agent-mesh.tgz`;
- has a rolling `gh release ... edge ...` step (delete-then-create) and a guarded
  `gh release ... v$VERSION` step that skips when the release exists;
- the rolling tag is `edge`, never `main` (no branch-name collision);
- does **not** trigger on `pull_request` or `push` (release only via `workflow_run`).

It also asserts, in a second test, that **`ci.yml` still has `name: CI`** — the
`workflow_run` trigger is coupled to that exact name, so a rename would silently
disable releases; this guard fails loudly if the name drifts.

### 3. README — install-the-latest note

Under the existing install section (which already shows `npm pack` +
`npm install -g ./agent-mesh-*.tgz`), add the prebuilt-release install lines so
users don't have to clone + pack — making the channel semantics explicit:

- **edge** (`…/releases/download/edge/agent-mesh.tgz`) — *moving*: rebuilt on
  every green push to `main`.
- **latest stable** (`…/releases/latest/download/agent-mesh.tgz`) — the most
  recent **version bump** (`v<version>`); advances only when `package.json`
  `version` changes, so it can lag `edge`.
- **pinned** (`…/releases/download/v<version>/agent-mesh.tgz`).

## Data Flow

`push → main` → `CI` (existing) completes `success` → `Release` fires → checkout
`head_sha` → `npm pack` + stable copy → re-cut rolling `edge` release → if version
bumped, create immutable `v<version>` release. Consumers fetch a `.tgz` from the
release URL and `npm i -g` it.

## Error Handling

- **Non-success / non-main** → the `if:` guard skips the whole job (no release on
  red CI or feature-branch CI runs).
- **Versioned re-create** → guarded by `gh release view`; skip if exists →
  idempotent across re-runs and non-bump pushes.
- **Pack failure** → job fails before any `gh release` call → no partial/empty
  release published.
- **Token scope** → only `contents: write`; the workflow cannot touch code, PRs,
  or secrets. No external secret is referenced, so a fork PR can never exfiltrate
  one (and `workflow_run` runs in the base-repo context regardless).

## Testing

Hermetic only (`node --test`, no network/`gh`): `test/release-workflow.test.js`
as in Component 2. The live publish path is exercised the first time a commit
lands on `main` after merge (manual verification below) — GitHub Actions is the
only place `gh release` can run.

## Files

- **Create** `.github/workflows/release.yml` — the release workflow.
- **Create** `test/release-workflow.test.js` — hermetic shape lint.
- **Modify** `README.md` — install-from-release lines.

## Verification (after merge, on GitHub)

1. `workflow_run` only fires from the workflow definition once it is on the
   default branch, so the **first** release reliably triggers on the **next**
   push to `main` *after* this merges (push a trivial follow-up commit to force
   it), not necessarily on the merge commit itself. That CI run completes → the
   `Release` workflow appears in the Actions tab and succeeds.
2. The repo's Releases page shows an `edge (rolling main)` prerelease with an
   `agent-mesh.tgz` asset; if `package.json` version changed in the merge, also a
   `v<version>` release.
3. `npm i -g https://github.com/danabaxia/agent_mesh/releases/download/edge/agent-mesh.tgz`
   then `agent-mesh --help` works on a clean machine.
4. Push a trivial follow-up commit; confirm the rolling asset's updated timestamp
   and that **no** new `v<version>` release was cut (version unchanged).

## Invariants / fit with existing workflows

- This is the **only** workflow that writes Releases; it does not overlap the
  `dev-mesh-*` automation (issues/PRs) or `ci.yml`/`integration.yml` (gates).
- Fork-PR safety comes from the `head_branch == 'main'` guard + `workflow_run`
  always executing from the base repo's default-branch definition with the base
  `GITHUB_TOKEN` (a fork's `head_sha` is never checked out because the guard skips
  it) — **not** merely from the absence of a `pull_request` trigger.
- Distribution-only: it does not deploy to or touch the host — the local
  `deploy-sync` pipeline remains the host CD.
