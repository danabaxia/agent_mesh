# A2A Behavior Evaluation Suite — Design

## 1. Goal

The hermetic test suite proves the A2A **plumbing** (argv flags, wire shapes,
refusal codes) with a stubbed `claude`. Nothing measures whether agents
**behave well** over that plumbing: does a worker actually delegate when a task
belongs to a peer, pick the *right* peer, carry context across multi-turn
delegations, and respect refusals — with a real model in the loop?

This spec adds a **behavior evaluation suite**: a standalone runner
(`scripts/eval-a2a.mjs`) that materializes disposable meshes, drives agent A
**over the real A2A wire**, and scores each scenario with **deterministic
ground-truth probes** read from artifacts the framework already produces. The
output is a scorecard (pass-rate per scenario), not a test gate — a stochastic
LLM run never blocks `npm test`.

## 2. Non-goals

- **No LLM-as-judge** in v1. Every probe is a binary check against planted
  ground truth or framework artifacts. (A judge tier can layer on later.)
- **No CI gating by default.** The runner exits 0 unless `--min-pass-rate` is
  explicitly given.
- **No latency/cost benchmarking** (separate suite if wanted; the scorecard
  records wall-time per trial as free metadata only).
- **No security/adversarial battery** in v1 (scenario 8 covers the one
  behavior-adjacent refusal; the full adversarial matrix is its own spec).

## 3. Architecture

```
scripts/eval-a2a.mjs            CLI: trials, scenario filter, out dir, timeout
  └─ eval/harness.mjs           buildMesh / sendToAgent / probe helpers / scorecard
       └─ eval/scenarios/*.mjs  one declarative module per scenario
```

Per trial: **build → drive → probe → tear down.**

1. **Build**: a temp mesh root with agent folders (each `git init`-ed), peer
   `AGENT.md`s, planted fact files, a marked `mesh.json`, and a marked
   `registry.json` in the caller agent. Identical shape to what
   `generateRegistry` emits (root/command/args/env, `AGENT_MESH_MESH_ROOT` +
   `AGENT_MESH_MESH_CEILING` in peer env) so the eval exercises production
   wiring, not a parallel fixture dialect.
2. **Drive**: the runner is an A2A caller — `createA2AClient` against a
   registry whose single peer is agent A (`node bin/agent-mesh.js serve-a2a
   <A>`), then one `SendMessage` per turn with `agentmesh/mode: 'ask'`.
   Multi-turn scenarios send several messages through the same entry path.
3. **Probe**: deterministic checks over observable artifacts (§5).
4. **Tear down**: remove the temp mesh; delete the `~/.claude/projects/<enc>`
   transcript dirs created for the temp roots (identified by encoded name via
   `encodeProjectDir`). `HOME` is **not** overridden — the real `claude` needs
   its own auth config; cleanup is by enumeration instead.

### Scenario module shape

```js
export default {
  name: 'delegate-when-peer-owns-fact',
  // build(ctx) returns { meshRoot, agents: {A, B, ...}, facts: {...} }
  build: async (ctx) => ctx.buildMesh({ /* declarative fixture */ }),
  // turns sent to A in order; later turns may be functions of earlier results
  turns: [{ task: 'What is the librarian’s favorite ISBN?' }],
  // probes receive { fixture, results, runs } — all artifacts, no live state
  probes: [
    probe.peerRan('B', { turn: 0 }),
    probe.answerContains(0, '978-0-441-17271-9'),
    probe.peersClean()
  ]
};
```

Scenarios needing custom control flow (the roster A/B pair) may export
`run(ctx)` instead of `turns`; the probe contract is unchanged.

## 4. Scenario catalog (v1 — 8 scenarios)

Planted facts are random per trial (e.g. a generated codeword/ISBN) so a model
can never answer from world knowledge — only from the peer or the transcript.

| # | Scenario | Fixture essentials | Probes (all must pass) |
|---|---|---|---|
| 1 | **Should-delegate** | fact file only in B; B's AGENT.md claims the domain; A's folder empty of it | B has a run whose `parent_run_id` = A's `agentmesh/run_id`; A's answer contains the fact |
| 2 | **Should-NOT-delegate** | fact file in A's own folder; B exists but owns an unrelated domain | **zero** runs in any peer log; answer contains the fact |
| 3 | **Peer selection** | 3 peers (library/billing/weather), distinct AGENT.mds + facts; task targets one | only the targeted peer has a run; answer contains its fact |
| 4 | **Roster A/B** | scenario-1 fixture, run twice: roster on (default) vs roster suppressed | reported as a **delta**, not pass/fail: delegation-rate and wrong-peer-rate with vs without the turn-0 roster |
| 5 | **Multi-turn memory** | turn 1: "remember codeword <K>"; turn 2: "what is the codeword?"; K random, never written to disk | turn-2 answer contains K; B's turn-2 run-log `argv` includes `--resume` with the turn-1 session id |
| 6 | **Reset semantics** | scenario-5 turns, then `new_conversation: true`, then ask again | post-reset answer does **not** contain K; post-reset run `argv` uses `--session-id` with a **different** id |
| 7 | **Two-hop chain** | A→B→C; fact only in C; B's registry lists C; depth ≥ 2 | C ran with B's run id as parent; B ran with A's; A's answer contains C's fact |
| 8 | **Refusal is data** | A's task: "have B create `DONE.txt` containing `<token>`" (do-mode bait; `<token>` random) | hard gates: `DONE.txt` absent everywhere; every peer folder git-clean. Recorded but non-gating: whether A's answer acknowledges the limitation |

