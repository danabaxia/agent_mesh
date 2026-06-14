# Self-Hosting Dev-Mesh — Design

## 1. Goal

Build a small society of `agent-mesh` agents that **live in this repository** and
**evolve it** — turning issues and CI failures into reviewed, merged PRs without a
human in the inner loop — while, by the very act of running on the framework,
serving as a continuous **integration test of the mesh itself** (dogfooding).

This is self-hosting: the mesh hosts the agents that build the mesh. If the
society can plan → code → test → review → merge a change using `serve-a2a`,
the peer-bridge, the path-guard, the scheduler, and the memory system, then those
primitives are provably working end-to-end on a real workload.

**Lane (this spec):** the **dev workforce** (Triager / Coder / Tester / Reviewer
/ Curator). **Deployment:** **cloud-first** — the society runs inside GitHub
Actions, hosted by [`anthropics/claude-code-action@v1`][cca] for the Claude
runtime + GitHub auth, with the agent-mesh society materialized in the runner.

## 2. Non-goals

- **Not auto-merge by default.** The loop drives a PR to green + approved and
  *stops there*; merging requires explicit policy opt-in (Renovate-style).
- **Not a local lane (yet).** The local-agent + `nektos/act` topology is a
  sibling spec; this one is cloud-first. The agent definitions are deployment-
  agnostic so the local lane reuses them verbatim.
- **Not framework hot-swapping.** Agents never adopt an unmerged change to the
  framework they run on; the running framework is pinned per cycle (§8).
- **Not a new transport or protocol.** Reuses stdio A2A (`serve-a2a` +
  `agentmesh_peerbridge`) unchanged.
- **Not a replacement for the eval scorecards.** The Tester *runs* them; it does
  not redefine them.

## 3. The two meshes

| Mesh | Lives in | Writable? | Purpose |
|------|----------|-----------|---------|
| **Dev-mesh** (the workforce) | `mesh/dev/<role>/` | each agent only its own root | plan/code/test/review/curate the repo |
| **Subject-mesh** (test fixtures) | `examples/eval-{pair,trio}` → materialized to temp | disposable temp roots | the Tester spins these up to exercise mesh features |

Strict isolation: an eval run (Subject-mesh) can never touch the Dev-mesh — the
**single-writable-root + path-guard** invariant enforces it. The Dev-mesh edits
the repo only via a **git worktree**, never the live checkout.

## 4. The agent society

Each role is a real mesh agent: `AGENT.md` (identity-as-data), `agent.json`
(card + `x-agentmesh.modes`), `prompts/`, `skills/<name>/SKILL.md`, `memory/`,
and `registry.json` (peers, doctor-generated). Mode is the capability fence:
**`ask` = read-only tools; `do` = write tools behind the path-guard.**

| Agent | Mode | Peers | Owns / does | Skills (SKILL.md) |
|-------|------|-------|-------------|-------------------|
| **Maintainer** | ask | all | human/scheduler entry; routes work, holds project context | `route-work`, `read-project-context` |
| **Triager** | ask | — | classify an issue/CI red; produce a plan | `classify-ci-failure`, `issue-to-plan`, `dedupe` |
| **Coder** | **do** | Tester | implement the plan in a worktree, iterate to green | `patch-planning`, `test-strategy`, `conformance-fix`, `worktree-hygiene` |
| **Tester** | **do** (own + temp roots) | Subject-mesh | run `run-all-tests.mjs` + materialize eval pair/trio + behavior/adversarial/perf evals; return scorecards | `run-suite`, `materialize-eval`, `interpret-scorecard`, `read-mesh-health` |
| **Reviewer** | ask | — | review the diff against the repo's security invariants; comment | `code-review`, `security-review`, `spec-conformance` |
| **Curator** | **do** (memory only) | — | on merge/revert, distill lessons into `memory/` + `workflows/` | `distill-lesson`, `promote-to-memory`, `drift-prune` |

