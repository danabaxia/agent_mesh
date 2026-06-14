# Mesh Agent Performance Benchmark — Design

## 1. Goal

The behavior eval (`scripts/eval-a2a.mjs`, spec
[2026-06-10-a2a-behavior-evals-design.md](2026-06-10-a2a-behavior-evals-design.md))
answers *"does the mesh behave **correctly**?"* with binary ground-truth
probes. Nothing measures *"how **well** does the mesh perform?"* — does a
worker pick the right peer when many peers have **overlapping** domains, what
does a delegation **cost** in latency / tokens / dollars, and is the final
answer **faithful** beyond just containing a planted token?

This spec adds a **performance benchmark**: a REAL-`claude` scorecard (like the
behavior eval, **not** a CI gate) that drives agent A over the live A2A wire and
reports three **coupled** axes per scenario —

- **Routing accuracy at scale** — precision / recall of peer selection, wasted-hop count,
- **Efficiency / cost** — latency, tokens, dollars, framework overhead tax,
- **Answer quality** — judge-scored faithfulness against planted ground truth.

The output is a single **composite, efficiency-normalized "PerfCard"**, designed
so the over-delegation gaming strategy (broadcast to every peer → perfect answer,
catastrophic cost) cannot score well.

This benchmark reuses the behavior eval's `build → drive → measure → tear down`
harness; the new work is a **meter** layer (numeric metrics, not pass/fail), a
**scale fixture generator**, a **judge tier**, and one small production change to
capture token/cost telemetry.

## 2. Non-goals

- **Not a CI gate.** Exit code 0 always, unless a `--min-*` threshold is
  explicitly passed (mirrors the behavior eval). A stochastic LLM run never
  blocks `npm test`.
- **Not a security/adversarial battery.** Prompt-injection, spoofed-caller, and
  AGENT.md-as-instructions live in their own spec. The read-anywhere confound
  (behavior-eval spec §5) is inherited, not solved — routing is scored from
  delegation **edges**, not answer text, which sidesteps it.
- **Not a replacement for the behavior eval.** Correctness gates stay there;
  this measures degrees, not pass/fail. The two run independently.
- **Not do-mode.** The bridge is ask-only in v1; all scenarios are ask-mode.
- **No new model-facing surface.** The anti-spoof invariant holds — no
  `path`/`depth`/cost field is ever read from tool args.

## 3. Architecture

```
scripts/eval-perf.mjs            CLI: trials, scenario/cell filter, out dir, budget caps
  └─ eval/perf/harness.mjs       buildRoutingMesh / drive-with-metrics / meters / judge
       ├─ eval/perf/meters.mjs   numeric metric extractors (routing / efficiency / quality)
       ├─ eval/perf/judge.mjs    independent low-temp judge spawn + rubric
       ├─ eval/perf/perfcard.mjs composite-card scoring + render
       └─ eval/perf/scenarios/*.mjs   declarative scenarios (one task set + labels)
```

It rides the existing `eval/harness.mjs` (`buildMesh`, `driveAgent`, `readRuns`,
`gitClean`, `cleanupMesh`) — `buildRoutingMesh` is a thin generator over
`buildMesh`, and the driver is the same `createA2AClient` path.

Per trial: **build → drive → meter → judge → tear down.**

1. **Build** — `buildRoutingMesh` materializes a mesh of N peers with
   domain-shaped `AGENT.md`s and planted facts, marked `mesh.json` + caller
   `registry.json` (identical shape to `generateRegistry`, same as the behavior
   eval). Overlap is a knob (§5).
2. **Drive** — same A2A caller path as the behavior eval; one `SendMessage` per
   task with `agentmesh/mode: 'ask'`. The returned `Task` carries the per-hop
   `metrics` block already emitted by `stdio-server.js` (§4).
3. **Meter** — numeric extractors over observable artifacts (§6) produce named
   metrics: routing edges, latency, tokens, dollars.