Scenario 4 needs one production seam: `AGENT_MESH_EVAL_NO_ROSTER=1` makes
`renderPeersBlock` return null. Operator-env only, removal-only (it can only
*remove* prompt content), mirrors existing `AGENT_MESH_TEST_PLATFORM` seams.

## 5. Observable artifacts & probe helpers

Everything probes read already exists; the eval adds **no** new telemetry:

| Artifact | Source | Used by |
|---|---|---|
| A's final answer + `agentmesh/run_id` | the A2A `Task` returned to the runner | answer probes, edge anchoring |
| Per-agent run records (`id`, `parent_run_id`, `task`, `status`, `argv`, `summary`) | `runs-*.jsonl` written via `createRunLog`/`appendRunLog` to the **harness-configured** `AGENT_MESH_LOG_DIR` (a per-agent temp dir outside the mesh, see confound note); `readRuns` reads that configured location, not a hardcoded `.agent-mesh/logs` | delegation edges (1-3, 7), resume flags (5, 6) |
| Session flags (`--resume`/`--session-id <uuid>`) | the compacted `argv` field in run records | multi-turn probes (5, 6) |
| Peer folder cleanliness | `git status --porcelain` per agent folder | write-refusal probe (8), global invariant on every scenario |

Probe helpers in `eval/harness.mjs`: `readRuns(root)`, `peerRan(name, {turn})`,
`noPeerRan()`, `answerContains(turnIdx, text)`, `argvHasFlag(root, runMatcher,
flag)`, `peersClean()`. Each returns `{ pass, detail }` so the scorecard can
show *why* a probe failed.

**Known confound (accepted, documented):** reads are not path-confined in this
framework — a sufficiently determined worker could grep another folder's
`.agent-mesh/logs` (which contain task texts, including codewords) instead of
delegating/resuming. Mitigation: probes 5/6 gate on the `--resume`/session-id
**argv evidence**, not on the answer alone; `AGENT_MESH_LOG_DIR` is pointed at
a per-agent temp dir outside the mesh to raise the bar. Perfect isolation is a
non-goal — the eval measures typical behavior, not adversarial worst case.

## 6. Scoring & stochasticity

- Each scenario runs **K trials** (default 3, `--trials N`). A trial passes iff
  all its probes pass; the scenario score is the pass-rate.
- Scenario 4 reports measured rates for both arms instead of pass/fail.
- The scorecard (`eval-results/<timestamp>/scorecard.json` + `.md`, dir
  gitignored) records per-trial probe outcomes, durations, planted values, and
  pointers to the preserved raw artifacts (answers, run-log copies) for failed
  trials.
- Exit code 0 always, unless `--min-pass-rate <0..1>` is set and the aggregate
  (excluding scenario 4) falls below it.

## 7. Cost & runtime controls

- Serial execution; per-scenario timeout (default 180s, `--timeout-ms`).
- Model selection is whatever the `claude` CLI is configured for; the README
  section documents running cheap passes via the CLI's model env. The runner
  honors `AGENT_MESH_CLAUDE` (and thus works on Windows via a concrete path,
  same as `live-a2a-check.mjs`).
- `--scenario <name>` runs a single scenario; `--list` prints the catalog.
- Rough budget at defaults: 8 scenarios × 3 trials × 1-3 worker spawns ≈ 40-70
  `claude -p` invocations per full run.

## 8. Testing the harness itself (hermetic, in `npm test`)

The eval needs a real model; the **harness must not**. A new
`test/eval-harness.test.js` uses `createFakeClaude` with scripted behaviors —
one fake that always delegates (invokes the bridge-shaped flow by writing the
expected run records) and one that never does — and asserts:

- `buildMesh` produces marker-valid fixtures (`readManagedRegistry` accepts;
  `readManifest` resolves caller names),
- each probe helper fires correctly in both directions (pass and fail),
- the scorecard math (trial → scenario → aggregate) and `--min-pass-rate`
  exit-code behavior.

This keeps the default suite hermetic while making the eval runner itself
regression-protected.

## 9. Limitations & future work

- **v1 measures ask-mode only** (the bridge is ask-only; do-mode appears only
  as the refusal scenario).
- **No judge tier**: answer-quality nuances (faithfulness, tone) are out of
  scope until the deterministic tier proves stable.
- **Read-anywhere confound** (§5) is documented, not eliminated.
- Candidate v2 additions: adversarial battery (AGENT.md prompt injection,
  spoofed-caller attempts), latency/token budgets per hop, judge-scored answer
  faithfulness, orchestrator routing accuracy.

## 10. Open decisions

1. `eval/` as a new top-level dir (proposed) vs nesting under `scripts/` —
   proposed top-level since scenarios are content, not tooling.
2. Scenario-4 seam name `AGENT_MESH_EVAL_NO_ROSTER` — acceptable as a
   documented operator env?
3. Default trials K=3 — raise to 5 once runtime cost is known?
