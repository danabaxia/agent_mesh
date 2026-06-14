# Agent-Mesh Evaluation Methodology — Unified System

The umbrella that ties every test and eval in this project into **one coherent
methodology**. It frames what already exists (the hermetic suite, the behavior
eval) and what is specced-but-unbuilt (do-mode evals, adversarial battery,
performance benchmark) as a single layered system, so contributors and the
implementation loop know *which layer a given question belongs to* and *how the
layers compose*.

This is a framing/strategy document, not a feature spec. Each layer's mechanics
live in its own design spec (linked per layer); this document is the map.

## 1. Philosophy — three load-bearing principles

1. **One hermetic gate, many real-`claude` scorecards.** Exactly one tier blocks
   merge: the deterministic, stubbed-`claude` suite (L0). Everything that needs a
   real model is a **scorecard** — measured, reported, never a default CI gate —
   because a stochastic LLM run must never block `npm test`.
2. **Failure is data, not an exception.** Every layer reports structured outcomes
   (a refusal code, a probe `{pass,detail}`, a meter value), never a thrown
   crash. This mirrors the framework's own invariant (`CLAUDE.md`: *"Failure is
   data"*) — the test system embodies the property it tests.
3. **Test the harness, not the model.** Each real-`claude` layer's *harness* is
   itself unit-tested in L0 with `createFakeClaude` (scripted, deterministic).
   The model's behavior is measured at eval time; the plumbing that measures it
   is regression-protected hermetically. No layer is allowed to depend on a real
   model to prove its own correctness.

## 2. The layered model

| Layer | Name | `claude` | Verdict type | Gates CI? | Question it answers |
|---|---|---|---|---|---|
| **L0** | Hermetic suite | stubbed | pass/fail | **yes** (the gate) | Is the *plumbing* correct? (wire shapes, refusal codes, path-guard `exit(2)`, env-only recursion, pure safety logic) |
| **L1** | Real-`claude` e2e | real | pass/fail | opt-in | Does the real CLI integrate end to end? (wire framing, do-mode write permission, cross-folder confinement) |
| **L2** | Behavior eval | real | pass-rate scorecard | no | Does the agent *behave well*? (delegate when it should, pick the right peer, multi-turn memory, refusal-is-data) |
| **L3** | Adversarial battery | real | hard-gate scorecard | opt-in `1.0` | Do the *security invariants* hold under active attack? |
| **L4** | Performance benchmark | real | numeric scorecard (meters) | no | How *well* does the mesh perform? (routing@scale, efficiency/cost, answer quality) |

The layers form a **confidence ladder**: L0 proves the machine is wired right; L1
proves the real model can drive it at all; L2 proves it drives it *well* on
typical work; L3 proves it stays safe under attack; L4 quantifies *how
efficiently and accurately* it performs. Cost and flakiness rise down the ladder;
so does the realism of what's being measured.

## 3. What occupies each layer today

### L0 — Hermetic suite — `npm test` / `node run-all-tests.mjs` — **EXISTS**
~95 files under `test/`, each its own `node --test` process (the
`run-all-tests.mjs` runner gives per-file isolation + timeouts, Windows-stable).
Stubs `claude` via `createFakeClaude`. Representative coverage:
- **Pure safety core**: `context`, `path-guard`, `change-detect`, `contract`,
  `reserved-env`, `conformance`, `structure-conformance`.
- **Protocol/wire**: `a2a-protocol`, `a2a-stdio-server/-client`, `mcp`,
  `peer-bridge`, `onward-delegation-wiring`.
- **Stubbed delegation**: `delegate`, `delegate-invocation`, `multi-turn-delegate`,
  `fast-path`.