4. **Judge** — one independent `claude -p` per scored answer returns an ordinal
   quality score against the planted ground truth (§7).
5. **Tear down** — same as the behavior eval (remove temp mesh + logs +
   enumerated transcript dirs; `HOME` not overridden).

### Scenario module shape

```js
export default {
  name: 'routing-confusable-6',
  cell: { peers: 6, overlap: 'confusable' },   // selects the fixture generator knobs
  // build(ctx) returns a buildRoutingMesh result: { meshRoot, agents, tasks }
  build: (ctx) => ctx.buildRoutingMesh({ peers: 6, overlap: 'confusable', domains: [...] }),
  // each task is one drive of A, carrying its own ground-truth labels
  tasks: [{
    prompt: 'What is the current dunning schedule for overdue invoices?',
    correctPeer: 'billing',
    acceptablePeers: ['billing'],   // routing tolerance set (precision/recall)
    groundTruth: 'DUNNING-7a3f',    // judge anchor + cheap contains-meter
    minimalHops: 1                  // wasted-hop = actualHops - minimalHops
  }],
  // meters receive { fixture, results, runs } — all artifacts, no live state
  meters: [m.routing(), m.efficiency(), m.quality()]
};
```

A scenario's `meters` emit `{ name, value }` (or `{ name, values: [...] }`)
rather than `{ pass }`. The PerfCard aggregates them as distributions across K
trials (§8).

## 4. Telemetry inventory — what exists vs. what is added

The benchmark adds **no new measurement surface** except token/cost capture:

| Signal | Source | Status |
|---|---|---|
| Per-hop latency: `queue_wait_ms`, `worker_run_ms`, `total_ms`, `worker_spawn_ms`, `change_detect_ms` | `metrics` block built in `src/a2a/stdio-server.js` `runWithMetrics`, attached to the `Task` | ✅ **exists** — meters just read it |
| Delegation edges (`id`, `parent_run_id`, `route`, `status`) | per-agent `runs-*.jsonl` via `createRunLog`/`appendRunLog`, read by `readRuns` | ✅ **exists** |
| Peer-folder cleanliness | `git status --porcelain` (`gitClean`) | ✅ **exists** |
| Tokens (`usage`), dollars (`total_cost_usd`), `num_turns`, `duration_api_ms` | the `claude -p` **terminal result event** — emitted by the CLI, **not currently parsed** | ⚠️ **added** (§9) |
| Answer faithfulness | new independent judge spawn | ⚠️ **added** (§7) |

The latency block already carries `isolation_violations` and a `conformance`
slot — a perf-telemetry skeleton designed in earlier; the benchmark is its first
real consumer.

## 5. The fixture generator — controlled scale & confusability

`buildRoutingMesh({ peers, overlap, domains })` wraps `buildMesh`:

- **N peers** — sweep cells `{ 3, 6, 12 }`. The caller (agent A) lists all N in
  its `registry.json`; each peer is `git init`-ed with a domain `AGENT.md` and a
  planted fact file (`plant()` — random per trial, unguessable from world
  knowledge).
- **overlap** — the discrimination knob:
  - `disjoint` — orthogonal domains (billing / weather / library). Baseline.
  - `confusable` — neighboring domains that a weak router conflates
    (billing / payments / invoicing / refunds). The real routing test.
- Tasks are phrased **functionally** — never naming the target peer or any
  internal tool. This is the CLAUDE.md discipline that both (a) tests genuine
  routing rather than literal name-matching and (b) avoids the documented
  first-turn tool-visibility race.

Metrics are reported **per cell**, so the card shows routing precision as a
**curve vs. N and vs. overlap** — the degradation curve *is* the agent-performance
story.

`buildRoutingMesh` emits the exact marker-valid shape `readManagedRegistry` /
`readManifest` accept, so the benchmark exercises production wiring, not a
parallel fixture dialect.

## 6. Meters (numeric extractors)

