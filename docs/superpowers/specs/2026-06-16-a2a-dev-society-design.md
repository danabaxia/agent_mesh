# A2A Dev-Society — dogfood + validate the mesh by developing it *with* the mesh

Status: draft / design
Date: 2026-06-16
Related: `2026-06-14-self-hosting-dev-mesh-design.md` (the GitHub-Actions Dev-mesh this augments),
`2026-06-13-mesh-perf-benchmark-design.md`, `2026-06-10-a2a-behavior-evals-design.md`,
`2026-06-06-onward-delegation-design.md`, `dev-mesh/README.md`.

## 1. Why (the original intent, and the drift)

The intent was an agent network that **behaves like the mesh** — the dev roles run on the
**A2A runtime itself** (`serve-a2a`, `registry.json`, `delegate_to_peer`). One configuration then
does double duty: **develop** the repo *using* the product (true dogfood), and the **same live
workload validates** the mesh's features / behavior / performance.

What shipped (the GitHub-Actions Dev-mesh) borrows the *vocabulary* — 7 roles, `AGENT.md`,
`quick.json` memory, a lifecycle — but the **engine is GitHub Actions**, not A2A. It never calls
`delegate_to_peer`, spawns no `serve-a2a` peers, exercises none of the safety mechanics
(path-guard, recursion guard, ask/do modes, peer bridge). It **develops** the repo but does **not
use** the mesh and **validates nothing** about the A2A product. On the two defining goals, drift is
near-total.

This spec adds the missing half **without throwing away the GitHub layer** (operator choice:
*augment, run both*).

## 2. Goals / non-goals

**Goals**
- Run the dev roles as a **real A2A mesh** on a **persistent host**, so real delegation
  (Maintainer→Coder→Reviewer) authors actual repo changes.
- Reuse the **same run** as a validation workload: emit run records + `agentmesh/metrics` that
  the perf/behavior eval cards consume — over *real* tasks, not just synthetic fixtures.
- **Coexist** with the GitHub-Actions Dev-mesh (it remains the ops/gate layer).

**Non-goals**
- Replacing the GitHub-Actions society (explicitly *augment*, not replace).
- Making the A2A workers perform Git/GitHub/test execution (they structurally can't — see §5).
- Auto-merging code (the human merge gate and all PROJECT.md invariants stand).

## 3. Architecture — outer shell + inner mesh

Mirrors the product's own pure-core / impure-shell split.

```
 PERSISTENT HOST
 ┌─ society daemon (OUTER SHELL — impure: git/gh/test + WRITE orchestration) ───────┐
 │  1. poll GitHub for approved+unclaimed issues labeled route:a2a                  │
 │  2. prepare an isolated git worktree (= the Coder agent's single writable root)  │
 │  3. A2A SendMessage(task, mode=do) ───▶  Coder  (serve-a2a)  [top-level do]      │
 │                                            edits the worktree, path-guarded       │
 │  4. ◀── A2A Task (files_changed, metrics)                                        │
 │  5. run the suite on the worktree (Tester = shell step) ; if green:              │
 │  6. A2A SendMessage(diff, mode=ask) ──▶  Reviewer (serve-a2a)  [ask; may also be │
 │                                            reached agent→agent via the bridge]    │
 │  7. ◀── A2A Task (review findings)                                               │
 │  8. commit → push branch → open PR (Closes #N) → label pr:in-review              │
 │  9. append metrics to the perf ledger ─────▶ eval-perf / eval-a2a scorecards     │
 └─────────────────────────────────────────────────────────────────────────────────┘
                                    │ PR
                                    ▼
   GitHub-Actions Dev-mesh (UNCHANGED): review · CI · human merge · curate → memory
```

> **Why the driver — not a Maintainer agent — orchestrates writes.** Validated in P0
> (§10): the peer bridge's onward delegation is **ask-only in v1** (`ONWARD_MODE='ask'`;
> `delegate_to_peer` refuses any `do` with `mode_disabled` *before spawning*). So an
> autonomous Maintainer agent **cannot** delegate write-work to a Coder peer. Write tasks
> must be issued **top-level** by the outer driver (mode=do, directly to the Coder agent).
> Reads/reviews (mode=ask) *can* flow agent→agent via the bridge. A truly
> agent-orchestrated write society would require deliberately lifting the ask-only gate —
> a separate product + security decision, out of scope here.

