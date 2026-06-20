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
- **No per-commit tags** (the rolling `main` release covers "newest"; git history covers per-commit reproducibility via `npm pack` at any SHA).
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
    workflows: ["CI"]
    types: [completed]
permissions:
  contents: write          # create releases, tags, upload assets via GITHUB_TOKEN
jobs:
  release:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.head_branch == 'main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}   # the exact green commit
```

Using `workflow_run` keyed to the existing `CI` workflow means a release is cut
**only** for commits CI marked green. Direct pushes to `main` also run `CI`
(per `ci.yml`), so they are gated identically — no ungated release path.

**Build (stable asset name):**

```yaml
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Pack
        id: pack
        run: |
          VERSION=$(node -p "require('./package.json').version")
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          npm pack                                  # → agent-mesh-<version>.tgz
          cp "agent-mesh-$VERSION.tgz" agent-mesh.tgz   # stable name for predictable URLs
```

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
              --notes "agent-mesh v$VERSION — install: npm i -g <this release's agent-mesh.tgz>" \
              "agent-mesh.tgz" "agent-mesh-$VERSION.tgz"
          fi
```

Idempotency: the versioned step is a no-op when `v<version>` already exists, so
ordinary (non-bump) commits only refresh the rolling release, and workflow
re-runs never error. The rolling step's delete-then-create (with `|| true` on the
delete) is safe whether or not `edge` already exists.

### 2. `test/release-workflow.test.js` — hermetic lint

Mirrors `test/integration-workflow.test.js` (zero-dep string/regex assertions on
the file; the repo has no YAML parser):

- the file exists at `.github/workflows/release.yml`;
- triggers on `workflow_run` with `workflows: ["CI"]` and `types: [completed]`;
- the job guard requires `conclusion == 'success'` **and** `head_branch == 'main'`;
- `permissions:` grants `contents: write`;
- checks out `github.event.workflow_run.head_sha`;
- runs `npm pack` and copies to the stable `agent-mesh.tgz`;
- has a rolling `gh release ... edge ...` step (delete-then-create) and a guarded
  `gh release ... v$VERSION` step that skips when the release exists;
- the rolling tag is `edge`, never `main` (no branch-name collision);
- does **not** trigger on `pull_request` or `push` (release only via `workflow_run`).

### 3. README — install-the-latest note

Under the existing install section (which already shows `npm pack` +
`npm install -g ./agent-mesh-*.tgz`), add the prebuilt-release install lines
(edge `main`, latest stable, pinned `v<version>`) so users don't have to clone +
pack.

## Data Flow

`push → main` → `CI` (existing) completes `success` → `Release` fires → checkout
`head_sha` → `npm pack` + stable copy → update rolling `main` release → if version
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

1. After this merges to `main`, the `CI` run completes → the `Release` workflow
   appears in the Actions tab and succeeds.
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
- It never runs on `pull_request`, so untrusted fork PRs cannot trigger a publish.
- Distribution-only: it does not deploy to or touch the host — the local
  `deploy-sync` pipeline remains the host CD.