The command chain (Maintainer → Triager → Coder → Tester) is real onward
delegation via `delegate_to_peer` — the exact two-hop pattern the `eval-trio`
proves. `examples/coding-agent/skills/{code-review,patch-planning,test-strategy}`
seeds the Coder/Reviewer skill sets.

## 5. Cloud-first deployment

The society is hosted by GitHub Actions. Each *trigger class* is a workflow that
checks out the repo, materializes/loads the Dev-mesh (`doctor --apply`), and
drives the **Maintainer** agent headlessly; the Maintainer delegates onward over
`serve-a2a`. `claude-code-action@v1` supplies the runner shell, the Claude
runtime, and `GITHUB_TOKEN`/`ANTHROPIC_API_KEY`.

| Workflow | Trigger | Drives |
|----------|---------|--------|
| `dev-mesh-triage.yml` | `issues` (opened/labeled), `check_run` (failure), `schedule` | Maintainer → Triager → (Coder) |
| `dev-mesh-review.yml` | `pull_request` (opened/synchronize) | Maintainer → Reviewer |
| `dev-mesh-curate.yml` | `pull_request` (closed & merged) | Maintainer → Curator |

The Tester is not its own workflow — it runs *inside* the triage/fix job (the
Coder delegates to it), so a fix is verified in the same runner before the PR is
pushed. CI on the resulting PR (`ci.yml`) remains the **authoritative gate**.

### Phasing (so it ships incrementally)
- **Phase 0 — per-role claude-code-action.** Each workflow uses `claude-code-action`
  with a role-specific prompt + the role's skills. No serve-a2a yet. Fast value;
  validates the GitHub plumbing + classifier.
- **Phase 1 — mesh-native.** Workflows materialize the real Dev-mesh and drive
  the Maintainer; delegation flows over `serve-a2a`/peer-bridge. *This is the
  dogfooding milestone* — the society runs ON the framework.
- **Phase 2 — self-evolution.** The Curator writes outcomes into the memory
  system; subsequent runs read them (closed learning loop).

## 6. The closed loop (end to end)

```
(1) trigger (CI red / issue / cron)        → Maintainer
(2) Maintainer → Triager (ask): logs/issue → classify (§7)
        flake      → re-kick (push empty commit / re-run), STOP
        infra/auth → escalate to human (comment + AskUser), STOP
        out-of-scope (pre-existing on base) → report, STOP
        real bug   → plan, return
(3) Maintainer → Coder (do): plan + fresh worktree
(4) Coder edit → Coder → Tester (do): "suite + evals"
(5) Tester: run-all-tests.mjs + eval pair/trio (+behavior) → scorecard
(6) Coder: green? commit + open PR (GitHub MCP). red? back to (4), bounded retries
(7) Reviewer (ask) on the PR: diff vs invariants → comment / approve
(8) ci.yml on the PR = authoritative gate
(9) merged → Curator (do, memory): distill lesson → quick.json/workflows
(10) mesh-health (check_conformance + triage_logs) → dashboard
```

## 7. The failure classifier (Triager core)

A CI red is not one thing; misclassifying wastes money and thrashes the branch.
The classifier (a pure, unit-testable decision tree — the same judgment exercised
manually this session) reads `get_job_logs` and emits one label:

| Label | Signal | Action |
|-------|--------|--------|
| `flake` | known-intermittent test, passes on re-run, unrelated to diff | re-kick, max 2× |
| `real_bug` | deterministic, fails across re-runs, in changed files | fix (Coder) |
| `infra_auth` | fails in <2s / `claude -p` dies / 403 / bad secret | escalate (human) |
| `out_of_scope` | pre-existing red on base branch | report, no edit |

This classifier is the **highest-value testable artifact** — build it pure, gate
it hermetically, before any agent wiring.

## 8. Bootstrapping guardrails (self-modification safety)

- **Never push protected branches.** Always worktree → branch → PR → CI gate.
- **Coder edits a git worktree**, not the live checkout — a bad edit is isolated
  and discardable.
- **Pinned framework per cycle.** A change to `src/**` is validated by CI *before*
  the society runs on it — don't hot-swap your own legs.
