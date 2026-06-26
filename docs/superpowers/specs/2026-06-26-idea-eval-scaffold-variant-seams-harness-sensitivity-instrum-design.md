# Eval Scaffold Variant Seams — Harness Sensitivity Instrumentation

## Goal

The behavior eval (`eval-a2a.mjs`) currently measures pass/fail without
controlling for scaffold variables — how the worker prompt is framed, whether
the peer roster is injected, how verbose the task description is. A 2026
SWE-bench analysis found the same model scoring 50.2%–55.4% across different
harnesses — a 5.2 pp variance from scaffold alone. For agent_mesh, a
pass-rate improvement might be scaffold-induced noise rather than a genuine
framework or model improvement. This spec formalizes the existing
`AGENT_MESH_EVAL_NO_ROSTER` seam into a named variant catalog and runs each
scenario under multiple scaffold variants so regressions become attributable.

## Motivation

Three concrete gaps the variant catalog closes:

1. **Attribution ambiguity**: today a pass-rate drop could be a genuine
   regression, a model update, or scaffold noise — there is no signal to tell
   them apart. A per-variant cross-comparison turns "did the score drop?" into
   "did *all* variants drop (genuine) or only one (scaffold-sensitive)?"
2. **Ad-hoc seam duplication**: `AGENT_MESH_EVAL_NO_ROSTER=1` is the only
   existing scaffold toggle; adding a second would require duplicating the
   invocation pattern. A named catalog makes adding variants systematic.
3. **Daily-review noise**: the MIR daily review shows raw pass-rate changes.
   Without variant attribution, a reviewer cannot distinguish a real regression
   from scaffold noise and may waste investigation time on the wrong signal.

## Background

- **SWE-bench 2026 harness analysis** (digitalapplied.com, June 2026): same
  model, five different harnesses → 50.2%–55.4% pass rate; "harness design
  dominates model choice." Tool definitions, retry logic, and prompting
  scaffold account for the full variance.
- **SWE-agent v1.1.0** (May 2026): confirms scaffold sensitivity is a
  first-class concern; the project maintains a strict scaffold-version log
  alongside model scores.
- **OpenHands SDK** (arxiv:2511.03690v1): multi-agent eval reports include
  per-scaffold breakouts to isolate genuine quality improvements.
- **Existing seam** (`AGENT_MESH_EVAL_NO_ROSTER`): eval scenario 04 already
  suppresses roster injection as one ad-hoc variant — this spec makes that
  pattern systematic.

## Variants (v1)

| Name | Peer roster | Task verbosity |
|------|-------------|----------------|
| `baseline` | Full roster (current default, regression-locked) | Full task |
| `no-roster` | Suppressed (`AGENT_MESH_EVAL_NO_ROSTER=1`) | Full task |
| `terse-task` | Full roster | First sentence only |

## Components

- **`eval/scaffold-variants.mjs`** — pure catalog (name, env overrides, and
  task transform); applies each variant's env overrides and task transform to a
  scenario run without altering its probes/assertions.
- **`scripts/eval-a2a.mjs`** — new `--scaffold-variants <names>` flag (default:
  `baseline` only — no change to existing usage); passes the selected variant
  names to the harness for each scenario run.
- **Per-variant scorecard + cross-variant classifier (pure)** — `(perVariantResults) → { perVariant, aggregate, classification }` where classification ∈ `{ healthy, scaffold-sensitive, genuine-regression }` per the attribution rule. Pure, table-testable.
- **Scorecard renderer** — adds the per-variant column, aggregate, and the `scaffold-sensitive` / genuine-regression tag to the eval output / daily review.
- **(Reused) existing `AGENT_MESH_EVAL_NO_ROSTER` seam** — now one entry in the catalog rather than an ad-hoc toggle.

## Data flow

1. `eval-a2a.mjs` is invoked with `--scaffold-variants baseline,no-roster,terse-task` (or no flag → `baseline` only).
2. For each selected scenario × each requested variant:
   - the variant applier sets `envOverrides` and applies `taskTransform` to the task,
   - the scenario runs with its **unchanged** probes/assertions,
   - pass/fail (and any metrics) are recorded under `(scenario, variant)`.
3. The cross-variant classifier compares each scenario's results across variants:
   - one-variant drop → `scaffold-sensitive`;
   - all-variant drop → `genuine-regression`;
   - stable → healthy.
4. The renderer emits a per-variant column + aggregate + classification.
5. The daily review now shows *attributable* movements: a reviewer can tell a real regression from scaffold noise instead of guessing.

## Testing

Pure-catalog, applier, and classifier tests (hermetic):

- **Default unchanged:** no `--scaffold-variants` flag → only `baseline` runs; output identical to today (regression lock on existing usage).
- **Variant application:** `no-roster` sets `AGENT_MESH_EVAL_NO_ROSTER=1`; `terse-task` reduces the task to its first sentence — verified against fixtures.
- **Probes invariant:** a scenario's assertions/probes are byte-identical across variants (only framing differs).
- **Classifier — scaffold-sensitive:** results passing in `baseline` but failing only in `terse-task` → classified `scaffold-sensitive`, not a genuine regression.
- **Classifier — genuine regression:** a drop across all three variants → classified `genuine-regression`.
- **Classifier — healthy:** stable across all variants → healthy.
- **Catalog purity:** `scaffold-variants.mjs` transforms are pure (same input → same output, no side effects).
- **Scorecard rendering:** per-variant column, aggregate, and classification tag all present and correct for a multi-variant run.
- **Determinism:** repeating the same scenario×variant yields the same result; the only diff between compared runs is the variant.
- **Unknown variant name:** an unrecognized `--scaffold-variants` entry is rejected/ignored with a clear message (not a silent no-op that skews the scorecard).

## Out of scope

- **Auto-remediating scaffold sensitivity** — this *measures and attributes*; deciding how to harden a scaffold-sensitive scenario is separate.
- **Changing scenario probes, pass criteria, or the behavior eval's correctness semantics** — variants perturb framing only.
- **More than the v1 three variants** — additional variants (tool-definition variants, retry-logic variants, prompt-format variants) are a natural follow-on but not in v1.
- **Applying variants to other eval tiers** beyond `eval-a2a.mjs` behavior scenarios (e.g. perf, swebench) — the catalog could be reused later, but this idea targets the behavior eval.
- **Statistical significance / repeated-trial variance modeling** — v1 classifies on single-run-per-variant drops; multi-trial CI/variance handling (cf. MIR variance work) is deferred.
- **Scaffold-version logging / provenance tracking** (à la SWE-agent's scaffold log) — recording which scaffold produced a historical score is a complementary future idea.
- **Making any variant the new default** — `baseline` stays the regression-locked default; promoting a variant is out of scope.
- **Path-guard / anti-spoof / write-boundary changes** — none; pure eval instrumentation.
