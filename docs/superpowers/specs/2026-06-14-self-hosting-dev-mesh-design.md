# Self-Hosting Dev-Mesh — Design

## 1. Goal

Build a small society of `agent-mesh` agents that **live in this repository** and
**evolve it** — taking a human idea through discussion → an approved spec →
reviewed, merged PR without a human in the inner loop — while, by the very act of
running on the framework, serving as a continuous **integration test of the mesh
itself** (dogfooding).

This is self-hosting: the mesh hosts the agents that build the mesh. If the
society can intake → spec → code → test → review → merge a change using
`serve-a2a`, the peer-bridge, the path-guard, the scheduler, and the memory
system, then those primitives are provably working end-to-end on a real workload.

**Lane (this spec):** the **dev workforce** (Analyst / Triager / Coder / Tester /
Reviewer / Curator). **Deployment:** **cloud-first** — the society runs inside
GitHub Actions, hosted by [`anthropics/claude-code-action@v1`][cca] for the Claude
runtime + GitHub auth, with the agent-mesh society materialized in the runner.

## 2. Non-goals

- **No autonomous *implementation*.** The Analyst MAY generate ideas — including
  by researching similar open-source projects (§5.0) — but every idea is a
  **proposal**: it becomes a draft spec for human review and is hard-gated behind
  approval (§5.3) before any code. The society never *ships* unapproved work.
- **No code before an approved spec.** Discussion, research, and spec drafting are
  cheap and reversible; `do`-mode work is hard-gated behind explicit approval (§5.3).
- **Not auto-merge by default.** The loop drives a PR to green + approved and
  *stops there*; merging requires explicit policy opt-in (Renovate-style).
- **Not a local lane (yet).** The local-agent + `nektos/act` topology is a
  sibling spec; agent definitions here are deployment-agnostic so it reuses them.
- **Not framework hot-swapping.** Agents never adopt an unmerged change to the
  framework they run on; the running framework is pinned per cycle (§9).
- **Not a new transport/protocol.** Reuses stdio A2A unchanged.

## 3. The two meshes

| Mesh | Lives in | Writable? | Purpose |
|------|----------|-----------|---------|
| **Dev-mesh** (the workforce) | `dev-mesh/<role>/` | each agent only its own root | intake/spec/code/test/review/curate the repo |
| **Subject-mesh** (test fixtures) | `examples/eval-{pair,trio}` → materialized to temp | disposable temp roots | the Tester spins these up to exercise mesh features |

Strict isolation: an eval run (Subject-mesh) can never touch the Dev-mesh — the
**single-writable-root + path-guard** invariant enforces it.

**Writable-root reconciliation (F1).** "Each agent writes only its own root" is the
invariant, but a `do` agent's root is *the folder it is served on*, not its
definition folder. So:
- the **Coder** is served with its writable root = a **per-task git worktree** of
  the repo (created fresh per task); that worktree *is* its single root, and the
  path-guard confines it there. Its definition (`AGENT.md`/skills) lives in
  `dev-mesh/coder/` but is never the write target.
- the **Curator** is served with root = the Dev-mesh **memory** location only.
- the **Analyst/Triager/Reviewer/Maintainer** are `ask` (no writable root at all).
The live checkout is never a writable root for any agent.

## 4. The agent society

Each role is a real mesh agent: `AGENT.md` (identity-as-data), `agent.json`
(card + `x-agentmesh.modes`), `prompts/`, `skills/<name>/SKILL.md`, `memory/`,
and `registry.json` (peers). Mode is the capability fence: **`ask` = read-only
tools; `do` = write tools behind the path-guard.**

| Agent | Mode | Peers | Owns / does | Skills (SKILL.md) |
|-------|------|-------|-------------|-------------------|
| **Maintainer** | ask | all | human/scheduler entry; **watches the backlog**, claims ready tasks, routes work | `route-work`, `watch-backlog`, `claim-task` |
| **Analyst** | ask | — | owns the **idea-intake door**; **researches similar OSS projects, absorbs findings, proposes ideas** (§5.0); discusses with the user; drafts the ready-for-review spec; shepherds approval; maintains backlog state | `research-landscape` (deep-research), `absorb-findings`, `ideate`, `brainstorm`, `write-spec`, `shepherd-approval`, `backlog-curate` |
| **Triager** | ask | — | classify an issue/CI red; produce a fix plan | `classify-ci-failure`, `issue-to-plan`, `dedupe` |
| **Coder** | **do** | Tester | implement the approved plan in a worktree, iterate to green | `patch-planning`, `test-strategy`, `conformance-fix`, `worktree-hygiene` |
| **Tester** | ask | Subject-mesh | **interpret** test/eval scorecards that the *workflow* produced (it never runs shell — see §4.1); flag regressions | `interpret-scorecard`, `read-mesh-health` |
| **Reviewer** | ask | — | review the diff against the repo's security invariants; comment | `code-review`, `security-review`, `spec-conformance` |
| **Curator** | **do** (memory only) | — | on merge/revert, distill lessons into `memory/` + `workflows/` | `distill-lesson`, `promote-to-memory`, `drift-prune` |