Each meter reads artifacts and emits named numbers. Pure functions of
`{ fixture, results, runs }`; no live state.

### `m.routing()` — scored from delegation **edges**, not answer text
- `delegated_peers` — set of peers with a run whose `parent_run_id` = A's run id.
- `precision` = |delegated ∩ acceptablePeers| / |delegated| (1 if none delegated and none needed).
- `recall` = correctPeer ∈ delegated ? 1 : 0.
- `wrong_peer` = |delegated \ acceptablePeers| > 0.
- `wasted_hops` = max(0, actualHops − minimalHops), where actualHops = total
  delegation edges in the task's subtree (counts two-hop chains).

Scoring the **decision**, not the answer, is deliberately robust to the
read-anywhere confound.

### `m.efficiency()` — read off the metrics block + captured cost
- `latency_ms` = end-to-end `total_ms` of A's root hop (user-facing latency).
- `worker_ms` = Σ `worker_run_ms` across the subtree (aggregate model work).
- `overhead_ms` = `total_ms − worker_run_ms` per hop, summed — the **framework
  tax** (spawn + bridge round-trip + queue wait). A mesh-specific number.
- `tokens_in` / `tokens_out` / `tokens_total` — Σ `usage` across hops.
- `cost_usd` — Σ `total_cost_usd` across hops (exact, from the CLI; no price
  table to maintain).
- `hops` — delegation-edge count.

### `m.quality()` — cheap proxy + judge
- `contains_truth` — boolean, the behavior-eval-style `answerContains` proxy.
- `judge_score` — ordinal 0 / 0.5 / 1 from §7.

### Derived (computed by the PerfCard, §8) — the anti-gaming headline
- `quality_per_1k_tokens` = judge_score / (tokens_total / 1000).
- `quality_per_hop` = judge_score / max(1, hops).
- The broadcaster's quality is divided by its bloated cost — it cannot win.

## 7. The judge tier

- **Independent spawn.** A fresh `claude -p` given **only** `{ prompt,
  groundTruth, answer }` and a fixed rubric — **no mesh tools, no registry, low
  temperature**. It never sees the mesh, so it can't be steered by it.
- **Ordinal score**, not fine-grained: `0` wrong/contradicted · `0.5` partial ·
  `1` faithful & complete. Coarse scores are far more stable across runs than a
  0–100 scale.
- **Rubric anchors on the planted token**: "faithful" requires the answer to
  convey `groundTruth` *and* not contradict/hallucinate around it; "wrong"
  includes fabricating an answer when the peer actually refused.
- **Calibration is mandatory** (§10): a hand-labeled golden set of known-good /
  known-bad answers is scored in the hermetic suite and the judge must rank them
  correctly, so judge drift is caught before real runs spend money on it.

## 8. The composite PerfCard (anti-gaming by construction)

The headline is **not** a single scalar and **not** three disconnected cards.
Per scenario/cell, across K trials:

- **The triple, reported together**: `quality` (judge p50), `routing`
  (precision / recall / wasted-hops), `cost` (latency p50/p95, tokens, $).
- **Efficiency-normalized headline**: `quality_per_1k_tokens`, `quality_per_hop`
  — the gaming-resistant numbers.
- **Quality-vs-cost scatter** across trials (rendered as a table of points in
  `.md`, full data in `.json`) — the Pareto view. A regression that trades cost
  for quality becomes **visible** instead of averaging out.

`eval-perf-results/<timestamp>/perfcard.{json,md}` (dir gitignored). The `.json`
preserves every trial's raw metrics + planted values + pointers to preserved
artifacts for inspection.

Exit code 0 always; `--min-quality`, `--max-cost-usd`, `--min-precision` set
optional gates (aggregate, excluding scatter-only cells).

## 9. Production change — token/cost capture

The only non-additive change. `src/delegate.js` already runs `claude -p` and
writes a run record; it does **not** parse the CLI's terminal result event.