The **inner mesh is the product under test**; the **outer daemon** does only what the confined
workers cannot (and must not): Git, GitHub, test execution, **and write-orchestration**.

## 4. Role → A2A mapping

Roles materialize as A2A agent folders under one mesh root via the existing onboarding
(`init-mesh` → `add --modes …` → `doctor`); the eval-trio fixture (`scripts/eval-trio-setup.mjs`)
is the working template.

| Role | A2A agent? | Mode | How it participates |
|---|---|---|---|
| **Maintainer** | **the outer driver** | — | The *orchestration* role. In v1 the driver issues the **top-level `do`** to Coder (onward `do` is bridge-blocked — §3) and routes the `ask` review. A Maintainer *agent* could still do `ask` fan-out, but it cannot delegate writes |
| **Coder** | yes | do | Receives a **top-level `do`** task from the driver; edits the worktree (Edit/Write/MultiEdit, path-guarded) |
| **Reviewer** | yes | ask | Reads the diff (as data) + invariants; returns findings (no writes). Reachable from the driver *or* agent→agent via the bridge |
| **Curator** | yes (later) | do | Distills a lesson into its own memory root (path-guarded), as a top-level `do` |
| **Tester** | **no — shell step** | — | Suite execution needs Bash, forbidden in `do` (§5). The daemon runs it and feeds results back as a message |
| **Triager / Analyst** | n/a here | — | Stay in the GitHub layer (CI triage, issue intake) — the augment seam |

The genuinely A2A-delegated, validated path is **driver→Coder (`do`)** + **driver/Maintainer→Reviewer
(`ask`)**. Orchestration of *writes*, execution, and I/O are the outer shell. The spec is deliberately
honest that **not all 7 roles are A2A agents, and write-orchestration is not an agent** — that's a
property of the v1 security model (ask-only bridge), not a shortcut.

## 5. Hard constraints (do not pretend around these)

1. **`do` mode has no `Bash`** (`WRITE_TOOLS` = Edit/Write/MultiEdit/NotebookEdit only). Therefore
   A2A workers **cannot** run `git`, `gh`, `npm`, or `node --test`. All of that lives in the outer
   daemon. This is why "Tester" and "GitHub I/O" are shell steps, and it is a *feature* (the same
   reason the product never lets a worker shell out).
2. **Single writable root / path-guard**: the Coder's writable root is the prepared worktree; the
   path-guard hook confines every write to it — exactly the product invariant, now exercised on the
   real repo.
3. **Recursion guard + onward delegation**: Maintainer→Coder→(peer) runs through the real peer
   bridge (`agentmesh_peerbridge`) and `AGENT_MESH_PATH`/`DEPTH` threading — so cycles/depth are
   enforced for real.
4. **Claim de-confliction (the augment tension):** the GitHub-Actions `backlog` worker *also* builds
   `approved` issues. To avoid both building the same issue, route by label: the daemon only takes
   **`route:a2a`** issues; `backlog` ignores `route:a2a` (add `&& !contains(labels,'route:a2a')` to
   its gate). Default route stays GitHub; `route:a2a` opts an issue into the dogfood path.
5. **All PROJECT.md invariants hold** — anti-spoof surface, human merge gate, no
   `pull_request_target`, honesty gate on the daemon's own runs.

## 6. Validation output (the second half of the intent)

Each delegation already emits a run record (cost/tokens/turns/`api_ms`) + the Task
`agentmesh/metrics` block. The daemon appends these to a **society ledger** keyed by issue/PR.
`eval-perf.mjs` and `eval-a2a.mjs` gain a mode that reads the ledger and produces a **PerfCard /
behavior scorecard over real dev tasks** — routing accuracy (from real delegation edges),
efficiency (tokens/$, latency), and judge-scored answer quality. This is what turns "we developed an
issue" into "we measured the mesh doing it."