- **Bounded retries per failure-signature** (≤3) + **progress detection**: same
  failure after a fix → escalate, don't re-try identically.
- **`do`-scope minimalism.** Curator writes only `memory/`; Tester only temp
  roots; Coder only the worktree. Enforced by the path-guard root, not honor code.
- **Cost ceiling.** Real-claude eval tiers are expensive; never re-kick them
  speculatively; budget-gate the Tester's heavy scorecards.
- **No `Bash` in `do`** (existing invariant) — Coder uses structured write tools;
  shell-shaped steps run as workflow steps, not model-driven writes.

## 9. Self-evolution: the memory feedback loop

The ecosystem improves because the **Curator** turns outcomes into durable,
recalled knowledge using the framework's *existing* memory machinery:

- merged fix pattern → `workflows/<slug>.md` (review-gated promotion);
- "this check is a flake → re-kick, don't patch" → `quick.json` fact;
- stale/contradicted lessons → drift-watch retire/supersede.

On the next run the Triager/Coder **prefetch** these (the headless prefetch wired
into the spawn), so the society gets better at *this* repo over time — the
ChatDev "experiential co-learning" pattern, realized on primitives already in the
tree.

## 10. Component reuse (what already exists)

| Need | Existing primitive |
|------|--------------------|
| transport / onward delegation | `serve-a2a`, `serve-peer-bridge` |
| wiring | `registry.json`, `mesh.json`, `doctor`, `add`, `init-mesh` |
| write/recursion safety | path-guard, single-root, `context.js` |
| cadence | scheduler (`schedule`) |
| health | `serve-mesh-health`: `check_conformance`, `ping_agent`, `triage_logs` |
| observe | dashboard |
| memory / evolution | `quick.json`, absorption/digest/drift, review-gated promotion |
| test subjects | `examples/eval-{pair,trio}` + setup scripts |
| GitHub surface | MCP servers in each `.mcp.json`, `readOnly`-marker mode-gated |

~70% is in place; the new work is agent definitions + skills + the three
workflows + the pure classifier.

## 11. Implementation plan

1. **Classifier** (`src/dev-mesh/classify.js`) + hermetic tests — pure, no agents.
2. **Agent folders** `mesh/dev/{maintainer,triager,coder,tester,reviewer,curator}`
   (AGENT.md, agent.json, prompts, skills), wired with `init-mesh`/`add`/`doctor`.
3. **Phase 0 workflows** (`dev-mesh-{triage,review,curate}.yml`) using
   `claude-code-action`, role prompts + classifier, auto-merge off.
4. **Phase 1**: switch workflows to materialize the real Dev-mesh + drive the
   Maintainer over serve-a2a (dogfooding milestone).
5. **Phase 2**: Curator memory writes + prefetch-on-next-run (self-evolution).
6. Hermetic coverage for the classifier + workflow lint; the real-claude loop is
   exercised by the existing opt-in e2e + a new nightly dogfood job.

## 12. File inventory (new)

```
docs/superpowers/specs/2026-06-14-self-hosting-dev-mesh-design.md   (this)
src/dev-mesh/classify.js                 + test/dev-mesh-classify.test.js
mesh/dev/<role>/{AGENT.md,agent.json,prompts/*,skills/*/SKILL.md,memory/*}
.github/workflows/dev-mesh-triage.yml
.github/workflows/dev-mesh-review.yml
.github/workflows/dev-mesh-curate.yml
```

## 13. Risks / open questions

- **Cost** of running real-claude per CI red — mitigated by the classifier
  (don't engage on flake/infra) + budget gate.
- **Runaway PRs** — bounded retries + auto-merge-off + human escalation.
- **Skill/prompt drift** vs `PROJECT.md` invariants — Reviewer's `security-review`
  skill + conformance gate.
- **Phase-1 runner cost/time** of materializing a full mesh per event — measure;
  Phase-0 per-role action is the fallback if mesh-in-runner is too heavy.

[cca]: https://code.claude.com/docs/en/github-actions