- Capture `usage`, `total_cost_usd`, `num_turns`, `duration_api_ms` from the
  final stream-json `result` event and add a `usage` field to the run record
  written in `appendRunLog`.
- Surface the same numbers in the `Task` metadata via the existing `metrics`
  block (extend `runWithMetrics`), so the benchmark reads cost the same way it
  reads latency.
- **Invariant-safe**: this is observability only — no model-facing surface
  change, no recursion-state read from input, no new writable root. The
  dashboard's activity/usage views gain exact per-hop cost for free.
- If the CLI output format in a given run carries no result event, the fields
  are `null` (degrade, never throw) — same discipline as `files_changed: null`
  for non-git folders.

## 10. Testing the harness itself (hermetic, in `npm test`)

The benchmark needs a real model; the **harness must not**. `test/perf-harness.test.js`
uses `createFakeClaude` with scripted behaviors and asserts:

- `buildRoutingMesh` produces marker-valid fixtures at each cell
  (`readManagedRegistry` accepts; `readManifest` resolves caller names).
- Each meter computes correctly from fixed artifacts — a fake that delegates to
  the right/wrong/many peers yields the expected precision/recall/wasted-hops; a
  fake emitting a known `usage`/`total_cost_usd` yields the expected
  tokens/dollars.
- **Judge calibration**: a stubbed judge scoring the golden set ranks
  known-good above known-bad (and the rubric-to-score mapping is asserted).
- PerfCard math: trial → distribution (p50/p95), derived `quality_per_*`, and
  the `--min-*`/`--max-*` exit-code behavior.

This keeps the default suite hermetic while regression-protecting the runner.

## 11. Stochasticity & cost controls

- **K trials**, default **5** (perf reports distributions, so more than the
  behavior eval's 3); `--trials N`. Percentiles (p50/p95), never bare means.
- Serial execution; per-scenario timeout (`--timeout-ms`, default 180s).
- Honors `AGENT_MESH_CLAUDE` (Windows-safe, same as `live-a2a-check.mjs`).
- `--cell <peers>x<overlap>` and `--scenario <name>` filters; `--list` prints
  the catalog.
- **Budget note**: the dominant cost. Rough order at defaults — for the 12-peer
  confusable cell, one task ≈ 1 root + up to a few worker spawns + 1 judge call;
  × K trials × scenarios. The judge call ~doubles spawn count vs. the behavior
  eval. `--max-spawns` aborts a run that exceeds a cap.

## 12. Limitations & future work

- **ask-mode only** (bridge is ask-only); do-mode perf is out of scope.
- **Read-anywhere confound** inherited (routing scored from edges mitigates it
  for the routing axis; quality could still be inflated by a worker grepping a
  peer's logs — accepted, documented).
- **Judge is itself a model** — calibration bounds but does not eliminate drift;
  scores are comparative within a run, not absolute truth.
- Candidate v2: do-mode cost, latency SLOs as gates, adversarial routing
  (peers that lie about their domain in AGENT.md), token-budget-per-hop
  enforcement, multi-judge ensembles.

## 13. Open decisions

1. `eval/perf/` as a sibling subtree (proposed) vs. folding into `eval/` with a
   `--perf` mode on the existing runner. Proposed sibling — meters/judge are a
   distinct concern from pass/fail probes.
2. Judge model selection — the configured `claude` (simplest) vs. a pinned
   cheaper model for the judge via a dedicated env. Proposed: configured CLI,
   `--judge-claude <path>` override.
3. Default K=5 — raise once real runtime/cost is measured?
4. Which `{N × overlap}` cells ship in v1 — proposed `3×disjoint` (baseline),
   `6×confusable`, `12×confusable` (the degradation curve) — vs. the full grid.
5. `minimalHops` labeling — author-declared per task (proposed) vs. derived from
   a reference "oracle" route. Author-declared is simpler and explicit.