## 7. Host / daemon requirements

- Always-on host (small VM/container): Node ≥ 20, `claude` CLI authed with OAuth/subscription auth,
  a repo clone, and a `workflow`-less GitHub PAT (reuse the `DEV_MESH_PAT` pattern; the daemon does
  the pushes/PRs).
- Runs the existing **dashboard** (`agent-mesh dashboard <mesh-root> --allow-shell`) for live
  observability of the society — sessions, delegation timeline, metrics.
- Secrets live on the host (not in the repo). Daemon is restartable + idempotent (claim via label so
  a restart can't double-build).

## 8. Phasing

- **P0 — inner loop (local/on-demand):** a `serve-society` driver that takes one `approved` issue →
  runs Maintainer→Coder→Reviewer over A2A in a worktree → emits a branch + metrics. Reuses
  eval-trio setup. *Acceptance: a PR whose authorship is provable as real `delegate_to_peer` edges
  in the run records.*
- **P1 — persistent daemon:** wrap P0 as the always-on poller (GitHub in/out + `route:a2a` routing +
  honesty gate). *Acceptance: an `approved` `route:a2a` issue becomes a PR with no human in the
  middle; no collision with `backlog`.*
- **P2 — validation ledger:** wire metrics → `eval-perf`/`eval-a2a` live scorecards over real tasks.
  *Acceptance: a PerfCard generated from real dev runs.*
- **P3 — observability:** dashboard on the host; optionally a `route:a2a` auto-label policy.

## 9. Open questions

- Routing default: should certain issue *types* auto-route to A2A (e.g. anything labeled `bug`), or
  is `route:a2a` always manual at first?
- Worktree vs full clone per task (isolation vs cost).
- Does the Curator distillation run in the A2A society (its own memory root) or stay in the GitHub
  `curate` workflow? (Either; P0 keeps it in GitHub.)
- Test execution: pure shell step vs a dedicated non-mesh "tester" service the Coder can *ask*
  (still outside `do`).

## 10. P0 validation (2026-06-16, run live in the Claude Code sandbox)

A minimal P0 was materialized with the framework's own commands (`init-mesh` → `add
maintainer/coder/reviewer` → peer → `doctor --apply`) and driven over the **real A2A wire**
(`createA2AClient().send()` → `serve-a2a` → real `claude -p` workers). Results:

- **do-delegation works (driver → Coder, top-level):** a `do` `SendMessage` produced a real
  `Task` — `TASK_STATE_COMPLETED`, `files_changed:["strings.js"]`, run_id, and a `metrics`
  block (`worker_run_ms≈20s`, `isolation_violations:0`). The Coder authored correct code; the
  write was **confined to `coder/`** (the `maintainer/` root was untouched — path-guard held).
- **ask-delegation works (driver → Reviewer):** an `ask` `SendMessage` returned a real review
  that **caught a genuine bug** in the Coder's diff (`truncateSlug("foo-bar-baz",7)` → "foo"
  instead of "foo-bar" because the trailing-segment regex was unconditional). The Reviewer
  authored **no files** — the only thing appearing in `reviewer/` was the framework's own
  `.agent-mesh/` audit log (expected residue, like the CLI's `.claude/`).
- **The decisive finding:** onward `do` delegation is **refused** (`ONWARD_MODE='ask'`), which
  is why write-orchestration is driver-side (see §3 callout + §5). This was *confirmed in code
  and by running it*, not assumed.

**Conclusion:** the inner loop (real A2A do + ask delegation, confinement, metrics, review
catching a real defect) is proven. P0 ran entirely locally (GitHub egress is blocked in the
sandbox), exactly matching the design's "develop *through* the mesh + emit validation metrics"
intent. Remaining build is the outer daemon (P1) + the metrics→eval ledger (P2).
