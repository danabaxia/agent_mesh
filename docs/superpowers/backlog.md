# Agent-Mesh Work Backlog

Single source of truth for specced-but-unbuilt work. The **loop** (see
[How the loop consumes this](#how-the-loop-consumes-this)) reads this file,
picks the top item whose `status` is **`approved`**, implements it one at a
time, and opens a PR. **The loop only ever builds `approved` items** — a written
spec is not enough; it requires explicit user sign-off first.

> The eval/test items below (cost-capture, do-mode evals, adversarial battery,
> performance benchmark) are framed by the unified
> **[Evaluation Methodology](specs/2026-06-13-evaluation-methodology-design.md)**
> (layers L0–L4): the hermetic gate, real-`claude` e2e, behavior eval,
> adversarial battery, and performance benchmark as one system.

## Inbox — raw thoughts (unrefined)

Drop one-liners here the instant they occur; no refinement required. Promote to
the table below (as `idea`) when we brainstorm it into a spec.

- _(empty — add thoughts as `- <thought>` bullets)_

## Status legend

The lifecycle: `idea → spec-draft → approved → in-progress → done`.

| status | meaning | loop-eligible? |
|---|---|---|
| `idea` | identified, no spec yet — needs brainstorm → spec | no |
| `spec-draft` | a design spec is written (optionally codex-reviewed), **awaiting user approval** | no |
| `approved` | user has signed off on the spec — ready for the loop to build | **yes** |
| `in-progress` | actively being built (loop sets this on its feature branch) | — |
| `done` | implemented, PR opened/merged | no |
| `blocked` | needs a decision or an upstream item first | no |

**Approval is an explicit, recorded step.** A spec moves `spec-draft → approved`
only when the user says so (typically after `/codex-spec-review`). Nothing the
user has not approved can be picked up — the gate is the `approved` status, not
the mere existence of a spec file.

## Priority order (top = next)

| # | Item | status | spec | source |
|---|---|---|---|---|
| 1 | **Token/cost capture in delegate** — switch worker to `--output-format json`, parse usage/cost into the run record (unblocks #4) | `done` | [2026-06-13-delegate-cost-capture-design.md](specs/2026-06-13-delegate-cost-capture-design.md) | perf-bench §9 |
| 2 | **do-mode behavior evals** — write-path delegation correctness + confinement; adds the harness mode seams #3 reuses | `done` | [2026-06-13-do-mode-behavior-evals-design.md](specs/2026-06-13-do-mode-behavior-evals-design.md) | [a2a-behavior-evals §9](specs/2026-06-10-a2a-behavior-evals-design.md) |
| 3 | **Adversarial eval battery** — AGENT.md prompt-injection + spoofed-caller + invariant matrix (builds on #2's seams) | `done` | [2026-06-13-adversarial-eval-battery-design.md](specs/2026-06-13-adversarial-eval-battery-design.md) | [a2a-behavior-evals §9](specs/2026-06-10-a2a-behavior-evals-design.md) |
| 4 | **Mesh performance benchmark** — routing/efficiency/quality composite PerfCard (depends on #1) | `done` | [2026-06-13-mesh-perf-benchmark-design.md](specs/2026-06-13-mesh-perf-benchmark-design.md) | new |
| 5 | **Post-merge integration test pipeline** — nightly `integration.yml` on `v0.4-development` running the real-`claude` integration tier (L1 e2e + L2 eval, L3/L4 as they land); needs an `ANTHROPIC_API_KEY` Actions secret | `done` | [2026-06-13-integration-test-pipeline-design.md](specs/2026-06-13-integration-test-pipeline-design.md) | new |
| 6 | **HTTP(S) peer transport** — standing-server inheritance + threat boundary | `idea` | — | [mesh-onboarding §12](specs/2026-06-06-mesh-onboarding-tool-design.md) |
| 7 | **Browser control-plane config editing** — edit mesh/agent config from the dashboard | `idea` | — | [mesh-dashboard §10](specs/2026-06-06-mesh-dashboard-design.md) |
| 8 | **Dashboard auth / remote access** — currently localhost-only, no auth | `idea` | — | [mesh-dashboard §10](specs/2026-06-06-mesh-dashboard-design.md) |
| 9 | **Multi-writer session lease coordination** — cross-terminal/-machine canonical-session joins | `idea` | — | [session-log §10](specs/2026-06-07-session-log-and-management-design.md) |
| 10 | **Prompt-cache reuse across delegations** — settings-inheritance Phase 2 | `idea` | — | [settings-inheritance §7](specs/2026-06-06-settings-inheritance-design.md) |
| 11 | **Claude Agent SDK port** — replace `claude -p` spawn with the SDK | `idea` | — | [settings-inheritance §7](specs/2026-06-06-settings-inheritance-design.md) |
| 12 | **Latency SLO gates / per-hop token budgets** — turn perf metrics into optional gates | `idea` | — | [perf-bench §12](specs/2026-06-13-mesh-perf-benchmark-design.md) |
| 13 | **Single-agent session management** — identity layer + task-sessions, L0/L1/L2 tiered context, pull-on-demand recall, per-agent session manifest, manual review-gated absorption→workflow/quick-memory + retire | `in-progress` | [2026-06-13-single-agent-session-management-design.md](specs/2026-06-13-single-agent-session-management-design.md) | new (user pain: 单一入口频繁压缩) |

## How the loop consumes this

**Mode:** implement-only — the loop builds **`approved`** items only; it does
**not** write specs and does **not** build `spec-draft` (unapproved) items.
**Branching:** branch-per-item + PR, based off `v0.4-development`. **One item per
iteration.**

**Full-automation contract (2026-06-14):** the loop runs **fully autonomously** —
build → hermetic tests → adversarial review (to CONVERGED) → open PR → drive CI
green — **without pausing to ask or report between steps.** The human is needed
**ONLY for spec discussion** (brainstorm a thought → write/refine a spec →
`approved`) and for the final PR merge click. The loop does **not** ping the human
for status, sequencing, or "should I continue" — it just produces PRs. A **large
item may span multiple loop ticks/sessions**: it commits WIP modules to its
`feat/<slug>` branch as it goes, and a later tick **resumes that branch from the
committed WIP** (reads the `in-progress` row, continues — never restarts). Nothing
is lost between ticks because every module is committed + tested as it lands.

**Resolved policy (2026-06-13):**
- **Cadence — continuous until empty.** No timer: build approved items
  back-to-back, one PR each, until the queue is empty *or every remaining item
  is dependency-blocked* (see below), then stop and report.
- **Dependencies — wait for merge.** An item whose dependency PR is not yet
  merged into `v0.4-development` is skipped (treated `blocked`); the loop takes
  the next *independent* approved item. It does **not** stack branches. When all
  remaining approved items are blocked on unmerged deps, the loop stops and
  reports which merges it's waiting on.
- **Red tests — revert & report.** If `npm test` won't go green after a genuine
  attempt, revert the row to `approved`, abandon the branch, report what failed,
  and move on (do not open a half-built PR, do not retry endlessly).
- **Green CI before approval — MUST HAVE.** A PR is **not** ready for the user's
  review/approval until its CI pipeline is green. After opening the PR the loop
  **subscribes to its activity and auto-fixes pipeline failures** until all
  required checks pass (auto-fix protocol below). The loop never presents a red
  PR as ready, and never asks the user to merge a PR with failing checks.
- **Adversarial review before PR — MUST HAVE.** *Green CI is necessary but not
  sufficient.* **Every PR must pass an independent adversarial review** (the
  "auto-research"/second-model gate) before it is presented for the user's
  approval — and every **spec** must pass one before it is `approved`. The review
  reads the change against `CLAUDE.md`'s security invariants and the actual code,
  and must reach **CONVERGED** (no unresolved BLOCKER/MAJOR) — see the adversarial
  review protocol below. A PR with an open blocker/major is never "ready," no
  matter how green CI is.

Each iteration:

1. Read this file; select the **top `approved` row whose dependencies are
   merged**. If none, stop (do not build `spec-draft`/`idea`; do not stack on
   unmerged deps).
2. From up-to-date `v0.4-development`, cut `feat/<slug>` for the item.
3. Flip the row to `in-progress` and commit the status change **on the branch**.
4. Implement the spec **fully** (code + hermetic tests), per the spec's
   §"Testing the harness" and the `CLAUDE.md` invariants.
5. Run `npm test` locally. **Green** → commit + `git push -u origin feat/<slug>`.
   **Red** (after a real attempt) → revert row to `approved`, report, continue.
6. **Adversarial review the diff (MUST HAVE)** — run the review protocol below on
   the change; **fix every BLOCKER/MAJOR on-branch and re-review until CONVERGED**
   (MINOR may be deferred with a noted follow-up). Only then flip the row to
   `done` and open a **PR targeting `v0.4-development`**.
7. **Subscribe to the PR's activity and drive CI to green (MUST HAVE).** Do not
   present the PR for approval until every required check passes — auto-fix
   protocol below.
8. Never merge a PR automatically (review/CI is the human's). A PR is user-ready
   only when **CONVERGED review + green CI** both hold. Only then start the next
   item; never start a second item before the current PR is ready.

**Adversarial review protocol (step 6 — the mandatory second-model gate).** Runs
on both specs (before `approved`) and implementation diffs (before PR):
- **Reviewer:** prefer the `codex-spec-review` skill (Codex CLI, when available);
  otherwise spawn an **independent reviewer agent** (the Agent tool) — never let
  the author (this loop) be the sole reviewer.
- **Mandate:** read the change against `CLAUDE.md`'s "Invariants — do not break
  these" **and the actual implementation it touches** (not the spec's claims).
  Critique security-invariant compatibility, internal consistency, feasibility
  under the constraints (zero-dep, the CLI session model, the first-turn MCP race,
  the review-first boundary), and gaps. Each finding gets a severity
  **BLOCKER / MAJOR / MINOR** + a concrete fix.
- **Convergence:** the author fixes all BLOCKER/MAJOR, then **re-reviews**; repeat
  until the reviewer returns **CONVERGED** (no blockers/majors). Record a short
  **review log** in the spec/PR (rounds + what each fixed). MINOR findings may ship
  with a noted follow-up.
- **Escalate, don't fudge:** if a blocker's fix would change a security invariant
  or needs a product call, stop and ask the user via `AskUserQuestion` — do not
  resolve it unilaterally to force CONVERGED.

**CI auto-fix protocol (step 6).** On each pipeline failure, investigate before
acting — never blindly retry:
- **Real failure caused by the change** (the diff broke a test / lint / build):
  fix it on the same branch, push, re-watch. This is mandatory, not optional.
- **Flake / infra unrelated to the change** (e.g. the known Windows
  `process.test.js` tree-kill timing flake; a passing parallel run on the same
  commit; an environment/signing error): re-trigger the job — prefer
  `rerun_failed_jobs`, else push an empty `ci:` re-trigger commit — and re-watch.
  If the *same* unrelated flake recurs ~2–3×, stop and report it as a
  pre-existing flake (and, if asked, file a hardening backlog item) rather than
  spinning.
- **Ambiguous or architecturally significant** (the fix would change a security
  invariant, touch a large surface, or the failure's cause is unclear): stop and
  ask the user via `AskUserQuestion` before pushing.
- Webhooks do not deliver CI **success**, new pushes, or merge-conflict
  transitions — so poll/re-check (timer or re-fetch) until the pipeline reaches a
  terminal state; do not assume green from silence.

Definition of done per item: spec satisfied, hermetic tests added and passing
(`npm test` green), `CLAUDE.md` updated if an invariant/architecture note
changed, **adversarial review CONVERGED (no open BLOCKER/MAJOR), review log
recorded**, pushed on `feat/<slug>`, PR opened against `v0.4-development`,
**CI pipeline green (failures auto-fixed)**, backlog row flipped to `done` in the
same PR. A red PR — or one with an open blocker/major — is never "done."

**Dependency map (current queue):** #1 cost-capture and #2 do-mode evals are
independent (buildable now); #3 adversarial battery needs #2's harness seams; #4
perf-bench needs #1's cost capture. So a continuous run builds #1 and #2, then
waits for their merges before #3/#4 become unblocked.

## Notes

- `done` items stay in the table (struck through) for provenance — the loop
  selects by status, not by deletion.
- Capturing a thought: add a bullet to the **Inbox** (no refinement needed), or
  append a table row with `status: idea` + a `Source` link. Promote
  `idea → spec-draft` by writing the spec; `spec-draft → approved` only on the
  user's explicit sign-off. Re-rank the priority column if it should jump queue.
- This backlog is repo-local on purpose — the loop reads it without external
  state. (The Obsidian vault tracks session-level progress separately, per
  `CLAUDE.md`.)