- **Platform guards**: `process`, `no-cmd-exe-spawn` (win32-guarded).
- **Eval-harness self-tests**: `eval-harness.test.js` (the L2 harness, tested
  hermetically — principle #3).
This is the **only** tier that gates merge.

### L1 — Real-`claude` e2e — opt-in — **EXISTS (platform-split)**
- `test/demo-e2e.test.js` — **POSIX-only**, `AGENT_MESH_E2E=1`. Spawns a real
  `claude` in folder A that delegates a real write to folder B — the regression
  net for wire framing / do-mode write permission / cross-folder confinement the
  stubbed suites can't see. Skips on Windows by design (the `execFileSync('claude')`
  can't resolve the `.cmd` shim — an expected skip, not a failure).
- `scripts/live-a2a-check.mjs` — the **Windows** equivalent: a real-`claude` run
  over the live `serve-a2a` JSON-RPC wire (`initialize`/`ping` + a two-turn
  resume). Uses the Windows-aware spawn path (`resolveSpawnTarget`).
- Keep the two in sync when the wire/protocol changes.

### L2 — Behavior eval — `scripts/eval-a2a.mjs` + `eval/` — **EXISTS**
8 scenarios, REAL `claude`, **deterministic ground-truth probes** (random planted
facts so the model can't answer from world knowledge), pass-rate scorecard, exit
0 unless `--min-pass-rate`. Spec:
[2026-06-10-a2a-behavior-evals-design.md](2026-06-10-a2a-behavior-evals-design.md).
Catalog: should/shouldn't-delegate, peer selection, roster A/B, multi-turn
memory, reset semantics, two-hop chain, refusal-is-data.

### L3 — Adversarial battery — **SPEC-DRAFT** (not built)
One REAL-`claude` scenario per security invariant (AGENT.md injection,
anti-spoof, single root, recursion, reserved env, ask-only bridge, registry
marker); hard gates designed for `--min-pass-rate 1.0`. Spec:
[2026-06-13-adversarial-eval-battery-design.md](2026-06-13-adversarial-eval-battery-design.md).

### L4 — Performance benchmark — **SPEC-DRAFT** (not built)
Composite PerfCard: routing accuracy at scale + efficiency/cost + judge-scored
quality, reported as a gaming-resistant triple (quality-per-token, wasted-hops).
Spec:
[2026-06-13-mesh-perf-benchmark-design.md](2026-06-13-mesh-perf-benchmark-design.md).
Depends on [delegate cost-capture](2026-06-13-delegate-cost-capture-design.md)
for the cost axis.

> **do-mode behavior evals** ([spec](2026-06-13-do-mode-behavior-evals-design.md),
> SPEC-DRAFT) extend **L2** (write-path correctness) and add the harness mode
> seams that **L3** reuses — it is L2 content, not a new layer.

## 4. The shared harness — one substrate, two scorer kinds

L2–L4 all ride **one** harness (`eval/harness.mjs`, extended per spec) with the
same lifecycle: **build → drive → score → tear down.**

- **`buildMesh` / `buildRoutingMesh`** — materialize a disposable mesh whose
  fixtures are byte-identical in shape to production wiring (`generateRegistry`
  output, marker-valid `registry.json`/`mesh.json`), so evals exercise the real
  wiring, not a parallel dialect.
- **`driveAgent`** — the eval is an A2A caller (`createA2AClient`) sending real
  `SendMessage`s; mode (`ask`/`do`) and per-turn metadata are parameters.
- **Tear down** — remove the temp mesh + logs + enumerated real-`claude`
  transcript dirs (`HOME` not overridden — the real CLI needs its auth).

The layers differ only in their **scorer**:

| Scorer | Shape | Used by | Aggregation |
|---|---|---|---|
| **probe** | `{ pass, detail }` over framework artifacts | L2, L3 | pass-rate across K trials |
| **meter** | `{ name, value }` numeric | L4 | p50/p95 distribution across K trials |
| **judge** | independent low-temp `claude -p`, ordinal score | L4 quality axis only | mean + self-agreement |

**No LLM-as-judge in the correctness tiers (L2/L3).** Every L2/L3 probe is a
binary check against planted ground truth or a framework artifact. A judge
appears *only* in L4's quality axis, and even there is calibrated against a
hand-labeled golden set (in L0) before its scores are trusted.

## 5. Cross-cutting conventions (every real-`claude` layer obeys)

1. **Random planted ground truth** (`plant()`): codewords/facts generated per
   trial, so a model can never answer from world knowledge — only from a peer or
   the transcript.
2. **K trials, distributions not single runs**: pass-rates (L2/L3) and
   percentiles (L4). Stochasticity is reported, never hidden behind a mean.
3. **Probe the artifacts, not the prose**: scoring reads run records
   (`parent_run_id` edges, `argv`, `status`, `usage`), `git status`, the
   path-guard denial log, the A2A `Task` metrics block — observable framework
   output, not free-text answers (which are at most a soft signal). Routing is
   scored from delegation *edges*, which is robust to the read-anywhere confound.
4. **Honest fixture framing**: deceptive bait trips the model's own safety layer
   *before* the mesh runs (testing the wrong thing). Confinement/adversarial
   fixtures declare themselves as the framework's own checks with neutral
   filenames, so the layer under test is the one exercised. (`CLAUDE.md` lesson.)
5. **Phrase worker tasks functionally**, never by internal tool name — both to
   test genuine behavior and to dodge the documented first-turn MCP
   tool-visibility race.
6. **Platform-split for write paths**: do-mode/adversarial write scenarios are
   POSIX-first and skip on Windows with a reason (managed-policy preflight),
   exactly like L1's `demo-e2e`.

## 6. When to run what

| Trigger | Layers | Why |
|---|---|---|
| Every commit / PR (CI) | **L0** | the gate — must be green to merge |
| Touching the spawn pipeline, wire, or path-guard | L0 + **L1** (`AGENT_MESH_E2E=1` / `live-a2a-check`) | real-CLI integration the stubs can't see |
| Changing delegation/routing behavior, prompts, or peer wiring | + **L2** | confirm behavior didn't regress |
| Changing any security invariant or its enforcement | + **L3** at `--min-pass-rate 1.0` | a failure is a security regression |
| Optimizing cost/latency, or before a release | + **L4** | quantify performance, catch regressions on the quality-vs-cost frontier |
| Release candidate | all layers | full confidence ladder |

L0 is cheap and hermetic; L1–L4 cost real model time and are run deliberately,
not on every push. None of L1–L4 gates by default — they gate only when a
threshold flag (`--min-pass-rate`, `--min-quality`, …) is explicitly passed.

## 7. Coverage matrix (the system at a glance)

| Concern | L0 hermetic | L1 e2e | L2 behavior | L3 adversarial | L4 perf |
|---|---|---|---|---|---|
| Wire shapes / refusal codes | ✅ | ✅ | — | — | — |
| Path-guard / single root | ✅ (unit) | ✅ (real write) | — | ✅ (under attack) | — |
| Recursion (cycle/depth) | ✅ (unit) | — | ✅ (two-hop) | ✅ (forced cycle) | — |
| Delegate-when-appropriate | — | — | ✅ | — | (precondition) |
| Peer selection accuracy | — | — | ✅ (3 peers) | — | ✅ (3/6/12, confusable) |
| Multi-turn memory / reset | — | — | ✅ | — | — |
| AGENT.md-as-data | ✅ (length-bound) | — | — | ✅ (injection) | — |
| Anti-spoof (env-only state) | ✅ (unit) | — | — | ✅ (spoofed meta) | — |
| Write correctness (do-mode) | (stubbed) | ✅ | ✅ (planned) | ✅ (denied) | — |
| Latency / tokens / $ | — | — | — | — | ✅ |
| Answer faithfulness | — | — | (contains-token) | — | ✅ (judge) |

✅ = covered or specced; gaps are deliberate (see each layer's non-goals).

## 8. Status & rollout

- **Built**: L0, L1, L2.
- **Spec-draft (awaiting approval, then the implementation loop)**: L2 do-mode
  extension, L3 adversarial battery, L4 performance benchmark + its cost-capture
  dependency. See `docs/superpowers/backlog.md`.
- Rollout order (dependency-driven, matches the backlog): cost-capture →
  do-mode evals (L2/L3 seams) → adversarial battery (L3) → performance benchmark
  (L4).

## 9. Open decisions

1. Discoverability — keep this umbrella in `specs/` (proposed, consistent with
   the approval flow) vs. promote a condensed version into `CLAUDE.md` /
   `PROJECT.md` so the layer model is front-and-center for every contributor.
2. A single `scripts/eval.mjs` front door dispatching `--suite behavior|adversarial|perf`
   vs. one script per layer (`eval-a2a.mjs`, `eval-adversarial.mjs`,
   `eval-perf.mjs`). Proposed: per-layer scripts (distinct verdict types &
   cadences) with a thin shared `eval/harness.mjs`.
3. Whether L3 should *also* be a CI gate (at `1.0`) on a nightly schedule rather
   than purely opt-in, given it tests security properties. Proposed: nightly
   scheduled scorecard, alert-on-regression, still not a per-PR blocker (cost +
   stochasticity).