The command chain (Maintainer → Triager/Coder → Tester) is real onward delegation
via `delegate_to_peer` — the exact two-hop pattern the `eval-trio` proves.
`examples/coding-agent/skills/{code-review,patch-planning,test-strategy}` seeds the
Coder/Reviewer skill sets.

### 4.1 Execution model — who runs shell (F2)

`do`-mode forbids `Bash` (a hard invariant: arbitrary shell can't be path-gated).
So **agents never execute processes** — no `npm test`, no eval scripts, no `git`,
no `act`. Division of labor:

- **GitHub Actions workflow steps** run *all* shell: install, `run-all-tests.mjs`,
  the eval setup scripts + scorecards, `git` (worktree, commit, push), `doctor`.
- **`do` agents** (Coder, Curator) only **edit files** in their worktree/memory
  root via Write/Edit tools.
- **`ask` agents** (Maintainer, Analyst, Triager, Tester, Reviewer) only **read +
  reason** — including reading the scorecards/logs the workflow produced.

A "fix → verify" cycle is therefore: Coder edits (do) → *workflow* runs the suite
(shell step) → Tester interprets the result (ask) → Coder edits again. The model
proposes file changes; the runner executes and verifies them.

## 5. The front door — intake → spec → approval → backlog

The society never invents its own work. Every change starts as a **human idea**,
is refined into a **ready-for-review spec**, and only begins implementation
**after the spec is approved**. This makes the repo's existing superpowers flow
(brainstorm → spec → codex-spec-review → approval → plan → build) first-class and
**continuously watched**.

### 5.0 Research-driven ideation (Analyst)
Ideas need not wait for a human to type them. On request ("research X and
propose") or on a cadence, the **Analyst** uses the repo's **`deep-research`**
skill (fan-out web search → fetch → adversarial verification → cited synthesis)
to **scan the landscape of similar open-source projects** (e.g. OpenHands,
SWE-agent, Aider, MetaGPT/ChatDev, Renovate, claude-code-action), **absorb** the
findings into `memory/` (with citations, via the absorption pipeline), and
**synthesize candidate ideas** for *this* project. Each promising idea is written
as a **ready-for-review draft spec** (and an `idea` Issue carrying the research
brief + sources). Crucially, these are **proposals only** — they enter the same
backlog at `spec:in-review` and are subject to the §5.3 approval gate before any
code. This makes the Analyst a continuously-learning scout, not an autonomous
implementer.

### 5.1 The door (cloud-first = GitHub Issues)
A user opens a **GitHub Issue** (label `idea`) — the door to discuss. The
**Analyst** engages in the issue thread to clarify scope. `docs/superpowers/backlog.md`
indexes every task; Issues + labels are the live state.

### 5.2 Spec authoring
When discussion converges, the Analyst drafts
`docs/superpowers/specs/<date>-<slug>-design.md` and opens a **spec PR** (label
`spec:in-review`), optionally running `codex-spec-review` to converge with a
second model before requesting human review.

### 5.3 The approval gate (HARD)
Implementation is **blocked** until approval: a human merges the spec PR (or adds
the `approved` label). **No `do`-mode work — no Coder, no code branch — happens
for a task in any earlier state.** This is the central safety property: discussion
and spec are cheap and reversible; code is gated behind explicit human approval.

### 5.4 Backlog as a state machine
The to-do list is the set of Issues, each in exactly one label-encoded state,
mirrored in `backlog.md`:

```
idea → discussing → spec:draft → spec:in-review → approved (ready)
     → in-progress → pr:in-review → done
                   ↘ blocked        ↘ rejected
```

### 5.5 The watch loop (continuous pickup)
Two signals drive pickup (event + poll — the §1 reconciler pattern):
- **event**: an Issue gains `approved`/`ready` → immediate dispatch;
- **poll**: a scheduled job lists `ready ∧ ¬in-progress` Issues → dispatch each.

On dispatch the **Maintainer** **claims** the task (flip to `in-progress` with an
**idempotent lock** so two ticks can't double-start it) and delegates to the
**Coder**, who works the §7 loop until the PR is ready-for-merge (green +
approved), then flips the Issue to `pr:in-review`.

> The watch is the **Maintainer/dispatcher's** scheduled job; the **Coder** is the
> executor. (The user's "an agent always loops monitoring and starts new tasks" =
> this watch loop. Putting the *watch* in the Maintainer keeps each Coder focused
> on one task and prevents two Coders racing the same backlog item.)

## 6. Cloud-first deployment

The society is hosted by GitHub Actions. Each trigger class is a workflow that
checks out the repo, materializes/loads the Dev-mesh (`doctor --apply`), and
drives the relevant agent headlessly; agents delegate onward over `serve-a2a`.
`claude-code-action@v1` supplies the runner shell, the Claude runtime, and
`GITHUB_TOKEN`/`ANTHROPIC_API_KEY`.

| Workflow | Trigger | Drives |
|----------|---------|--------|
| `dev-mesh-research.yml` | `workflow_dispatch` + `schedule` (cadence) | Analyst (research OSS landscape → absorb → propose draft specs) |
| `dev-mesh-intake.yml` | `issues` (opened/commented), label changes | Analyst (discuss, draft spec, manage labels) |
| `dev-mesh-backlog.yml` | `schedule` + `issues` labeled `approved` | Maintainer → Coder (claim ready task, build) |
| `dev-mesh-autofix.yml` | `check_run` (test failure) on a same-repo PR | Triager + Coder (classify → fix the failing PR, commit; ≤2/PR, never merge) |
| `dev-mesh-triage.yml` | `schedule` (hourly sweep) | Maintainer → Triager (classify/escalate lingering reds) |
| `dev-mesh-review.yml` | `pull_request` (opened/synchronize) | Maintainer → Reviewer |
| `dev-mesh-curate.yml` | `pull_request` (closed & merged) | Maintainer → Curator |

The Tester runs *inside* the backlog/triage job (the Coder delegates to it), so a
change is verified in the same runner before the PR is pushed. CI on the resulting
PR (`ci.yml`) remains the **authoritative gate**.

### Phasing (so it ships incrementally)
- **Phase 0 — per-role claude-code-action.** Each workflow uses `claude-code-action`
  with a role prompt + skills. No serve-a2a yet. Fast value; validates the GitHub
  plumbing, the classifier, and the intake/approval/backlog gating.
- **Phase 1 — mesh-native.** Workflows materialize the real Dev-mesh and drive the
  Maintainer; delegation flows over serve-a2a/peer-bridge. *Dogfooding milestone.*
- **Phase 2 — self-evolution.** Curator writes outcomes to memory; later runs
  prefetch them.

## 7. The closed loop (idea → merge)

```
(0) user opens `idea` Issue → Analyst discusses → spec PR → APPROVAL GATE (§5.3)
(1) approved/ready (event or poll) → Maintainer CLAIMS (idempotent lock) → Coder
(2) [if instead a CI red] Maintainer → Triager: classify (§8)
        flake → re-kick, STOP · infra/auth → escalate, STOP · out-of-scope → report
        real bug → plan
(3) Coder (do): edit files in a fresh worktree
(4) workflow (shell): run-all-tests.mjs + eval pair/trio (+behavior) → Tester (ask) interprets scorecard
(5) green? workflow commits + opens PR (GitHub MCP) + Issue → `pr:in-review`
    red? Tester's findings → Coder edits again (3), bounded retries
(6) Reviewer (ask) on the PR: diff vs invariants → comment / approve
(7) ci.yml on the PR = authoritative gate
(8) merged → Curator (do, memory): distill lesson; Issue → `done`
(9) mesh-health (check_conformance + triage_logs) → dashboard
```

## 8. The failure classifier (Triager core)

A CI red is not one thing; misclassifying wastes money and thrashes the branch.
The classifier (a pure, unit-testable decision tree) reads `get_job_logs` and
emits one label:

| Label | Signal | Action |
|-------|--------|--------|
| `flake` | known-intermittent test, passes on re-run, unrelated to diff | re-kick, max 2× |
| `real_bug` | deterministic, fails across re-runs, in changed files | fix (Coder) |
| `infra_auth` | fails in <2s / `claude -p` dies / 403 / bad secret | escalate (human) |
| `out_of_scope` | pre-existing red on base branch | report, no edit |

The highest-value testable artifact — build it pure, gate it hermetically, first.

## 9. Bootstrapping guardrails

- **Approval gate is mandatory** (§5.3) — zero `do`-work without an approved spec.
- **Idempotent claim lock** on backlog pickup — two ticks never double-start a task.
- **Never push protected branches.** Always worktree → branch → PR → CI gate.
- **Coder edits a git worktree**, not the live checkout — bad edits are isolated.
- **Pinned framework + workforce per cycle (F6).** Changes to `src/**` *and*
  `dev-mesh/**` (the agents' own prompts/skills) are validated by CI and merged
  *before* the society adopts them — agents never hot-swap their own legs or rewrite
  themselves mid-task.
- **Atomic claim, not a label race (F5).** Task claiming uses an Actions
  `concurrency:` group keyed on the issue + issue **assignee** as the lock, not a
  bare label (label add/check is not atomic across concurrent runs).
- **Bounded retries per failure-signature** (≤3) + **progress detection** → escalate.
- **`do`-scope minimalism.** Curator writes only the memory root; Coder only its
  per-task worktree — enforced by the path-guard root (§3), not honor code.
- **No `Bash` in `do`** (existing invariant); all shell is workflow steps (§4.1).
- **Cost ceiling.** Never re-kick expensive eval tiers speculatively; budget-gate.

## 10. Self-evolution: the memory feedback loop

The **Curator** turns outcomes into durable, recalled knowledge via the framework's
*existing* memory machinery: merged fix patterns → `workflows/<slug>.md` (review-
gated promotion); "this check is a flake → re-kick" → `quick.json`; stale/
contradicted lessons → drift-watch retire/supersede. On the next run the Triager/
Coder **prefetch** these (headless prefetch wired into the spawn), so the society
gets better at *this* repo over time — ChatDev's "experiential co-learning" on
primitives already in the tree.

## 11. Component reuse (what already exists)

| Need | Existing primitive |
|------|--------------------|
| transport / onward delegation | `serve-a2a`, `serve-peer-bridge` |
| wiring | `registry.json`, `mesh.json`, `doctor`, `add`, `init-mesh` |
| write/recursion safety | path-guard, single-root, `context.js` |
| cadence (watch loop) | scheduler (`schedule`) |
| health | `serve-mesh-health`: `check_conformance`, `ping_agent`, `triage_logs` |
| observe | dashboard |
| memory / evolution | `quick.json`, absorption/digest/drift, review-gated promotion |
| research / ideation | superpowers: **`deep-research`** skill (fan-out search, verify, cited synthesis) + absorption pipeline |
| intake/spec/review flow | superpowers: brainstorming → `codex-spec-review` → writing-plans |
| backlog | `docs/superpowers/backlog.md` + GitHub Issues/labels |
| test subjects | `examples/eval-{pair,trio}` + setup scripts |
| GitHub surface | MCP servers in each `.mcp.json`, `readOnly`-marker mode-gated |

~70% is in place; new work is agent definitions + skills + the pure classifier +
the pure backlog logic + the six workflows + the backlog/label conventions.

## 12. Implementation plan

1. **Classifier** (`src/dev-mesh/classify.js`) + hermetic tests — pure, no agents.
2. **Backlog conventions**: label set + state machine + `backlog.md` mirror; a pure
   `src/dev-mesh/backlog.js` (parse/derive state, pick ready∧¬in-progress) + tests.
3. **Agent folders** `dev-mesh/{maintainer,analyst,triager,coder,tester,reviewer,curator}`
   (AGENT.md, agent.json, prompts, skills), wired via `init-mesh`/`add`/`doctor`.
4. **Phase 0 workflows** (`dev-mesh-{research,intake,backlog,triage,review,curate}.yml`)
   using `claude-code-action`, role prompts + classifier + approval/claim gating;
   execution as shell steps (§4.1); fork-PR-safe (§15); auto-merge off.
5. **Phase 1**: switch workflows to materialize the real Dev-mesh + drive the
   Maintainer over serve-a2a (dogfooding milestone).
6. **Phase 2**: Curator memory writes + prefetch-on-next-run (self-evolution).
7. Hermetic coverage for classifier + backlog logic + workflow lint; the real-claude
   loop is exercised by the opt-in e2e + a new nightly dogfood job.

## 13. File inventory (new)

```
docs/superpowers/specs/2026-06-14-self-hosting-dev-mesh-design.md   (this)
src/dev-mesh/classify.js      + test/dev-mesh-classify.test.js
src/dev-mesh/backlog.js       + test/dev-mesh-backlog.test.js
dev-mesh/<role>/{AGENT.md,agent.json,prompts/*,skills/*/SKILL.md,memory/*}
.github/workflows/dev-mesh-research.yml
.github/workflows/dev-mesh-intake.yml
.github/workflows/dev-mesh-backlog.yml
.github/workflows/dev-mesh-triage.yml
.github/workflows/dev-mesh-review.yml
.github/workflows/dev-mesh-curate.yml
```

## 14. Risks / open questions

- **Cost** of real-claude per event — mitigated by the classifier (don't engage on
  flake/infra) + budget gate + intake gating (no code before approval).
- **Runaway PRs** — bounded retries + auto-merge-off + claim lock + escalation.
- **Backlog source of truth** — Issues+labels (live) vs `backlog.md` (index): keep
  one authoritative (Issues) and treat the file as a generated mirror to avoid drift.
- **Skill/prompt drift** vs `PROJECT.md` invariants — Reviewer's `security-review` +
  conformance gate.
- **Phase-1 runner cost/time** of materializing a full mesh per event — measure;
  Phase-0 per-role action is the fallback.
- **Recursion depth budget.** The chain Maintainer→Triager→Coder→Tester is ~3 hops;
  `AGENT_MESH_DEPTH` defaults to 3. Confirm the budget covers the deepest chain (incl.
  Tester→Subject-mesh) or raise it explicitly — the recursion guard refuses past it.
- **Curator memory approval.** Memory/workflow promotion is review-gated by design;
  in an autonomous loop the "reviewer" must be defined — default to **human approval**
  of Curator promotions (a `memory:promote` PR), not auto-write, until trusted.

## 15. Security model

The society ingests **untrusted external content** and runs in CI with secrets, so
it inherits and extends the framework's threat model:

- **All external content is data, never instructions (F3).** Issue/PR bodies,
  review comments, CI logs, and **web research results** are treated like `AGENT.md`
  — length-bounded, framed as data, never executed/obeyed. The `deep-research`
  skill's adversarial verification + citation requirement is the first filter;
  absorbed research is **cited and review-gated** (§5.0/§10) so a poisoned page
  can't silently become a prefetched instruction.
- **No secrets to untrusted code (F4).** Dev-mesh workflows run only on
  **same-repo / trusted refs**; they must NOT expose `ANTHROPIC_API_KEY`/write
  tokens to **fork PRs** (the `pull_request_target` "pwn request" class). Fork PRs
  get read-only review at most.
- **Least privilege per role.** `ask` roles get read-only GitHub MCP (the
  `x-agentmesh readOnly` marker); only the workflow (not the model) holds write
  tokens / pushes; `do` agents touch only their path-guarded root.
- **Human at the two gates that matter.** Spec **approval** (§5.3) and PR **merge**
  (auto-merge off) are human-held; everything between is reversible (branches/PRs).

## 16. State & persistence (sandbox vs repo vs GitHub)

Cloud-first agents run in **ephemeral GitHub Actions runners** — checked out fresh,
destroyed after each run. Anything left only on the runner FS is lost, so all
durable state lives in one of two external stores, never the sandbox.

| Tier | Where | Lifetime | Holds |
|------|-------|----------|-------|
| **Ephemeral (sandbox)** | the Actions runner FS | one run | the Coder's worktree, temp eval dirs, intermediate scorecards — scratch only |
| **Durable in repo (git)** | committed files | versioned, forever | **agent memory** (`dev-mesh/<role>/memory/quick.json`, `workflows/*.md`), the `backlog.md` mirror, agent defs, code |
| **Durable in GitHub** | Issues + labels + PRs | forever | the **live backlog** state machine (authoritative to-do list) |

- **Memory is committed to the repo, not the sandbox.** On start a runner checks
  out the repo and the agent loads memory from git; the Curator persists new
  lessons by **committing them back** via a review-gated `memory:promote` PR
  (§10) — durable, versioned, diff-reviewable, shared across runs. Trade-offs:
  commit churn + concurrent writes, mitigated by the review-gate (serializes
  promotions) and the per-issue concurrency lock (§9).
- **The backlog is detected by querying GitHub, not a sandbox file.** Each tick
  lists Issues by label via the GitHub API/MCP (event: `approved`-label fires the
  workflow; poll: scheduled list of `approved ∧ ¬assigned`). `backlog.md` is a
  committed *mirror* generated from Issues, not the source of truth.

Per-run lifecycle: `checkout (load memory) → query GitHub (load backlog) → work in
ephemeral worktree → commit code (task PR) + memory (promote PR) → runner
destroyed`. Only what is committed/pushed survives.

[cca]: https://code.claude.com/docs/en/github-actions
