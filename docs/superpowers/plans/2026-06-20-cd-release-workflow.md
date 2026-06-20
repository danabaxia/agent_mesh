# CD Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the packed npm tarball as GitHub Releases (rolling `edge` + immutable `v<version>`) after every CI-green push to `main`, so any machine can `npm i -g` the latest build.

**Architecture:** One new GitHub Actions workflow `.github/workflows/release.yml` triggered via `workflow_run` after the `CI` workflow succeeds on `main`; it `npm pack`s and publishes releases with the built-in `GITHUB_TOKEN`. A hermetic `node --test` lint asserts the workflow's shape (zero-dep string/regex, mirroring `test/integration-workflow.test.js`). README gains install-from-release lines.

**Tech Stack:** GitHub Actions (`workflow_run`, `gh` CLI), Node ≥ 20, `node --test` (zero deps), Markdown.

---

## Background the implementer needs

- **Repo conventions:** zero runtime deps; tests are `node --test` files under `test/`; ES modules; Node ≥ 20. Run one test file `node --test test/<f>.js`, all with `npm test`.
- **`package.json`:** name `agent-mesh`, version `0.1.0`, has `bin` + `files`, **no** `prepack`/`prepare` lifecycle scripts. `npm pack` → `agent-mesh-0.1.0.tgz`.
- **Existing CI workflow** is `.github/workflows/ci.yml` with `name: CI`; it runs on push to `main` (Linux smoke) + `pull_request`. Default branch is `main`. The new workflow's `workflow_run` trigger is keyed to that **name**.
- **GitHub Actions facts this plan relies on (all verified in the spec's review):**
  - `workflow_run` fires when the named workflow *completes*, runs from the workflow definition on the **default branch**, with the **base repo's** `GITHUB_TOKEN`. So the first release triggers on the next push to `main` *after* `release.yml` is on `main` (not necessarily the merge commit).
  - For a fork/branch PR's CI completion, `workflow_run.head_branch` is the PR branch, so the `head_branch == 'main'` guard skips it and the fork SHA is never checked out — this is the fork-safety mechanism.
  - A CI re-run / `workflow_dispatch` on main also has `head_branch == 'main'` + success; the `event == 'push'` clause excludes those so `edge` can't roll backwards.
  - `/releases/download/<tag>/<asset>` is tag-addressed (works for the `edge` prerelease). `/releases/latest/download/<asset>` resolves to the newest **non-prerelease** (the `v<version>` releases).
  - A git tag named `main` would collide with the `main` branch (ambiguous ref) — the rolling tag is `edge`.
- **Lint-test pattern** (`test/integration-workflow.test.js`): module-top `const wf = await readFile(wfPath, 'utf8')`, then `test(...)` blocks with `assert.match` / `assert.doesNotMatch` on the raw text. No YAML parser.

---

## File Structure

- **Create** `.github/workflows/release.yml` — the release workflow (trigger gating, pack, publish edge + versioned).
- **Create** `test/release-workflow.test.js` — hermetic shape lint + the `ci.yml` name-coupling guard.
- **Modify** `README.md` — install-from-release lines (edge / latest / pinned).

---

## Task 1: Release workflow + hermetic lint

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `test/release-workflow.test.js`

TDD: write the lint test first (fails — workflow file missing), then create the workflow to satisfy it.

- [ ] **Step 1: Write the failing test**

Create `test/release-workflow.test.js` with exactly:

```js
// test/release-workflow.test.js — hermetic lint of the Release workflow. The repo
// is zero-dependency (no YAML parser), so this asserts the invariants that matter
// against the raw workflow text — trigger gating, concurrency, permissions, and the
// publish steps — catching drift in the L0 suite even though the workflow only runs
// on GitHub. Spec: docs/superpowers/specs/2026-06-20-cd-release-workflow-design.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const wfPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const ciPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const wf = await readFile(wfPath, 'utf8');

test('release workflow: triggers only on CI completion, gated to a green push on main', () => {
  assert.match(wf, /^on:/m);
  assert.match(wf, /workflow_run:/);
  assert.match(wf, /workflows:\s*\["CI"\]/);
  assert.match(wf, /types:\s*\[completed\]/);
  // all three guard clauses are load-bearing
  assert.match(wf, /conclusion == 'success'/);
  assert.match(wf, /head_branch == 'main'/);
  assert.match(wf, /event == 'push'/);
  // release only via workflow_run — never per-PR or direct push
  assert.doesNotMatch(wf, /^\s*pull_request:/m, 'release must not trigger on pull_request');
  assert.doesNotMatch(wf, /^\s*push:/m, 'release must not trigger on push directly');
});

test('release workflow: serialized, scoped, bounded', () => {
  assert.match(wf, /concurrency:/);
  assert.match(wf, /cancel-in-progress:\s*false/);   // never interrupt a versioned create
  assert.match(wf, /permissions:[\s\S]*contents:\s*write/);
  assert.match(wf, /timeout-minutes:/);
  assert.match(wf, /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/);
});

test('release workflow: packs to a stable name and publishes edge + versioned', () => {
  assert.match(wf, /npm pack --ignore-scripts \| tail -1/);
  assert.match(wf, /cp "\$TARBALL" agent-mesh\.tgz/);
  // rolling edge: delete-then-create; tag is edge, never main
  assert.match(wf, /gh release delete edge --yes --cleanup-tag/);
  assert.match(wf, /gh release create edge --prerelease/);
  assert.doesNotMatch(wf, /gh release (create|delete|view|upload) main\b/, 'rolling tag must be edge, not main');
  // versioned: guarded create (skip if exists)
  assert.match(wf, /gh release view "v\$VERSION"/);
  assert.match(wf, /gh release create "v\$VERSION"/);
});

test('release workflow: CI name-coupling guard — ci.yml still named "CI"', async () => {
  const ci = await readFile(ciPath, 'utf8');
  assert.match(ci, /^name:\s*CI\s*$/m, 'release.yml workflow_run is keyed to CI by name; keep ci.yml name: CI');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/release-workflow.test.js`
Expected: FAIL — `release.yml` does not exist (`ENOENT` on the top-level `await readFile`).

- [ ] **Step 3: Create the workflow**

Create `.github/workflows/release.yml` with exactly:

```yaml
name: Release

# Publish the packed tarball as GitHub Releases after CI passes on main.
# Triggered via workflow_run keyed to the CI workflow's name ("CI") — keep that
# name in sync (the lint test asserts it). Distribution only; the host's running
# services are updated by the local deploy-sync pipeline, not by this workflow.
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

permissions:
  contents: write          # create releases, tags, and upload assets via GITHUB_TOKEN

concurrency:
  group: release           # serialize runs so the edge tag delete+create can't race
  cancel-in-progress: false  # never cancel mid-run → never leave a partial versioned release

jobs:
  release:
    # success + on main + a real push (not a re-run / workflow_dispatch, which would
    # otherwise re-cut edge at a stale head_sha). A fork PR's CI completion has a
    # non-main head_branch, so it is skipped and its head_sha is never checked out.
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

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Pack
        id: pack
        run: |
          VERSION=$(node -p "require('./package.json').version")
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          TARBALL=$(npm pack --ignore-scripts | tail -1)   # real filename (scope/version-proof); no build scripts
          echo "tarball=$TARBALL" >> "$GITHUB_OUTPUT"
          cp "$TARBALL" agent-mesh.tgz                      # stable name for predictable URLs

      - name: Rolling release (edge)
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release delete edge --yes --cleanup-tag 2>/dev/null || true
          gh release create edge --prerelease \
            --target "${{ github.event.workflow_run.head_sha }}" \
            --title "edge (rolling main)" \
            --notes "Always-newest build of main; re-cut on every green push. Not a stable release." \
            agent-mesh.tgz

      - name: Versioned release (on bump)
        env:
          GH_TOKEN: ${{ github.token }}
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/release-workflow.test.js`
Expected: PASS — all 4 tests pass.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — including the new `release-workflow.test.js`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release.yml test/release-workflow.test.js
git commit -m "feat(release): publish tarball as GitHub Release on green main (edge + versioned)"
```

---

## Task 2: README — install-from-release lines

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the prebuilt-release install block**

In `README.md`, find:

```
agent-mesh --help                  # verify
```

To deploy to another machine, copy the `.tgz` over and run
```

Replace it with (inserts a prebuilt-release block between the manual block and the deploy note):

```
agent-mesh --help                  # verify
```

Or install a prebuilt release straight from GitHub (no clone or pack needed):

```sh
# edge — rebuilt on every green push to main (moving target):
npm i -g https://github.com/danabaxia/agent_mesh/releases/download/edge/agent-mesh.tgz
# latest stable version (advances only on a package.json version bump):
npm i -g https://github.com/danabaxia/agent_mesh/releases/latest/download/agent-mesh.tgz
# a pinned version:
npm i -g https://github.com/danabaxia/agent_mesh/releases/download/v0.1.0/agent-mesh.tgz
```

These are published by [`.github/workflows/release.yml`](.github/workflows/release.yml)
after CI passes on `main`.

To deploy to another machine, copy the `.tgz` over and run
```

- [ ] **Step 2: Sanity-check the edit**

Run: `grep -n "releases/download/edge/agent-mesh.tgz" README.md`
Expected: one match (the edge install line).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(release): document installing prebuilt edge/stable/pinned releases"
```

---

## Verification (after merge, on GitHub)

The lint test is hermetic; the live publish path runs only on GitHub:

1. `workflow_run` only fires once `release.yml` is on the default branch, so push a
   trivial follow-up commit to `main` *after* this merges to force the first run.
   The `CI` run completes → `Release` appears in Actions and succeeds.
2. The Releases page shows an `edge (rolling main)` prerelease with `agent-mesh.tgz`;
   the first run also creates `v0.1.0` (it didn't exist before).
3. On a clean machine:
   `npm i -g https://github.com/danabaxia/agent_mesh/releases/download/edge/agent-mesh.tgz`
   then `agent-mesh --help` works.
4. Push another trivial commit; confirm `edge`'s asset timestamp updates and **no**
   new `v<version>` was cut (version unchanged).

---

## Self-Review notes (author)

- **Spec coverage:** trigger+gating (T1 release.yml `if:` + `event=='push'`), concurrency/timeout (T1), pack-to-stable-name with `--ignore-scripts`/`tail -1` (T1), edge delete+create (T1), versioned guarded create + tolerate-concurrent (T1), hermetic lint incl. `name: CI` guard (T1 test), README channels edge/latest/pinned (T2), fork-safety via guard (encoded in `if:` + comments). All spec §1–§3 + Testing + Verification mapped.
- **Type/string consistency:** the test's `assert.match` patterns match the workflow text verbatim (`npm pack --ignore-scripts | tail -1`, `cp "$TARBALL" agent-mesh.tgz`, `gh release delete edge --yes --cleanup-tag`, `gh release create edge --prerelease`, `gh release view "v$VERSION"`, `gh release create "v$VERSION"`, the three `if:` clauses, `cancel-in-progress: false`, `timeout-minutes:`, the `head_sha` ref). Rolling tag is `edge` everywhere; README URLs use `edge` / `latest` / `v0.1.0` consistently.
- **No placeholders:** full file contents in every create step; exact commands + expected output.
