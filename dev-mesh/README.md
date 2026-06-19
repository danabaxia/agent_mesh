# The Dev-mesh — a self-hosting agent society

The Dev-mesh is a society of role-agents that **develops this repository itself**:
idea → approved → build → review → merge → distill, with humans holding only the
approval and merge gates. It runs entirely as **GitHub Actions** driving
`claude-code-action@v1`.

> **Two different "meshes" — don't confuse them.**
> - **A2A peer mesh** = the *product* (`agent-mesh serve-a2a`, `registry.json`,
>   `delegate_to_peer`): agents in folders that talk over the A2A stdio protocol.
> - **Dev-mesh** = *this* — the self-hosting society of GitHub-Actions workflows below.
>   In the current Phase-0 deployment, it does **not** use the A2A protocol; it
>   coordinates through GitHub. (Phase 1 will make the society mesh-native.)

Run/health/auth notes: [OPERATING.md](OPERATING.md). Full design:
[docs/superpowers/specs/2026-06-14-self-hosting-dev-mesh-design.md](../docs/superpowers/specs/2026-06-14-self-hosting-dev-mesh-design.md).

## The agents

Nine society roles — **Maintainer, Analyst, Triager, Coder, Tester, Reviewer,
Curator, Orchestrator, Security** — each backed by a `dev-mesh/<role>/AGENT.md`.
The GitHub-Actions side is driven by 14 workflows (11 model-agents + 3 pure scripts):

| Workflow | Role | Trigger | Job |
|---|---|---|---|
| `research` | Analyst | `workflow_dispatch` + sched (weekly Mon) | Generate new `idea` issues from the roadmap |
| `intake` | Analyst | `issues` / `issue_comment` | Triage issues, draft specs, manage labels (discuss → approval gate) |
| `backlog` | Maintainer→Coder→Tester | `issues:labeled` + sched 30m | Claim an `approved` issue, build on a branch, run tests, open a PR |
| `review` | Maintainer→Reviewer | `pull_request` | Review PRs (correctness, tests, scope, security invariants); comments only |
| `review-respond` | Coder | sched 30m | Find `CHANGES_REQUESTED` PRs, apply the review fixes, push |
| `autofix` | Triager+Coder | `check_run` (CI fail) | Classify a failing CI check, fix the real bug, push (≤2/PR) |
| `ci-sweep` | Triager+Coder | sched 30m | Scheduled backstop for `autofix` (missed CI-fail webhooks) |
| `mergefix` | Coder | `push:main` + sched hourly | Resolve PRs that conflict with `main` |
| `triage` | Maintainer→Triager | sched hourly | Sweep unresolved red checks; label/comment/re-kick |
| `security` | Maintainer→Security | sched 6h + manual | Sweep injection, identity/auth, and token-budget attack surfaces; open/update security alert issues |
| `curate` | Maintainer→Curator | `pull_request:closed` | Distill a lesson from a merged PR → open a `memory:promote` PR |
| `memory-automerge` | *(pure script)* | sched 15m | Validate + auto-merge `memory:promote` PRs (the one sanctioned auto-merge) |
| `health` | *(pure script)* | sched 6h | Probe mesh health (run-record envelopes, conformance) |
| `dogfood` | *(pure script)* | sched nightly | Drive the loop end-to-end + capture logs (observational, non-gating) |

## How they collaborate

There is **no central orchestrator and no direct agent-to-agent messaging.** The
shared medium is GitHub itself — **issues, PRs, labels, CI checks, and the shared
memory `quick.json`**. Each agent owns one stage and reacts to repo state; the
artifact moving through the stages *is* the collaboration (stigmergic / choreographed):

```
                         ┌──────────────────── shared memory (dev-mesh/*/memory/quick.json) ───────────────────┐
                         │  every agent reads it as collective knowledge; Curator writes it                     │
                         └────────────────────────────────────────────────────────────────────────────────────┘
                                    ▲
   research ──▶ idea ──▶ intake (Analyst) ──▶ [HUMAN approves] ──▶ approved
   (Analyst)              discussing/spec:draft/spec:in-review
                                                                          │
                                                                          ▼
                          backlog (Coder) ── build branch + tests ──▶ Pull Request ──▶ review (Reviewer)
                                                                          │                  │ CHANGES_REQUESTED
                                  CI red ──▶ autofix / ci-sweep ──┐       │                  ▼
                                  conflicts ──▶ mergefix ─────────┤       │           review-respond (Coder)
                                                                  └──────▶ PR green ──▶ [HUMAN merges]
                                                                                            │
                                                                                            ▼
                                                              curate (Curator) ── distill lesson ──▶ memory:promote PR
                                                                                            │
                                                                          memory-automerge (auto) ──▶ persisted to quick.json
```

Humans appear at exactly two gates: **approve an `idea`** and **merge a code PR**.
`memory:promote` PRs are the single deliberate auto-merge (validated memory DATA only).

### Lifecycle labels (the hand-off protocol)

`idea` → `discussing` → `spec:draft` → `spec:in-review` → `approved` → `in-progress`
→ `pr:in-review` → (merge) → `done`.

`intake` manages the pre-approval stages (`discussing` → `spec:draft` → `spec:in-review`);
the human approval gate fires only after `spec:in-review`. Terminal labels: `blocked`
(needs a human unblock) and `rejected` (closed without implementation). Supporting
labels: `bug` and `memory:promote`. Labels + PR/issue state are how a stage signals
the next agent — changing a label is the hand-off.

The local A2A dev-society daemon also runs a `label-repair-sweep` before its
`issue-sweep`. It auto-normalizes machine-obvious label drift, such as a scheduled
security alert incorrectly stuck at `blocked`, while keeping arbitrary human-blocked
issues blocked until a human re-approves them.

## Safety properties

- **Human merge gate** on all code (no agent self-merges code); `memory:promote` is the
  one sanctioned exception (memory data only, validated by `validate-quick-memory.mjs`).
- **No `pull_request_target`**; same-repo guards keep secrets off fork PRs.
- **Honesty gate** (`scripts/assert-run-healthy.mjs`): a green job ≠ a healthy run — each
  agent run is judged on its result envelope, not the Actions conclusion.
- **Workflow self-edits** go through a `workflows`-scoped PAT (`DEV_MESH_PAT`) with a
  `CODEOWNERS` review gate — the mesh can *author* workflow changes but a human merges them.
