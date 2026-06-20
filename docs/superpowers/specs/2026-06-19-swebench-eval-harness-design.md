# SWE-bench L5 Eval Harness — Design

**Status**: approved  
**Issue**: #98  
**Spec date**: 2026-06-19

## 1. Goal

agent_mesh has the most sophisticated *internal* eval system in its class
(L0 hermetic, L1 e2e, L2 behavior, L3 adversarial, L4 performance), but no
**externally comparable score**. Every major OSS agent framework now publishes
a SWE-bench number:

| Framework | Score (mid-2026) |
|---|---|
| OpenHands | ~72% SWE-bench Verified |
| SWE-agent | ~65% SWE-bench Verified |

agent_mesh's distinctive claim is that **multi-peer coordination produces
better outcomes than single-agent work**. SWE-bench Verified is the canonical
task format that tests this claim against a shared, reproducible baseline.

This spec adds an **L5 eval tier**: a `scripts/eval-swebench.mjs` harness
(same pattern as `eval-a2a.mjs` / `eval-perf.mjs`) that routes SWE-bench
Verified tasks through a mesh, measures output quality, and emits a
**pass-rate scorecard** comparable to published baselines.

## 2. Non-goals

- **Not a CI gate.** Exit code 0 always, unless `--min-pass-rate` is
  explicitly passed. A stochastic LLM run never blocks `npm test`.
- **Not a replacement for L2–L4.** L5 answers "do we match published
  benchmarks on real-world tasks?"; correctness, safety, and internal
  perf are L2/L3/L4.
- **No new in-repo runtime dependency.** The eval *script* has no Docker
  dependency in Phase 1. Phase 2 shells out to an external `swebench` CLI
  — Docker is a CI runner configuration, not a package dependency.
- **No new framework surface.** L5 is entirely additive: new `scripts/`,
  new `eval/swebench/`. Nothing in `src/` changes.
- **Do-mode tasks are Phase 2.** Phase 1 covers ask-mode read/reasoning
  tasks (feasible today). Do-mode architect/editor tasks require issue #97
  (do-mode peer delegation) to land first.

## 3. Architecture

```
scripts/eval-swebench.mjs          CLI: --suite, --trials, --topology, --out, --min-pass-rate
  └─ eval/swebench/harness.mjs     task loader, mesh setup, drive, score, teardown
       ├─ eval/swebench/tasks/     task descriptor JSON files (gitignored data)
       ├─ eval/swebench/scorer.mjs  score one task result (Phase 1: text match; Phase 2: swebench-cli)
       ├─ eval/swebench/topologies.mjs  topology factory (single_worker, ask_chain, architect_editor)
       └─ eval/swebench/report.mjs  scorecard aggregation + rendering
```

Reuses `eval/harness.mjs` (`buildMesh`, `driveAgent`, `cleanupMesh`) —
the same substrate as L2–L4.

## 4. Task corpus — hybrid model (Q2 resolution)

### 4a. Curated mesh-bench (20–50 tasks) — default, nightly-safe

A hand-curated subset of SWE-bench Verified tasks selected for multi-peer
coordination value (issues requiring reading one module + writing another).
Stored as `eval/swebench/tasks/mesh-bench.json` (task descriptors;
gitignored for the full data file).

Tasks labelled `ask_only` (Phase 1) or `do_required` (Phase 2; skipped
until #97 lands).

### 4b. Full SWE-bench Verified — manual/quarterly

500 tasks via `--suite full`. Triggers the swebench CLI dependency check
and requires Docker. Exit 0 if the CLI is absent.

**Q1 decision: dependency model** — CI-only Docker runner, same
skip-guard pattern as L3/L4. Missing `swebench` on PATH → exit 0 with
a warning. In-repo zero-deps ethos preserved.

## 5. Topologies (Q3 resolution)

**Phase 1 (ask-mode only):**

- `single_worker`: one agent receives the task in ask mode. The control arm.
- `ask_chain`: a coordinator agent asks a specialist peer for analysis. The
  treatment arm for Phase 1.

**Phase 2 (gated on #97 — do-mode peer delegation):**

- `architect_editor`: architect (ask) reads the codebase, editor (do) writes
  the patch. The mesh's headline multi-peer comparison.

Topology names use `_` not `/` to avoid filesystem path concerns.

## 6. Scoring

### Phase 1 (text match, no Docker)

For each `ask_only` task:
1. Send the issue text to the mesh in ask mode.
2. Score: does the agent's text answer mention the `expected_keywords` from
   the task descriptor? Pass if ≥ `min_keyword_hits` (default: 1).
3. Records the pass/fail and the agent's answer.

This gives a deterministic, Docker-free score for Phase 1. It does NOT
measure patch correctness — it measures whether the agent reasons correctly
about the issue. Task selection must focus on issues with clear, specific
answers (correct file paths, function names, root-cause identification).

### Phase 2 (swebench-cli, Docker)

For each `do_required` task:
1. Check `swebench` on PATH; skip if absent.
2. Set up an isolated git worktree at the task's pinned commit.
3. Send the issue to the mesh in do mode; agent produces the patch.
4. Shell out to `swebench-cli evaluate --repo <path>` to run the task's
   test suite.
5. Parse the exit code / output for pass/fail.

## 7. Scorecard

Scorecard format matches `eval/scorecard.mjs` (passRate, per-topology table).
Cost-normalized: cost_per_pass = total_cost_usd / passes (from run-record
`usage` field, same as L4).

Output files:
```
<out-dir>/swebench-scorecard.json
<out-dir>/swebench-scorecard.md
```

## 8. CLI flags

```
node scripts/eval-swebench.mjs
  [--list]                       list available task suites
  [--suite mesh-bench|full]      default: mesh-bench
  [--topology single_worker|ask_chain|architect_editor]  default: single_worker
  [--trials N]                   default: 1 (SWE-bench convention for comparability)
  [--timeout-ms N]               default: 600000 (10 min; tasks are harder than evals)
  [--out DIR]                    default: eval-swebench-results
  [--min-pass-rate 0..1]         gate (exit 1 if below); default: none (exit 0)
  [--help]
```

## 9. Hermetic test plan

`test/swebench-harness.test.js` (no Docker, no real claude):

- Task loader: load valid JSON, empty list, malformed JSON.
- Scorer (Phase 1): text match pass/fail, keyword threshold, empty answer.
- Topology factory: single_worker builds correct mesh shape; architect_editor
  throws a "Phase 2 / issue #97" error.
- Scorecard: aggregate pass-rate, cost-per-pass, markdown render.
- CLI arg parser: all flags, unknown flag → exit 2.
- Skip-guard: absent swebench binary → graceful exit 0 for full suite.

## 10. Invariants

All four CLAUDE.md invariants upheld (no src/ changes; additive only):

- **Single writable root**: not relevant (Phase 1 ask-mode only; Phase 2
  uses isolated worktrees per task, never touching live checkout).
- **Anti-spoof**: eval harness sends `mode: ask` in A2A metadata, not via
  tool args.
- **No Bash in do**: Phase 1 is ask-only. Phase 2 do-mode is not implemented.
- **AGENT.md as data**: the harness agents use minimal `agentMd` for eval
  fixture purposes only.
- **Failure is data**: any task that times out or errors is recorded as a
  failed trial with an `error` field, never crashes the run.

## 11. Sequencing and dependencies

- **Phase 1** (this spec, ask-mode): independent of #97. Shippable now.
- **Phase 2** (do-mode): gated on #97 merging. Phase 2 topologies skip.
- Recommended merge order: **#97 → #98** for the most compelling headline
  score (architect/editor vs. single-worker comparison). Phase 1 is
  independently shippable if #97 is delayed.

## 12. Open decisions for the implementer

1. **Task storage**: pre-fetch script vs. fetch at eval time. Placeholder
   empty `mesh-bench.json` ships; a `scripts/fetch-swebench-tasks.mjs`
   can be added separately.
2. **Mesh-bench curation**: 20–50 tasks selected by the criterion "issue
   requires reading one module + writing another". Requires a human selection
   pass before Phase 1 produces meaningful scores. The harness ships with
   a placeholder task list.
3. **Phase 2 topology name**: `architect_editor` (used here, matches Aider's
   framing).
4. **K for full-suite runs**: K=1 (SWE-bench comparability convention).
5. **Score persistence**: gitignored results dir (same as L2–L4).
